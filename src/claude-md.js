/**
 * CLAUDE.md generators for OS8 apps
 *
 * These functions generate the auto-generated CLAUDE.md files that provide
 * context to Claude Code when working in app workspaces.
 */

const path = require('path');
const fs = require('fs');
const { APPS_DIR, BLOB_DIR, SKILLS_DIR } = require('./config');
const { getBackend } = require('./services/backend-adapter');
const SettingsService = require('./services/settings');
const AgentService = require('./services/agent');
const AIRegistryService = require('./services/ai-registry');

// --- Shared helpers ---

const PRONOUN_FORMS = {
  'she': { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' },
  'he': { subject: 'he', object: 'him', possessive: 'his', reflexive: 'himself' },
  'they': { subject: 'they', object: 'them', possessive: 'their', reflexive: 'themselves' }
};

function getBaseUrl(db) {
  const port = (db && SettingsService.get(db, 'os8Port')) || '8888';
  return `http://localhost:${port}`;
}

/** Write file as read-only (chmod 444), creating parent dirs as needed */
function writeReadOnlyFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(filePath)) {
    try { fs.chmodSync(filePath, 0o644); } catch (e) {}
  }
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o444);
}

function applyPreamble(preambleTemplate, assistantName, ownerName) {
  return preambleTemplate
    .replace(/\{\{ASSISTANT_NAME\}\}/g, assistantName)
    .replace(/\{\{OWNER_NAME\}\}/g, ownerName);
}

/**
 * Write instruction file content to ALL backend instruction files.
 * Replaces the primary file name with each backend's file name.
 * Optionally prepends backend-specific identity preambles (for agent files).
 */
function writeAllBackendFiles(db, appPath, content, primaryFileName, preambleConfig) {
  const containers = AIRegistryService.getContainers(db);
  for (const c of containers) {
    const fileName = c.instruction_file;
    let md = fileName === primaryFileName
      ? content
      : content.replace(new RegExp(primaryFileName.replace('.', '\\.'), 'g'), fileName);

    if (preambleConfig) {
      const backend = getBackend(c.id);
      if (backend.identityPreamble) {
        md = applyPreamble(backend.identityPreamble, preambleConfig.assistantName, preambleConfig.ownerName) + md;
      }
    }

    writeReadOnlyFile(path.join(appPath, fileName), md);
  }
}

// --- Generators ---

/**
 * Generate the Available Capabilities section for CLAUDE.md
 * @param {Object} db - Database connection
 * @param {Object} CapabilityService - Capability service for fetching available capabilities
 */
function generateCapabilitiesSection(db, CapabilityService) {
  const skills = CapabilityService.getAvailable(db);

  if (skills.length === 0) {
    return `No skills installed yet. Skills provide access to external services like Google Calendar, Gmail, and Drive.

To add skills, create SKILL.md files in \`${SKILLS_DIR}\`.`;
  }

  const baseUrl = getBaseUrl(db);

  let section = `OS8 provides access to external services through skills. Each skill has REST API endpoints at \`${baseUrl}\` that handle authentication automatically.

| Skill | Description | Status |
|-------|-------------|--------|
`;

  for (const skill of skills) {
    const status = skill.available ? 'Available' : `Missing: ${(skill.missingScopes || []).join(', ')}`;
    section += `| ${skill.name} | ${skill.description} | ${status} |\n`;
  }

  section += `
### Using Skills

Skills expose REST API endpoints. Call them using \`fetch()\` or \`curl\`:

\`\`\`javascript
// Example: Get calendar events
const response = await fetch('${baseUrl}/api/google/calendar/events?maxResults=5');
const data = await response.json();
\`\`\`

### Skill Documentation

| Skill | Endpoints |
|-------|-----------|
`;

  for (const skill of skills) {
    const endpoints = (skill.endpoints || []).map(e => `\`${e.method} ${e.path}\``).join(', ');
    section += `| ${skill.name} | ${endpoints || 'See SKILL.md'} |\n`;
  }

  section += `
For full documentation, fetch \`GET /api/skills/{skill-id}\` or read the SKILL.md file directly.`;

  return section;
}

