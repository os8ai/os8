/**
 * McpServerService — MCP server lifecycle management.
 *
 * Spawns, stops, and monitors MCP server processes.
 * Each server exposes tools that become callable via REST proxy.
 *
 * Runtime state (process handles, MCP clients, discovered tools) is kept
 * in-memory — only config and status persist in the mcp_servers table.
 *
 * Follows OS8 service conventions: static methods, db as first param.
 */

const { generateId } = require('../utils');

// Runtime state: serverId → { process, client, transport, tools[], restartAttempts }
const processes = new Map();

const MAX_RESTARTS = 3;
const RESTART_BASE_MS = 2000;
const STOP_TIMEOUT_MS = 5000;

class McpServerService {

  // ──────────────────────────────────────────────
  // CRUD
  // ──────────────────────────────────────────────

  static getAll(db) {
    const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY name').all();
    return rows.map(r => ({
      ...this._parseRow(r),
      running: processes.has(r.id) && processes.get(r.id).client != null,
      toolCount: processes.has(r.id) ? (processes.get(r.id).tools || []).length : 0
    }));
  }

  static getById(db, id) {
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...this._parseRow(row),
      running: processes.has(id) && processes.get(id).client != null,
      toolCount: processes.has(id) ? (processes.get(id).tools || []).length : 0
    };
  }

  static add(db, config) {
    const id = config.id || generateId();
    db.prepare(`
      INSERT INTO mcp_servers (id, name, description, transport, command, args, env, url, auto_start, source, catalog_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      config.name,
      config.description || '',
      config.transport || 'stdio',
      config.command || null,
      config.args ? JSON.stringify(config.args) : null,
      config.env ? JSON.stringify(config.env) : null,
      config.url || null,
      config.autoStart ? 1 : 0,
      config.source || 'local',
      config.catalogId || null
    );
    return { id };
  }

  static update(db, id, updates) {
    const fields = [];
    const values = [];
    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.command !== undefined) { fields.push('command = ?'); values.push(updates.command); }
    if (updates.args !== undefined) { fields.push('args = ?'); values.push(JSON.stringify(updates.args)); }
    if (updates.env !== undefined) { fields.push('env = ?'); values.push(JSON.stringify(updates.env)); }
    if (updates.url !== undefined) { fields.push('url = ?'); values.push(updates.url); }
    if (updates.autoStart !== undefined) { fields.push('auto_start = ?'); values.push(updates.autoStart ? 1 : 0); }
    if (fields.length === 0) return;
    values.push(id);
    db.prepare(`UPDATE mcp_servers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  static remove(db, id) {
    // Stop if running
    if (processes.has(id)) {
      this._stopProcess(id);
    }
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    // Caller should also call CapabilityService.removeMcpTools(db, id) if integrated
  }

  // ──────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────

  /**
   * Start an MCP server: spawn process, create MCP client, handshake, discover tools.
   * Returns { tools } on success.
   */
  static async start(db, id) {
    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);
    if (!server) throw new Error(`MCP server not found: ${id}`);

    // Already running?
    if (processes.has(id) && processes.get(id).client) {
      return { tools: processes.get(id).tools };
    }

    // Update status
    db.prepare("UPDATE mcp_servers SET status = 'starting', error_message = NULL WHERE id = ?").run(id);

    try {
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

      let transport;
      if (server.transport === 'stdio') {
        const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
        const args = server.args ? JSON.parse(server.args) : [];
        const serverEnv = server.env ? JSON.parse(server.env) : {};
        transport = new StdioClientTransport({
          command: server.command,
          args,
          env: { ...process.env, ...serverEnv }
        });
      } else if (server.transport === 'sse') {
        const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(new URL(server.url));
      } else {
        throw new Error(`Unsupported transport: ${server.transport}`);
      }

      const client = new Client({ name: 'os8', version: '1.0.0' });
      await client.connect(transport);

      // Discover tools
      const { tools } = await client.listTools();

      const entry = {
        client,
        transport,
        tools: tools || [],
        restartAttempts: 0
      };
      processes.set(id, entry);

      db.prepare("UPDATE mcp_servers SET status = 'running', last_started_at = datetime('now') WHERE id = ?").run(id);
      console.log(`[MCP] Started server "${server.name}" — ${(tools || []).length} tools discovered`);

      // Set up crash recovery for stdio transport
      if (server.transport === 'stdio' && transport.process) {
        transport.process.on('exit', (code) => {
          if (processes.has(id) && processes.get(id).client === client) {
            console.warn(`[MCP] Server "${server.name}" exited with code ${code}`);
            processes.delete(id);
            try {
              db.prepare("UPDATE mcp_servers SET status = 'error', error_message = ? WHERE id = ?")
                .run(`Process exited with code ${code}`, id);
            } catch (e) {
              // DB may be closed during shutdown
            }
            // Attempt restart with backoff
            this._maybeRestart(db, id, server.name);
          }
        });
      }

      return { tools: tools || [] };
    } catch (err) {
      db.prepare("UPDATE mcp_servers SET status = 'error', error_message = ? WHERE id = ?")
        .run(err.message, id);
      throw err;
    }
  }

  /**
   * Stop an MCP server.
   */
  static async stop(db, id) {
    this._stopProcess(id);
    try {
      db.prepare("UPDATE mcp_servers SET status = 'stopped', error_message = NULL WHERE id = ?").run(id);
    } catch (e) {
      // DB may be closed during shutdown
    }
  }

  /**
   * Start all servers with auto_start=1.
   */
  static async startAll(db) {
    const servers = db.prepare("SELECT id, name FROM mcp_servers WHERE auto_start = 1").all();
    for (const s of servers) {
      try {
        await this.start(db, s.id);
      } catch (e) {
        console.warn(`[MCP] Failed to auto-start "${s.name}":`, e.message);
      }
    }
  }

  /**
   * Stop all running servers.
   */
  static stopAll() {
    for (const [id] of processes) {
      this._stopProcess(id);
    }
  }

  // ──────────────────────────────────────────────
  // Tool Operations
  // ──────────────────────────────────────────────

  /**
   * Call a tool on a running MCP server.
   */
  static async callTool(serverId, toolName, args = {}) {
    const entry = processes.get(serverId);
    if (!entry || !entry.client) {
      throw new Error(`MCP server not running: ${serverId}`);
    }

    const result = await entry.client.callTool({
      name: toolName,
      arguments: args
    });

    return result;
  }

  /**
   * Get cached tools for a server (from last handshake).
   */
  static getTools(serverId) {
    const entry = processes.get(serverId);
    return entry ? entry.tools : [];
  }

  /**
   * Get runtime status for a server.
   */
  static getStatus(serverId) {
    const entry = processes.get(serverId);
    return {
      running: entry != null && entry.client != null,
      toolCount: entry ? entry.tools.length : 0
    };
  }

  // ──────────────────────────────────────────────
  // Internal
  // ──────────────────────────────────────────────

  static _stopProcess(id) {
    const entry = processes.get(id);
    if (!entry) return;

    try {
      if (entry.client) {
        entry.client.close().catch(() => {});
      }
    } catch (e) {
      // Ignore close errors
    }

    // For stdio transport, force-kill if still alive after timeout
    if (entry.transport && entry.transport.process) {
      const proc = entry.transport.process;
      if (!proc.killed) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, STOP_TIMEOUT_MS);
      }
    }

    processes.delete(id);
  }

  static _maybeRestart(db, id, name) {
    const entry = processes.get(id);
    const attempts = entry ? entry.restartAttempts : 0;

    if (attempts >= MAX_RESTARTS) {
      console.warn(`[MCP] Server "${name}" exceeded max restart attempts (${MAX_RESTARTS})`);
      return;
    }

    const delay = RESTART_BASE_MS * Math.pow(2, attempts);
    console.log(`[MCP] Scheduling restart for "${name}" in ${delay}ms (attempt ${attempts + 1}/${MAX_RESTARTS})`);

    setTimeout(async () => {
      try {
        const result = await this.start(db, id);
        console.log(`[MCP] Successfully restarted "${name}" — ${result.tools.length} tools`);
        // Update restart counter
        const newEntry = processes.get(id);
        if (newEntry) newEntry.restartAttempts = attempts + 1;
      } catch (e) {
        console.warn(`[MCP] Restart failed for "${name}":`, e.message);
        // _maybeRestart will be called again by the exit handler if applicable
      }
    }, delay);
  }

  static _parseRow(row) {
    if (!row) return null;
    return {
      ...row,
      args: row.args ? JSON.parse(row.args) : [],
      env: row.env ? JSON.parse(row.env) : {},
      autoStart: row.auto_start === 1
    };
  }
}

module.exports = McpServerService;
