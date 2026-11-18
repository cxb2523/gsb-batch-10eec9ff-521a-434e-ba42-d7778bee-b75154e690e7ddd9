import path from "node:path";
import { defineConfig } from "vitest/config";

// Dedicated headless config so unit tests never load the browser-only Vite
// plugins (tailwind, JSX location, Manus runtime) from vite.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    environment: "node",
    include: ["client/**/*.test.ts"],
  },
});