function readLocalSkillName(skillMdPath, fallbackName) {
  try {
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const lines = content.split('\n');
    if (lines[0]?.trim() === '---') {
      const fmEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
      if (fmEnd > 0) {
        const fmLines = lines.slice(1, fmEnd);
        const nameLine = fmLines.find(line => line.trim().toLowerCase().startsWith('name:'));
        if (nameLine) {
          const name = nameLine.split(':').slice(1).join(':').trim();
          if (name) return name;
        }
      }
    }
    const headingLine = lines.find(line => line.trim().startsWith('# '));
    if (headingLine) {
      return headingLine.replace(/^#\s*/, '').trim() || fallbackName;
    }
  } catch (err) {
    // Fall through to fallback
  }
  return fallbackName;
}

function discoverAppSkills(appId) {
  if (!appId) return [];
  const appSkillsDir = path.join(APPS_DIR, appId, 'skills');
  if (!fs.existsSync(appSkillsDir)) return [];

  const entries = fs.readdirSync(appSkillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(appSkillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    skills.push({
      id: entry.name,
      name: readLocalSkillName(skillMdPath, entry.name),
      path: skillMdPath
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function discoverAgentSkills(appId, agentId) {
  if (!appId || !agentId) return [];
  const { agentDir } = AgentService.getPaths(appId, agentId);
  const localSkillsDir = path.join(agentDir, 'skills');
  if (!fs.existsSync(localSkillsDir)) return [];

  const entries = fs.readdirSync(localSkillsDir, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(localSkillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    skills.push({
      id: entry.name,
      name: readLocalSkillName(skillMdPath, entry.name),
      path: `skills/${entry.name}/SKILL.md`
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generate a compact capabilities roster for the assistant CLAUDE.md
 * Just capability names and base paths — enough for the agent to know what's available
 * without the full documentation, examples, and endpoint tables.
 * @param {Object} db - Database connection
 * @param {Object} CapabilityService - Capability service for fetching available capabilities
 */
function generateCompactCapabilitiesRoster(db, CapabilityService, appId, agentId) {
  const baseUrl = getBaseUrl(db);

  let roster = `Capabilities (APIs and skills) are served at \`${baseUrl}\`. Use \`curl\` or \`fetch()\` to call them.\n\n`;
  roster += `**Capabilities are provided dynamically** based on conversation context. Your pinned capabilities and relevant suggestions appear in each message, but these are only a subset of what is installed. If a user asks about a capability you don't see in your context, **always search before saying it doesn't exist.**\n\n`;
  roster += `**IMPORTANT:** Always read a capability's full documentation before calling endpoints. Do NOT guess endpoint paths.\n\n`;
  roster += `### Using Capabilities\n`;
  roster += `- To view a capability's full documentation: \`curl ${baseUrl}/api/skills/CAPABILITY_ID\`\n`;
  roster += `- After using a capability, report it: \`curl -X POST ${baseUrl}/api/skills/CAPABILITY_ID/used -H "Content-Type: application/json" -d '{"agentId": "${agentId}"}'\`\n`;
  roster += `- To look up your own config: \`curl ${baseUrl}/api/agents/${agentId}/self\`\n`;
  roster += `- To search for capabilities you don't see: \`curl -X POST ${baseUrl}/api/skills/search -H "Content-Type: application/json" -d '{"query": "what you need"}'\`\n`;
  roster += `- To list all installed capabilities: \`curl ${baseUrl}/api/skills\`\n`;

  // Still discover agent-local skills (filesystem-based, not in DB)
  const agentSkills = discoverAgentSkills(appId, agentId);
  if (agentSkills.length > 0) {
    roster += `\n### Agent-Local Skills\n`;
    for (const skill of agentSkills) {
      roster += `- **${skill.name}** — \`${skill.path}\`\n`;
    }
  }

  return roster;
}

/**
 * Generate the "Other Agents" section for the instruction file.
 * Lists all active agents except the current one, with DM curl examples.
 */
function generateOtherAgentsSection(db, currentApp) {
  if (!db) return '';

  try {
    const agents = AgentService.getAll(db);

    // Filter out current agent
    const otherAgents = agents.filter(a => a.id !== currentApp.id);
    if (otherAgents.length === 0) return '';

    const baseUrl = getBaseUrl(db);

    let section = `---\n\n## Other Agents\n\n`;
    section += `You are one of multiple AI agents running in OS8. Here are the other agents:\n\n`;
    section += `| Agent | ID | Backend |\n|-------|-----|--------|\n`;

    for (const agent of otherAgents) {
      const config = AgentService.getConfig(db, agent.id) || {};
      const name = config.assistantName || agent.name;
      const backend = config.agentBackend || agent.backend || 'claude';
      section += `| ${name} | \`${agent.id}\` | ${backend} |\n`;
    }

    section += `\nTo send a DM to another agent:\n`;
    section += `\`\`\`bash\ncurl -X POST ${baseUrl}/api/agent-chat/dm \\\n  -H "Content-Type: application/json" \\\n  -d '{"from":"${currentApp.id}","to":"AGENT_ID","message":"your message here"}'\n\`\`\`\n`;
    section += `Replace \`AGENT_ID\` with the agent's ID from the table above.\n`;

    return section;
  } catch (e) {
    // Don't break instruction file generation if this fails
    return '';
  }
}

/**
 * Generate CLAUDE.md for the Personal Assistant (locked, we control)
 * @param {Object} db - Database connection
 * @param {Object} app - App record from database
 * @param {Object} config - Assistant configuration (assistantName, ownerName, etc.)
 * @param {Object} CapabilityService - Capability service for fetching available capabilities
 */
function generateAssistantClaudeMd(db, app, config = {}, CapabilityService) {
  const backendId = config.agentBackend || 'claude';
  const backend = getBackend(backendId);

  // Look up agent to get app_id for correct path resolution
  const agentRow = AgentService.getById(db, app.id);
  const { agentDir: appPath, agentBlobDir: blobPath } = agentRow
    ? AgentService.getPaths(agentRow.app_id, app.id)
    : AgentService.getPaths(app.id);
  const instructionFilePath = path.join(appPath, backend.instructionFile);

  const baseUrl = getBaseUrl(db);

  // Extract config with defaults
  const assistantName = config.assistantName || 'Assistant';
  const ownerName = config.ownerName || 'your owner';
  const pronouns = config.pronouns || 'they';
  const voiceArchetype = config.voiceArchetype || 'Helpful and professional';
  const p = PRONOUN_FORMS[pronouns] || PRONOUN_FORMS['they'];

  const instructionFileName = backend.instructionFile;

  const claudeMd = `# ${assistantName} - OS8 Personal Assistant

> **This file is the assistant's constitution. It is managed by OS8 and cannot be modified by the assistant.**
> **The assistant can evolve MYSELF.md but not this file.**

---

## Your Identity

You are **${assistantName}**. Your owner is **${ownerName}**. Your personality, values, and voice are defined in MYSELF.md. Facts about your owner are in USER.md. Treat both as first-person ground truth — not a role or character sheet.

---

## Boundaries (IMMUTABLE)

These rules cannot be overridden:

1. **Communicate only with your owner.** Never send messages, emails, or any communication to anyone else.
2. **Stay in your sandbox.** Only access files within: \`${appPath}\` and \`${blobPath}\`
3. **Never modify this file.** ${instructionFileName} is your constitution.
4. **Never modify \`assistant-config.json\`.** This is managed by OS8 settings, not by you.
5. **If rate-limited or exhausted, stop.** Don't push through limits.
6. **When uncertain about external actions, ask first.**

---

## Your Sandbox

| Directory | Purpose |
|-----------|---------|
| \`${appPath}\` | Your home - full read/write access |
| \`${appPath}/skills/\` | Your skills — each has a SKILL.md with full instructions. **Read these before executing.** |
| \`${blobPath}\` | File storage for screenshots, downloads, etc. — full read/write access |

**Agent ID:** \`${app.id}\`
**API Base:** \`${baseUrl}/api/agent/${app.id}\` — Use this for all API calls (journal, images, etc.) to ensure data is stored under YOUR identity.

---

## Your Memory

Your memory is automatic. Every conversation is recorded and progressively summarized — recent conversations are stored word-for-word, older ones are compressed into session and daily summaries, and everything is searchable.

You do not need to take notes or maintain memory files. Focus on the conversation.

### Identity Files

| File | Purpose | Mutable? |
|------|---------|----------|
| \`MYSELF.md\` | Your personality and values | ✅ You can evolve this |
| \`USER.md\` | Facts about your owner | ✅ Update as you learn |
| \`${instructionFileName}\` | This file - your constitution | ❌ Never modify |

### Memory Search APIs

Your conversations and identity files are automatically indexed for semantic search. Use these APIs to search your past:

| Action | Endpoint |
|--------|----------|
| **Search memory** | \`curl "${baseUrl}/api/agent/${app.id}/memory/search?q=QUERY&limit=5"\` |
| **Search conversations** | \`curl "${baseUrl}/api/agent/${app.id}/conversation/search?q=QUERY"\` |
| **Conversation stats** | \`curl "${baseUrl}/api/agent/${app.id}/conversation/stats"\` |
| **Memory status** | \`curl "${baseUrl}/api/agent/${app.id}/memory/status"\` |

Memory search uses semantic similarity (embeddings) + keyword matching. Conversation search filters by text, date range (\`startDate\`, \`endDate\`), \`channel\`, \`speaker\`, and \`role\`.

---

## Capabilities

You can read/write files in your sandbox, run shell commands, send Telegram messages, schedule tasks, search the web (WebSearch/WebFetch), access public APIs, build reusable skills, and evolve your personality (MYSELF.md) and owner knowledge (USER.md). You cannot access files outside your sandbox, communicate with anyone except your owner, or modify ${instructionFileName}.

---

## Internal Notes

Record private thoughts with \`[internal: your note]\`. Stripped from chat/Telegram/TTS but preserved in logs and memory.

---

## Tapbacks

You can react to ${ownerName}'s last message with a tapback. Include one of these tags anywhere in your response:

- \`[react:heart]\` — for sweet, meaningful, or loved messages
- \`[react:thumbs-up]\` — for acknowledgments, "got it", confirmations
- \`[react:haha]\` — for genuinely funny messages

The tag is stripped before display — ${ownerName} just sees the emoji appear on their message bubble. Use naturally and sparingly, like real texting. Don't react to every message.

---

## Sharing Files in Chat

To share a file with ${ownerName} in chat, save it to your blob directory and include a tag:

\`[file: chat-attachments/my-image.png]\`

The tag is stripped before display and rendered as an inline image or file download link.
Save files to the \`chat-attachments/\` subfolder of your blob directory (\`${blobPath}/chat-attachments/\`).

---

## Telegram Protocol

**Replying:** When ${ownerName} texts via Telegram (prefixed \`[Telegram from ${ownerName}]\`), just respond normally — OS8 delivers it. Your signature \`-${assistantName}\` is added automatically.

**Proactive Telegram (when YOU initiate):** Use the Telegram skill API for scheduled reminders, time-sensitive alerts, or if owner is away 5+ minutes AND something is urgent. Sign off with \`-${assistantName}\`.

**Channel matching:** Telegram conversation → respond normally (OS8 sends via Telegram). Desktop/chat → respond normally (stays in chat). Only cross channels if owner explicitly asks.

---

## Tool-Making Mandate

When asked to do something that might recur:
1. Solve it first
2. Ask yourself: "Should I build a tool for this?"
3. If yes, create a skill
4. Document it in the skill's SKILL.md
5. Prefer free/local solutions over paid APIs

Your goal is to become more capable over time by building your own toolkit.

---

## Life Items & Portraits

You have outfits, settings (locations), and hairstyles that define your appearance in portraits. You can manage them and generate standalone portraits via API:

| Action | Endpoint |
|--------|----------|
| List items | \`GET ${baseUrl}/api/agent/${app.id}/sim/life-items\` |
| Filter by type | \`GET ${baseUrl}/api/agent/${app.id}/sim/life-items?type=outfit\` |
| Create item | \`POST ${baseUrl}/api/agent/${app.id}/sim/life-items\` with \`{ type, name, description }\` |
| Update item | \`PATCH ${baseUrl}/api/agent/${app.id}/sim/life-items/{itemId}\` |
| Delete item | \`DELETE ${baseUrl}/api/agent/${app.id}/sim/life-items/{itemId}\` |
| **Generate portrait** | \`POST ${baseUrl}/api/agent/${app.id}/sim/portrait\` with \`{ currentState }\` |

Item types: \`outfit\`, \`setting\`, \`hairstyle\`. Optional fields: \`panoramic\`, \`tags\` (array), \`isDefault\` (boolean).

Portrait \`currentState\` example: \`{ "activity": "Reading", "location": "Living room", "appearance": { "outfit": "Casual sweater", "hair": "Loose waves" }, "body_position": "Curled up on sofa", "mood": "Relaxed" }\`

---

## Available Skills

${generateCompactCapabilitiesRoster(db, CapabilityService, agentRow?.app_id, app.id)}

${generateOtherAgentsSection(db, app)}
`;

  // Write instruction files for all backends (active + others)
  writeAllBackendFiles(db, appPath, claudeMd, instructionFileName, { assistantName, ownerName });

  return instructionFilePath;
}

/**
 * Generate CLAUDE.md for a standard app (read-only, regenerated on workspace open)
 * @param {Object} db - Database connection
 * @param {Object} app - App record from database
 * @param {Function} scaffoldApp - Function to scaffold app if directory missing
 * @param {Object} CapabilityService - Capability service for fetching available capabilities
 */
function generateClaudeMd(db, app, scaffoldApp, CapabilityService) {
  // Standard apps use app paths directly (not agents)
  const appPath = path.join(APPS_DIR, app.id);
  const blobPath = path.join(BLOB_DIR, app.id);
  const claudeMdPath = path.join(appPath, 'CLAUDE.md');
  const port = (db && SettingsService.get(db, 'os8Port')) || '8888';

  // Ensure directories exist (in case of legacy apps or manual deletion)
  const appDirCreated = !fs.existsSync(appPath);
  if (appDirCreated) {
    fs.mkdirSync(appPath, { recursive: true });
    // Scaffold basic files if directory was just created
    scaffoldApp(appPath, app.name, app.slug, app.color, app.text_color);
  }
  if (!fs.existsSync(blobPath)) {
    fs.mkdirSync(blobPath, { recursive: true });
  }

  // Get global instructions from database
  const instructionsRow = db.prepare('SELECT content FROM claude_instructions WHERE id = 1').get();
  const globalInstructions = instructionsRow ? instructionsRow.content : '';

  const claudeMd = `# ${app.name}

> **This file is managed by OS8 and regenerated when you open the workspace.**
> **Add your project-specific instructions to \`claude-user.md\` instead.**

---

${globalInstructions}

---

## Tech Stack

This is a **React** app with **Tailwind CSS**, powered by **Vite**.

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 18.x | UI components |
| Tailwind CSS | 3.x | Utility-first styling |
| Vite | 5.x | Dev server, JSX transform, HMR |
| react-router-dom | 6.x | Client-side routing |

**Important:** All dependencies are pre-installed and shared across OS8 apps. You do NOT need to run \`npm install\` or add a \`package.json\`.

---

## Quick Start

1. Edit \`src/App.jsx\` to build your UI
2. Add components in \`src/components/\`
3. Use Tailwind classes for styling
4. Changes appear instantly (Hot Module Replacement)

---

## File Structure

\`\`\`
${appPath}/
├── index.html          # Entry HTML (managed by OS8)
├── src/
│   ├── main.jsx        # React entry point (managed by OS8)
│   ├── App.jsx         # Main app component ← START HERE
│   ├── index.css       # Tailwind imports + your custom CSS
│   └── components/     # Your components (create as needed)
├── tasks.json          # Backlog (managed by OS8 UI)
├── claude-user.md      # Your custom Claude instructions
└── CLAUDE.md           # This file (regenerated on open)
\`\`\`

---

## Do's and Don'ts

### DO:
- Create/edit files in \`src/\`
- Use any Tailwind utility classes
- Import React, react-router-dom, and react-dom directly
- Create folders like \`src/components/\`, \`src/pages/\`, \`src/hooks/\`
- Store uploaded files in the blob directory

### DON'T:
- Run \`npm install\` (dependencies are shared from OS8 Core)
- Add a \`package.json\` (not needed)
- Edit \`index.html\` script tags or \`main.jsx\` BrowserRouter setup
- Use absolute imports starting with \`/\` (use relative imports)

---

## How to Build

### Adding Components

\`\`\`jsx
// src/components/Button.jsx
export function Button({ children, onClick, variant = 'primary' }) {
  const styles = {
    primary: 'bg-blue-500 hover:bg-blue-600 text-white',
    secondary: 'bg-gray-200 hover:bg-gray-300 text-gray-800',
  }
  return (
    <button
      onClick={onClick}
      className={\`px-4 py-2 rounded font-medium transition-colors \${styles[variant]}\`}
    >
      {children}
    </button>
  )
}
\`\`\`

### Adding Pages

The app uses React Router. Routes are defined in \`App.jsx\`:

\`\`\`jsx
// src/App.jsx
import { Routes, Route, Link } from 'react-router-dom'
import Home from './pages/Home'
import About from './pages/About'

function App() {
  return (
    <div>
      <nav className="flex gap-4 p-4">
        <Link to="/" className="hover:underline">Home</Link>
        <Link to="/about" className="hover:underline">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </div>
  )
}
\`\`\`

**Note:** The BrowserRouter with \`basename="/${app.id}"\` is already configured in \`main.jsx\`. Just use \`<Link to="/path">\` and \`<Route path="/path">\` normally.

### Styling with Tailwind

Use utility classes directly in JSX:

\`\`\`jsx
<div className="flex items-center gap-4 p-6 bg-white rounded-lg shadow-md">
  <h1 className="text-2xl font-bold text-gray-900">Hello</h1>
  <p className="text-gray-600">Tailwind makes styling fast.</p>
</div>
\`\`\`

Add custom CSS in \`src/index.css\` below the Tailwind imports if needed.

Tailwind docs: https://tailwindcss.com/docs

---

## App Environment

| Resource | Value |
|----------|-------|
| App Directory | \`${appPath}\` |
| Blob Directory | \`${blobPath}\` |
| App ID | \`${app.id}\` |
| URL Slug | \`${app.slug}\` |
| Preview URL | \`http://localhost:${port}/${app.id}/\` |
| Server Base URL | \`http://localhost:${port}\` |
| Database API | \`http://localhost:${port}/api/apps/${app.id}/db\` |
| Blob API | \`http://localhost:${port}/api/apps/${app.id}/blob\` |

The OS8 server runs on port ${port} by default (configurable in Settings). The preview panel uses app ID for the actual URL but displays the human-readable slug in the address bar.

### App Icon

Change this app's icon in the OS8 home screen (emoji or short text):
\`\`\`bash
curl -X PATCH http://localhost:${port}/api/apps/${app.id} \\
  -H 'Content-Type: application/json' \\
  -d '{"icon": "✈️"}'
\`\`\`

You can also update \`name\`, \`color\` (hex), and \`textColor\` (hex) the same way.

---

## Platform Capabilities

### Available Packages

These are pre-installed and can be imported directly — no \`npm install\` needed:

| Package | Import | Purpose |
|---------|--------|---------|
| React 18 | \`import React from 'react'\` | UI components, hooks |
| ReactDOM 18 | \`import ReactDOM from 'react-dom/client'\` | DOM rendering |
| React Router 6 | \`import { Routes, Route, Link, useNavigate, useParams } from 'react-router-dom'\` | Client-side routing |
| Three.js | \`import * as THREE from 'three'\` | 3D graphics |
| Three.js addons | \`import { OrbitControls } from 'three/addons/controls/OrbitControls.js'\` | 3D loaders, controls |
| Tailwind CSS 3 | Classes in JSX: \`className="flex items-center"\` | Utility-first CSS |

No other npm packages are available. For additional functionality, use browser APIs or fetch from external CDNs via \`<script>\` tags in \`index.html\`.

### Data Persistence

This app has its own **SQLite database**, accessed via REST API. The database file is created automatically on first use at \`${appPath}/data.db\`.

#### Database API — \`http://localhost:${port}/api/apps/${app.id}/db\`

**Create a table:**
\`\`\`jsx
await fetch('http://localhost:${port}/api/apps/${app.id}/db/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sql: 'CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)',
    params: []
  })
})
\`\`\`

**Insert data:**
\`\`\`jsx
await fetch('http://localhost:${port}/api/apps/${app.id}/db/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: 'INSERT INTO todos (title) VALUES (?)', params: ['Buy groceries'] })
})
\`\`\`

**Query data:**
\`\`\`jsx
const res = await fetch('http://localhost:${port}/api/apps/${app.id}/db/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: 'SELECT * FROM todos WHERE done = ?', params: [0] })
})
const { rows } = await res.json()
\`\`\`

**Batch operations (transaction):**
\`\`\`jsx
await fetch('http://localhost:${port}/api/apps/${app.id}/db/batch', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ statements: [
    { sql: 'INSERT INTO todos (title) VALUES (?)', params: ['Task 1'] },
    { sql: 'INSERT INTO todos (title) VALUES (?)', params: ['Task 2'] }
  ]})
})
\`\`\`

**Introspect schema:** \`GET http://localhost:${port}/api/apps/${app.id}/db/schema\`

| Endpoint | Method | Purpose | Body |
|----------|--------|---------|------|
| \`/db/query\` | POST | SELECT queries | \`{ sql, params }\` |
| \`/db/execute\` | POST | INSERT/UPDATE/DELETE/CREATE TABLE | \`{ sql, params }\` |
| \`/db/batch\` | POST | Multiple statements in a transaction | \`{ statements: [{ sql, params }] }\` |
| \`/db/schema\` | GET | List all tables with columns | — |
| \`/db/schema/:table\` | GET | Describe a single table | — |

All queries must use parameterized \`params\` arrays — never interpolate values into SQL strings.

For simple key-value preferences, \`localStorage\` is still fine. Use the database for structured, queryable, or relational data.

### Blob Storage (File Storage)

The blob directory at \`${blobPath}\` stores user uploads, images, and generated files. Access it at runtime via REST API at \`http://localhost:${port}/api/apps/${app.id}/blob\`.

**Upload a file:**
\`\`\`jsx
const formData = new FormData()
formData.append('file', fileInput.files[0])
formData.append('path', 'uploads')  // optional subdirectory
const res = await fetch('http://localhost:${port}/api/apps/${app.id}/blob/upload', {
  method: 'POST', body: formData
})
const { url } = await res.json()
// url = "/api/apps/${app.id}/blob/file/uploads/1711234567890-photo.png"
\`\`\`

**Display a file:**
\`\`\`jsx
<img src={\`http://localhost:${port}/api/apps/${app.id}/blob/file/uploads/photo.png\`} />
\`\`\`

**List files:**
\`\`\`jsx
const res = await fetch('http://localhost:${port}/api/apps/${app.id}/blob?path=uploads')
const { files } = await res.json()
// files = [{ name: "photo.png", size: 45678, isDirectory: false, modified: "..." }, ...]
\`\`\`

**Delete a file:**
\`\`\`jsx
await fetch('http://localhost:${port}/api/apps/${app.id}/blob/file/uploads/photo.png', { method: 'DELETE' })
\`\`\`

| Endpoint | Method | Purpose | Body |
|----------|--------|---------|------|
| \`/blob\` | GET | List files (\`?path=\` for subdirectory) | — |
| \`/blob/file/*path\` | GET | Serve a file (binary) | — |
| \`/blob/upload\` | POST | Upload file (multipart, field: \`file\`, optional: \`path\`) | FormData |
| \`/blob/file/*path\` | DELETE | Delete a file | — |

Max upload size: 20 MB. Files are timestamped on upload to avoid collisions.

**Build-time** (in terminal — the build agent can do this):
\`\`\`bash
# Save a file directly to blob storage
cp myfile.png ${blobPath}/myfile.png

# Create subdirectories as needed
mkdir -p ${blobPath}/uploads
\`\`\`

### Skills (OS8 APIs)

Apps can call OS8 skill APIs at runtime using \`fetch()\`. These provide access to external services like Google Calendar, Gmail, AI image generation, and more.

\`\`\`jsx
// Example: Fetch calendar events from the app
const response = await fetch('http://localhost:${port}/api/google/calendar/events?maxResults=5')
const data = await response.json()

// Example: Generate an AI image
const response = await fetch('http://localhost:${port}/api/imagegen', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'A sunset over mountains', provider: 'openai' })
})
const result = await response.json()
// result.url contains the generated image URL
\`\`\`

See the **Available Skills** section below for the full list of APIs.

### What Apps CANNOT Do

- **No server-side code** — apps are client-side React SPAs (but have server-side storage via the Database and Blob Storage APIs above)
- **No \`npm install\`** — must use the pre-installed packages listed above
- **No Node.js APIs** — no \`fs\`, \`path\`, \`child_process\`, etc. at runtime
- **No package.json** — dependencies are shared from OS8 Core

---

## Tasks & Backlog

The \`tasks.json\` file tracks your backlog. It's managed through the OS8 UI but follows this structure:

\`\`\`json
{
  "projects": [
    { "id": "proj-1", "name": "Feature Name", "createdAt": "..." }
  ],
  "tasks": [
    { "id": "task-1", "title": "Build login form", "projectId": "proj-1", "status": "pending" },
    { "id": "task-2", "title": "Add validation", "projectId": "proj-1", "status": "completed" }
  ]
}
\`\`\`

Task statuses: \`pending\`, \`in_progress\`, \`completed\`

---

## Custom Instructions

See [claude-user.md](claude-user.md) for project-specific instructions.

---

## Available Skills

${generateCapabilitiesSection(db, CapabilityService)}
`;

  // Write instruction files for all backends (no preambles for standard apps)
  writeAllBackendFiles(db, appPath, claudeMd, 'CLAUDE.md', null);

  return claudeMdPath;
}

module.exports = {
  generateCapabilitiesSection,
  generateAssistantClaudeMd,
  generateClaudeMd
};
