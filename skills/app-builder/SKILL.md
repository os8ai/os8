---
name: app-builder
description: Build new OS8 apps from scratch. Use when asked to build a new app, create a project, or generate a web application. Covers the full lifecycle — plan, propose, approve, build, inspect, fix, deliver.
version: 4.0.0
tags: [apps, build, plan, create]
endpoints:
  - method: POST
    path: /api/apps/propose
    description: Submit a build plan for user approval
  - method: POST
    path: /api/apps/:id/build
    description: Dispatch headless AI builder for existing app (fix iterations)
  - method: GET
    path: /api/apps/:id/build/status
    description: Poll build progress
  - method: POST
    path: /api/apps/:id/inspect
    description: Screenshot + console errors
---

# App Builder

Build new OS8 apps end-to-end. Every app gets a scaffolded React 18 + Tailwind 3 + Vite 5 environment, blob storage, and a home screen icon — ready for code.

**Note:** All URLs below use `http://localhost:PORT` as a placeholder. Use the same base URL (host and port) you used to fetch this skill documentation.

## Process

### 1. Write the build plan

Think about what the user wants. Consider their preferences, past conversations, and what would make a great app. Then write your plan as a JSON file:

```bash
mkdir -p ~/os8/plans
```

Write to `~/os8/plans/YYYYMMDDHHMM-app-name.json`:

```json
{
  "name": "Weather Dashboard",
  "color": "#3b82f6",
  "icon": "cloud-sun",
  "textColor": "#ffffff",
  "spec": "Build a weather dashboard that shows current conditions and a 5-day forecast.\n\nLayout:\n- Search bar at top for city lookup\n- Current weather card: temperature, humidity, wind speed, weather icon\n- Below: horizontal row of 5 day-forecast cards\n\nInteractions:\n- Search triggers API fetch (OpenWeatherMap free tier)\n- Loading spinner during fetch\n- Error state for invalid cities\n\nData:\n- Cache results in localStorage for 30 minutes\n- Remember last searched city\n\nStyle:\n- Dark UI with blue accents (#3b82f6)\n- Rounded cards with subtle shadows\n- Responsive — works on narrow preview pane"
}
```

**Required fields:**
- `name` — short, clear app name (appears on home screen)
- `spec` — detailed build instructions. Be thorough: layout, components, interactions, data persistence, colors/style, edge cases

**Optional fields:**
- `color` — hex background for the home screen icon
- `icon` — Lucide icon name (e.g. "cloud-sun", "check-circle", "calendar") or 1-2 character emoji
- `textColor` — hex text color on the icon (default `#ffffff`)

**Writing good specs:** The spec is the most important input. A vague spec produces a vague app.

Good: "Build a pomodoro timer. Single page. Large circular countdown display (25min default). Start/pause/reset buttons below. Session counter in top-right. When timer hits zero, play a short beep sound and auto-start a 5-minute break. Dark UI, red accent for the timer ring. Data in localStorage."

Bad: "Build a timer app."

Include: layout, components, interactions, data persistence, colors/style, edge cases.

### 2. Submit the plan for approval

```bash
curl -X POST http://localhost:PORT/api/apps/propose \
  -H "Content-Type: application/json" \
  -d '{
    "planFile": "~/os8/plans/202603111430-weather-dashboard.json",
    "agentId": "YOUR_AGENT_ID"
  }'
```

**Response:** `{ proposalId, status: "pending_approval", message: "..." }`

**IMPORTANT:** After calling this endpoint, STOP. Do NOT create the app. Do NOT call any build endpoints. The user will see a proposal card showing your plan with three options:
- **Approve** — the app is created and the build starts automatically
- **Propose Changes** — the user sends feedback; you'll receive it and should revise your plan
- **Reject** — the plan is discarded

Just tell the user you've submitted your build plan for their review.

#### Autonomous mode (timed jobs / autonomous tasks)

If you are executing a timed job or autonomous task — meaning the user did **not** just ask you to build this app — pass `autoApprove: true` to skip the approval gate:

```bash
curl -X POST http://localhost:PORT/api/apps/propose \
  -H "Content-Type: application/json" \
  -d '{
    "planFile": "~/os8/plans/202603111430-weather-dashboard.json",
    "agentId": "YOUR_AGENT_ID",
    "autoApprove": true
  }'
```

The app will be created and the build will start immediately. No user approval is needed. The response returns the app ID and build status directly.

**When to use `autoApprove`:**
- You are running as part of a timed job
- You are completing an autonomous task that involves building an app
- The user is NOT actively waiting for your response

**When NOT to use `autoApprove`:**
- The user just asked you to build an app in conversation
- You are responding to a direct user message

### 3. Handle change requests

If the user proposes changes, you'll receive a message like:
`[internal: build-changes-requested] User wants changes to "Weather Dashboard" plan: "Add hourly forecast too, and use Celsius by default"`

Read their feedback, revise your plan file (overwrite the same file), and re-submit:

```bash
curl -X POST http://localhost:PORT/api/apps/propose \
  -H "Content-Type: application/json" \
  -d '{
    "planFile": "~/os8/plans/202603111430-weather-dashboard.json",
    "agentId": "YOUR_AGENT_ID"
  }'
```

A new proposal card will appear with your revised plan. Repeat until the user approves.

### 4. Wait for build completion

After the user approves, the build runs in the background. You'll receive an `[internal: build-complete]` or `[internal: build-failed]` notification. Do not poll — just wait.

### 5. Inspect the result

After the build completes, inspect the app:

```bash
curl -X POST http://localhost:PORT/api/apps/APP_ID/inspect
```

Returns a screenshot (base64 PNG) and any console errors. Review both:
- **Screenshot**: Does the UI match the spec? Is it rendering correctly?
- **Console errors**: Any React errors, missing imports, or runtime failures?

### 6. Fix issues (if needed)

If the inspection reveals problems, dispatch a fix build on the **existing** app:

```bash
curl -X POST http://localhost:PORT/api/apps/APP_ID/build \
  -H "Content-Type: application/json" \
  -d '{
    "spec": "Fix: the calendar view crashes with TypeError on line 42 of Calendar.jsx. The habit grid renders but checkboxes do not toggle. Add missing onClick handler.",
    "agentId": "YOUR_AGENT_ID"
  }'
```

Be specific about what's wrong. Include error messages. Then inspect again to verify.

### 7. Report completion

If running as a timed job, end with:

```
[JOB_COMPLETE: Built "{app name}" — {1-2 sentence description}. URL: http://localhost:PORT/{id}/]
```

## What every app gets for free

- **React 18 + Tailwind 3 + Vite 5** — hot reload, JSX, utility classes
- **React Router 6** — client-side routing (basename pre-set to `/{id}`)
- **SQLite database** — `POST /api/apps/{id}/db/*` for structured data persistence (created on first use)
- **Blob storage** — `/api/apps/{id}/blob/*` for file uploads, reads, listing, and deletion at runtime
- **No npm install needed** — apps share a Core environment with all dependencies
- **Auto-generated CLAUDE.md** — the builder agent knows the full app environment
- **Home screen icon** — appears on the OS8 home grid immediately

## Guidelines

- **Always write a plan file first** — never skip the planning step
- **Always use `/api/apps/propose`** to submit plans — never call `POST /api/apps` directly
- Use `POST /api/apps/:id/build` only for fix iterations on existing apps
- Always inspect after building — never assume success
- Keep specs concrete — layout, data, interactions, style
- Don't add `package.json` to apps — they use Core's shared dependencies
