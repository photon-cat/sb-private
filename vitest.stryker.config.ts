import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Scoped Vitest config used ONLY by Stryker mutation testing. It includes just
// the fast unit tests that directly exercise the simulator modules under
// mutation, so each mutant runs against a minimal, quick suite (no toolchain).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "@kicanvas": path.resolve(__dirname, "vendor/kicanvas/src"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: [
      "lib/__tests__/hc595-sim.test.ts",
      "lib/__tests__/lcd1602-sim.test.ts",
      "lib/__tests__/chip-runtime.test.ts",
    ],
    exclude: ["node_modules", "e2e"],
  },
});
