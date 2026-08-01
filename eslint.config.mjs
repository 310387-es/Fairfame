import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Project conventions (CLAUDE.md): TypeScript strict, no `any`.
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Parameter properties are unsupported by Node's strip-only type
      // stripping, which is how scripts/ and the worker process execute.
      // Vite transpiles them fine, so tests would not catch the breakage.
      "@typescript-eslint/parameter-properties": ["error", { prefer: "class-property" }],
    },
  },
  // Keep formatting concerns in Prettier, not ESLint. Must stay last.
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "docs/**",
    "src/db/migrations/**",
  ]),
]);

export default eslintConfig;
