// Wallet bundle build — esbuild + content-hash naming.
//
// Usage:
//   npm run build          # one-shot build into dist/
//   npm run build:watch    # rebuild on file changes
//   npm run build:check    # same as build; CI uses this to verify toolchain
//
// Output:
//   dist/wallet-bundle-<hash>.js     bundled wallet entry (ESM)
//   dist/<asset>-<hash>.wasm         LWK WASM binary
//   dist/manifest.json               { walletBundle, walletWasm } — logical → hashed filename
//
// index.html does NOT reference the bundle directly by filename. script.js
// reads dist/manifest.json at runtime when the wallet is first needed, then
// dynamic-imports the hashed bundle. That keeps the source index.html cache-
// stable while the bundle name rotates every build.

import * as esbuild from "esbuild";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;
const outDir = path.join(projectRoot, "dist");
const entryPoint = path.join(projectRoot, "wallet", "entry.js");

const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const check = args.has("--check");

async function cleanOutDir() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}

/** @returns {import("esbuild").BuildOptions} */
function buildOptions() {
  return {
    entryPoints: [entryPoint],
    outdir: outDir,
    entryNames: "wallet-bundle-[hash]",
    assetNames: "[name]-[hash]",
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    minify: true,
    sourcemap: false,
    metafile: true,
    legalComments: "linked",
    // Keep `trusted-types.js` external so the bundle emits a runtime
    // `import "../trusted-types.js"` that resolves (relative to the
    // hashed bundle in dist/) to the same site-root module the legacy
    // entry point loaded. One module instance = one `createPolicy`
    // call, so the CSP can drop `'allow-duplicates'` and the policy
    // name acts as a real barrier.
    external: ["../trusted-types.js"],
    loader: {
      ".wasm": "file"
    },
    logLevel: "info"
  };
}

async function writeManifest(metafile) {
  const outputs = Object.keys(metafile.outputs);
  const bundle = outputs.find(f => {
    const name = path.basename(f);
    return name.startsWith("wallet-bundle-") && name.endsWith(".js");
  });
  const wasm = outputs.find(f => path.basename(f).endsWith(".wasm"));
  if (!bundle) {
    throw new Error("build: wallet bundle not found in esbuild outputs");
  }
  const rel = absPath => path.relative(projectRoot, absPath).split(path.sep).join("/");
  const manifest = {
    builtAt: new Date().toISOString(),
    walletBundle: rel(bundle),
    walletWasm: wasm ? rel(wasm) : null
  };
  await writeFile(
    path.join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
  return manifest;
}

async function oneShot() {
  await cleanOutDir();
  const result = await esbuild.build(buildOptions());
  const manifest = await writeManifest(result.metafile);
  const files = await readdir(outDir);
  console.log(`build: ${files.length} files in dist/`);
  console.log(`build: walletBundle = ${manifest.walletBundle}`);
  if (manifest.walletWasm) {
    console.log(`build: walletWasm   = ${manifest.walletWasm}`);
  }
  return manifest;
}

async function watchMode() {
  await cleanOutDir();
  const manifestPlugin = {
    name: "manifest-on-rebuild",
    setup(build) {
      build.onEnd(async result => {
        if (result.errors.length || !result.metafile) return;
        try {
          const manifest = await writeManifest(result.metafile);
          console.log(`build: walletBundle = ${manifest.walletBundle}`);
        } catch (err) {
          console.error("build: manifest write failed:", err);
        }
      });
    }
  };
  const ctx = await esbuild.context({
    ...buildOptions(),
    plugins: [manifestPlugin]
  });
  await ctx.watch();
  console.log("build: watching wallet/ for changes…");
}

try {
  if (watch) {
    await watchMode();
  } else {
    await oneShot();
  }
  if (check) {
    // `build:check` is just a successful one-shot. CI exits non-zero on
    // thrown errors; nothing else to assert.
  }
} catch (err) {
  console.error("build failed:", err);
  process.exit(1);
}
