/**
 * Claude Instructions Service
 * Manages global Claude instructions stored in the database
 */

const ClaudeInstructionsService = {
  get(db) {
    const row = db.prepare('SELECT * FROM claude_instructions WHERE id = 1').get();
    return row ? row.content : '';
  },

  set(db, content) {
    db.prepare(`
      UPDATE claude_instructions
      SET content = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run(content);
  },

  getVersion(db) {
    const row = db.prepare('SELECT version FROM claude_instructions WHERE id = 1').get();
    return row ? row.version : 0;
  }
};

module.exports = ClaudeInstructionsService;
