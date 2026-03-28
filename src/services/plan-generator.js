/**
 * Plan Generator — Phase 1 planning prompt + Opus call
 *
 * Pure functions for building the planning prompt and calling the LLM.
 * V2 swap point: planWithModel() wraps the Anthropic SDK call.
 * Replace with RoutingService.resolve(db, 'planning') in v2.
 */

const AnthropicSDK = require('./anthropic-sdk');
const SettingsService = require('./settings');
const RoutingService = require('./routing');
const { familyToSdkModel } = require('./cli-runner');

/**
 * OS8 app environment context — single source of truth.
 * Used by planning prompts and step execution prompts so agents know
 * what the app environment provides without guessing.
 *
 * @param {object} [db] - Database connection (for port lookup)
 * @returns {string} Environment description block
 */
function getAppEnvironmentContext(db) {
  const port = (db && SettingsService.get(db, 'os8Port')) || '8888';
  const baseUrl = `http://localhost:${port}`;

  return `### OS8 App Environment (Pre-Built — No Setup Required)

Every OS8 app is scaffolded with a complete, ready-to-use development environment:

**Stack:** React 18 + Tailwind CSS 3 + Vite 5 + React Router 6 — all pre-installed.
- No \`npm install\`, no \`package.json\` — dependencies are shared via a Core environment.
- Three.js is available for 3D graphics (\`import * as THREE from 'three'\`).
- Tailwind utility classes work immediately. Custom CSS goes in \`src/index.css\`.
- React Router is pre-configured with \`basename="/{appId}"\` — just add Routes and Links.

**Data Persistence — zero friction, USE IT:**
- \`localStorage\` / \`sessionStorage\` — simple key-value, persists across reloads
- \`IndexedDB\` — structured data, large datasets, offline storage
- JSON files in \`src/\` — static seed data, importable directly
- Blob storage at \`~/os8/blob/{appId}/\` — file uploads, generated assets, images

Storage is free and ready. Do not skip persistence because of assumed friction — there is none. Apps that store data are better apps. Default to using localStorage or IndexedDB for any stateful feature.

**File Structure** (auto-scaffolded):
\`\`\`
~/os8/apps/{appId}/
├── index.html          # Entry HTML (managed by OS8, don't edit)
├── src/
│   ├── main.jsx        # React entry (managed, don't edit)
│   ├── App.jsx         # Main component — START HERE
│   ├── index.css       # Tailwind imports + custom CSS
│   └── components/     # Create as needed
├── CLAUDE.md           # Auto-generated (full docs for the builder)
└── claude-user.md      # Custom instructions
\`\`\`

**Serving:** Apps are live at \`${baseUrl}/{appId}/\` immediately after creation.

**What apps CANNOT do:**
- No server-side code — apps are client-only React SPAs
- No Node.js APIs at runtime (no \`fs\`, \`path\`, \`child_process\`)
- No \`npm install\` — only pre-installed packages are available
- No package.json — dependencies come from Core

**API integration:** Apps can call OS8 skill APIs at runtime via \`fetch('${baseUrl}/api/...')\` — Google Calendar, Gmail, image generation, Telegram, and more. See the app's CLAUDE.md for the full list.`;
}

/**
 * Build the structured planning prompt with full OS8 context.
 * @param {string} request - User's original request
 * @param {Array} agents - Agent roster from AgentService.getOperational()
 * @param {Array} capabilities - Capabilities list
 * @param {object} context - { identityContext?, memoryContext?, fileTree? }
 * @returns {string} Complete planning prompt
 */
