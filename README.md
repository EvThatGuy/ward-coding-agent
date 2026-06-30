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

| `AGENT_ENGINE` | Behavior | Auth env |
|---|---|---|
| `claude` (default) | Claude Code only | `CLAUDE_CODE_OAUTH_TOKEN` |
| `composer` | Composer only | `CURSOR_API_KEY` |
| `composer-fallback` | **Composer first, Claude if Composer fails** | both keys |

Default models: `composer-2.5` (Composer), `sonnet` (Claude). Override per-engine with `COMPOSER_MODEL` / `CLAUDE_MODEL`, or set `AGENT_MODEL` to override both.

### Composer primary + Claude fallback

Set on Coolify:

```
AGENT_ENGINE=composer-fallback
CURSOR_API_KEY=<your-cursor-api-key>
CLAUDE_CODE_OAUTH_TOKEN=<your-claude-token>
COMPOSER_MODEL=composer-2.5   # optional
CLAUDE_MODEL=sonnet           # optional
```

Composer runs first. If it exits non-zero (auth error, timeout, crash), Ward automatically retries with Claude and logs the fallback in the PR/result.

## Deploy (Coolify / Hetzner)

Dockerfile build, no exposed port (background worker — disable the HTTP healthcheck).

### Env
| key | value |
|---|---|
| `LWOS_BASE` | `https://os.launchwisebc.com` |
| `WARD_AGENT_KEY` | the OS machine key (same as the growth-agent box) |
| `WARD_AGENT_ID` | `coding` |
| `GH_TOKEN` | GitHub PAT — contents + pull-request write (all repos) |
| `AGENT_ENGINE` | `claude`, `composer`, or `composer-fallback` (optional, default `claude`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription token (`claude setup-token`) — required for `claude` / fallback |
| `CURSOR_API_KEY` | Cursor API key — required for `composer` / fallback |
| `COMPOSER_MODEL` | `composer-2.5` / `composer-2.5-fast` (optional) |
| `CLAUDE_MODEL` | `sonnet` / `opus` (optional) |
| `AGENT_MODEL` | Sets both models if `COMPOSER_MODEL` / `CLAUDE_MODEL` unset (optional) |
| `DIRECTIVE_POLL_MS` | `20000` (optional) |

With `LWOS_BASE` + `WARD_AGENT_KEY` unset the process exits cleanly (safe no-op).
