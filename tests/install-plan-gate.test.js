/**
 * Unit tests for the install-plan modal's approval gate.
 *
 * The renderer module is an ES module that imports browser-only globals
 * (process.arch, navigator). The gate function is exported as a pure
 * helper, so we import it via vitest's ESM-friendly import.
 */

import { describe, it, expect } from 'vitest';
import { gateEvaluation } from '../src/renderer/install-plan-modal.js';

const VALID_MANIFEST = {
  slug: 'fixture',
  runtime: { kind: 'node', arch: ['arm64', 'x86_64'] },
  permissions: {
    network: { outbound: true, inbound: false },
    filesystem: 'app-private',
    os8_capabilities: [],
    secrets: [
      { name: 'NEWS_API_KEY', required: true, pattern: '^[A-Za-z0-9]{8,}$' },
      { name: 'OPTIONAL_FLAG', required: false },
    ],
  },
};

const baseState = (overrides = {}) => ({
  secrets: {},
  review: null,
  lastStatus: null,
  secondConfirmed: false,
  ...overrides,
});

describe('install plan gate', () => {
  it('rejects when host arch is incompatible', () => {
    const state = baseState({ lastStatus: 'awaiting_approval', review: { riskLevel: 'low', findings: [] } });
    const out = gateEvaluation(VALID_MANIFEST, state, 'mips64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/arch incompatible/);
  });

  it('rejects when required secret is missing', () => {
    const state = baseState({ lastStatus: 'awaiting_approval', review: { riskLevel: 'low', findings: [] } });
    const out = gateEvaluation(VALID_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/NEWS_API_KEY required/);
  });

  it('rejects when required secret doesn\'t match pattern', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      secrets: { NEWS_API_KEY: 'short' },
    });
    const out = gateEvaluation(VALID_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/NEWS_API_KEY doesn't match/);
  });

  it('passes with valid secret + low risk + no critical findings', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      secrets: { NEWS_API_KEY: 'abcdefgh1234' },
    });
    const out = gateEvaluation(VALID_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(true);
  });

  it('rejects when status is not awaiting_approval', () => {
    const state = baseState({
      lastStatus: 'reviewing',
      review: null,
      secrets: { NEWS_API_KEY: 'abcdefgh1234' },
    });
    const out = gateEvaluation(VALID_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/review not yet complete/);
  });

  // PR 3.10 hotfix: scan results are advisory across all channels — the
  // user is the final authority. Critical findings are now an override
  // path (single confirm), not a hard block. Same for high risk.
  it('critical findings → override on first call, ok:true after secondConfirmed', () => {
    const stateBefore = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [{ severity: 'critical', description: 'a critical' }] },
      secrets: { NEWS_API_KEY: 'abcdefgh1234' },
    });
    const before = gateEvaluation(VALID_MANIFEST, stateBefore, 'arm64');
    expect(before.ok).toBe('override');
    expect(before.reason).toMatch(/critical finding/);

    const stateAfter = baseState({
      ...stateBefore,
      secondConfirmed: true,
    });
    const after = gateEvaluation(VALID_MANIFEST, stateAfter, 'arm64');
    expect(after.ok).toBe(true);
  });

  it('high-risk → override on first call, ok:true after secondConfirmed', () => {
    const stateBefore = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'high', findings: [] },
      secrets: { NEWS_API_KEY: 'abcdefgh1234' },
    });
    const before = gateEvaluation(VALID_MANIFEST, stateBefore, 'arm64');
    expect(before.ok).toBe('override');
    expect(before.reason).toMatch(/high risk/);

    const stateAfter = baseState({
      ...stateBefore,
      secondConfirmed: true,
    });
    const after = gateEvaluation(VALID_MANIFEST, stateAfter, 'arm64');
    expect(after.ok).toBe(true);
  });

  it('medium risk requires second confirm', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'medium', findings: [] },
      secrets: { NEWS_API_KEY: 'abcdefgh1234' },
    });
    const out = gateEvaluation(VALID_MANIFEST, state, 'arm64');
    expect(out.ok).toBe('override');
  });

  it('medium risk passes after secondConfirmed', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'medium', findings: [] },
      secrets: { NEWS_API_KEY: 'abcdefgh1234' },
      secondConfirmed: true,
    });
    const out = gateEvaluation(VALID_MANIFEST, state, 'arm64');
    expect(out.ok).toBe(true);
  });

  it('aarch64 host matches arm64 architecture (alias)', () => {
    const state = baseState({
      lastStatus: 'awaiting_approval',
      review: { riskLevel: 'low', findings: [] },
      secrets: { NEWS_API_KEY: 'abcdefgh1234' },
    });
    const out = gateEvaluation(VALID_MANIFEST, state, 'aarch64');
    expect(out.ok).toBe(true);
  });
});
