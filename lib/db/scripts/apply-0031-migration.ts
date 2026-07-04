import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sqlContent = readFileSync(
    join(__dirname, "../drizzle/0031_rate_limit_buckets.sql"),
    "utf8",
  );

  const statements = sqlContent
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/^--[^\n]*\n/gm, "").trim())
    .filter((s) => s.length > 0);

  const client = await pool.connect();
  try {
    for (const stmt of statements) {
      console.log("Running:", stmt.slice(0, 80).replace(/\s+/g, " "));
      await client.query(stmt);
      console.log("OK");
    }
    console.log("Migration 0031 applied successfully");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