function buildPlanningPrompt(request, agents, capabilities, context = {}, db = null) {
  const sections = [];

  sections.push(`You are planning a task for execution in OS8. Produce a structured plan.

## User Request
${request}`);

  // Agent roster
  if (agents && agents.length > 0) {
    const agentLines = agents.map(a => {
      const config = a.config || {};
      const name = config.assistantName || a.name || a.id;
      const role = config.role || 'assistant';
      const backend = config.agentBackend || 'claude';
      return `- **${name}** (id: ${a.id}, backend: ${backend}, role: ${role})`;
    }).join('\n');
    sections.push(`## Available Agents
${agentLines}`);
  }

  // Capabilities
  if (capabilities && capabilities.length > 0) {
    const capLines = capabilities.map(c => {
      return `- **${c.name}** (${c.type}): ${c.description || ''}`;
    }).join('\n');
    sections.push(`## Available Capabilities
${capLines}`);
  }

  // Context
  const contextParts = [];
  if (context.identityContext) contextParts.push(context.identityContext);
  if (context.memoryContext) contextParts.push(context.memoryContext);
  if (context.fileTree) contextParts.push(`### File Tree\n${context.fileTree}`);

  if (contextParts.length > 0) {
    sections.push(`## Context
${contextParts.join('\n\n')}`);
  }

  // OS8 platform rules for app creation/building
  const port = (db && SettingsService.get(db, 'os8Port')) || '8888';
  const baseUrl = `http://localhost:${port}`;
  sections.push(`## OS8 Platform

OS8 is a desktop platform for building web apps with AI agents.

${getAppEnvironmentContext(db)}

### Building Apps — API Workflow
- Create app: \`POST ${baseUrl}/api/apps\` with \`{"name": "App Name", "color": "#hex", "icon": "emoji", "textColor": "#fff", "planId": "<planId>", "stepId": "<stepId>"}\` → returns \`{ id, name, slug, path }\`. The planId and stepId are provided in the plan execution context and MUST be included or the request will be rejected.
- Build/modify app code: \`POST ${baseUrl}/api/apps/{id}/build\` with \`{"spec": "what to build"}\` — spawns headless AI builder
- Poll build status: \`GET ${baseUrl}/api/apps/{id}/build/status\`
- Inspect result: \`POST ${baseUrl}/api/apps/{id}/inspect\` — screenshot + console errors
- Apps must NOT be created by writing raw files. No mkdir, no touch, no python/node scripts.

### App-related plans MUST follow this pattern:
1. Create the app via \`POST ${baseUrl}/api/apps\` with planId and stepId from the execution context (returns the app ID). Choose a meaningful name, icon, and color.
2. Build/modify the app via \`POST ${baseUrl}/api/apps/{id}/build\` — the step description MUST contain the full feature requirements (UI, layout, components, data persistence approach, styling, interactions). The build step's spec is the ONLY thing the builder sees. Reference the environment above — tell the builder to use localStorage, IndexedDB, blob storage, Tailwind, etc. explicitly.
3. After building, inspect the app to verify quality. Fix issues with another build pass if needed.

**Note:** The plan executor provides planId and stepId automatically. Direct app creation via POST /api/apps is ONLY allowed within plan steps. For agent-initiated builds (outside plans), use the app-builder skill which writes a plan file and submits via POST /api/apps/propose.

**CRITICAL:** Each step description must be self-contained. The agent executing a step only sees that step's description and the original user request — not the full plan. Embed all necessary details directly in the step description. Include data persistence strategy, UI layout, and component names.

### Non-app requests
For tasks that don't involve creating or building apps (scripts, data processing, research, etc.), use normal CLI capabilities.`);

  sections.push(`## Instructions
Break this into concrete, sequential steps. For each step specify:
- A clear description of what to do
- Which agent should execute it (use "self" for the current agent, or an agent ID for cross-agent steps)
- What the completion criteria are
- Dependencies on prior steps (by step number, 1-indexed)

Output format (strict JSON, no additional text):
{
  "summary": "one-line plan summary",
  "steps": [
    {
      "description": "what to do",
      "agent": "self",
      "completion_criteria": "how to verify this step succeeded",
      "depends_on": []
    }
  ]
}`);

  return sections.join('\n\n');
}

/**
 * Call the planning model to generate a plan.
 * Uses the planning routing cascade to select the model.
 * Falls back to opus for non-Anthropic families (plan generation is SDK-only).
 *
 * @param {object} db
 * @param {string} prompt - Full planning prompt
 * @returns {Promise<{ text: string, usage: object }>}
 */
async function planWithModel(db, prompt) {
  let sdkModel = 'opus';
  try {
    const resolved = RoutingService.resolve(db, 'planning');
    sdkModel = familyToSdkModel(resolved.familyId, 'opus');
    console.log(`[Routing] planning/generate: ${resolved.familyId} via ${resolved.source}`);
  } catch (e) {
    console.warn('[PlanGenerator] Routing failed, falling back to opus:', e.message);
  }
  return AnthropicSDK.sendMessage(db, null, prompt, { agentModel: sdkModel });
}

/**
 * Extract a JSON object from LLM response text.
 * Handles markdown fences, leading/trailing text, nested braces.
 *
 * @param {string} text - Raw LLM response
 * @returns {object} Parsed JSON object
 * @throws {Error} If no valid JSON found
 */
function extractJson(text) {
  if (!text) throw new Error('Empty response');

  // Try 1: Direct parse
  try {
    return JSON.parse(text.trim());
  } catch {}

  // Try 2: Extract from ```json ... ``` fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  // Try 3: Find outermost { } braces
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) throw new Error('No JSON object found in response');

  let depth = 0;
  let lastBrace = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        lastBrace = i;
        break;
      }
    }
  }

  if (lastBrace === -1) throw new Error('Unmatched braces in response');

  try {
    return JSON.parse(text.substring(firstBrace, lastBrace + 1));
  } catch (e) {
    throw new Error(`Failed to parse extracted JSON: ${e.message}`);
  }
}

module.exports = { buildPlanningPrompt, planWithModel, extractJson, getAppEnvironmentContext };
