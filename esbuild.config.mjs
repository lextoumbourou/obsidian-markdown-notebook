import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
};

// Headless cell runner — same sources, no Obsidian imports
const cliBuildOptions = {
  ...buildOptions,
  entryPoints: ["src/cli.ts"],
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  outfile: "cli.js",
};

if (prod) {
  Promise.all([esbuild.build(buildOptions), esbuild.build(cliBuildOptions)])
    .catch(() => process.exit(1));
} else {
  esbuild.context(buildOptions).then((ctx) => ctx.watch()).catch(() => process.exit(1));
  esbuild.context(cliBuildOptions).then((ctx) => ctx.watch()).catch(() => process.exit(1));
}
