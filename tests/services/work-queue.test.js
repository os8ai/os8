import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { parseJobCompletion, validateJobCompletion } = require('../../src/services/work-queue-validators');
const AgentService = require('../../src/services/agent');

describe('work-queue completion parsing and validation', () => {
  let tempDir;
  let tempBlobDir;
  let originalGetPaths;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-workqueue-test-'));
    tempBlobDir = path.join(tempDir, 'blob-root');
    originalGetPaths = AgentService.getPaths;
    AgentService.getPaths = () => ({ agentDir: tempDir, agentBlobDir: tempBlobDir });
  });

  afterEach(() => {
    AgentService.getPaths = originalGetPaths;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks missing completion marker as could_not_complete', () => {
    const parsed = parseJobCompletion('I did the task.');
    expect(parsed.status).toBe('could_not_complete');
    expect(parsed.hasMarker).toBe(false);
  });

  it('parses JOB_COMPLETE marker as completed', () => {
    const parsed = parseJobCompletion('[JOB_COMPLETE: Updated files and posted summary]');
    expect(parsed.status).toBe('completed');
    expect(parsed.hasMarker).toBe(true);
    expect(parsed.notes).toContain('Updated files');
  });

  it('validates Exists check against filesystem', () => {
    const existingFile = path.join(tempBlobDir, 'current-image', 'current-image.png');
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, 'ok');

    const result = validateJobCompletion('app-1', {
      completionChecks: ['Exists: blob/current-image/current-image.png']
    }, Date.now(), { getDb: () => null });

    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails Recent File check when nothing changed this run', () => {
    const oldFile = path.join(tempBlobDir, 'current-image', 'older.png');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, 'old');

    const oldTime = new Date(Date.now() - (10 * 60 * 1000));
    fs.utimesSync(oldFile, oldTime, oldTime);

    const result = validateJobCompletion('app-1', {
      completionChecks: ['Recent File: blob/current-image']
    }, Date.now(), { getDb: () => null });

    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('was not updated during this run');
  });

  it('requires fresh portrait + POV outputs for current-image when no explicit checks exist', () => {
    const currentImageDir = path.join(tempBlobDir, 'current-image');
    fs.mkdirSync(currentImageDir, { recursive: true });
    fs.writeFileSync(path.join(currentImageDir, '2026-02-14-1000-agent.png'), 'old');
    fs.writeFileSync(path.join(currentImageDir, '2026-02-14-1000-agent-pov.png'), 'old');

    const oldTime = new Date(Date.now() - (20 * 60 * 1000));
    fs.utimesSync(path.join(currentImageDir, '2026-02-14-1000-agent.png'), oldTime, oldTime);
    fs.utimesSync(path.join(currentImageDir, '2026-02-14-1000-agent-pov.png'), oldTime, oldTime);

    const result = validateJobCompletion('app-1', {
      skill: 'current-image',
      completionChecks: []
    }, Date.now(), { getDb: () => null });

    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('No recent image files');
  });

  it('passes current-image validation when fresh portrait + POV image files are written', () => {
    const currentImageDir = path.join(tempBlobDir, 'current-image');
    fs.mkdirSync(currentImageDir, { recursive: true });
    fs.writeFileSync(path.join(currentImageDir, '2026-02-14-1007-agent.jpg'), 'new');
    fs.writeFileSync(path.join(currentImageDir, '2026-02-14-1007-agent-pov.jpg'), 'new');

    const runStartedAt = Date.now();
    const result = validateJobCompletion('app-1', {
      skill: 'current-image',
      completionChecks: []
    }, runStartedAt, { getDb: () => null });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('current-image outputs verified');
  });
});
