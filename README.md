# PDF Wohl

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
  mozjpeg/
    mozjpeg_enc.js      # glue de emscripten
    mozjpeg_enc.wasm    # el codificador JPEG, ~246 KB
  pdfjs/
    pdf.worker.min.mjs  # sólo para el comparador antes/después
```

Los tres archivos de mupdf tienen que quedar en el **mismo directorio**:
`mupdf.js` importa `./mupdf-wasm.js`, y ése resuelve `mupdf-wasm.wasm` contra su
propio `import.meta.url`. Si se separan, la cadena se rompe. Lo mismo vale para
el par de mozjpeg.

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
3. **Remuestrea con promedio de área en luz lineal**. Promediar bytes con gamma
   aplicada es la operación equivocada: un par blanco/negro da 128 cuando la
   respuesta correcta es 188. En zonas suaves el error es despreciable, pero en
   bordes duros y altas luces quemadas llega a dE 24. Se descartó Lanczos3:
   contra un ideal supersampleado analíticamente mide dE 0.40 donde el promedio
   de área mide 0.03, y sobrepasa hasta dE 40 en bordes duros, que en una foto de
   producto se ve como un halo.
4. **RGB → JPEG** (`/DCTDecode`) a la calidad del preset, con **croma 4:4:4**.
   **Grises → `/FlateDecode`**, sin pérdida. CMYK, Lab, Indexed y separaciones se
   convierten a RGB antes de reencodear.
5. **Conserva el perfil ICC**. Una imagen `/ICCBased` se reescribe con su entrada
   `/ColorSpace` intacta, porque mupdf la decodifica en su propio espacio y
   reetiquetarla `/DeviceRGB` correría cada color: un rojo Adobe RGB
   `(200,60,60)` debería mostrarse como sRGB `(231,57,57)`. Convertir a sRGB
   tampoco sirve para este caso, porque recorta el gamut. Un `/Indexed` sobre una
   base ICC sí se convierte: sus muestras se expanden al decodificar y la paleta
   original ya no las describe.
6. **Máscaras suaves**: si el valor mínimo del canal es `>= 250`, la máscara no
   hace nada y se borra junto con la referencia `/SMask` del padre. Si hace algo,
   se remuestrea a las dimensiones exactas del padre, con transferencia lineal en
   vez de sRGB: una muestra de `/SMask` es una fracción de cobertura, ya lineal,
   y pasarla por gamma distorsionaría justo los bordes suaves que la máscara
   existe para producir. Esta pregunta se hace también para los padres que **no**
   se reencodean: una máscara opaca es peso muerto independientemente de la
   resolución de su padre.
7. **Nunca se toca**: content streams, fuentes Type 3, vectores, anotaciones,
   stencils `/ImageMask`, imágenes de 1 bit, ni imágenes que no se dibujan en
   ninguna página.
8. **Si el resultado no ayuda, no se aplica**. La comparación es por objeto
   (stream reencodeado contra stream original) y también global: si el archivo
   final pesa igual o más que el de entrada, se devuelve el original y se avisa
   en la interfaz.

Al guardar: `garbage: "deduplicate"` (descarta objetos inalcanzables y unifica
duplicados), `compress: true` (deflate de todo lo que no reescribimos nosotros) y
`clean: true`.

Todo el trabajo ocurre en un Web Worker. Nunca hay más de una imagen decodificada
viva: cada pixmap se libera antes de pasar al objeto siguiente, y el remuestreo
trabaja sobre dos búferes de una fila en vez de un acumulador del tamaño de la
imagen.

### Por qué mozjpeg y no el codificador del navegador

`OffscreenCanvas.convertToBlob` no expone control de submuestreo de croma, y los
navegadores submuestrean 4:2:0 a calidades normales: el color queda a la mitad de
resolución en ambos ejes, así que una imagen bajada a 110 ppi lleva su color a 55
ppi. En todas las mediciones el error de croma domina el error total, entre el 75
y el 95 %, de modo que ése era el mayor costo de color del pipeline y la API de
plataforma no lo puede tocar.

mozjpeg además trae mejores tablas de cuantización, que es lo que paga la mayor
parte del costo de 4:4:4. Su cuantización trellis, en cambio, está deliberadamente
**apagada**: no dio ninguna mejora medible sobre este contenido y costaba entre un
30 y un 140 % más de tiempo de codificación.

## Presets

| Preset          | ppi | calidad JPEG |
| --------------- | --- | ------------ |
| Máxima          | 200 | 85           |
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

**El remuestreo asume la curva sRGB.** Una imagen que se conserva en Adobe RGB o
ProPhoto RGB mantiene su perfil intacto, pero el promediado la lineariza con la
curva de transferencia de sRGB en vez de la del perfil (gamma 2,2 y 1,8
respectivamente). El error es de segundo orden, porque afecta sólo cómo se
promedian los vecinos y la transformación inversa lo revierte, y es mucho menor
que el de reetiquetar el espacio. Leer la TRC real del perfil ICC lo eliminaría.

**No se preserva `/OutputIntent`.** Los perfiles de las imágenes sí se conservan,
y las conversiones desde CMYK, Lab o Indexed sí son colorimétricas (este build de
mupdf trae lcms: `DeviceCMYK(0,255,255,0)` da `237,28,36`, no el `255,0,0` de una
fórmula naíf). Pero el intento de salida del documento no se toca, así que para un
PDF destinado a imprenta hace falta revisarlo aparte.

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
