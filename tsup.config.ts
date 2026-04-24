import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/vercel-ai.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
  splitting: false,
  outDir: "dist",
});
