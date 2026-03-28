# OpenAI TTS Phase 3: Voice Persistence & Agent Schema

## Context

Currently, `agents.voice_id` / `voice_name` stores the active voice — but there's no memory of what voice an agent had with a previous provider. When the user switches from ElevenLabs to OpenAI (or back), all agents lose their voice selections and get defaults.

**Goal:** Create an `agent_voices` table that remembers each agent's voice per provider. When the global provider switches, save current voices → restore saved voices (or gender defaults).

**Constraint:** `agents.voice_id` / `voice_name` remain the active voice columns — all existing callers work unchanged. The new table is a persistence layer behind the scenes.

---

## Step 1: Add `agent_voices` table to schema

**File: `src/db/schema.js`**

Add after the `agents` table creation:

```sql
CREATE TABLE IF NOT EXISTS agent_voices (
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  voice_id TEXT,
  voice_name TEXT,
  PRIMARY KEY (agent_id, provider),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
```

This is safe to add — `CREATE TABLE IF NOT EXISTS` won't break existing databases.

---

## Step 2: Backfill existing agent voices in seeds

**File: `src/db/seeds.js`**

After existing seed statements, add a migration block:

```js
// Phase 3: Backfill agent_voices for existing agents with voice selections
// For each agent that has a voice_id set, save it as an elevenlabs voice
// (since before Phase 1, ElevenLabs was the only provider)
const agentsWithVoice = db.prepare(
  `SELECT id, voice_id, voice_name FROM agents WHERE voice_id IS NOT NULL`
).all()

for (const agent of agentsWithVoice) {
  db.prepare(`
    INSERT OR IGNORE INTO agent_voices (agent_id, provider, voice_id, voice_name)
    VALUES (?, 'elevenlabs', ?, ?)
  `).run(agent.id, agent.voice_id, agent.voice_name)
}
```

**Why `INSERT OR IGNORE`:** If the seed runs again on an already-migrated DB, the PK constraint prevents duplicates. No data loss.

---

## Step 3: Add persistence helpers to TTSService

**File: `src/services/tts.js`**

Add three new methods:

### 3a: `saveAgentVoice(db, agentId, provider, voiceId, voiceName)`

Upserts a voice selection into `agent_voices` for the given provider.

```js
function saveAgentVoice(db, agentId, provider, voiceId, voiceName) {
  db.prepare(`
    INSERT INTO agent_voices (agent_id, provider, voice_id, voice_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id, provider) DO UPDATE SET voice_id = ?, voice_name = ?
  `).run(agentId, provider, voiceId, voiceName, voiceId, voiceName)
}
```

### 3b: `getAgentVoice(db, agentId, provider)`

Retrieves saved voice for a specific provider. Returns `{ voiceId, voiceName }` or `null`.

```js
function getAgentVoice(db, agentId, provider) {
  const row = db.prepare(
    `SELECT voice_id, voice_name FROM agent_voices WHERE agent_id = ? AND provider = ?`
  ).get(agentId, provider)
  if (!row) return null
  return { voiceId: row.voice_id, voiceName: row.voice_name }
}
```

### 3c: `switchProvider(db, toProvider)`

The core logic — saves all current agent voices for the outgoing provider, then restores saved voices for the incoming provider (or sets gender defaults).

```js
function switchProvider(db, toProvider) {
  const fromProvider = getProviderName(db)

  // Get all agents (not just ones with voice set — we want to set defaults too)
  const AgentService = require('./agent')
  const agents = db.prepare(`SELECT id, voice_id, voice_name, gender FROM agents`).all()

  const transaction = db.transaction(() => {
    for (const agent of agents) {
      // 1. Save current voice for outgoing provider (if agent has one)
      if (fromProvider && agent.voice_id) {
        saveAgentVoice(db, agent.id, fromProvider, agent.voice_id, agent.voice_name)
      }

      // 2. Restore saved voice for incoming provider, or use gender default
      const saved = getAgentVoice(db, agent.id, toProvider)
      if (saved) {
        AgentService.update(db, agent.id, {
          voice_id: saved.voiceId,
          voice_name: saved.voiceName
        })
      } else {
        // No saved voice — set gender default for the new provider
        const defaults = getProviderDefaults(toProvider)
        if (defaults) {
          const gender = agent.gender || 'female'
          const defaultVoice = defaults[gender] || defaults.female
          AgentService.update(db, agent.id, {
            voice_id: defaultVoice.id,
            voice_name: defaultVoice.name
          })
        }
      }
    }

    // 3. Update the global provider setting
    setProvider(db, toProvider)
  })

  transaction()

  return {
    previousProvider: fromProvider,
    newProvider: toProvider,
    agentCount: agents.length
  }
}
```

**Why a transaction:** All agent updates + setting change must be atomic. If any step fails, nothing changes.

**Export** all three new functions alongside existing exports.

---

## Step 4: Upsert `agent_voices` on voice selection

**File: `src/routes/agents.js`**

When a user picks a voice for an agent (via `PATCH /api/agents/:id`), the voice should be saved to both the active columns AND `agent_voices` for the current provider.

In the PATCH handler, after `AgentService.updateConfig()` is called, add:

```js
// If voice was updated, also save to agent_voices for current provider
if (configUpdates.voiceId !== undefined) {
  const currentProvider = TTSService.getProviderName(db)
  if (currentProvider) {
    TTSService.saveAgentVoice(
      db, agent.id, currentProvider,
      configUpdates.voiceId, configUpdates.voiceName || null
    )
  }
}
```

**Location:** After line ~289 where `AgentService.updateConfig(db, agent.id, configUpdates)` is called, before the response is sent.

**Imports needed:** `TTSService` — check if already imported at top of file.

---

## Step 5: Verification

### 5a: Startup test
```bash
npm start   # Verify OS8 starts, agent_voices table created
```

### 5b: Schema check
- Open DB, verify `agent_voices` table exists with correct schema
- Verify backfill: agents that had ElevenLabs voices should have rows in `agent_voices`

### 5c: Voice selection persistence
- Set provider to ElevenLabs
- Pick a voice for an agent → verify row in `agent_voices (agent_id, 'elevenlabs', ...)`
- Switch to OpenAI → agent gets default OpenAI voice (nova/echo based on gender)
- Pick a different OpenAI voice → verify row in `agent_voices (agent_id, 'openai', ...)`
- Switch back to ElevenLabs → original ElevenLabs voice restored

### 5d: Edge cases
- Agent with no voice set → gets gender default on provider switch
- Multiple agents → each gets independent voice restoration
- Switch to same provider (no-op) → voices unchanged
- New agent created after switch → no `agent_voices` row yet, uses whatever voice is set during setup

### 5e: Tests
```bash
npm test   # All existing tests pass
```

---

## Files Summary

| Action | File | Scope |
|--------|------|-------|
| Modify | `src/db/schema.js` | Add `agent_voices` table |
| Modify | `src/db/seeds.js` | Backfill existing agent voices as ElevenLabs |
| Modify | `src/services/tts.js` | Add `switchProvider()`, `saveAgentVoice()`, `getAgentVoice()` |
| Modify | `src/routes/agents.js` | Upsert `agent_voices` on voice selection |

No client-side changes — Phase 4 will add the UI for provider switching and voice pickers.

---

## Execution Order

```
Step 1 (schema) → Step 2 (backfill) → Step 3 (TTSService methods) → Step 4 (route upsert) → Step 5 (verify)
```

Steps 1-2 are schema/data. Steps 3-4 are code. All sequential — each builds on the previous.
