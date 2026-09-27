const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

// web-tree-sitter's runtime + each language grammar are WASM binaries —
// esbuild bundles JS/TS, not these, so they're copied next to
// dist/extension.js and loaded via `locateFile`/an explicit path at runtime
// instead of require.resolve (which would only work in dev, never in a
// packaged .vsix with no node_modules). Keep this list in sync with
// cartographerExtractor.ts's LANGUAGE_SPECS.
const GRAMMAR_WASM_FILES = [
  "tree-sitter-python.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
];

function copyWasmAssets() {
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync(
    require.resolve("web-tree-sitter/tree-sitter.wasm"),
    path.join("dist", "tree-sitter.wasm")
  );
  const wasmsOutDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
  for (const file of GRAMMAR_WASM_FILES) {
    fs.copyFileSync(path.join(wasmsOutDir, file), path.join("dist", file));
  }
}

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  minify: !watch,
};

// Standalone, no-vscode bundle — invoked by a plain `node` call from a repo's
// own .githooks/post-commit, never loaded inside the extension host. See
// fileSetup.ts's setupCartographerFiles for where this gets installed to.
const hookScriptOptions = {
  entryPoints: ["src/cartographerHookScript.ts"],
  bundle: true,
  outfile: "dist/cartographer-hook-push.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  minify: !watch,
};

async function main() {
  copyWasmAssets();
  if (watch) {
    const ctx = await esbuild.context(extensionOptions);
    const hookCtx = await esbuild.context(hookScriptOptions);
    await Promise.all([ctx.watch(), hookCtx.watch()]);
    console.log("esbuild watching...");
  } else {
    await Promise.all([esbuild.build(extensionOptions), esbuild.build(hookScriptOptions)]);
    console.log("esbuild build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
