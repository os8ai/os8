/**
 * Template resync — copy shell-owned template files into a deployed app,
 * preserving user/agent-owned state files that live at the template's top
 * level (MYSELF.md, USER.md, claude-user.md, *.json).
 *
 * "Shell-owned" = any path under `src/` + `index.html`. These are code
 * files OS8 ships and controls; users aren't expected to edit them. Every
 * other top-level file in the template (markdown, JSON) is initial state
 * that becomes user/agent-owned after scaffold.
 *
 * Used by migrations (e.g. 0.2.10-template-resync.js) when a shell-owned
 * file contract changes between versions.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// Relative paths (or directory roots) inside the template that are shell-owned
// and safe to resync. Anything else is left alone.
const SHELL_OWNED_ROOTS = ['src', 'index.html'];

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function renderTemplate(content, variables) {
  let result = content;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(regex, value);
  }
  return result;
}

function isShellOwned(relPath) {
  const norm = relPath.split(path.sep).join('/');
  return SHELL_OWNED_ROOTS.some(root => norm === root || norm.startsWith(root + '/'));
}

function walkFiles(dir, base = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Resync shell-owned files for a single deployed app directory.
 *
 * Template files under `SHELL_OWNED_ROOTS` (currently `src/` + `index.html`)
 * are compared against the deployed app's corresponding file. If different,
 * the deployed file is backed up to `.os8-backup/<timestamp>/<relPath>` and
 * replaced with the re-rendered template.
 *
 * Template variables come from the caller. For assistant apps these are
 * typically `{ APP_NAME, ID, ASSISTANT_NAME, OWNER_NAME }` — only APP_NAME
 * and ID appear in currently-shipping shell-owned files.
 *
 * @param {object} opts
 * @param {string} opts.appDir - Absolute path to deployed app directory
 * @param {string} opts.templateName - 'assistant' or other template name
 * @param {object} opts.variables - Variable substitutions
 * @param {string} [opts.templatesDir] - Override templates root (tests)
 * @returns {{ updated: string[], skipped: string[], created: string[], backupRoot: string|null }}
 */
function resyncAppShellFiles({ appDir, templateName, variables, templatesDir }) {
  const root = templatesDir || TEMPLATES_DIR;

  // Walk both 'base' and the specific template (same layer order as scaffold).
  const templateLayers = ['base', templateName].map(name => path.join(root, name));

  const updated = [];
  const skipped = [];
  const created = [];
  const backupRoot = path.join(
    appDir,
    '.os8-backup',
    new Date().toISOString().replace(/[:.]/g, '-')
  );
  let backupCreated = false;

  // Deduplicate by relative path — later layer wins (matches scaffold's copy order).
  const planned = new Map();
  for (const layerDir of templateLayers) {
    for (const rel of walkFiles(layerDir)) {
      if (!isShellOwned(rel)) continue;
      planned.set(rel, path.join(layerDir, rel));
    }
  }

  for (const [rel, srcAbs] of planned) {
    const destAbs = path.join(appDir, rel);
    const templateContent = fs.readFileSync(srcAbs, 'utf-8');
    const rendered = renderTemplate(templateContent, variables);

    let deployedContent = null;
    if (fs.existsSync(destAbs)) {
      deployedContent = fs.readFileSync(destAbs, 'utf-8');
    }

    if (deployedContent !== null && sha256(rendered) === sha256(deployedContent)) {
      skipped.push(rel);
      continue;
    }

    if (deployedContent !== null) {
      // Back up before overwriting.
      if (!backupCreated) {
        fs.mkdirSync(backupRoot, { recursive: true });
        backupCreated = true;
      }
      const backupPath = path.join(backupRoot, rel);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.writeFileSync(backupPath, deployedContent);
      updated.push(rel);
    } else {
      created.push(rel);
    }

    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.writeFileSync(destAbs, rendered);
  }

  return {
    updated,
    skipped,
    created,
    backupRoot: backupCreated ? backupRoot : null
  };
}

module.exports = {
  resyncAppShellFiles,
  isShellOwned,
  renderTemplate,
  SHELL_OWNED_ROOTS,
  TEMPLATES_DIR,
};
