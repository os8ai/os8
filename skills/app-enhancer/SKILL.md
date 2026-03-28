---
name: app-enhancer
description: Inspect, debug, and improve existing OS8 apps. Captures screenshots and console errors, then dispatches fixes or enhancements. Use when asked to fix, improve, debug, or redesign an app that already exists.
version: 2.0.0
tags: [apps, debug, fix, enhance, inspect]
endpoints:
  - method: POST
    path: /api/apps/:id/inspect
    description: Screenshot + console errors
  - method: POST
    path: /api/apps/:id/build
    description: Dispatch headless AI builder with fix/enhancement spec
  - method: GET
    path: /api/apps/:id/build/status
    description: Poll build progress
---

# App Enhancer

Diagnose and improve existing OS8 apps using the inspect → fix → verify loop.

## Process

### 1. Inspect the app

```bash
curl -X POST http://localhost:8888/api/apps/APP_ID/inspect
```

Loads the app in a hidden browser, captures a screenshot and any console errors/warnings.

**Response:**
```json
{
  "appId": "...",
  "appName": "My App",
  "screenshot": "<base64-encoded-png>",
  "consoleErrors": [{"type": "error", "text": "Uncaught TypeError: ..."}],
  "consoleWarnings": [],
  "url": "http://localhost:8888/APP_ID/"
}
```

Review both the screenshot (visual state) and console errors (runtime issues).

### 2. Dispatch the fix or enhancement

```bash
curl -X POST http://localhost:8888/api/apps/APP_ID/build \
  -H "Content-Type: application/json" \
  -d '{
    "spec": "Fix the TypeError in Calendar.jsx line 42 — events array is undefined on first render. Add null check. Also: the header text is clipped on mobile widths, add responsive padding.",
    "agentId": "YOUR_AGENT_ID"
  }'
```

Be specific. Include error messages, component names, line numbers, and exactly what to change. The more precise the spec, the better the fix.

Returns immediately. Build runs in background.

### 3. Poll build status

```bash
curl "http://localhost:8888/api/apps/APP_ID/build/status?since=0"
```

Poll every 5-10 seconds. Track the `since` index for incremental updates. Stop when status is `completed` or `failed`.

### 4. Verify

Inspect again after the build completes:

```bash
curl -X POST http://localhost:8888/api/apps/APP_ID/inspect
```

Compare the new screenshot and console output against the original. If issues remain, repeat steps 2-4 with updated instructions.

## Guidelines

- Always inspect before fixing — don't guess at the problem
- Always inspect after fixing — don't assume the build worked
- Include specific error messages and component names in the spec
- One focused fix per build pass is more reliable than a kitchen-sink spec
- For major redesigns (new pages, new features), use the app-builder skill with a plan instead
