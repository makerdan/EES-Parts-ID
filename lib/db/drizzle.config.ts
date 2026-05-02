/**
 * Drizzle Kit config — drives `pnpm --filter @workspace/db run push`
 * and the migration generator. Schema lives in `src/schema/*`; SQL
 * migrations land in `drizzle/`.
 */
import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.join(__dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
