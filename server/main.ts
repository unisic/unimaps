/** Production entry: the API plus the static frontend build (KB_STATIC_DIR, default <cwd>/out). */
import "./env";
import path from "node:path";
import { boot, createServer, listen } from "./http";
import { staticFrontend } from "./static";

listen(createServer(staticFrontend(process.env.KB_STATIC_DIR || path.join(process.cwd(), "out"))));
boot();
