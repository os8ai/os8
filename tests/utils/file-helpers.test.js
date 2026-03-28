import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Import the module under test
const { loadJSON, saveJSON, readFile, fileExists } = require('../../src/utils/file-helpers');

describe('file-helpers', () => {
  let tempDir;

  beforeEach(() => {
    // Create a temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os8-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadJSON', () => {
    it('should load valid JSON file', () => {
      const filePath = path.join(tempDir, 'test.json');
      fs.writeFileSync(filePath, JSON.stringify({ key: 'value' }));

      const result = loadJSON(filePath);
      expect(result).toEqual({ key: 'value' });
    });

    it('should return default value for non-existent file', () => {
      const filePath = path.join(tempDir, 'nonexistent.json');
      const defaultValue = { default: true };

      const result = loadJSON(filePath, defaultValue);
      expect(result).toEqual(defaultValue);
    });

    it('should return null when no default provided', () => {
      const filePath = path.join(tempDir, 'nonexistent.json');

      const result = loadJSON(filePath);
      expect(result).toBeNull();
    });

    it('should return default value for invalid JSON', () => {
      const filePath = path.join(tempDir, 'invalid.json');
      fs.writeFileSync(filePath, 'not valid json {{{');

      const result = loadJSON(filePath, { fallback: true });
      expect(result).toEqual({ fallback: true });
    });

    it('should handle empty file', () => {
      const filePath = path.join(tempDir, 'empty.json');
      fs.writeFileSync(filePath, '');

      const result = loadJSON(filePath, { empty: true });
      expect(result).toEqual({ empty: true });
    });

    it('should load nested JSON structures', () => {
      const filePath = path.join(tempDir, 'nested.json');
      const nested = {
        level1: {
          level2: {
            level3: ['a', 'b', 'c']
          }
        }
      };
      fs.writeFileSync(filePath, JSON.stringify(nested));

      const result = loadJSON(filePath);
      expect(result).toEqual(nested);
    });

    it('should load arrays', () => {
      const filePath = path.join(tempDir, 'array.json');
      fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]));

      const result = loadJSON(filePath);
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('saveJSON', () => {
    it('should save JSON to file', () => {
      const filePath = path.join(tempDir, 'save.json');
      const data = { saved: true, count: 42 };

      saveJSON(filePath, data);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual(data);
    });

    it('should create directory when createDir option is true', () => {
      const filePath = path.join(tempDir, 'subdir', 'nested', 'save.json');
      const data = { nested: true };

      saveJSON(filePath, data, { createDir: true });

      expect(fs.existsSync(filePath)).toBe(true);
      expect(loadJSON(filePath)).toEqual(data);
    });

    it('should fail when directory does not exist and createDir is false', () => {
      const filePath = path.join(tempDir, 'nodir', 'save.json');
      const data = { nested: true };

      const result = saveJSON(filePath, data);

      expect(result).toBe(false);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should overwrite existing file', () => {
      const filePath = path.join(tempDir, 'overwrite.json');
      fs.writeFileSync(filePath, JSON.stringify({ old: true }));

      saveJSON(filePath, { new: true });

      expect(loadJSON(filePath)).toEqual({ new: true });
    });

    it('should format JSON with 2-space indentation', () => {
      const filePath = path.join(tempDir, 'formatted.json');
      saveJSON(filePath, { a: 1 });

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toBe('{\n  "a": 1\n}');
    });
  });

  describe('readFile', () => {
    it('should read file contents', () => {
      const filePath = path.join(tempDir, 'readme.txt');
      fs.writeFileSync(filePath, 'Hello, World!');

      const result = readFile(filePath);
      expect(result).toBe('Hello, World!');
    });

    it('should return default value for non-existent file', () => {
      const filePath = path.join(tempDir, 'nonexistent.txt');

      const result = readFile(filePath, 'default content');
      expect(result).toBe('default content');
    });

    it('should return empty string as default when no default provided', () => {
      const filePath = path.join(tempDir, 'nonexistent.txt');

      const result = readFile(filePath);
      expect(result).toBe('');
    });

    it('should handle UTF-8 content', () => {
      const filePath = path.join(tempDir, 'utf8.txt');
      const content = 'Unicode: 日本語 émojis 🎉';
      fs.writeFileSync(filePath, content, 'utf-8');

      const result = readFile(filePath);
      expect(result).toBe(content);
    });
  });

  describe('fileExists', () => {
    it('should return true for existing file', () => {
      const filePath = path.join(tempDir, 'exists.txt');
      fs.writeFileSync(filePath, 'content');

      expect(fileExists(filePath)).toBe(true);
    });

    it('should return false for non-existent file', () => {
      const filePath = path.join(tempDir, 'does-not-exist.txt');

      expect(fileExists(filePath)).toBe(false);
    });

    it('should return true for existing directory', () => {
      const dirPath = path.join(tempDir, 'subdir');
      fs.mkdirSync(dirPath);

      expect(fileExists(dirPath)).toBe(true);
    });
  });
});
