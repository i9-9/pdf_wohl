# pdf-shrink

Reduce el peso de presentaciones exportadas a PDF que pesan demasiado por
imágenes sobredimensionadas. Todo ocurre en el navegador: no hay backend, no hay
API routes, y el archivo nunca sale de la máquina. El único recurso que se
descarga es el `.wasm` de mupdf, servido desde `/public` por el propio dev
server.

No re-rasteriza páginas. Reescribe únicamente el stream y el diccionario de los
XObjects de imagen que están colocados a más resolución de la que se ve. El
texto (vectorizado como fuentes Type 3 en los exports de Figma), los vectores,
los content streams y las anotaciones quedan byte a byte donde estaban.

## Instalación

Requiere Node 20 o superior.

```bash
npm install
npm run dev
```

Abrir http://localhost:3000.

Para una build de producción local:

```bash
npm run build
npm start
```

Comprobación de tipos, sin emitir nada:

```bash
npm run typecheck
```

## Cómo se sirve el .wasm desde /public

`npm install` no deja el motor en su lugar por sí solo: hay un paso previo que
copia los tres archivos de mupdf y el worker de pdf.js a `/public`. Lo ejecutan
automáticamente los scripts `predev` y `prebuild`, así que en el flujo normal no
hay que invocarlo a mano:

```bash
node scripts/copy-assets.mjs
```

Deja este árbol:

```
public/
  mupdf/
    mupdf.js            # fachada JS
    mupdf-wasm.js       # glue de emscripten
    mupdf-wasm.wasm     # el motor, ~12 MB
  pdfjs/
    pdf.worker.min.mjs  # sólo para el comparador antes/después
```

Los tres archivos de mupdf tienen que quedar en el **mismo directorio**:
`mupdf.js` importa `./mupdf-wasm.js`, y ése resuelve `mupdf-wasm.wasm` contra su
propio `import.meta.url`. Si se separan, la cadena se rompe.

El worker de compresión no importa mupdf como dependencia del bundle: lo carga en
tiempo de ejecución desde esa ruta.

```ts
const mod = await import(/* webpackIgnore: true */ "/mupdf/mupdf.js");
```

Ese `webpackIgnore` es deliberado. mupdf usa `await` de nivel superior y busca su
`.wasm` por ruta relativa; pasándolo por el bundler, ambas cosas se rompen. Al
cargarse como archivo estático plano, el problema desaparece.

Si se despliega bajo un prefijo de ruta, hay que cambiar `DEFAULT_ENGINE_URL` en
`lib/compress.ts`.

## Qué hace, exactamente

Por cada XObject de imagen, una sola vez por xref (no por página):

1. **Mide el ppi efectivo real**: `72 * anchoEnPíxeles / anchoDelRectDeColocación`.
   La colocación se obtiene interpretando las páginas con un `Device` de mupdf
   que sólo escucha `fillImage`, `fillImageMask` y `clipImageMask`. Una imagen
   reutilizada a varios tamaños se juzga por su colocación **más grande**: usar
   la más chica destruiría la copia grande.
2. **Reencodea sólo si `ppi > target * 1.15`**. Por debajo de ese margen la
   imagen se deja intacta; reencodear de gusto sólo degrada.
3. **RGB → JPEG** (`/DCTDecode`) a la calidad del preset. **Grises →
   `/FlateDecode`**, sin pérdida. CMYK, Lab, Indexed y separaciones se convierten
   a RGB antes de reencodear.
4. **Máscaras suaves**: si el valor mínimo del canal es `>= 250`, la máscara no
   hace nada y se borra junto con la referencia `/SMask` del padre. Si hace algo,
   se remuestrea a las dimensiones exactas del padre. Esta pregunta se hace
   también para los padres que **no** se reencodean: una máscara opaca es peso
   muerto independientemente de la resolución de su padre.
5. **Nunca se toca**: content streams, fuentes Type 3, vectores, anotaciones,
   stencils `/ImageMask`, imágenes de 1 bit, ni imágenes que no se dibujan en
   ninguna página.
6. **Si el resultado no ayuda, no se aplica**. La comparación es por objeto
   (stream reencodeado contra stream original) y también global: si el archivo
   final pesa igual o más que el de entrada, se devuelve el original y se avisa
   en la interfaz.

Al guardar: `garbage: "deduplicate"` (descarta objetos inalcanzables y unifica
duplicados), `compress: true` (deflate de todo lo que no reescribimos nosotros) y
`clean: true`.

