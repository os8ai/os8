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

const SCHEMA_V1 = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'appspec-v1.json'), 'utf8')
);
const SCHEMA_V2 = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'appspec-v2.json'), 'utf8')
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchemaV1 = ajv.compile(SCHEMA_V1);
const validateSchemaV2 = ajv.compile(SCHEMA_V2);

// Back-compat alias used by existing tests / external callers.
const SCHEMA = SCHEMA_V1;
const validateSchema = validateSchemaV1;

const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SHA_RE  = /^[0-9a-f]{40}$/;

function pickValidator(manifest) {
  return manifest?.schemaVersion === 2 ? validateSchemaV2 : validateSchemaV1;
}

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

  const validate = pickValidator(manifest);
  if (!validate(manifest)) {
    for (const e of validate.errors || []) {
      errors.push({
        kind: 'schema',
        path: e.instancePath || e.schemaPath || '/',
        message: `${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`,
      });
    }
  }

  // Schema-version-conditional invariants.
  // v1 rejects docker entirely; v2 un-rejects it (PR 2.5).
  // Catch the case where the schema picker fell through to v1 because
  // schemaVersion was missing or invalid AND the manifest tried to use docker.
  if (manifest?.runtime?.kind === 'docker' && manifest?.schemaVersion !== 2) {
    errors.push({ kind: 'invariant', path: '/runtime/kind', message: 'docker runtime requires schemaVersion: 2' });
  }

  // Phase 5 PR 5.8 — runtime.volumes invariants beyond what JSON Schema
  // can express. The schema's regex on container_path already rejects
  // `..` and any non-`/[a-zA-Z0-9_/-]` chars; the additional checks here
  // catch duplicate container_path entries (two items with the same
  // mount target — either a typo or a sneaky aliasing attempt).
  const volumes = manifest?.runtime?.volumes;
  if (Array.isArray(volumes)) {
    const seen = new Set();
    volumes.forEach((vol, i) => {
      const cp = vol?.container_path;
      if (typeof cp !== 'string') return;   // schema catches it
      if (seen.has(cp)) {
        errors.push({
          kind: 'invariant',
          path: `/runtime/volumes/${i}/container_path`,
          message: `duplicate container_path: ${cp}`,
        });
      }
      seen.add(cp);
    });
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
  // that's missing the required `dependency_strategy: frozen`. Docker
  // manifests bypass the dependency_strategy gate (the image digest is the
  // equivalent supply-chain pin).
  if (manifest?.review?.channel === 'verified' && manifest?.runtime?.kind !== 'docker') {
    if (manifest?.runtime?.dependency_strategy !== 'frozen') {
      errors.push({
        kind: 'invariant',
        path: '/runtime/dependency_strategy',
        message: 'verified channel requires dependency_strategy: frozen',
      });
    }
  }
  // PR 2.5: docker manifests in Verified channel must pin by digest.
  if (manifest?.review?.channel === 'verified'
      && manifest?.runtime?.kind === 'docker'
      && !manifest?.runtime?.image_digest) {
    errors.push({
      kind: 'invariant',
      path: '/runtime/image_digest',
      message: 'verified channel: docker manifest must pin image by digest (image_digest field)',
    });
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { parseManifest, validateManifest, SLUG_RE, SHA_RE };
