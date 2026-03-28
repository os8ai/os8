/**
 * Life items CRUD and life entry queries for agent simulation.
 * Extracted from sim.js — manages outfits, settings, hairstyles, and life entries.
 */

const { generateId } = require('../utils');

/**
 * Get life items for an agent, optionally filtered by type
 * @param {object} db
 * @param {string} agentId
 * @param {string} [type] - 'outfit', 'setting', or 'hairstyle'
 * @returns {Array}
 */
function getLifeItems(db, agentId, type = null) {
  let sql = 'SELECT * FROM agent_life_items WHERE agent_id = ?';
  const params = [agentId];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' ORDER BY type, display_order';
  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : []
  }));
}

/**
 * Create a life item
 * @param {object} db
 * @param {string} agentId
 * @param {object} item
 * @returns {object}
 */
function createLifeItem(db, agentId, { type, name, description, panoramic, scene_prompt, tags, isDefault }) {
  const id = generateId();
  db.prepare(`
    INSERT INTO agent_life_items (id, agent_id, type, name, description, panoramic, scene_prompt, tags, is_default, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(display_order), -1) + 1 FROM agent_life_items WHERE agent_id = ? AND type = ?))
  `).run(id, agentId, type, name, description, panoramic || null, scene_prompt || null,
    tags ? JSON.stringify(tags) : null, isDefault ? 1 : 0, agentId, type);

  return db.prepare('SELECT * FROM agent_life_items WHERE id = ?').get(id);
}

/**
 * Update a life item
 * @param {object} db
 * @param {string} itemId
 * @param {object} updates
 * @returns {object|null}
 */
