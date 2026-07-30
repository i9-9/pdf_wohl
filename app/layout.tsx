import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
	title: "PDF Wohl",
	description:
		"Reduce la resolución de imágenes sobredimensionadas en PDF. Sin tocar texto ni vectores. Todo en el navegador.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="es">
			<body className="min-h-screen">{children}</body>
		</html>
	);
}
