'use strict';

/**
 * Bundles src/notes/notes-entry.tsx (React + TipTap rich-text editor) into
 * public/notes.js. Run: npm run build:notes
 */

const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

async function main() {
  await esbuild.build({
    entryPoints: [path.join(root, 'src/notes/notes-entry.tsx')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    jsx: 'automatic',
    outfile: path.join(root, 'public/notes.js'),
    logLevel: 'info',
  });
  console.log('Notes bundle written to public/notes.js');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
