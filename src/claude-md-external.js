/**
 * CLAUDE.md generator for external apps.
 *
 * Spec §6.6 + plan §3 PR 1.21. Called by AppInstaller._runApprove step 7
 * (already stubbed in PR 1.16) to drop a CLAUDE.md + os8-sdk.d.ts into
 * each freshly-installed external app's directory. The file documents:
 *
 *   - Local paths (app dir, blob dir, SQLite path)
 *   - Declared os8_capabilities — the only OS8 APIs the app may call
 *   - window.os8 SDK overview + reference to os8-sdk.d.ts
 *   - Dev Mode + git workflow (user/main branch + upstream/manifest tracking)
 *   - Update flow expectations
 *
 * Side-effects: writes CLAUDE.md + os8-sdk.d.ts into <appDir>/, and a
 * frozen manifest snapshot into <appDir>/.os8/manifest.yaml.
 *
 * No-throws: failures are logged and swallowed — a missing CLAUDE.md
 * shouldn't block install activation.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { APPS_DIR, BLOB_DIR, CONFIG_DIR } = require('./config');

const SDK_DTS_PATH = path.join(__dirname, 'templates', 'os8-sdk.d.ts');

function buildCapabilityHints(caps) {
  if (!caps || caps.length === 0) return '_No capabilities declared. The app cannot call OS8 APIs._\n';

  const groups = {
    blob: caps.filter(c => c.startsWith('blob.')),
    db:   caps.filter(c => c.startsWith('db.')),
    http: caps.filter(c => ['imagegen', 'speak', 'youtube', 'x'].includes(c)),
    telegram: caps.filter(c => c === 'telegram.send'),
    google:   caps.filter(c => c.startsWith('google.')),
    mcp:      caps.filter(c => c.startsWith('mcp.')),
  };

  const lines = ['Available methods (subset of the SDK; see `os8-sdk.d.ts`):', ''];
  if (groups.blob.length > 0) {
    const rw = groups.blob.includes('blob.readwrite');
    lines.push('- `window.os8.blob.read(key)` / `.list(prefix)`' +
      (rw ? ' / `.write(key, data)` / `.delete(key)`' : ''));
  }
  if (groups.db.length > 0) {
    const rw = groups.db.includes('db.readwrite');
    lines.push('- `window.os8.db.query(sql, params?)`' +
      (rw ? ' / `.execute(sql, params?)`' : ''));
  }
  for (const cap of groups.http) {
    lines.push(`- \`window.os8.${cap}.get(...)\` / \`.post(...)\``);
  }
  if (groups.telegram.length > 0) {
    lines.push('- `window.os8.telegram.send({ text, chatId? })`');
  }
  for (const cap of groups.google) {
    if (cap.startsWith('google.calendar')) {
      lines.push('- `window.os8.googleCalendar.{get,post}(...)`');
    } else if (cap === 'google.drive.readonly') {
      lines.push('- `window.os8.googleDrive.get(...)`');
    } else if (cap === 'google.gmail.readonly') {
      lines.push('- `window.os8.googleGmail.get(...)`');
    }
  }
  if (groups.mcp.length > 0) {
    lines.push('- `window.os8.mcp(server, tool, body?)` — declared: ' +
      groups.mcp.map(c => `\`${c}\``).join(', '));
  }
  return lines.join('\n') + '\n';
}

function renderClaudeMd(app, manifest) {
  const caps = manifest.permissions?.os8_capabilities || [];
  const upstream = manifest.upstream?.git || '(unknown)';
  const ref = app.upstream_resolved_commit || manifest.upstream?.ref || '(unknown)';
  const license = manifest.legal?.license || 'unknown';
  const commercial = manifest.legal?.commercial_use || 'unknown';

  return `# ${manifest.name || app.name} — OS8 external app

Installed from the OS8 catalog (channel: \`${app.channel || 'verified'}\`).
Source: ${upstream} @ \`${ref}\`

License: \`${license}\` · Commercial use: \`${commercial}\`

## Local paths

- App source: \`~/os8/apps/${app.id}/\`
- Per-app blob storage: \`~/os8/blob/${app.id}/\`
- Per-app SQLite database: \`~/os8/config/app_db/${app.id}.db\` (created on first \`window.os8.db.execute\`)
- Frozen manifest snapshot: \`./.os8/manifest.yaml\` (read-only — the catalog source of truth)

## Declared capabilities

${caps.length === 0 ? '_None — the app cannot call OS8 APIs._' : caps.map(c => `- \`${c}\``).join('\n')}

## window.os8 SDK

Inside this app's BrowserView, OS8 exposes a typed SDK at \`window.os8\`.
Methods are present only when the manifest declares the corresponding
capability — see \`./os8-sdk.d.ts\` for the full type signatures.

${buildCapabilityHints(caps)}

Calls under \`/_os8/api/...\` are server-side authorized by OS8's scoped
API surface. A capability mismatch returns a \`403\` with
\`{ error, required, declared }\` so user code can branch on \`err.status\`.

## Editing this app

When OS8's **Dev Mode** is enabled for this app:

- Your edits in \`./src/\` and \`./public/\` auto-save.
- Changes are committed to a local \`user/main\` branch.
- The original install is pinned on \`upstream/manifest\` —
  \`git diff upstream/manifest..user/main\` shows your divergence.

## Updates

When the catalog publishes a new commit for this app, OS8 surfaces an
update banner. Updates with no local edits fast-forward; updates with
local edits perform a three-way merge into \`user/main\`. Conflicts surface
in a sidebar (PR 1.25).

## Type definitions

\`os8-sdk.d.ts\` is shipped alongside this file. Reference it from your
TypeScript code:

\`\`\`ts
/// <reference path="./os8-sdk.d.ts" />
\`\`\`

(The file lives at the app root so editors find it without an npm install.)
`;
}

function generateForExternal(db, app) {
  if (!app?.id) {
    console.warn('[claude-md-external] generateForExternal: app.id missing');
    return;
  }
  const appDir = path.join(APPS_DIR, app.id);
  if (!fs.existsSync(appDir)) {
    console.warn(`[claude-md-external] appDir missing: ${appDir}`);
    return;
  }

  let manifest = {};
  try { manifest = yaml.load(app.manifest_yaml || '') || {}; }
  catch (e) {
    console.warn('[claude-md-external] manifest parse failed:', e.message);
  }

  try {
    fs.writeFileSync(path.join(appDir, 'CLAUDE.md'), renderClaudeMd(app, manifest), 'utf8');
  } catch (e) {
    console.warn('[claude-md-external] CLAUDE.md write failed:', e.message);
  }

  // Ship the SDK type definitions next to CLAUDE.md so the IDE finds them
  // without an npm install round-trip.
  try {
    if (fs.existsSync(SDK_DTS_PATH)) {
      const dts = fs.readFileSync(SDK_DTS_PATH, 'utf8');
      fs.writeFileSync(path.join(appDir, 'os8-sdk.d.ts'), dts, 'utf8');
    }
  } catch (e) {
    console.warn('[claude-md-external] os8-sdk.d.ts copy failed:', e.message);
  }

  // Snapshot the manifest into a hidden .os8/ dir so the app code can read
  // its own contract without a network round-trip.
  try {
    const dotOs8 = path.join(appDir, '.os8');
    fs.mkdirSync(dotOs8, { recursive: true });
    fs.writeFileSync(
      path.join(dotOs8, 'manifest.yaml'),
      app.manifest_yaml || '',
      'utf8'
    );
  } catch (e) {
    console.warn('[claude-md-external] .os8/manifest.yaml write failed:', e.message);
  }
}

module.exports = { generateForExternal, renderClaudeMd };
