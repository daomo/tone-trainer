/** @type {import('next').NextConfig} */
const repo = process.env.NEXT_PUBLIC_REPO_NAME || ""; // GitHub repo name (for Project Pages)
const isProd = process.env.NODE_ENV === "production";
const basePath = isProd && repo ? `/${repo}` : "";

const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },

  // For GitHub Pages (Project Pages): https://<user>.github.io/<repo>/
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
};

export default nextConfig;
