/**
 * Context Limits Service
 *
 * Single source of truth for "how many tokens of identity + memory + history
 * may be packed into an agent prompt". Two values, picked by the resolved
 * model family's container type:
 *
 *   - container.type === 'http' (local launcher) → context_limit_local_tokens
 *   - anything else (Claude/Gemini/GPT/Grok CLI)  → context_limit_proprietary_tokens
 *
 * The two values are stored in the `settings` table; migration 0.4.5 seeds
 * sensible defaults. UI lives at OS8 Settings → AI Models.
 */

const SettingsService = require('./settings');
const AIRegistryService = require('./ai-registry');

const KEY_PROPRIETARY = 'context_limit_proprietary_tokens';
const KEY_LOCAL = 'context_limit_local_tokens';

const FALLBACK_PROPRIETARY = 200000;
const FALLBACK_LOCAL = 60000;

const MIN_TOKENS = 1024;
const MAX_TOKENS = 1000000;

/**
 * Determine whether a resolved family points at the local launcher.
 * Returns null when we can't tell (no db, missing family/container) — caller
 * should treat null as "assume proprietary" since that's the historical default.
 */
function isLocalResolved(db, resolved) {
  if (!db || !resolved?.familyId) return null;
  const family = AIRegistryService.getFamily(db, resolved.familyId);
  if (!family) return null;
  const container = AIRegistryService.getContainer(db, family.container_id);
  if (!container) return null;
  return container.type === 'http';
}

/**
 * Get the active token budget for a resolved model family.
 * Falls back to the proprietary default when db/resolved are unavailable
 * (tests, headless paths, pre-migration installs).
 *
 * @param {object|null} db
 * @param {{familyId: string}|null} resolved - output of RoutingService.resolve()
 * @returns {number} token budget
 */
function getContextLimitTokens(db, resolved) {
  const local = isLocalResolved(db, resolved);
  if (local === null) return FALLBACK_PROPRIETARY;

  const key = local ? KEY_LOCAL : KEY_PROPRIETARY;
  const fallback = local ? FALLBACK_LOCAL : FALLBACK_PROPRIETARY;

  const raw = SettingsService.get(db, key);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= MIN_TOKENS ? n : fallback;
}

/**
 * Read both limits as-stored (with fallbacks for missing rows). Used by the API.
 */
function getAllLimits(db) {
  const readKey = (key, fallback) => {
    const raw = SettingsService.get(db, key);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= MIN_TOKENS ? n : fallback;
  };
  return {
    localTokens: readKey(KEY_LOCAL, FALLBACK_LOCAL),
    proprietaryTokens: readKey(KEY_PROPRIETARY, FALLBACK_PROPRIETARY)
  };
}

/**
 * Update one or both limits. Validates each value is an integer in
 * [MIN_TOKENS, MAX_TOKENS]; throws on invalid input so the route can return 400.
 */
function setLimits(db, { localTokens, proprietaryTokens } = {}) {
  const validate = (v, label) => {
    if (v === undefined || v === null) return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < MIN_TOKENS || n > MAX_TOKENS) {
      throw new Error(`${label} must be an integer between ${MIN_TOKENS} and ${MAX_TOKENS}`);
    }
    return n;
  };

  const local = validate(localTokens, 'localTokens');
  const proprietary = validate(proprietaryTokens, 'proprietaryTokens');

  if (local !== null) SettingsService.set(db, KEY_LOCAL, String(local));
  if (proprietary !== null) SettingsService.set(db, KEY_PROPRIETARY, String(proprietary));

  return getAllLimits(db);
}

module.exports = {
  getContextLimitTokens,
  getAllLimits,
  setLimits,
  KEY_PROPRIETARY,
  KEY_LOCAL,
  FALLBACK_PROPRIETARY,
  FALLBACK_LOCAL,
  MIN_TOKENS,
  MAX_TOKENS
};
