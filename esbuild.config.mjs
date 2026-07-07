import esbuild from "esbuild";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

const banner = `/*
Unhidden — bundled output. Source lives in src/ (TypeScript, esbuild).
*/`;

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins, ...builtins.map((name) => `node:${name}`)],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  banner: { js: banner },
  outfile: "main.js",
});
