/**
 * FileSystemService — File tree traversal, binary detection, image handling.
 *
 * All static methods, no instance state.
 */

const path = require('path');
const fs = require('fs');

const EXCLUDED_NAMES = ['.DS_Store', 'node_modules', '.git', '.next', '__pycache__', '.env'];
const MAX_FILE_SIZE = 1024 * 1024; // 1MB for text files
const MAX_IMAGE_SIZE = 25 * 1024 * 1024; // 25MB for images

const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp'
};

const TEXT_EXTENSIONS = [
  '.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.css',
  '.scss', '.yaml', '.yml', '.xml', '.svg', '.sh', '.py', '.rb', '.go',
  '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.sql', '.env', '.gitignore',
  '.prettierrc', '.eslintrc'
];

class FileSystemService {

  static isImageFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ext in IMAGE_EXTENSIONS;
  }

  static getImageMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return IMAGE_EXTENSIONS[ext] || 'application/octet-stream';
  }

  /**
   * Recursively build a file tree for a directory.
   * @param {string} dirPath - Directory to scan
   * @param {string} [basePath] - Base path for relative path computation (defaults to dirPath)
   * @returns {Array<{name, path, relativePath, type, children?}>}
   */
  static getTree(dirPath, basePath = dirPath) {
    const items = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (EXCLUDED_NAMES.includes(entry.name)) continue;

        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (entry.isDirectory()) {
          items.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            type: 'directory',
            children: this.getTree(fullPath, basePath),
          });
        } else {
          items.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            type: 'file',
          });
        }
      }
    } catch (err) {
      console.error('Error reading directory:', err);
    }

    // Sort: directories first, then files, alphabetically
    items.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });

    return items;
  }

  /**
   * Read a file with security checks, binary detection, and image handling.
   * @param {string} filePath - File to read
   * @param {string[]} allowedDirs - Directories the file must be within
   * @returns {{content?, dataUrl?, type?, error?, size?}}
   */
  static readFile(filePath, allowedDirs) {
    const resolvedPath = path.resolve(filePath);

    // Security: ensure path is within allowed directories
    const inAllowed = allowedDirs.some(dir => resolvedPath.startsWith(path.resolve(dir)));
    if (!inAllowed) {
      return { error: 'Access denied' };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { error: 'File not found' };
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) {
      return { error: 'Cannot read directory' };
    }

    // Handle image files — return as base64 data URL
    if (this.isImageFile(resolvedPath)) {
      if (stats.size > MAX_IMAGE_SIZE) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        return { error: `Image too large to preview (${sizeMB}MB, max 25MB)`, type: 'image-too-large', size: stats.size };
      }

      try {
        const buffer = fs.readFileSync(resolvedPath);
        const mimeType = this.getImageMimeType(resolvedPath);
        const base64 = buffer.toString('base64');
        return {
          type: 'image',
          dataUrl: `data:${mimeType};base64,${base64}`,
          size: stats.size
        };
      } catch (err) {
        return { error: 'Could not read image file' };
      }
    }

    if (stats.size > MAX_FILE_SIZE) {
      return { error: 'File too large to preview', size: stats.size };
    }

    // Check if binary (for non-image files)
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext) && ext !== '') {
      const buffer = Buffer.alloc(512);
      const fd = fs.openSync(resolvedPath, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
      fs.closeSync(fd);

      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) {
          return { error: 'Binary file', type: 'binary' };
        }
      }
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      return { content, size: stats.size };
    } catch (err) {
      return { error: 'Could not read file' };
    }
  }
}

module.exports = FileSystemService;
