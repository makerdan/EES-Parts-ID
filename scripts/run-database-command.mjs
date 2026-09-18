#!/usr/bin/env node
/**
 * Run a database-affecting command with an explicit non-production target.
 *
 * The caller must already identify its current Replit database context. This
 * prevents a package script from silently replacing DATABASE_ENV=production
 * with a test/development value and then running against a production URL.
 */
import { spawnSync } from "node:child_process";

const [target, separator, command, ...args] = process.argv.slice(2);
const current = process.env.DATABASE_ENV?.trim().toLowerCase();

if (
  !target ||
  separator !== "--" ||
  !command ||
  !["development", "test"].includes(target) ||
  !["development", "test"].includes(current)
) {
  console.error(
    "Database command refused: set DATABASE_ENV=development or DATABASE_ENV=test explicitly.",
  );
  process.exit(1);
}

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_ENV: target },
  stdio: "inherit",
});

process.exit(result.status ?? 1);