function updateLifeItem(db, itemId, updates) {
  const fields = [];
  const values = [];
  const allowed = ['name', 'description', 'panoramic', 'scene_prompt', 'tags', 'is_default', 'display_order'];

  for (const [key, value] of Object.entries(updates)) {
    if (allowed.includes(key) && value !== undefined) {
      fields.push(`${key} = ?`);
      if (key === 'tags') {
        values.push(JSON.stringify(value));
      } else {
        values.push(value);
      }
    }
  }

  if (fields.length === 0) return null;
  values.push(itemId);
  db.prepare(`UPDATE agent_life_items SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return db.prepare('SELECT * FROM agent_life_items WHERE id = ?').get(itemId);
}

/**
 * Delete a life item
 * @param {object} db
 * @param {string} itemId
 */
function deleteLifeItem(db, itemId) {
  db.prepare('DELETE FROM agent_life_items WHERE id = ?').run(itemId);
}

/**
 * Seed default life items for a new agent
 * @param {object} db
 * @param {string} agentId
 * @param {string} role - Agent role
 * @param {string} gender - Agent gender
 */
function seedDefaultLifeItems(db, agentId, role = '', gender = 'female') {
  // Check if already seeded
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM agent_life_items WHERE agent_id = ?').get(agentId);
  if (existing.cnt > 0) return;

  const items = [];

  // Outfits (role-aware)
  if (gender === 'male') {
    items.push({ type: 'outfit', name: 'Professional', description: 'Fitted navy button-down shirt, dark charcoal slacks, brown leather belt, oxford shoes', tags: ['work', 'professional'] });
    items.push({ type: 'outfit', name: 'Casual', description: 'Soft heather grey t-shirt, dark wash jeans, white sneakers', tags: ['casual', 'relaxed'] });
    items.push({ type: 'outfit', name: 'Athleisure', description: 'Black performance quarter-zip, joggers, running shoes', tags: ['active', 'comfortable'] });
  } else {
    items.push({ type: 'outfit', name: 'Professional', description: 'Fitted blazer over a silk camisole, tailored trousers, pointed-toe flats', tags: ['work', 'professional'], isDefault: true });
    items.push({ type: 'outfit', name: 'Casual', description: 'Oversized cream knit sweater, high-waisted jeans, barefoot at home', tags: ['casual', 'relaxed'] });
    items.push({ type: 'outfit', name: 'Cozy evening', description: 'Soft ribbed tank top, cotton sleep shorts, fuzzy socks', tags: ['evening', 'comfortable'] });
    items.push({ type: 'outfit', name: 'Active', description: 'Sports bra and fitted tank, high-waisted leggings, running shoes', tags: ['active', 'workout'] });
  }

  // Settings
  items.push({
    type: 'setting', name: 'Home office',
    description: 'Desk with monitor, laptop, and coffee mug. Window with natural light. Bookshelf on the wall.',
    panoramic: 'Left: bookshelf with personal items, framed photos. Center: walnut desk with dual monitors, laptop, desk lamp, coffee mug. Right: window overlooking trees, afternoon light streaming in.',
    scene_prompt: 'Cozy home office, walnut desk with dual monitors, warm desk lamp glow, bookshelf with personal items, natural afternoon light through window overlooking trees, soft warm tones',
    tags: ['work', 'indoor'], isDefault: true
  });
  items.push({
    type: 'setting', name: 'Living room',
    description: 'Comfortable sofa with throw pillows, coffee table with books, TV on the wall, warm ambient lighting.',
    panoramic: 'Left: entryway and coat hooks. Center: deep grey sectional sofa with throw blankets, glass coffee table, wall-mounted TV. Right: floor lamp, window with sheer curtains, potted plant.',
    scene_prompt: 'Open living room, deep grey sectional sofa with throw blankets, glass coffee table, warm pendant lighting, sheer curtains filtering soft light, potted plant in corner',
    tags: ['relaxation', 'indoor']
  });
  items.push({
    type: 'setting', name: 'Kitchen',
    description: 'Modern kitchen with white countertops, stovetop, coffee maker, morning light through the window.',
    panoramic: 'Left: refrigerator, pantry shelving. Center: kitchen island with barstools, coffee maker, fruit bowl. Right: stove, oven, window above the sink with herb pots.',
    scene_prompt: 'Modern kitchen, white countertops, kitchen island with barstools, coffee maker and fruit bowl, morning light through window above sink, herb pots on sill, clean bright space',
    tags: ['cooking', 'indoor']
  });

  // Hairstyles
  if (gender === 'male') {
    items.push({ type: 'hairstyle', name: 'Neat', description: 'Clean side-parted style, neatly combed', tags: ['professional'], isDefault: true });
    items.push({ type: 'hairstyle', name: 'Casual', description: 'Slightly tousled, natural texture', tags: ['casual'] });
  } else {
    items.push({ type: 'hairstyle', name: 'Loose waves', description: 'Hair down with soft loose waves, past shoulders', tags: ['casual', 'default'], isDefault: true });
    items.push({ type: 'hairstyle', name: 'Low ponytail', description: 'Hair pulled back in a low, relaxed ponytail', tags: ['work', 'active'] });
    items.push({ type: 'hairstyle', name: 'Messy bun', description: 'High messy bun with a few face-framing strands loose', tags: ['casual', 'cozy'] });
  }

  const stmt = db.prepare(`
    INSERT INTO agent_life_items (id, agent_id, type, name, description, panoramic, scene_prompt, tags, is_default, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let orderByType = {};
  for (const item of items) {
    const typeOrder = orderByType[item.type] || 0;
    stmt.run(
      generateId(), agentId, item.type, item.name, item.description,
      item.panoramic || null, item.scene_prompt || null,
      item.tags ? JSON.stringify(item.tags) : null,
      item.isDefault ? 1 : 0, typeOrder
    );
    orderByType[item.type] = typeOrder + 1;
  }

  console.log(`[SimService] Seeded ${items.length} default life items for agent ${agentId}`);
}

/**
 * Get the latest life entry for an agent
 * @param {object} db
 * @param {string} agentId
 * @returns {object|null}
 */
function getLatestLifeEntry(db, agentId) {
  const row = db.prepare(`
    SELECT * FROM agent_life_entries
    WHERE agent_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(agentId);
  if (!row) return null;
  return {
    ...row,
    reflections: row.reflections ? JSON.parse(row.reflections) : null
  };
}

module.exports = {
  getLifeItems,
  createLifeItem,
  updateLifeItem,
  deleteLifeItem,
  seedDefaultLifeItems,
  getLatestLifeEntry
};
