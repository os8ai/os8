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

// Per-backend reserve for the CLI's own request envelope (system prompt +
// tool schemas + auto-loaded instruction file). This eats into the model's
// input window before OS8's identity/memory/user-message content joins, so
// we subtract it from the user-configured budget when computing what's
// actually safe to pack.
//
// These values are FALLBACKS used when the corresponding `cli_overhead_*_tokens`
// settings row is missing (tests, headless paths, pre-migration installs).
// Migration 0.4.10 seeds matching settings rows that the user can edit in
// Settings → AI Models. `getCliOverheadTokens` reads the setting first and
// falls back here.
//
// Defaults are conservative estimates calibrated from telemetry. The
// diagnostic logging in `src/services/cli-runner.js` (look for
// `[opencode] step tokens: input=...`) is what we used to set opencode=15000;
// real overhead on AEON-7 + Gemma was ~12K once `limit.context` was wired in.
//
// openhands defaults to 18000 (slightly higher than opencode) because it
// includes a security-analyzer system prompt by default and its tool schemas
// are larger. Tune down if telemetry shows you can spare more for memory.
const CLI_OVERHEAD = {
  opencode:  15000,
  openhands: 18000,
  claude:    20000,
  gemini:    15000,
  codex:     20000,
  grok:      15000
};

const CLI_OVERHEAD_KEY_PREFIX = 'cli_overhead_';
const CLI_OVERHEAD_KEY_SUFFIX = '_tokens';

function cliOverheadKey(backendId) {
  return `${CLI_OVERHEAD_KEY_PREFIX}${backendId}${CLI_OVERHEAD_KEY_SUFFIX}`;
}

/**
 * Read the per-CLI overhead reservation in tokens.
 *
 * Resolution order:
 *   1. `settings` row at `cli_overhead_<backendId>_tokens` (user-editable in
 *      Settings → AI Models, seeded by migration 0.4.10)
 *   2. Hardcoded fallback in CLI_OVERHEAD
 *   3. 0 (when the backend isn't catalogued)
 *
 * Negative or non-numeric stored values are treated as missing. 0 is a valid
 * setting (hypothetical CLI with no envelope overhead) and passes through.
 *
 * @param {object|null} db
 * @param {string} backendId - 'opencode', 'claude', 'gemini', 'codex', 'grok'
 * @returns {number} overhead in tokens (>= 0)
 */
function getCliOverheadTokens(db, backendId) {
  if (!backendId) return 0;
  const fallback = CLI_OVERHEAD[backendId] || 0;
  if (!db) return fallback;
  const raw = SettingsService.get(db, cliOverheadKey(backendId));
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return fallback;
}

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
 * Effective context budget for OS8's portion of the prompt, after reserving
 * room for the CLI's own request envelope (system prompt + tool schemas +
 * auto-loaded instruction file).
 *
 * Behavior:
 *   - Local container (resolved family on launcher): pessimistically reserve
 *     `CLI_OVERHEAD.opencode` regardless of `resolved.backendId`. This handles
 *     the early-resolve timing problem in message-handler — `calculateContextBudgets`
 *     fires before the classifier has decided whether to dispatch through
 *     opencode, so the initial resolve carries `backendId='local'` (HTTP).
 *     We assume the agent-spawn path will fire and reserve accordingly.
 *
 *     Trade-off: vision-swap turns (which stay on HTTP local with no CLI
 *     overhead) over-reserve by ~25K. Vision turns rarely depend on deep
 *     memory, so the lost headroom is acceptable. Revisit if vision turns
 *     visibly degrade.
 *
 *   - Proprietary backends: look up `CLI_OVERHEAD[resolved.backendId]` and
 *     subtract. Tool use can push proprietary requests over the wire too,
 *     so we reserve here as well — Opus's 200K window is large enough that
 *     the 20K reserve doesn't pinch real workloads.
 *
 *   - Unknown / no resolve: pass through the full configured budget. Safe
 *     default for tests, headless paths, and pre-migration installs.
 *
 * Always clamps the floor to `MIN_TOKENS` so a misconfigured tiny budget
 * doesn't underflow.
 *
 * @param {object|null} db
 * @param {{familyId: string, backendId?: string}|null} resolved
 * @returns {number} effective token budget for OS8's portion of the prompt
 */
