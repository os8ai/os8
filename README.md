# OS8

A personal operating system for building custom web apps with AI assistance.

**Repository:** https://github.com/os8ai/os8

## Quick Start

```bash
# Install dependencies
npm install

# Rebuild native modules for Electron (required after npm install)
npx electron-rebuild -f -w better-sqlite3

# Run OS8
npm start
```

## What is OS8?

OS8 is an Electron desktop app where you can:
- Get started with a guided first-run setup (AI providers, voice, account)
- Create web applications with one click
- Build with AI in an integrated terminal (Claude, Gemini, Codex, Grok)
- Plan and execute multi-step tasks with dependency tracking
- Preview your app in real-time
- Manage tasks, timed jobs, and files
- Create and customize AI agents with contextual memory
- Sign in with os8.ai account (Google OAuth + PKCE)

**Multi-Agent System** - Create agents with:
- Intelligent model routing across AI backends (Claude, Gemini, Codex, Grok)
- Per-agent visibility controls (visible, hidden, off) with full lifecycle management
- Automatic 4-tier memory (raw entries, session digests, daily digests, semantic search with drill-down)
- Timed jobs for scheduled recurring tasks
- Telegram messaging integration with auto-registration
- Voice input/output (ElevenLabs + OpenAI TTS) and phone calls
- Life system (reverie, journal, portrait, life items) and simulation
- Group chat threads with multi-agent coordination
- Skill catalog with installable capabilities

**Capabilities** - Unified system of APIs, skills, and MCP tools for Google services, image generation, Telegram, YouTube, text-to-speech, and more. APIs auto-register from route modules; skills are multi-step workflows; MCP tools are proxied from external servers. Discoverable via ClawHub catalog.

All your data stays local in `~/os8/`.

## Documentation

- **[CLAUDE.md](CLAUDE.md)** - Quick reference for development (routing hub)
- **[OS8 Project Context.md](OS8%20Project%20Context.md)** - Vision, architecture, and philosophy
- **[OS8-project-design-principles.md](OS8-project-design-principles.md)** - Architectural patterns and conventions

## Tech Stack

- Electron (desktop shell)
- React + Tailwind CSS (app framework)
- Vite (build tool, middleware mode)
- SQLite (database)
- node-pty + xterm.js (terminal)

## Project Structure

```
os8/
├── main.js              # Electron main process (lifecycle only)
├── index.html           # Renderer HTML shell
├── styles.css           # CSS entry point (imports styles/)
├── styles/              # Modular CSS (variables, primitives, layout, components, panels, modals, animations)
├── preload.js           # IPC bridge
├── src/
│   ├── renderer/        # UI modules (state, tabs, preview, terminal, agent chat)
│   ├── ipc/             # IPC handler modules (apps, agents, terminal, etc.)
│   ├── assistant/       # Agent services (memory, telegram, identity)
│   ├── routes/          # Express route modules
│   ├── services/        # Backend services (~60 modules)
│   ├── shared/          # Modules shared between shell and apps
│   ├── templates/       # App scaffolding templates
│   ├── utils/           # Utility helpers
│   ├── db.js            # Database initialization
│   ├── server.js        # Express + Vite
│   └── ...
├── tests/               # Unit tests (vitest)
└── docs/                # Documentation
```
