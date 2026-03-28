const chokidar = require('chokidar');
const path = require('path');

class MemoryWatcher {
  constructor(memoryService, appPath, options = {}) {
    this.memory = memoryService;
    this.appPath = appPath;
    this.watcher = null;
    this.debounceMs = options.debounceMs || 1500;
    this.debounceTimer = null;
    this.pendingFiles = new Set();
    this.onLog = options.onLog || console.log;
    this.onError = options.onError || console.error;
    this.isRunning = false;
    this.lastError = null;
  }

  start() {
    if (this.isRunning) return;

    const watchPaths = [
      path.join(this.appPath, 'MYSELF.md'),
      path.join(this.appPath, 'USER.md')
    ];

    try {
      this.watcher = chokidar.watch(watchPaths, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500 },
        persistent: true
      });

      this.watcher.on('change', (filePath) => this.queueReindex(filePath, 'change'));
      this.watcher.on('add', (filePath) => this.queueReindex(filePath, 'add'));
      this.watcher.on('unlink', (filePath) => this.handleDelete(filePath));

      this.watcher.on('error', (error) => {
        this.lastError = error;
        this.onError(`Watcher error: ${error.message}`);
        // Don't crash - manual reindex is still available
      });

      this.isRunning = true;
      this.lastError = null;
      this.onLog('Memory watcher started');
    } catch (err) {
      this.lastError = err;
      this.onError(`Failed to start watcher: ${err.message}`);
    }
  }

  queueReindex(filePath, event) {
    // Only watch markdown files
    if (!filePath.endsWith('.md')) return;

    this.onLog(`File ${event}: ${path.basename(filePath)}`);
    this.pendingFiles.add(filePath);

    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.processPending(), this.debounceMs);
  }

  async processPending() {
    const files = [...this.pendingFiles];
    this.pendingFiles.clear();

    for (const file of files) {
      try {
        await this.memory.indexFile(file);
        this.onLog(`Reindexed: ${path.basename(file)}`);
      } catch (err) {
        this.onError(`Failed to index ${file}: ${err.message}`);
      }
    }
  }

  async handleDelete(filePath) {
    try {
      this.memory.removeSource(filePath);
      this.onLog(`Removed from index: ${path.basename(filePath)}`);
    } catch (err) {
      this.onError(`Failed to remove ${filePath}: ${err.message}`);
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    clearTimeout(this.debounceTimer);
    this.isRunning = false;
    this.onLog('Memory watcher stopped');
  }

  getStatus() {
    return {
      running: this.isRunning,
      pendingFiles: this.pendingFiles.size,
      lastError: this.lastError?.message || null
    };
  }
}

module.exports = { MemoryWatcher };
