import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/github.test.ts",
      "src/store.test.ts",
      "src/store/**/*.test.ts",
      "src/semantic.test.ts",
      "src/cli.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      all: true,
      include: [
        "src/github.ts",
        "src/store.ts",
        "src/store/**/*.ts",
        "src/lib/**/*.ts",
        "src/semantic.ts",
        "src/embedding.ts",
        "src/pr-facts.ts",
      ],
      exclude: ["src/**/*.test.ts", "src/tui/**"],
      thresholds: {
        statements: 78,
        branches: 60,
        functions: 80,
        lines: 78,
      },
    },
  },
});
