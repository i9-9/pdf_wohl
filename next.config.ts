import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactStrictMode: true,
	// The whole app is client-side; no image optimization pipeline is used.
	images: { unoptimized: true },
};

export default nextConfig;
