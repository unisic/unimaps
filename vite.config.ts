import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";

import { head, PAGES } from "./app/head";
import manifest from "./app/manifest";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The shared <head> into every app/*.html, and /manifest.webmanifest (served in dev, emitted at build). */
function pages(): Plugin {
  const body = () => JSON.stringify(manifest());
  return {
    name: "unimaps-pages",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = PAGES[basename(ctx.filename)];
        if (!page) throw new Error(`app/head.ts has no PAGES entry for ${ctx.filename}`);
        return html.replace("<!--head-->", head(page));
      },
    },
    configureServer(server) {
      server.middlewares.use("/manifest.webmanifest", (_req, res) => {
        res.setHeader("content-type", "application/manifest+json");
        res.end(body());
      });
      // after Vite's own middlewares only a page or a miss is left; a miss gets the 404 page, as server/static.ts
      // answers it in production (Vite's mpa mode ends it empty)
      return () =>
        server.middlewares.use((req, res, next) => {
          const path = (req.url ?? "/").split(/[?#]/)[0];
          if (path.endsWith(".html") && existsSync(join(server.config.root, path))) return next();
          server.transformIndexHtml("/404.html", readFileSync(at("./app/404.html"), "utf8")).then((html) => {
            res.statusCode = 404;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(html);
          }, next);
        });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: body() });
    },
  };
}

export default defineConfig(({ command }) => ({
  root: at("./app"),
  publicDir: at("./public"),
  // the dev server runs inside server/dev.ts on the API's own port
  appType: "mpa",
  resolve: { alias: { "@": at(".") } },
  define: {
    // one service worker per build: PwaRegister registers /sw.js?v=<this>
    __BUILD_ID__: JSON.stringify(command === "build" ? Date.now().toString(36) : "dev"),
    "process.env.NODE_ENV": JSON.stringify(command === "build" ? "production" : "development"),
  },
  plugins: [svelte({ configFile: at("./svelte.config.mjs") }), pages()],
  server: { fs: { allow: [at(".")] } },
  // the map chunk is import()ed after the city pick: found that late, these were optimized in two rounds and the
  // first round's leaflet chunk no longer matched (SyntaxError on load); maplibre-gl-leaflet patches that one L
  optimizeDeps: { include: ["leaflet", "maplibre-gl", "@maplibre/maplibre-gl-leaflet"] },
  build: {
    outDir: at("./out"),
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: {
      input: Object.keys(PAGES).map((f) => at(`./app/${f}`)),
    },
  },
}));
