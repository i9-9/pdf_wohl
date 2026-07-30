import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
	title: "PDF Shrink — reduce imágenes sobredimensionadas",
	description:
		"Baja la resolución de las imágenes de un PDF sin tocar texto ni vectores. Todo el procesamiento ocurre en el navegador.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="es">
			<body className="min-h-screen antialiased">{children}</body>
		</html>
	);
}