Todo el trabajo ocurre en un Web Worker. Nunca hay más de una imagen decodificada
viva: cada pixmap y cada canvas se libera antes de pasar al objeto siguiente.

## Presets

| Preset          | ppi | calidad JPEG |
| --------------- | --- | ------------ |
| Máxima calidad  | 200 | 85           |
| Equilibrado     | 150 | 78           |
| Liviano         | 110 | 68           |

Los sliders permiten cualquier combinación entre 72–300 ppi y 50–95 de calidad.

## Limitaciones conocidas

**`PDFObject.resolve()` corrompe el documento en mupdf 1.28.0 (WASM).** Es la
limitación más importante y condiciona el estilo del código. Llamar a
`resolve()` sobre una referencia indirecta y después guardar con
`garbage: "compact"` o `"deduplicate"` deja todos los objetos resueltos como
no-streams: el archivo sale con cada referencia de imagen colgando. Se reprodujo
con un bucle que sólo resuelve y no muta nada (50,1 MB → 13,9 MB con 180 de 180
referencias rotas). Por eso el código no llama nunca a `resolve()`: lee las
propiedades directamente sobre la referencia indirecta con `ref.get("Clave")`,
que resuelve internamente en C sin disparar el bug. Si se toca `lib/compress.ts`,
mantener esa regla.

**Los objetos inalcanzables desaparecen.** Una imagen que no está referenciada
desde ninguna página ni anotación se informa como "no se dibuja" y no se
reencodea, pero el garbage collect la elimina del archivo final, porque nada
apunta a ella. Es lo que "garbage collect" significa; conviene saberlo antes de
preguntarse dónde quedó.

**Grises fotográficos pueden no mejorar.** `/FlateDecode` es sin pérdida, así que
en una imagen con grano fino real el stream remuestreado puede pesar más que el
original. En ese caso el objeto se deja intacto y se informa como "no convenía".
Es el comportamiento correcto, pero significa que en documentos con muchas fotos
en escala de grises el ahorro es menor de lo esperado.

**La calidad JPEG depende del navegador.** El encoder es
`OffscreenCanvas.convertToBlob({ type: "image/jpeg", quality })`, es decir el del
navegador. La curva de calidad no es idéntica entre Chromium, Firefox y Safari,
así que el mismo archivo con el mismo preset puede pesar algo distinto según
dónde se procese.

**La conversión de color no es colorimétrica.** CMYK/ICC pasan a RGB con la
conversión de mupdf, sin gestión de perfiles ni preservación de `/OutputIntent`.
Para pantalla es lo correcto; para un PDF destinado a imprenta, no.

**Sin soporte para PDF cifrado.** Un archivo protegido con contraseña falla al
abrirse y se informa como error.

**Un archivo a la vez.** La cola acepta varios, pero el worker los procesa en
serie. Es a propósito: dos documentos de 50 MB decodificando en paralelo es
exactamente la forma de agotar el heap de 32 bits de WASM.

**El piso duro no se puede bajar.** En un export de Figma el texto viene
vectorizado como fuentes Type 3, y ese peso —13,4 MB en el archivo de
referencia— es intocable por diseño. Ninguna combinación de presets baja de ahí.

## Verificación

El directorio `spike/` contiene los scripts con los que se validó el motor y el
algoritmo. No forman parte de la app (están excluidos de `tsconfig.json`) y
requieren `npm install` dentro de `spike/`.

- `fixture-edge.mjs` genera `edge.pdf`, un documento donde cada imagen ataca una
  regla distinta del algoritmo: máscara opaca de 8 bits, máscara con gradiente
  real, CMYK, gris fotográfico, gris incompresible, stencil `/ImageMask`, imagen
  nunca dibujada, imagen reutilizada a dos tamaños e imagen ya a resolución sana.
- `assert-edge.mjs` verifica el resultado: 16 comprobaciones, entre ellas que no
  queden referencias colgando, que la máscara que sobrevive coincida en
  dimensiones con su padre, y que la luminancia media de cada página no se mueva.
- `figma-like.mjs` genera un documento calibrado contra el perfil medido del
  archivo de referencia: 154 imágenes, mediana 430 ppi, máxima 1365, 116 por
  encima de 200 ppi, 139 máscaras opacas, 14,1 MB de content streams con texto
  Type 3 real.
- `compose.mjs` desglosa el peso de un PDF por tipo de objeto, que es la forma de
  comprobar que los content streams siguen intactos.
- `bench.mjs` corre un archivo por los tres presets en Chromium real y mide peso,
  tiempo y pico de heap JS.
- `browser-test.mjs` maneja la interfaz de punta a punta con Playwright.
