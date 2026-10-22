import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // inlined into the client bundle: PwaRegister registers /sw.js?v=<this>, one service worker per build
  env: { NEXT_PUBLIC_BUILD_ID: Date.now().toString(36) },
  reactStrictMode: true,
  poweredByHeader: false,
  // lib reads <cwd>/output and the tests <cwd>/test at runtime, so the tracer would bake a snapshot of
  // the local output/ (feed, shape store, its .lock) and the fixtures into .next/standalone.
  // Covers the route traces only: Next 16 applies no excludes to the instrumentation trace, so a local
  // build still copies them (unused: start-server.mjs points KB_OUTPUT_DIR at the real output/, and
  // .dockerignore keeps both out of the image)
  outputFileTracingExcludes: { "/*": ["./output/**/*", "./test/**/*"] },
};

export default nextConfig;
