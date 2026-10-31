/**
 * Bundles server/main.ts (API + static frontend) and every dependency it imports into one ESM file,
 * dist/server.mjs, so production needs neither node_modules nor tsx: `node dist/server.mjs`.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["server/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // CommonJS dependencies (protobufjs, long) call require() for node builtins, which an ES module has no binding for
  banner: { js: "import { createRequire as __kbRequire } from 'node:module'; const require = __kbRequire(import.meta.url);" },
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
  logLevel: "warning",
});
