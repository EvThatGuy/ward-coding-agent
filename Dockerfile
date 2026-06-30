# Ward's dedicated coding-agent box (Coolify / Hetzner).
# Runs as root so it can setuid into the unprivileged `node` user for git + Claude
# (Claude refuses --permission-mode bypassPermissions as root). No web port — it's
# a background worker that polls LaunchWise OS.
FROM node:22-bookworm-slim

# git for clone/commit/push, build tools in case a cloned repo's tooling needs them,
# ca-certificates for HTTPS to GitHub + the OS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI — default coding brain (authed by CLAUDE_CODE_OAUTH_TOKEN at runtime).
RUN npm install -g @anthropic-ai/claude-code

# Cursor Agent CLI (Composer) — optional engine (authed by CURSOR_API_KEY at runtime).
# Installed into the node user's HOME so setuid child processes can find `agent`.
RUN mkdir -p /home/node \
  && HOME=/home/node bash -c 'curl https://cursor.com/install -fsS | bash' \
  && chown -R node:node /home/node

WORKDIR /app
COPY package.json ./
COPY index.js ./

# The `node` user (uid/gid 1000) ships in the base image; give it a writable HOME
# for git config + Claude. The container stays root (CMD has no USER) so the worker
# can setuid into node for child processes.
RUN mkdir -p /home/node && chown -R node:node /home/node /app
ENV HOME=/home/node
ENV PATH="/home/node/.local/bin:${PATH}"
ENV NODE_ENV=production

CMD ["node", "index.js"]
