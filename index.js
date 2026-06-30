// Ward Coding Agent — a DEDICATED executor box (Hetzner / Coolify).
//
// Polls LaunchWise OS for directives Ward has dispatched to this agent and runs
// them. Its job is engineering: for a `code` directive it clones the target repo,
// runs Claude Code as a coding agent on a fresh branch, pushes, and opens a PR for
// review (it NEVER merges to the default branch). Supports Claude Code and Cursor
// Composer (via the `agent` CLI), including Composer-first with Claude fallback.
// The GET poll doubles as a
// heartbeat so the OS shows this agent Connected. Fully env-gated: with no
// LWOS_BASE / WARD_AGENT_KEY it exits cleanly.
//
// This is separate from the UPA growth-agent box on purpose — coding work runs in
// isolation from league ops / Discord / crons, on its own schedule and resources.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.LWOS_BASE || "").replace(/\/+$/, "");
const KEY = process.env.WARD_AGENT_KEY || "";
const AGENT_ID = process.env.WARD_AGENT_ID || "coding";
const POLL_MS = parseInt(process.env.DIRECTIVE_POLL_MS || "20000", 10);
const ENGINE = (process.env.AGENT_ENGINE || "claude").toLowerCase();
const VALID_ENGINES = new Set(["claude", "composer", "composer-fallback"]);
if (!VALID_ENGINES.has(ENGINE)) {
  console.log(`[coding-agent] disabled — AGENT_ENGINE must be "claude", "composer", or "composer-fallback", got "${ENGINE}".`);
  process.exit(1);
}
const COMPOSER_MODEL = process.env.COMPOSER_MODEL || process.env.AGENT_MODEL || "composer-2.5";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || process.env.AGENT_MODEL || "sonnet";
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const CURSOR_API_KEY = process.env.CURSOR_API_KEY || "";
const RESULT_CAP = 1500;

function engineChain() {
  if (ENGINE === "composer-fallback") return ["composer", "claude"];
  return [ENGINE];
}

// Claude refuses bypassPermissions as root, so git + Claude run as the
// unprivileged `node` user (uid/gid 1000) with its own HOME. The container
// itself runs as root so it can setuid into that user.
const NODE_UID = 1000;
const NODE_GID = 1000;
const CHILD_ENV = { ...process.env, HOME: "/home/node" };

if (!BASE || !KEY) {
  console.log("[coding-agent] disabled — set LWOS_BASE + WARD_AGENT_KEY to enable.");
  process.exit(0);
}
if (!GH_TOKEN) console.log("[coding-agent] WARNING: no GH_TOKEN set — code tasks will fail until it is.");
const chain = engineChain();
if (chain.includes("composer") && !CURSOR_API_KEY) {
  console.log("[coding-agent] WARNING: Composer in engine chain but no CURSOR_API_KEY — will skip/fail Composer runs.");
}
if (chain.includes("claude") && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.log("[coding-agent] WARNING: Claude in engine chain but no CLAUDE_CODE_OAUTH_TOKEN — Claude runs may fail.");
}

