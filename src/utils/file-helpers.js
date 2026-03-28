/**
 * File utility helpers for OS8
 *
 * Provides consistent JSON file operations with proper error handling.
 * Replaces scattered JSON.parse(fs.readFileSync(...)) patterns.
 */

const fs = require('fs');
const path = require('path');

/**
 * Load and parse a JSON file
 * @param {string} filePath - Absolute path to the JSON file
 * @param {*} defaultValue - Value to return if file doesn't exist or parsing fails (default: null)
 * @param {Object} options - Options
 * @param {boolean} options.silent - If true, suppress error logging (default: false)
 * @returns {*} Parsed JSON content or defaultValue
 */
function loadJSON(filePath, defaultValue = null, options = {}) {
  const { silent = false } = options;

  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    if (!silent) {
      console.error(`Failed to load JSON from ${filePath}:`, err.message);
    }
    return defaultValue;
  }
}

/**
 * Save data as JSON to a file
 * @param {string} filePath - Absolute path to the JSON file
 * @param {*} data - Data to serialize and write
 * @param {Object} options - Options
 * @param {number} options.indent - JSON indentation (default: 2)
 * @param {boolean} options.createDir - Create parent directories if needed (default: false)
 * @returns {boolean} True if successful, false otherwise
 */
function saveJSON(filePath, data, options = {}) {
  const { indent = 2, createDir = false } = options;

  try {
    if (createDir) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(data, null, indent));
    return true;
  } catch (err) {
    console.error(`Failed to save JSON to ${filePath}:`, err.message);
    return false;
  }
}

/**
 * Check if a file exists
 * @param {string} filePath - Path to check
 * @returns {boolean} True if file exists
 */
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

/**
 * Read a text file safely
 * @param {string} filePath - Absolute path to the file
 * @param {string} defaultValue - Value to return if file doesn't exist (default: '')
 * @returns {string} File content or defaultValue
 */
function readFile(filePath, defaultValue = '') {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }

  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`Failed to read file ${filePath}:`, err.message);
    return defaultValue;
  }
}

/**
 * Write content to a text file
 * @param {string} filePath - Absolute path to the file
 * @param {string} content - Content to write
 * @param {Object} options - Options
 * @param {boolean} options.createDir - Create parent directories if needed (default: false)
 * @returns {boolean} True if successful, false otherwise
 */
function writeFile(filePath, content, options = {}) {
  const { createDir = false } = options;

  try {
    if (createDir) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    fs.writeFileSync(filePath, content);
    return true;
  } catch (err) {
    console.error(`Failed to write file ${filePath}:`, err.message);
    return false;
  }
}

module.exports = {
  loadJSON,
  saveJSON,
  fileExists,
  readFile,
  writeFile
};
