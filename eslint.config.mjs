import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    "modules/**",
    "vendor/**",
    "wokwi-dev/**/build/**",
    "espwebemu/**",
    "stm32webemu/**",
    ".playwright-mcp/**",
    "coverage/**",
  ]),
  {
    rules: {
      // This codebase still bridges web components, KiCanvas internals, WASM,
      // MCP tool payloads, and legacy diagram tuples. Keep TypeScript strictness
      // via `tsc --noEmit`, but don't let migration scaffolding block lint.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
      "prefer-const": "warn",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react/jsx-no-comment-textnodes": "off",
      "@next/next/no-html-link-for-pages": "off",
      "@next/next/no-img-element": "off",
      "@next/next/no-page-custom-font": "off",
    },
  },
]);

export default eslintConfig;
