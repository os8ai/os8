/**
 * Tier 3A — failure-hints unit tests.
 *
 * The hint matcher must be conservative: false-negative >> false-positive.
 * Wrong hints push users toward the wrong fix. These tests are pinned to
 * stderr fragments we've actually seen during Phase 3.5.x smokes.
 */

import { describe, it, expect } from 'vitest';

const { matchHints, parseStartError } = require('../src/services/failure-hints');

describe('failure-hints — matchHints', () => {
  it('flags missing model weights from a HivisionIDPhotos-shaped error', () => {
    const stderr = `Traceback (most recent call last):
  File "/home/leo/os8/apps/.../app.py", line 23, in <module>
    raise ValueError(
ValueError: 未找到任何存在的人像分割模型，请检查 hivision/creator/weights 目录下的文件
No existing portrait segmentation model was found, please check the files in the hivision/creator/weights directory.
`;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('missing-model-weights');
    expect(hints[0].title).toMatch(/missing model files/i);
  });

  it('flags an unexpected-keyword-argument error and interpolates the kwarg name', () => {
    const stderr = `TypeError: Blocks.launch() got an unexpected keyword argument 'show_api'`;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('unexpected-kwarg');
    expect(hints[0].body).toContain("'show_api'");
  });

  it('flags ModuleNotFoundError with the missing module name', () => {
    const stderr = `ModuleNotFoundError: No module named 'gradio'`;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('module-not-found');
    expect(hints[0].body).toContain("'gradio'");
  });

  it('flags ImportError: cannot import name (library version mismatch)', () => {
    const stderr = `ImportError: cannot import name 'HfFolder' from 'huggingface_hub'`;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('cannot-import-name');
    expect(hints[0].body).toContain('huggingface_hub');
    expect(hints[0].body).toContain("'HfFolder'");
  });

  it('flags port-in-use', () => {
    const stderr = `Error: listen EADDRINUSE: address already in use 127.0.0.1:7860`;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('port-in-use');
  });

  it('flags Gradio localhost reachability error', () => {
    const stderr = `ValueError: When localhost is not accessible, a shareable link must be created. Please set share=True or check your proxy settings to allow access to localhost.`;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('localhost-not-accessible');
  });

  it('flags GPU/CUDA-required errors', () => {
    const stderr = `RuntimeError: CUDA out of memory. Tried to allocate 24.00 MiB`;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0].name).toBe('gpu-required');
  });

  it('returns nothing for an unrecognised error', () => {
    const stderr = `Some completely unfamiliar error from a custom binary nobody has seen before.`;
    expect(matchHints(stderr)).toEqual([]);
  });

  it('caps at 2 matches even when many patterns hit', () => {
    const stderr = `
      ModuleNotFoundError: No module named 'gradio'
      ImportError: cannot import name 'HfFolder' from 'huggingface_hub'
      EADDRINUSE: address already in use
      未找到任何存在的人像分割模型
    `;
    const hints = matchHints(stderr);
    expect(hints).toHaveLength(2);
  });

  it('handles non-string input gracefully', () => {
    expect(matchHints(null)).toEqual([]);
    expect(matchHints(undefined)).toEqual([]);
    expect(matchHints(0)).toEqual([]);
    expect(matchHints({})).toEqual([]);
  });
});

describe('failure-hints — parseStartError', () => {
  it('extracts code + stderrTail from a Tier-1-formatted error message', () => {
    const message = `process exited before ready code=7
--- last process output ---
ValueError: 未找到任何存在的人像分割模型，请检查 hivision/creator/weights 目录下的文件`;
    const r = parseStartError(message);
    expect(r.code).toBe(7);
    expect(r.summary).toBe('process exited before ready code=7');
    expect(r.stderrTail).toContain('ValueError');
  });

  it('returns null stderrTail when the marker is absent (legacy format)', () => {
    const message = 'process exited before ready code=1';
    const r = parseStartError(message);
    expect(r.code).toBe(1);
    expect(r.summary).toBe(message);
    expect(r.stderrTail).toBeNull();
  });

  it('handles non-string / missing input', () => {
    expect(parseStartError(null)).toEqual({ summary: '', code: null, stderrTail: null });
    expect(parseStartError(undefined)).toEqual({ summary: '', code: null, stderrTail: null });
    expect(parseStartError(42)).toEqual({ summary: '42', code: null, stderrTail: null });
  });

  it('still extracts stderrTail when code is missing', () => {
    const message = `something exploded
--- last process output ---
crash details here`;
    const r = parseStartError(message);
    expect(r.code).toBeNull();
    expect(r.stderrTail).toBe('crash details here');
  });
});
