/** Development entry: the API from source plus Vite in middleware mode (HMR) for the frontend, one port as before. */
import "./env";
import { createServer as createVite, type ViteDevServer } from "vite";
import { boot, createServer, listen } from "./http";

let vite: ViteDevServer | null = null;
const server = createServer((req, res) => {
  // pages take no body
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    return void res.end();
  }
  vite!.middlewares(req, res);
});
// the HMR socket rides this server's upgrade event instead of Vite's own port (24678 in middleware mode)
void createVite({ server: { middlewareMode: true, ws: { server } } }).then((v) => {
  vite = v;
  listen(server);
  boot();
});
