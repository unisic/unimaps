/**
 * Next's .env files, in Next's precedence (the process environment, then .env.<mode>.local, .env.local,
 * .env.<mode>, .env). Each entry imports this first: ES modules evaluate in import order, so the files are in
 * process.env before lib/config reads it at module load.
 */
import fs from "node:fs";

const mode = process.env.NODE_ENV === "production" ? "production" : "development";
// loadEnvFile never overwrites a variable that is already set, so the strongest file goes first
for (const f of [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"]) if (fs.existsSync(f)) process.loadEnvFile(f);
