/**
 * Phase 6 PR 6.2 — `appspec-v2.json` $schema alignment to draft 2020-12.
 *
 * Closes deferred-items #33. Until this PR, all three canonical
 * appspec-v2.json files (os8 + 2× catalog) declared draft-07 while
 * the os8dotai consumer (Phase 3.5.5 PR #14) declared 2020-12.
 * The drift was invisible to plain Ajv (default = draft-07) but
 * tripped Ajv2020 in os8dotai with `schema_invalid: no schema with
 * key or ref "http://json-schema.org/draft-07/schema#"`.
 *
 * Per the deferred-items entry the v2 schema doesn't actually use
 * any draft-07-only constructs, so the alignment is a one-line edit
 * + a validator AJV-import swap.
 *
 * What this test asserts:
 *   1. v2 schema declares draft 2020-12 (the file edit landed).
 *   2. Existing realistic v2 manifests (worldmonitor + linkding-style
 *      docker-with-volumes) still validate green.
 *   3. v1 schema declarations are untouched (v1 not actively curated).
 *   4. Ajv2020 successfully compiles both schemas under the same
 *      instance with the draft-07 metaschema registered.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const yaml = require('js-yaml');

const APPSPEC_V1_PATH = path.join(__dirname, '..', 'src', 'data', 'appspec-v1.json');
const APPSPEC_V2_PATH = path.join(__dirname, '..', 'src', 'data', 'appspec-v2.json');

describe('PR 6.2 — appspec-v2 declares draft 2020-12', () => {
  it('appspec-v2.json $schema is draft/2020-12', () => {
    const schema = JSON.parse(fs.readFileSync(APPSPEC_V2_PATH, 'utf8'));
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('appspec-v1.json $schema stays draft-07 (v1 not actively curated)', () => {
    const schema = JSON.parse(fs.readFileSync(APPSPEC_V1_PATH, 'utf8'));
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('Ajv2020 compiles v1 + v2 under one instance with draft-07 meta registered', () => {
    const v1 = JSON.parse(fs.readFileSync(APPSPEC_V1_PATH, 'utf8'));
    const v2 = JSON.parse(fs.readFileSync(APPSPEC_V2_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addMetaSchema(require('ajv/dist/refs/json-schema-draft-07.json'));
    expect(() => ajv.compile(v1)).not.toThrow();
    expect(() => ajv.compile(v2)).not.toThrow();
  });
});

describe('PR 6.2 — realistic manifests still validate under Ajv2020', () => {
  // Two manifests covering the live catalog corpus shape:
  //   1. A v2 docker manifest with runtime.volumes (post PR 5.8) — the
  //      most schema-novel construction in the catalog today.
  //   2. A v1-shaped Vite manifest like worldmonitor (the canonical
  //      Verified-channel fixture).
  //
  // Both use the validator service so the production code path is the
  // one under test, not a parallel construction.

  function freshValidator() {
    const { validateManifest, parseManifest } = require('../src/services/manifest-validator');
    return { validateManifest, parseManifest };
  }

  it('v2 docker manifest with runtime.volumes validates green', () => {
    // Mirror of os8-catalog-community/apps/linkding/manifest.yaml (PR 5.8).
    const yamlText = `
schemaVersion: 2
slug: linkding-fixture
name: Linkding
publisher: sissbruecker
upstream:
  git: https://github.com/sissbruecker/linkding.git
  ref: 7e0b7a3f4d5e6c1a2b3c4d5e6f7a8b9c0d1e2f3a
runtime:
  kind: docker
  version: "1"
  image: "docker.io/sissbruecker/linkding:1.45.0"
  image_digest: "sha256:61b2eb9eed8e5772a473fb7f1f8923e046cb8cbbeb50e88150afd5ff287d4060"
  internal_port: 9090
  arch: [arm64, x86_64]
  volumes:
    - container_path: /etc/linkding/data
      persist: true
start:
  argv: []
  port: detect
surface:
  kind: web
permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: []
legal:
  license: MIT
  commercial_use: unrestricted
review:
  channel: community
`.trim();
    const { validateManifest, parseManifest } = freshValidator();
    const manifest = parseManifest(yamlText);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('v1 Vite manifest (worldmonitor-shape) validates green under default schemaVersion=1', () => {
    const yamlText = `
schemaVersion: 1
slug: worldmonitor
name: World Monitor
publisher: koala73
upstream:
  git: https://github.com/koala73/worldmonitor.git
  ref: a1b2c3d4e5f6789012345678901234567890abcd
framework: vite
runtime:
  kind: node
  arch: [arm64, x86_64]
  package_manager: auto
  dependency_strategy: frozen
install:
  - argv: ["npm", "ci"]
start:
  argv: ["npm", "run", "dev"]
  port: detect
surface:
  kind: web
permissions:
  network:
    outbound: true
    inbound: false
  filesystem: app-private
  os8_capabilities: []
legal:
  license: MIT
  commercial_use: unrestricted
review:
  channel: verified
`.trim();
    const { validateManifest, parseManifest } = freshValidator();
    const manifest = parseManifest(yamlText);
    const r = validateManifest(manifest);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('rejects a v2 manifest missing required runtime field (proves validator is live)', () => {
    const yamlText = `
schemaVersion: 2
slug: bad
name: Bad
publisher: test
upstream:
  git: https://example.com/x.git
  ref: a1b2c3d4e5f6789012345678901234567890abcd
start:
  argv: ["true"]
  port: detect
surface:
  kind: web
permissions:
  network:
    outbound: false
    inbound: false
  filesystem: app-private
  os8_capabilities: []
legal:
  license: MIT
  commercial_use: unrestricted
review:
  channel: community
`.trim();
    const { validateManifest, parseManifest } = freshValidator();
    const manifest = parseManifest(yamlText);
    const r = validateManifest(manifest);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.kind === 'schema')).toBe(true);
  });
});
