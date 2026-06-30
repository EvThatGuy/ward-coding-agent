# Ward Coding Agent

A **dedicated** executor box for Ward (LaunchWise OS). It polls the OS for
directives dispatched to the `coding` agent and carries them out — its specialty
is engineering:

- **`code` directive** → clones the target repo, runs a coding agent on a fresh
  `ward/<ts>` branch, pushes, and opens a **pull request** for review. It never
  merges to the default branch.
- **`ops` directive** → a generic agent reasoning pass (answers / recommendations).

The `GET /api/ward/agent?agent=coding` poll doubles as a **heartbeat**, so the OS
shows this agent **Connected**. Runs in isolation from the UPA growth-agent box, so
coding work doesn't compete with league ops / Discord / crons.

## Coding engines

Pick the agent backend with `AGENT_ENGINE`:

| `AGENT_ENGINE` | CLI | Auth env | Default model |
|---|---|---|---|
| `claude` (default) | Claude Code (`claude`) | `CLAUDE_CODE_OAUTH_TOKEN` | `sonnet` |
| `composer` | Cursor Agent (`agent`) | `CURSOR_API_KEY` | `composer-2.5` |

Override the model with `AGENT_MODEL` (e.g. `composer-2.5-fast`, `opus`).

## Deploy (Coolify / Hetzner)

Dockerfile build, no exposed port (background worker — disable the HTTP healthcheck).

### Env
| key | value |
|---|---|
| `LWOS_BASE` | `https://os.launchwisebc.com` |
| `WARD_AGENT_KEY` | the OS machine key (same as the growth-agent box) |
| `WARD_AGENT_ID` | `coding` |
| `GH_TOKEN` | GitHub PAT — contents + pull-request write (all repos) |
| `AGENT_ENGINE` | `claude` or `composer` (optional, default `claude`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription token (`claude setup-token`) — required when `AGENT_ENGINE=claude` |
| `CURSOR_API_KEY` | Cursor API key — required when `AGENT_ENGINE=composer` |
| `AGENT_MODEL` | `sonnet` / `composer-2.5` / etc. (optional) |
| `DIRECTIVE_POLL_MS` | `20000` (optional) |

With `LWOS_BASE` + `WARD_AGENT_KEY` unset the process exits cleanly (safe no-op).
