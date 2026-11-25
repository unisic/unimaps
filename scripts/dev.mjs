/**
 * `npm run dev`: Vite's dev server (HOST:PORT, default 0.0.0.0:8080), which proxies /api (vite.config.ts) to the
 * server. With a server checkout in KB_BACKEND_DIR (default ../unimaps-backend) that is `cargo run` there on
 * 127.0.0.1:KB_API_PORT (default 8081), and either one exiting stops the other; without one, KB_API_URL (default
 * the production site). SIGINT / SIGTERM go to both.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// the .env files the server reads, so a PORT / HOST / KB_API_PORT set there moves Vite too
for (const f of [".env.development.local", ".env.local", ".env.development", ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);

const apiPort = process.env.KB_API_PORT || "8081";
const manifest = path.resolve(process.env.KB_BACKEND_DIR || "../unimaps-backend", "backend/Cargo.toml");
const local = fs.existsSync(manifest);
const apiUrl = local ? `http://127.0.0.1:${apiPort}` : process.env.KB_API_URL || "https://map.unisic.app";
if (!local) console.log(`dev: no server checkout at ${manifest}, /api goes to ${apiUrl}`);
// pages come from Vite: the API gets an empty static dir (a missing one only logs a warning at start)
const staticDir = path.resolve("node_modules/.cache/unimaps-dev-static");
fs.mkdirSync(staticDir, { recursive: true });

const kids = [
  // release, not debug: a search is charged its run time against the shared search budget, and a debug search
  // (~6x slower) uses it up, so a second journey search got a 429.
  ...(local
    ? [
        spawn("cargo", ["run", "--release", "--manifest-path", manifest], {
          stdio: "inherit",
          // NODE_ENV: a release build alone would read the .env.production* files
          env: { NODE_ENV: "development", ...process.env, PORT: apiPort, HOST: "127.0.0.1", KB_STATIC_DIR: staticDir },
        }),
      ]
    : []),
  spawn(process.execPath, [path.resolve("node_modules/vite/bin/vite.js")], {
    stdio: "inherit",
    env: { ...process.env, KB_API_URL: apiUrl },
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
