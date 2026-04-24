/**
 * Migration 0.3.16 — per-mode agent model override.
 *
 * Mirrors the agent_voices pattern: the agent's model pin is now scoped by
 * ai_mode ('local' vs 'proprietary'), so flipping the master Local-mode
 * toggle in Settings doesn't silently route a local-only agent through a
 * cloud family (or vice-versa), and the "other mode's" choice is remembered
 * when the user flips back.
 *
 * Backfill: for each agent with a non-null `agents.model`, infer the mode
 * from the family's container (local families live under container_id='local';
 * everything else is a cloud family) and seed the matching row in the new
 * agent_models table. The legacy `agents.model` column stays in the schema
 * but is no longer read/written by AgentService — a later cleanup migration
 * can drop it once we're confident no external tooling depends on it.
 */

module.exports = {
  version: '0.3.16',
  description: 'Per-mode agent model override (backfill from agents.model)',

  async up({ db, logger }) {
    // Create table if the schema runner hasn't already (fresh installs seed
    // via createSchema; upgraders hit this migration first on a schema that
    // lacks it). Idempotent.
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_models (
        agent_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        family_id TEXT,
        PRIMARY KEY (agent_id, mode),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );
    `);

    // Backfill — read each agent's current `model` and place it in the
    // bucket that matches its family's container.
    const rows = db.prepare(`
      SELECT a.id AS agent_id, a.model AS family_id, f.container_id
      FROM agents a
      LEFT JOIN ai_model_families f ON f.id = a.model
      WHERE a.model IS NOT NULL AND a.model != '' AND a.model != 'auto'
    `).all();

    if (rows.length === 0) {
      logger.log('[0.3.16] No agents with a pinned model — backfill skipped');
      return;
    }

    const upsert = db.prepare(`
      INSERT INTO agent_models (agent_id, mode, family_id) VALUES (?, ?, ?)
      ON CONFLICT(agent_id, mode) DO UPDATE SET family_id = excluded.family_id
    `);

    let placed = 0;
    let skipped = 0;
    for (const row of rows) {
      // An override pointing at a family that no longer exists gets dropped
      // quietly — better than resurrecting a stale pin under the wrong mode.
      if (!row.container_id) {
        skipped += 1;
        continue;
      }
      const mode = row.container_id === 'local' ? 'local' : 'proprietary';
      upsert.run(row.agent_id, mode, row.family_id);
      placed += 1;
    }

    // Once the value is safely captured in agent_models, clear the legacy
    // column so downstream reads don't silently bypass the per-mode lookup.
    // getConfig falls through to agents.model as a secondary source (for
    // pre-migration safety), so nulling here ensures the per-mode table is
    // authoritative.
    const cleared = db.prepare(
      `UPDATE agents SET model = NULL WHERE model IS NOT NULL AND model != ''`
    ).run();
    logger.log(`[0.3.16] Backfilled ${placed} agent model pin(s); skipped ${skipped} orphaned; nulled ${cleared.changes} legacy agents.model column(s)`);
  }
};
