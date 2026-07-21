/**
 * Bundles browser dependencies into src/vendor/.
 *
 * transformers.js ships ES modules containing bare specifiers
 * ("onnxruntime-common", "onnxruntime-web/webgpu"). Browsers cannot resolve
 * those, and the alternative — an inline <script type="importmap"> — would
 * have to be exempted from the app's Content-Security-Policy. Bundling avoids
 * both problems and produces a single self-contained module.
 *
 * Runs automatically from scripts/start-electron.js; skipped when the output
 * is already newer than the installed dependency.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, 'src', 'vendor');

const BUNDLES = [
  {
    name: 'transformers',
    entry: path.join(
      projectRoot,
      'node_modules/@huggingface/transformers/dist/transformers.web.js'
    ),
    outfile: path.join(outDir, 'transformers.bundle.mjs')
  }
];

function isUpToDate(entry, outfile) {
  if (!fs.existsSync(outfile)) return false;
  return fs.statSync(outfile).mtimeMs >= fs.statSync(entry).mtimeMs;
}

async function buildVendorBundles({ force = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  for (const bundle of BUNDLES) {
    if (!fs.existsSync(bundle.entry)) {
      console.warn(`[Vendor] Missing ${bundle.name} entry, run npm install first`);
      continue;
    }

    if (!force && isUpToDate(bundle.entry, bundle.outfile)) {
      continue;
    }

    console.log(`[Vendor] Bundling ${bundle.name}...`);
    await esbuild.build({
      entryPoints: [bundle.entry],
      outfile: bundle.outfile,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome110',
      minify: true,
      // The .wasm binaries are fetched at runtime from wasmPaths, not inlined.
      external: ['*.wasm'],
      logLevel: 'error'
    });

    const sizeMb = (fs.statSync(bundle.outfile).size / 1024 / 1024).toFixed(2);
    console.log(`[Vendor] ${bundle.name} -> ${sizeMb}MB`);
  }
}

if (require.main === module) {
  buildVendorBundles({ force: process.argv.includes('--force') }).catch((error) => {
    console.error('[Vendor] Build failed:', error);
    process.exit(1);
  });
}

module.exports = { buildVendorBundles };
