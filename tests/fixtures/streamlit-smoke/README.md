# streamlit-smoke fixture

The Phase 2 GATE smoke test fixture. PR 2.2's
`tests/e2e/streamlit-proxy-smoke.test.js` spawns Streamlit against this
app, mounts `ReverseProxyService` on a fresh Express, drives Chromium,
and asserts that:

1. The page loads at `<slug>.localhost:<proxyPort>/`.
2. Streamlit's `/_stcore/stream` WebSocket connects through the proxy.
3. Editing `app.py` triggers a re-render via the WS within 5s without a
   full page reload.

The smoke test is gated behind `OS8_STREAMLIT_SMOKE=1` because it needs
to install `streamlit==1.32.2` into a venv (network-bound) and launch
Chromium via `@playwright/test`. Set the env var when running locally:

```bash
OS8_STREAMLIT_SMOKE=1 npx vitest run tests/e2e/streamlit-proxy-smoke.test.js
```

If the gate fails on macOS or Linux, do not merge PR 2.4's Streamlit /
Gradio / ComfyUI manifests — `phase-2-plan.md` §1 documents the gating
rule.
