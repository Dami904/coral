// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "out/**",
      "cache/**",
      "broadcast/**",
      "lib/**",
      "node_modules/**",
      ".claude/**",
      "mock-x402-server/**",
      "eslint.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Fakes/mocks in tests intentionally implement an async interface
      // without an internal await — that's the point of a fake.
      "@typescript-eslint/require-await": "off",
    },
  },
);
