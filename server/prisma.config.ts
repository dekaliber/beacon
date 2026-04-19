import { defineConfig } from "prisma/config";

export default defineConfig({
  earlyAccess: true,
  schema: "prisma/schema.prisma",
  seed: {
    run: "tsx prisma/seed.ts",
  },
});
