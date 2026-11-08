/**
 * `npm run dev`: the Rust API (backend/, on 127.0.0.1:KB_API_PORT, default 8081) beside Vite's dev server
 * (HOST:PORT, default 0.0.0.0:8080), which proxies /api to it (vite.config.ts). SIGINT / SIGTERM go to both,
 * and either one exiting stops the other.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// the .env files the server reads, so a PORT / HOST / KB_API_PORT set there moves Vite too
for (const f of [".env.development.local", ".env.local", ".env.development", ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);

const apiPort = process.env.KB_API_PORT || "8081";
// pages come from Vite: the API gets an empty static dir (a missing one only logs a warning at start)
const staticDir = path.resolve("node_modules/.cache/unimaps-dev-static");
fs.mkdirSync(staticDir, { recursive: true });

const kids = [
  // release, not debug: a search is charged its run time against the shared search budget, and a debug search
  // (~6x slower) uses it up, so a second journey search got a 429. It also shares npm start's target/release.
  spawn("cargo", ["run", "--release", "--manifest-path", "backend/Cargo.toml"], {
    stdio: "inherit",
    // NODE_ENV: a release build alone would read the .env.production* files
    env: { NODE_ENV: "development", ...process.env, PORT: apiPort, HOST: "127.0.0.1", KB_STATIC_DIR: staticDir },
  }),
  spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js")], {
    stdio: "inherit",
    env: { ...process.env, KB_API_PORT: apiPort },
  }),
];
const exited = new Set();
let code = null;
const stop = (sig) => {
  for (const k of kids) if (!exited.has(k)) k.kill(sig);
};
const done = (k, c) => {
  if (exited.has(k)) return;
  exited.add(k);
  code ??= c;
  stop("SIGTERM");
  if (exited.size === kids.length) process.exit(code);
};
for (const k of kids) {
  k.on("exit", (c) => done(k, c ?? 1));
  k.on("error", (e) => {
    console.error(`dev: ${e.message}`);
    done(k, 1);
  });
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => stop(sig));
