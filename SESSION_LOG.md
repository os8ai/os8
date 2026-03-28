# Session Log — 2026-03-20

## Changes

### 1. Add Telegram group chat support (commit `739f0e2`)
- **Files:** `src/assistant/telegram-watcher.js`, `src/server-telegram.js`, `src/services/thread-orchestrator.js`, `src/services/agent.js`, `src/db/schema.js`, `src/db/seeds.js`, `src/templates/assistant/src/components/SetupScreen.jsx`, deployed copy
- **Problem:** Telegram groups with multiple agent bots were silent — watchers dropped all non-private messages ("Phase 2" placeholder)
- **Solution:** Route Telegram group messages through the same ThreadOrchestrator + ModeratorService pipeline as OS8 in-app group chats
- **TelegramWatcher:** Added `onGroupMessage` callback, `ownerUserId` tracking, group/supergroup detection. Filters out non-owner and bot messages
- **Central group handler** (`handleTelegramGroupMessage` in `server-telegram.js`): Cross-bot dedup by message_id, auto-creates `telegram_groups` + `agent_threads` on first message, progressive agent discovery (each watcher registers itself), memory recording for all agents with labeled speaker names, dispatches to ThreadOrchestrator
- **ThreadOrchestrator:** Added Telegram delivery hook — after storing response, checks `telegram_groups` for thread linkage and sends via agent's own bot token (messages appear "from" correct bot in Telegram)
- **Schema:** Added `telegram_owner_user_id` column to agents table (migration + schema)
- **Setup wizard:** Added group chat privacy instructions (BotFather `/setprivacy` → Disable) shown after bot verification
- **Bug fix (during testing):** `updateThread` already calls `JSON.stringify` on participants internally — passing pre-stringified participants caused double-encoding, breaking `JSON.parse` downstream. Fixed by passing raw array. Also restructured dedup so agent registration happens before dedup check (late-arriving watchers register but don't re-process the message)

### 2. Update docs for Telegram group chat feature
- **Files:** `CLAUDE.md`, `OS8 Project Context.md`
- Updated service descriptions, channel list, agent config table, and agent messaging section to reflect Telegram group chat support

## Status
- All changes committed and pushed
