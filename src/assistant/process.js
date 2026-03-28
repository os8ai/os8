const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

class AssistantProcess extends EventEmitter {
  constructor(appPath) {
    super();
    this.appPath = appPath;
    this.process = null;
    this.isReady = false;
    this.buffer = '';
    this.currentCallback = null;
    this.responseBuffer = '';
    this.isProcessingResponse = false;
  }

  start() {
    if (this.process) {
      console.log('Assistant process already running');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      // Ensure Claude Code is in PATH
      const env = { ...process.env };
      if (!env.PATH.includes('.local/bin')) {
        env.PATH = `${process.env.HOME}/.local/bin:${env.PATH}`;
      }

      // Start Claude Code in interactive mode (uses subscription)
      this.process = spawn('claude', ['--dangerously-skip-permissions'], {
        cwd: this.appPath,
        env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.emit('log', { type: 'system', text: 'Starting Claude Code...' });

      let startupBuffer = '';
      let started = false;

      const onData = (data) => {
        const text = data.toString();
        this.emit('log', { type: 'stdout', text });

        if (!started) {
          startupBuffer += text;
          // Claude Code is ready when we see the prompt or first output
          if (startupBuffer.includes('>') || startupBuffer.includes('Claude') || startupBuffer.length > 100) {
            started = true;
            this.isReady = true;
            this.emit('ready');
            this.emit('log', { type: 'system', text: 'Claude Code ready!' });
            resolve();
          }
        } else {
          // Process response
          this.handleOutput(text);
        }
      };

      this.process.stdout.on('data', onData);

      this.process.stderr.on('data', (data) => {
        const text = data.toString();
        this.emit('log', { type: 'stderr', text });
        // Some stderr is normal (progress indicators, etc.)
      });

      this.process.on('close', (code) => {
        this.emit('log', { type: 'system', text: `Claude Code exited with code ${code}` });
        this.process = null;
        this.isReady = false;
        this.emit('close', code);
      });

      this.process.on('error', (err) => {
        this.emit('log', { type: 'error', text: err.message });
        reject(err);
      });

      // Timeout for startup
      setTimeout(() => {
        if (!started) {
          started = true;
          this.isReady = true;
          this.emit('ready');
          resolve();
        }
      }, 10000);
    });
  }

  handleOutput(text) {
    // Emit each chunk for streaming display
    this.emit('stream', text);

    this.responseBuffer += text;

    // Check if response is complete (Claude shows prompt again or stops)
    // This is tricky with interactive mode - we look for the prompt pattern
    if (this.responseBuffer.includes('\n> ') || this.responseBuffer.includes('\n❯ ')) {
      // Response complete
      const response = this.responseBuffer.split(/\n[>❯] /)[0].trim();
      this.responseBuffer = '';

      if (this.currentCallback) {
        this.currentCallback(null, response);
        this.currentCallback = null;
      }
      this.emit('response', response);
    }
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.isReady) {
        reject(new Error('Assistant not ready'));
        return;
      }

      this.emit('log', { type: 'cmd', text: message });
      this.responseBuffer = '';
      this.currentCallback = (err, response) => {
        if (err) reject(err);
        else resolve(response);
      };

      // Send message to Claude Code
      this.process.stdin.write(message + '\n');

      // Timeout for response
      setTimeout(() => {
        if (this.currentCallback) {
          // Return whatever we have so far
          const partial = this.responseBuffer.trim();
          this.responseBuffer = '';
          this.currentCallback = null;
          resolve(partial || 'Response timed out');
        }
      }, 180000); // 3 minute timeout
    });
  }

  stop() {
    if (this.process) {
      this.emit('log', { type: 'system', text: 'Stopping Claude Code...' });
      this.process.stdin.write('/exit\n');
      setTimeout(() => {
        if (this.process) {
          this.process.kill();
          this.process = null;
        }
      }, 2000);
    }
    this.isReady = false;
  }

  isRunning() {
    return this.process !== null && this.isReady;
  }
}

module.exports = { AssistantProcess };
