import { defineConfig } from "prisma/config";

// Prisma 6 no longer auto-loads .env when a prisma.config.ts is present, so load
// it ourselves before the schema's env("DATABASE_URL") is resolved. Non-fatal if
// the file is absent (e.g. CI/prod, where vars come from the real environment).
try {
  process.loadEnvFile(new URL(".env", import.meta.url));
} catch {
  // no .env file — rely on the ambient environment
}

export default defineConfig({
  earlyAccess: true,
  schema: "prisma/schema.prisma",
  seed: {
    run: "tsx prisma/seed.ts",
  },
});
