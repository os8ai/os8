import { describe, it, expect } from 'vitest';

const DockerRuntimeAdapter = require('../../src/services/runtime-adapters/docker');

const { compactDockerPullLine } = DockerRuntimeAdapter._internal;

describe('compactDockerPullLine — Phase 4 PR 4.1', () => {
  it('compacts a Downloading progress line into "<sha>: <Status> N% (cur / tot)"', () => {
    expect(
      compactDockerPullLine('abc123def456: Downloading [===>] 12.3MB/45.6MB')
    ).toBe('abc123def456: Downloading 27% (12.3MB / 45.6MB)');
  });

  it('handles Extracting status', () => {
    expect(
      compactDockerPullLine('deadbeef0123: Extracting [==] 5.0MB/10.0MB')
    ).toBe('deadbeef0123: Extracting 50% (5.0MB / 10.0MB)');
  });

  it('handles missing progress bar', () => {
    expect(
      compactDockerPullLine('abc123def456: Downloading 1.5GB/3.0GB')
    ).toBe('abc123def456: Downloading 50% (1.5GB / 3.0GB)');
  });

  it('passes "Pull complete" through unchanged', () => {
    expect(
      compactDockerPullLine('abc123def456: Pull complete')
    ).toBe('abc123def456: Pull complete');
  });

  it('passes "Status: Downloaded newer image" through unchanged', () => {
    expect(
      compactDockerPullLine('Status: Downloaded newer image for nginx:latest')
    ).toBe('Status: Downloaded newer image for nginx:latest');
  });

  it('normalizes mixed units (KB / MB)', () => {
    // 100KB = 102400; 1MB = 1048576 → ~10%
    expect(
      compactDockerPullLine('abc123def456: Downloading 100KB/1.0MB')
    ).toMatch(/^abc123def456: Downloading 10% \(100KB \/ 1\.0MB\)$/);
  });

  it('passes empty string through unchanged', () => {
    expect(compactDockerPullLine('')).toBe('');
  });

  it('passes non-string input through unchanged', () => {
    expect(compactDockerPullLine(undefined)).toBe(undefined);
    expect(compactDockerPullLine(null)).toBe(null);
  });

  it('passes through total=0 (no division by zero)', () => {
    expect(
      compactDockerPullLine('abc123def456: Downloading 0B/0B')
    ).toBe('abc123def456: Downloading 0B/0B');
  });

  it('skips short SHA prefixes (real docker SHAs are 12+ hex)', () => {
    // 8-char prefix should not match (we require 12+).
    expect(
      compactDockerPullLine('abcd1234: Downloading 1MB/2MB')
    ).toBe('abcd1234: Downloading 1MB/2MB');
  });
});
