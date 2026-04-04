/**
 * Build CodeMirror 6 into a single IIFE bundle for the OS8 shell.
 *
 * The shell doesn't use Vite/webpack, so CM6's ESM packages can't be
 * imported directly. This script bundles them into vendor/codemirror.js
 * which exposes window.CodeMirror as a global.
 *
 * Usage: node tools/build-codemirror.js
 */

const { rollup } = require('rollup');
const resolve = require('@rollup/plugin-node-resolve');
const terser = require('@rollup/plugin-terser');
const path = require('path');
const fs = require('fs');

const INPUT_FILE = path.join(__dirname, '_cm6-entry.js');
const OUTPUT_FILE = path.join(__dirname, '..', 'vendor', 'codemirror.js');

// Temporary entry file that re-exports everything we need
const ENTRY_CODE = `
export {
  EditorState, StateEffect, StateField, Compartment, Transaction
} from '@codemirror/state';

export {
  EditorView, keymap, placeholder, ViewPlugin, Decoration,
  WidgetType, drawSelection, highlightActiveLine, highlightSpecialChars,
  rectangularSelection, crosshairCursor
} from '@codemirror/view';

export {
  defaultKeymap, history, historyKeymap, indentWithTab,
  undo, redo, toggleComment
} from '@codemirror/commands';

export {
  language, syntaxHighlighting, defaultHighlightStyle,
  HighlightStyle, indentOnInput, bracketMatching,
  foldGutter, foldKeymap, syntaxTree
} from '@codemirror/language';

export { markdown, markdownLanguage } from '@codemirror/lang-markdown';

export {
  search, searchKeymap, highlightSelectionMatches,
  openSearchPanel, closeSearchPanel
} from '@codemirror/search';

export { tags } from '@lezer/highlight';

export {
  autocompletion, completionKeymap, CompletionContext,
  startCompletion, closeCompletion, acceptCompletion
} from '@codemirror/autocomplete';
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
      name: 'CodeMirror',
      sourcemap: false
    });

    await bundle.close();

    const stats = fs.statSync(OUTPUT_FILE);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`Built ${OUTPUT_FILE} (${sizeKB} KB)`);
  } finally {
    // Clean up temporary entry file
    fs.unlinkSync(INPUT_FILE);
  }
}

build().catch(err => {
  console.error('Build failed:', err);
  // Clean up on error too
  if (fs.existsSync(INPUT_FILE)) fs.unlinkSync(INPUT_FILE);
  process.exit(1);
});