const api = (path, opts = {}) =>
  fetch(`${BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });

const report = (id, body) =>
  api("/api/ward/agent", { method: "PATCH", body: JSON.stringify({ id, ...body }) }).catch((e) =>
    console.log("[coding-agent] report failed", id, e?.message),
  );

const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const clip = (s, n = RESULT_CAP) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function sh(cmd, cwd) {
  return new Promise((resolve) => {
    const c = spawn("bash", ["-c", cmd], { cwd, uid: NODE_UID, gid: NODE_GID, env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", () => resolve({ code: -1, out }));
    c.on("close", (code) => resolve({ code, out }));
  });
}

function spawnChild(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, uid: NODE_UID, gid: NODE_GID, env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(timer); resolve({ code: -1, out }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

function spawnClaude(prompt, cwd, { readOnly = false, timeoutMs, model = CLAUDE_MODEL } = {}) {
  const args = [
    "-p", prompt, "--model", model, "--permission-mode", "bypassPermissions", "--output-format", "text",
    "--allowedTools", readOnly ? "" : "Read,Write,Edit,Bash,Glob,Grep",
  ];
  const timeout = timeoutMs ?? parseInt(process.env.CODE_RUN_TIMEOUT_MS || "600000", 10);
  return spawnChild("claude", args, cwd, timeout);
}

function spawnComposer(prompt, cwd, { readOnly = false, timeoutMs, model = COMPOSER_MODEL } = {}) {
  const args = ["-p", prompt, "--model", model, "--output-format", "text", "--trust"];
  if (readOnly) args.push("--mode", "ask");
  else args.push("--force");
  const timeout = timeoutMs ?? parseInt(process.env.CODE_RUN_TIMEOUT_MS || "600000", 10);
  return spawnChild("agent", args, cwd, timeout);
}

function canRunEngine(engine) {
  if (engine === "composer") return !!CURSOR_API_KEY;
  if (engine === "claude") return !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  return false;
}

async function spawnAgent(prompt, cwd, opts = {}) {
  const engines = engineChain();
  let last = { code: -1, out: "", engine: engines.at(-1) };

  for (let i = 0; i < engines.length; i++) {
    const engine = engines[i];
    const isLast = i === engines.length - 1;

    if (!canRunEngine(engine)) {
      console.log(`[coding-agent] skipping ${engine} — missing credentials`);
      if (isLast) return { ...last, engine, skipped: true };
      continue;
    }

    console.log(`[coding-agent] running with ${engine}`);
    const result = await (engine === "composer" ? spawnComposer : spawnClaude)(prompt, cwd, opts);
    last = { ...result, engine };

    if (result.code === 0 || isLast) return last;
    console.log(`[coding-agent] ${engine} failed (code ${result.code}), trying fallback...`);
  }

  return last;
}

// ── code directive: clone → agent on a branch → push → open a PR ─────────────
async function runCode(d) {
  const repo = (d.repo || "").trim();
  if (!repo.includes("/")) return { ok: false, result: "Code task had no valid owner/repo." };
  if (!GH_TOKEN) return { ok: false, result: "Code execution needs a GH_TOKEN (contents + pull-request write) on this box." };

  const dir = mkdtempSync(join(tmpdir(), "wardcode-"));
  chmodSync(dir, 0o777); // root-created; let the node-uid git/claude write inside
  const branch = `ward/${Date.now()}`;
  const cloneUrl = `https://x-access-token:${GH_TOKEN}@github.com/${repo}.git`;
  try {
    let r = await sh(`git clone --depth 1 "${cloneUrl}" repo`, dir);
    if (r.code !== 0) return { ok: false, result: `Clone failed: ${clip(r.out, 300)}` };
    const repoDir = join(dir, "repo");
    const base = (await sh(`git rev-parse --abbrev-ref HEAD`, repoDir)).out.trim() || "main";
    await sh(`git config user.email "ward@launchwisebc.com" && git config user.name "Ward (Coding Agent)" && git checkout -b ${branch}`, repoDir);

    const prompt =
      `You are making a focused code change in the repository "${repo}" (working directory is the repo root). Task:\n\n${d.directive}\n\n` +
      `Edit the files directly. Keep the change correct, minimal, and consistent with the surrounding code. Do NOT run git, commit, or push — just make the edits. When done, briefly summarize what you changed.`;
    const agent = await spawnAgent(prompt, repoDir);
    const engineLabel = agent.engine || ENGINE;

    const status = (await sh(`git status --porcelain`, repoDir)).out.trim();
    if (!status) return { ok: true, result: `No changes were needed (${engineLabel}). ${clip(oneLine(agent.out).slice(-400))}` };

    await sh(`git add -A && git commit -m "Ward: ${oneLine(d.directive).slice(0, 70)}"`, repoDir);
    const push = await sh(`git push origin ${branch}`, repoDir);
    if (push.code !== 0) return { ok: false, result: `Push failed: ${clip(push.out, 300)}` };

    const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "ward-coding-agent" },
      body: JSON.stringify({
        title: `Ward: ${oneLine(d.directive).slice(0, 80)}`,
        head: branch,
        base,
        body: `Automated by Ward's coding agent from a dispatched directive.\n\n**Task:** ${d.directive}\n\n**Engine:** ${engineLabel}\n\n**Change notes:**\n${clip(oneLine(agent.out).slice(-800))}\n\nReview before merging — Ward never merges to ${base} unattended.`,
      }),
    });
    const pr = await prRes.json().catch(() => ({}));
    if (!prRes.ok || !pr.html_url) return { ok: false, result: `Pushed ${branch} but PR open failed: ${clip(JSON.stringify(pr), 300)}` };
    return { ok: true, result: "Opened a PR with the change for your review.", prUrl: pr.html_url };
  } catch (e) {
    return { ok: false, result: `Code task error: ${clip(String(e?.message || e))}` };
  } finally {
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── ops directive: a generic agent reasoning pass (no repo) ───────────────────
async function runGeneric(d) {
  const prompt =
    `You are Ward's coding agent. Directive from the LaunchWise OS command center: ${d.directive}\n\n` +
    `Reply with a concise, useful engineering answer (a few sentences). You have no repo checked out in this pass, so don't claim to have changed code; if it needs a real change, say which repo + change would do it. Reply with ONLY the answer text.`;
  const out = await spawnAgent(prompt, undefined, { readOnly: true, timeoutMs: parseInt(process.env.OPS_RUN_TIMEOUT_MS || "90000", 10) });
  const t = clip(oneLine(out.out).slice(-RESULT_CAP * 2));
  const engineNote = out.engine ? ` (${out.engine})` : "";
  return { ok: out.code === 0 && !!t, result: (t || "Completed.") + engineNote };
}

async function execute(d) {
  console.log(`[coding-agent] executing ${d.kind}/${d.id} → ${oneLine(d.directive).slice(0, 60)}`);
  await report(d.id, { status: "running" });
  try {
    const out = d.kind === "code" ? await runCode(d) : await runGeneric(d);
    await report(d.id, { status: out.ok ? "done" : "failed", result: out.result, resultUrl: out.prUrl });
    console.log(`[coding-agent] ${d.id} → ${out.ok ? "done" : "failed"}`);
  } catch (e) {
    await report(d.id, { status: "failed", result: clip(String(e?.message || e)) });
  }
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const res = await api(`/api/ward/agent?agent=${encodeURIComponent(AGENT_ID)}`, { method: "GET" });
    if (!res.ok) { console.log("[coding-agent] GET", res.status); return; }
    const { directives = [] } = await res.json().catch(() => ({ directives: [] }));
    for (const d of directives.filter((x) => x.agentId === AGENT_ID && x.status === "pending")) {
      await execute(d);
    }
  } catch (e) {
    console.log("[coding-agent] tick error", e?.message);
  } finally {
    ticking = false;
  }
}

console.log(`[coding-agent] online → ${BASE} as "${AGENT_ID}" every ${Math.round(POLL_MS / 1000)}s engine=${ENGINE} chain=${engineChain().join("→")}${GH_TOKEN ? " (PRs enabled)" : " (NO GH_TOKEN)"}`);
setTimeout(tick, 3000);
setInterval(tick, POLL_MS);
