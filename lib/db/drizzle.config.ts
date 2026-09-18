import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set for the Replit PostgreSQL database.",
  );
}

// drizzle-kit can mutate the connected database. Production is never a valid
// target for local schema synchronization or test setup.
const databaseEnvironment = process.env.DATABASE_ENV?.trim().toLowerCase();
if (
  databaseEnvironment !== "development" &&
  databaseEnvironment !== "test"
) {
  throw new Error(
    "DATABASE_ENV must be set to development or test for schema synchronization.",
  );
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  out: path.join(__dirname, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
