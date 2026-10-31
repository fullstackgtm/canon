import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "extensions/rep-desk/dist{,-test}/**",
    "scale-spike/**",
    "services/**",
    ".agents/**",
    ".augment/**",
    ".claude/**",
    ".cursor/**",
    ".factory/**",
    ".logs/**",
    ".pi/**",
    ".playwright-mcp/**",
    ".projects/**",
    "node_modules/**",
    "convex/_generated/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "react/no-unescaped-entities": "off",
    },
  },
]);
