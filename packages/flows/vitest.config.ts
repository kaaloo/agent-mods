import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["mods/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
