import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = process.argv[2] || process.env.PORT || "8080";
const standaloneServer = path.join(process.cwd(), ".next", "standalone", "server.js");

/**
 * `output: "standalone"` bundles server.js but NOT the static assets — Next
 * leaves it to the deploy step (see Dockerfile) to copy `.next/static` and
 * `public` alongside it. For a local `npm start` there is no such step, so the
 * standalone server 404s every `/_next/static/*` chunk and the app renders a
 * blank shell. Mirror those two dirs (and the env files) in before launching.
 */
function syncStandaloneAssets() {
  const root = process.cwd();
  const pairs = [
    [path.join(root, ".next", "static"), path.join(root, ".next", "standalone", ".next", "static")],
    [path.join(root, "public"), path.join(root, ".next", "standalone", "public")],
  ];
  for (const [src, dest] of pairs) {
    if (!fs.existsSync(src)) continue;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  // The server loads env files from .next/standalone, where the build left a
  // stale copy of .env/.env.production (and never .env*.local). Mirror the
  // repo's current ones so an edit takes effect on restart, as with `next start`.
  for (const name of [".env", ".env.production", ".env.local", ".env.production.local"]) {
    const src = path.join(root, name);
    const dest = path.join(root, ".next", "standalone", name);
    if (fs.existsSync(src)) fs.copyFileSync(src, dest);
    else fs.rmSync(dest, { force: true });
  }
}

let child;
if (fs.existsSync(standaloneServer)) {
  syncStandaloneAssets();
  child = spawn(process.execPath, [standaloneServer], {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: port,
      HOSTNAME: process.env.HOST || "0.0.0.0",
      // server.js chdirs into .next/standalone; keep output/ (GTFS feeds, logs)
      // resolving to the repo root so build:gtfs output stays visible.
      KB_OUTPUT_DIR: process.env.KB_OUTPUT_DIR || path.join(process.cwd(), "output"),
    },
  });
} else {
  const nextBin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );
  child = spawn(nextBin, ["start", "-p", port], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

// A signal sent to this wrapper alone (npm, pm2, `kill <pid>`) must reach the
// server too, or it outlives us holding the port and the shape-store lock.
const forwarded = ["SIGTERM", "SIGINT", "SIGHUP"];
for (const sig of forwarded) process.on(sig, () => child.kill(sig));

child.on("error", (err) => {
  console.error(`start-server: failed to start the server: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // drop our forwarders so the re-raised signal takes its default action
    for (const sig of forwarded) process.removeAllListeners(sig);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
