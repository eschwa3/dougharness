import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "plugins/*/tests/**/*.test.mjs",
      "packages/*/tests/**/*.test.ts",
      "evals/tests/**/*.test.mjs",
      "tests/**/*.test.mjs",
    ],
    setupFiles: ["./tests/setup/tmpdir.mjs"],
    testTimeout: 20000,
  },
});
