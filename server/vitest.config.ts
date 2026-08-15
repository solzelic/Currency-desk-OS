import { defineConfig } from "vitest/config";

// keep vitest scoped to this workspace's tests directory. (The comment
// that stood here warned about a frontend vite.config.ts at the repo
// root; that app was deleted — the pin stays because it is still the
// correct scope, not because of the old hazard.)
export default defineConfig({
  test: {
    dir: "tests",
    environment: "node",
  },
});
