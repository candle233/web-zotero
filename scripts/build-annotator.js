'use strict';

/**
 * Bundles src/pdf/annotator-entry.tsx (React + PDF.js annotator) into
 * public/annotator.js and copies the PDF.js worker next to it.
 * Run: npm run build:annotator
 */

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const vendorDir = path.join(publicDir, 'vendor');

async function main() {
  fs.mkdirSync(vendorDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, 'src/pdf/annotator-entry.tsx')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    jsx: 'automatic',
    outfile: path.join(publicDir, 'annotator.js'),
    logLevel: 'info',
  });
  const workerSource = path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
  fs.copyFileSync(workerSource, path.join(vendorDir, 'pdf.worker.min.mjs'));
  console.log('Annotator bundle written to public/annotator.js');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
