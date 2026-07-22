import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // playwright is a heavy peer dep loaded lazily at runtime; don't bundle it.
  external: ["playwright"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
