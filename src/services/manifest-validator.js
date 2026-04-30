/**
 * Manifest validator — mechanical AppSpec v1 checks.
 *
 * Spec §3 + §3.5. Validates a parsed manifest against the bundled
 * JSON Schema (src/data/appspec-v1.json) plus the v1 invariants the
 * schema can't fully express (catalog-side checks done in CI; we
 * re-do them here for defense-in-depth).
 *
 * Two error kinds: 'schema' (manifest violates JSON Schema) and
 * 'invariant' (v1 invariants — docker rejected, surface=web only,
 * filesystem=app-private only, slug regex, no shell strings).
 *
 * The yaml parser uses js-yaml's safe `load`, never `loadAll`.
 *
 * NB: src/data/appspec-v1.json is a desktop copy of the canonical
 * schema in os8ai/os8-catalog/schema/appspec-v1.json (Phase 0 PR 0.1).
 * When that ships, replace this copy verbatim.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const yaml = require('js-yaml');
const path = require('path');
const fs = require('fs');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'appspec-v1.json'), 'utf8')
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(SCHEMA);

const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SHA_RE  = /^[0-9a-f]{40}$/;

function parseManifest(yamlText) {
  const obj = yaml.load(yamlText);
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('manifest is not an object');
  }
  return obj;
}

/**
 * Validate a parsed manifest object.
 *
 * @param {object} manifest - parsed YAML
 * @param {object} [opts]
 * @param {string} [opts.upstreamResolvedCommit] - if provided, must be a
 *   40-char SHA. The catalog sync resolves tags → SHAs at sync time.
 * @returns {{ ok: boolean, errors: Array<{kind: 'schema'|'invariant', path: string, message: string}> }}
 */
function validateManifest(manifest, { upstreamResolvedCommit } = {}) {
  const errors = [];

  if (!validateSchema(manifest)) {
    for (const e of validateSchema.errors || []) {
      errors.push({
        kind: 'schema',
        path: e.instancePath || e.schemaPath || '/',
        message: `${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`,
      });
    }
  }

  // V1 invariants — duplicate the schema where the schema already covers,
  // because manifests with a different schemaVersion may slip past.
  if (manifest?.runtime?.kind === 'docker') {
    errors.push({ kind: 'invariant', path: '/runtime/kind', message: 'docker runtime not supported in v1' });
  }
  if (manifest?.surface && manifest.surface.kind !== 'web') {
    errors.push({ kind: 'invariant', path: '/surface/kind', message: 'only surface.kind=web supported in v1' });
  }
  if (manifest?.permissions && manifest.permissions.filesystem !== 'app-private') {
    errors.push({ kind: 'invariant', path: '/permissions/filesystem', message: 'only filesystem=app-private supported in v1' });
  }
  if (typeof manifest?.slug === 'string' && !SLUG_RE.test(manifest.slug)) {
    errors.push({ kind: 'invariant', path: '/slug', message: 'slug must match ^[a-z][a-z0-9-]{1,39}$' });
  }
  if (upstreamResolvedCommit !== undefined && !SHA_RE.test(upstreamResolvedCommit)) {
    errors.push({
      kind: 'invariant',
      path: '/upstream/ref',
      message: 'upstream resolved commit must be a 40-char hex SHA (resolution by sync)',
    });
  }

  // Defensive shell-string check. The schema constrains command shapes, but
  // belt-and-suspenders: argv arrays only, no `shell: true`.
  for (const key of ['install', 'postInstall', 'preStart']) {
    const list = manifest?.[key];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const cmd = list[i];
      if (cmd?.shell === true) {
        errors.push({ kind: 'invariant', path: `/${key}/${i}/shell`, message: 'shell:true not allowed' });
      }
      if (!Array.isArray(cmd?.argv)) {
        errors.push({ kind: 'invariant', path: `/${key}/${i}/argv`, message: 'argv array required' });
      }
    }
  }
  if (manifest?.start?.shell === true) {
    errors.push({ kind: 'invariant', path: '/start/shell', message: 'shell:true not allowed' });
  }
  if (manifest?.start && !Array.isArray(manifest.start.argv)) {
    errors.push({ kind: 'invariant', path: '/start/argv', message: 'start.argv array required' });
  }

  // Verified channel gates beyond what CI enforces locally — strictly speaking,
  // these are also checked by os8ai/os8-catalog's lockfile-gate.yml CI, but
  // catching them here lets the desktop refuse to install a Verified manifest
  // that's missing the required `dependency_strategy: frozen`.
  if (manifest?.review?.channel === 'verified') {
    if (manifest?.runtime?.dependency_strategy !== 'frozen') {
      errors.push({
        kind: 'invariant',
        path: '/runtime/dependency_strategy',
        message: 'verified channel requires dependency_strategy: frozen',
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { parseManifest, validateManifest, SLUG_RE, SHA_RE };
