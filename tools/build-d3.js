/**
 * Build D3.js into a minimal IIFE bundle for the OS8 shell.
 *
 * Only includes modules needed for force-directed graph visualization:
 * selection, zoom, drag, force, scale-chromatic.
 *
 * Usage: node tools/build-d3.js
 */

const { rollup } = require('rollup');
const resolve = require('@rollup/plugin-node-resolve');
const terser = require('@rollup/plugin-terser');
const path = require('path');
const fs = require('fs');

const INPUT_FILE = path.join(__dirname, '_d3-entry.js');
const OUTPUT_FILE = path.join(__dirname, '..', 'vendor', 'd3.js');

// Temporary entry file that re-exports only what we need
const ENTRY_CODE = `
export {
  select, selectAll, create
} from 'd3-selection';

export {
  zoom, zoomIdentity, zoomTransform
} from 'd3-zoom';

export {
  drag
} from 'd3-drag';

export {
  forceSimulation, forceLink, forceManyBody,
  forceCenter, forceCollide, forceX, forceY
} from 'd3-force';

export {
  scaleOrdinal
} from 'd3-scale';

export {
  schemeTableau10
} from 'd3-scale-chromatic';
`;

async function build() {
  // Write temporary entry file
  fs.writeFileSync(INPUT_FILE, ENTRY_CODE);

  try {
    const bundle = await rollup({
      input: INPUT_FILE,
      plugins: [
        resolve(),
        terser()
      ]
    });

    await bundle.write({
      file: OUTPUT_FILE,
      format: 'iife',
      name: 'D3',
      sourcemap: false
    });

    await bundle.close();

    const stats = fs.statSync(OUTPUT_FILE);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`Built ${OUTPUT_FILE} (${sizeKB} KB)`);
  } finally {
    // Clean up temporary entry file
    if (fs.existsSync(INPUT_FILE)) fs.unlinkSync(INPUT_FILE);
  }
}

build().catch(err => {
  console.error('Build failed:', err);
  if (fs.existsSync(INPUT_FILE)) fs.unlinkSync(INPUT_FILE);
  process.exit(1);
});
