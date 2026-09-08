import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui", "@workspace/normalize", "@workspace/ingest"],
  // @napi-rs/canvas ships a native .node binary — bundling it breaks the
  // binary's own path resolution, so it must run straight from node_modules.
  serverExternalPackages: ["@napi-rs/canvas"],
}

export default nextConfig
