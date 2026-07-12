import { defineConfig } from "vitest/config";

// pin vitest to this workspace so it doesn't walk up and load the
// frontend's vite.config.ts at the repository root
export default defineConfig({
  test: {
    dir: "tests",
    environment: "node",
  },
});
