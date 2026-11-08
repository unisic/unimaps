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
      // /brygady is a module URL to Vite (app/brygady.ts) unless the browser sends Sec-Fetch-Dest: document, which it
      // omits on a non-secure origin (http://<LAN IP>:8080 from a phone): name the page, as
      // backend/src/static_files.rs does
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "/";
        const cut = url.search(/[?#]/);
        const path = cut < 0 ? url : url.slice(0, cut);
        if (Object.hasOwn(PAGES, `${path.slice(1)}.html`)) req.url = `${path}.html${cut < 0 ? "" : url.slice(cut)}`;
        next();
      });
      server.middlewares.use("/manifest.webmanifest", (_req, res) => {
        res.setHeader("content-type", "application/manifest+json");
        res.end(body());
      });
      // after Vite's own middlewares only a page or a miss is left; a miss gets the 404 page, as
      // backend/src/static_files.rs answers it in production (Vite's mpa mode ends it empty)
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
  appType: "mpa",
  resolve: { alias: { "@": at(".") } },
  define: {
    // one service worker per build: PwaRegister registers /sw.js?v=<this>
    __BUILD_ID__: JSON.stringify(command === "build" ? Date.now().toString(36) : "dev"),
    "process.env.NODE_ENV": JSON.stringify(command === "build" ? "production" : "development"),
  },
  plugins: [svelte({ configFile: at("./svelte.config.mjs") }), pages()],
  server: {
    fs: { allow: [at(".")] },
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT) || 8080,
    strictPort: true,
    // /api goes to the Rust server scripts/dev.mjs starts beside this one; xfwd hands it the client's address
    proxy: { "^/api(?:[/?]|$)": { target: `http://127.0.0.1:${Number(process.env.KB_API_PORT) || 8081}`, xfwd: true } },
  },
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
