import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@kan/db": resolve(__dirname, "../db/src"),
      "@kan/shared": resolve(__dirname, "../shared/src"),
    },
  },
});
