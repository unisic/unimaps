/**
 * Import FIRST in a test that constructs pollers: points KB_OUTPUT_DIR at a throw-away directory before
 * lib/config.ts is evaluated, so nothing a test persists (fleet history, learned stop directions) can
 * touch the real output/ of the checkout. `node --test` runs every file in its own process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-test-output-"));
process.env.KB_OUTPUT_DIR = dir;
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
