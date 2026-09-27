const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

// web-tree-sitter's runtime + the python grammar are WASM binaries — esbuild
// bundles JS/TS, not these, so they're copied next to dist/extension.js and
// loaded via `locateFile`/an explicit path at runtime instead of require.resolve
// (which would only work in dev, never in a packaged .vsix with no node_modules).
function copyWasmAssets() {
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync(
    require.resolve("web-tree-sitter/tree-sitter.wasm"),
    path.join("dist", "tree-sitter.wasm")
  );
  fs.copyFileSync(
    path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out", "tree-sitter-python.wasm"),
    path.join("dist", "tree-sitter-python.wasm")
  );
}

const options = {
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

async function main() {
  copyWasmAssets();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("esbuild watching...");
  } else {
    await esbuild.build(options);
    console.log("esbuild build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
