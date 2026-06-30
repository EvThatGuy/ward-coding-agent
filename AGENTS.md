# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single-file **background worker** (`index.js`), not a web service — there is
no HTTP server, no exposed port, no lint config, and no automated tests. See `README.md`
for the product overview and env vars, and `Dockerfile` for the production image.

- **Run it:** `npm start` (= `node index.js`). `npm install` is a no-op here (no
  third-party deps; the code uses only Node built-ins + global `fetch`, Node >= 20).
- **Env-gated no-op:** with `LWOS_BASE` / `WARD_AGENT_KEY` unset the process logs a
  "disabled" message and exits 0. An invalid `AGENT_ENGINE` exits 1. So a bare
  `node index.js` is expected to exit immediately, not hang.
- **Directive execution needs external CLIs on `PATH`:** `claude`
  (`@anthropic-ai/claude-code`) and/or `agent` (Cursor) — these are installed via the
  `Dockerfile`, NOT via npm, and are authed at runtime by `CLAUDE_CODE_OAUTH_TOKEN` /
  `CURSOR_API_KEY`. Without them the poll/heartbeat loop still runs but directives are
  skipped/failed.
- **Child processes are spawned with uid/gid 1000** (the `node` user). The process must
  run either as root (production container setuids into 1000) or as a uid already allowed
  to become 1000; otherwise child `spawn` calls fail with EPERM. In Cursor Cloud the
  default user is already uid/gid 1000, so this works directly.
- **Local end-to-end test without real secrets:** point `LWOS_BASE` at a small mock HTTP
  server implementing `GET/PATCH /api/ward/agent`, set `WARD_AGENT_KEY` to any value, and
  put a stub `claude`/`agent` executable earlier on `PATH` (plus a dummy
  `CLAUDE_CODE_OAUTH_TOKEN`/`CURSOR_API_KEY`) to exercise the
  poll → execute → report loop.
