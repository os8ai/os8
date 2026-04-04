#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT, 'package.json');
const PACKAGE_APP_ASAR = path.join(
  ROOT,
  'dist',
  'mac-arm64',
  'OS8.app',
  'Contents',
  'Resources',
  'app.asar'
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function getStyleDependencies() {
  const stylesIndexPath = path.join(ROOT, 'styles', 'index.css');
  const contents = readFile(stylesIndexPath);
  const imports = [...contents.matchAll(/@import\s+['"](.+?)['"]/g)].map((match) => {
    const relativeImport = match[1];
    return normalizeSlashes(path.posix.join('styles', relativeImport));
  });
  return ['styles/index.css', ...imports];
}

function getBackgroundDependencies() {
  const backgroundsJsPath = path.join(ROOT, 'src', 'renderer', 'backgrounds.js');
  const contents = readFile(backgroundsJsPath);
  const matches = [...contents.matchAll(/['"]\.\/backgrounds\/([^'"]+)['"]/g)];
  const backgrounds = new Set();

  for (const match of matches) {
    backgrounds.add(`backgrounds/${match[1]}`);
  }

  return [...backgrounds].sort();
}

function getRequiredAssets() {
  return [
    'index.html',
    'main.js',
    'preload.js',
    'src/renderer/main.js',
    'vendor/codemirror.js',
    'vendor/d3.js',
    'node_modules/@xterm/xterm/css/xterm.css',
    'node_modules/@xterm/xterm/lib/xterm.js',
    'node_modules/@xterm/addon-fit/lib/addon-fit.js',
    'build/icon.png',
    ...getStyleDependencies(),
    ...getBackgroundDependencies()
  ];
}

function isCoveredByPattern(filePath, pattern) {
  const normalizedFile = normalizeSlashes(filePath);
  const normalizedPattern = normalizeSlashes(pattern);

  if (normalizedPattern.endsWith('/**/*')) {
    const prefix = normalizedPattern.slice(0, -4);
    return normalizedFile.startsWith(prefix);
  }

  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedFile.startsWith(prefix);
  }

  return normalizedFile === normalizedPattern;
}

function listPackagedFiles() {
  if (!fs.existsSync(PACKAGE_APP_ASAR)) {
    return null;
  }

  const asarBinary = path.join(ROOT, 'node_modules', '.bin', 'asar');
  if (!fs.existsSync(asarBinary)) {
    return null;
  }

  const output = execFileSync(asarBinary, ['list', PACKAGE_APP_ASAR], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\//, ''))
  );
}

function main() {
  const shouldCheckDist = process.argv.includes('--dist');
  const pkg = readJson(PACKAGE_JSON_PATH);
  const patterns = pkg.build?.files || [];
  const requiredAssets = getRequiredAssets();

  const missingOnDisk = requiredAssets.filter((assetPath) => !fs.existsSync(path.join(ROOT, assetPath)));
  if (missingOnDisk.length > 0) {
    console.error('Package asset verification failed: missing files on disk.');
    for (const assetPath of missingOnDisk) {
      console.error(`- ${assetPath}`);
    }
    process.exit(1);
  }

  const uncoveredByPackageConfig = requiredAssets.filter(
    (assetPath) => !patterns.some((pattern) => isCoveredByPattern(assetPath, pattern))
  );
  if (uncoveredByPackageConfig.length > 0) {
    console.error('Package asset verification failed: files are not covered by build.files.');
    for (const assetPath of uncoveredByPackageConfig) {
      console.error(`- ${assetPath}`);
    }
    process.exit(1);
  }

  const packagedFiles = shouldCheckDist ? listPackagedFiles() : null;
  if (shouldCheckDist && !packagedFiles) {
    console.error(`Package asset verification failed: packaged app not found at ${path.relative(ROOT, PACKAGE_APP_ASAR)}.`);
    process.exit(1);
  }

  if (packagedFiles) {
    const missingFromPackagedBundle = requiredAssets.filter((assetPath) => !packagedFiles.has(assetPath));
    if (missingFromPackagedBundle.length > 0) {
      console.error('Package asset verification failed: files are missing from dist/mac-arm64 app.asar.');
      for (const assetPath of missingFromPackagedBundle) {
        console.error(`- ${assetPath}`);
      }
      process.exit(1);
    }
  }

  console.log(`Package asset verification passed for ${requiredAssets.length} required assets.`);
  if (packagedFiles) {
    console.log(`Checked build.files and packaged output at ${path.relative(ROOT, PACKAGE_APP_ASAR)}.`);
  } else {
    console.log('Checked build.files coverage only.');
  }
}

main();