function getEffectiveContextBudget(db, resolved) {
  const total = getContextLimitTokens(db, resolved);
  if (!resolved) return total;

  const local = isLocalResolved(db, resolved);
  if (local) {
    const overhead = getCliOverheadTokens(db, 'opencode');
    return Math.max(MIN_TOKENS, total - overhead);
  }

  if (resolved.backendId) {
    const overhead = getCliOverheadTokens(db, resolved.backendId);
    if (overhead > 0) return Math.max(MIN_TOKENS, total - overhead);
  }
  return total;
}

/**
 * Read both budget limits and all per-CLI overhead settings as-stored
 * (with fallbacks for missing rows). Used by the API to populate the
 * Settings → AI Models panel.
 */
function getAllLimits(db) {
  const readBudget = (key, fallback) => {
    const raw = SettingsService.get(db, key);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= MIN_TOKENS ? n : fallback;
  };
  const cliOverhead = {};
  for (const backendId of Object.keys(CLI_OVERHEAD)) {
    cliOverhead[backendId] = getCliOverheadTokens(db, backendId);
  }
  return {
    localTokens: readBudget(KEY_LOCAL, FALLBACK_LOCAL),
    proprietaryTokens: readBudget(KEY_PROPRIETARY, FALLBACK_PROPRIETARY),
    cliOverhead
  };
}

/**
 * Update budget limits and/or per-CLI overhead values.
 *
 * Budget fields (localTokens, proprietaryTokens) validate to [MIN_TOKENS, MAX_TOKENS].
 * Overhead fields (cliOverhead.<backendId>) validate to [0, MAX_TOKENS] — 0 is
 * a valid overhead (a CLI with no envelope reserve). Throws on invalid input
 * so the route can return 400 before any persistence.
 */
function setLimits(db, { localTokens, proprietaryTokens, cliOverhead } = {}) {
  const validateBudget = (v, label) => {
    if (v === undefined || v === null) return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < MIN_TOKENS || n > MAX_TOKENS) {
      throw new Error(`${label} must be an integer between ${MIN_TOKENS} and ${MAX_TOKENS}`);
    }
    return n;
  };
  const validateOverhead = (v, label) => {
    if (v === undefined || v === null) return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0 || n > MAX_TOKENS) {
      throw new Error(`${label} must be an integer between 0 and ${MAX_TOKENS}`);
    }
    return n;
  };

  const local = validateBudget(localTokens, 'localTokens');
  const proprietary = validateBudget(proprietaryTokens, 'proprietaryTokens');

  // Validate ALL overhead values up-front (before any write) so an invalid
  // value in one backend doesn't leave a partial write for the others.
  const overheadWrites = {};
  if (cliOverhead && typeof cliOverhead === 'object') {
    for (const [backendId, value] of Object.entries(cliOverhead)) {
      if (!(backendId in CLI_OVERHEAD)) {
        throw new Error(`Unknown backend in cliOverhead: ${backendId}`);
      }
      const n = validateOverhead(value, `cliOverhead.${backendId}`);
      if (n !== null) overheadWrites[backendId] = n;
    }
  }

  if (local !== null) SettingsService.set(db, KEY_LOCAL, String(local));
  if (proprietary !== null) SettingsService.set(db, KEY_PROPRIETARY, String(proprietary));
  for (const [backendId, n] of Object.entries(overheadWrites)) {
    SettingsService.set(db, cliOverheadKey(backendId), String(n));
  }

  return getAllLimits(db);
}

module.exports = {
  getContextLimitTokens,
  getEffectiveContextBudget,
  getCliOverheadTokens,
  getAllLimits,
  setLimits,
  CLI_OVERHEAD,
  cliOverheadKey,
  KEY_PROPRIETARY,
  KEY_LOCAL,
  FALLBACK_PROPRIETARY,
  FALLBACK_LOCAL,
  MIN_TOKENS,
  MAX_TOKENS
};
