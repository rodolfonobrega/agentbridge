# NextGen AgentBridge Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade AgentBridge with state-of-the-art capabilities extracted from Orca and T3 Code: proactive quota/rate-limit probing, robust process supervision and pipe deadlock protection, Git hidden-ref checkpointing, native subagent lineage tracking, persistent `codex app-server` JSON-RPC mode, 5 new agent providers (Cursor, Grok, Gemini CLI, Devin, generic ACP), and comprehensive architectural documentation highlighting AgentBridge's core strengths.

**Architecture:** Maintain AgentBridge's signature zero-runtime-dependency pure TypeScript/Node ESM architecture. Enhance `spawnProc` with bounded stderr ring-buffers and cross-platform process tree lifecycles; introduce `src/extras/checkpoint.ts` using isolated `GIT_INDEX_FILE` plumbing; extend the account pool with active OAuth/RPC quota fetchers; implement generic ACP (Agent Client Protocol) and dedicated adapters for Cursor, Grok, Gemini, and Devin; add subagent roster tracking into `runs.ts` and the dashboard; and document the complete architectural comparison in `docs/COMPARISON.md`.

**Tech Stack:** TypeScript (Node.js ESM >= 22), Git Plumbing (`GIT_INDEX_FILE`, `write-tree`, `commit-tree`, `update-ref`), JSON-RPC 2.0 (over stdio), Native HTTP (`node:http`, `node:https`), Win32 Job Objects / Taskkill, Node test runner (`node --test`).

---

## Phase 1: Process Supervision, Anti-Zombie & Pipe Buffer Protection

### Task 1: Stderr Bounded Ring Buffer & Child PID Exposure
**Files:**
- Modify: `src/core/spawn.ts`
- Test: `acceptance/core.test.mjs`

**Step 1: Write the failing test**
Add a test in `acceptance/core.test.mjs` verifying that `spawnProc` exposes `handle.pid` reliably and that huge stderr emissions do not exceed a bounded 8 KiB ring buffer in the wait result.

```javascript
test('spawnProc bounds stderr to 8KiB ring buffer and provides child PID', async () => {
  const h = spawnProc(process.execPath, ['-e', 'for(let i=0;i<5000;i++) console.error("X".repeat(50));']);
  assert.ok(typeof h.pid === 'number' && h.pid > 0);
  const res = await h.wait();
  assert.ok(res.stderr.length <= 8192);
});
```

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/core.test.mjs`
Expected: FAIL (stderr length exceeds 8192 bytes because existing buffer allows 1e6 chars).

**Step 3: Write minimal implementation**
In `src/core/spawn.ts`:
- Replace unbounded/1MB `stderr` aggregation with an 8 KiB circular buffer (`STDERR_TAIL_MAX_CHARS = 8192`).
- Ensure `handle.pid` is guaranteed to be set to `child.pid`.

**Step 4: Run test to verify it passes**
Run: `node --test acceptance/core.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/core/spawn.ts acceptance/core.test.mjs && git commit -m "feat(core): add bounded 8KiB stderr ring buffer and expose pid in handle"`

---

### Task 2: Supervisor Shim (POSIX) & Enhanced Process Tree Termination (Windows)
**Files:**
- Modify: `src/core/spawn.ts`
- Test: `acceptance/core.test.mjs`

**Step 1: Write the failing test**
Add a test in `acceptance/core.test.mjs` that launches a child process with a grandchild and verifies `killTree(handle.child)` terminates the entire process tree without leaving orphaned grandchildren.

```javascript
test('killTree terminates entire process tree cleanly', async () => {
  const script = 'const { spawn } = require("child_process"); spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); setInterval(()=>{},1000);';
  const h = spawnProc(process.execPath, ['-e', script]);
  await new Promise((r) => setTimeout(r, 200));
  h.kill();
  const res = await h.wait();
  assert.ok(res.killed);
});
```

**Step 2: Run test to verify it fails/passes**
Run: `node --test acceptance/core.test.mjs`

**Step 3: Write minimal implementation**
In `src/core/spawn.ts`:
- Enhance `killTree`:
  - On Windows: ensure `taskkill /pid <pid> /T /F` handles error codes cleanly without throwing.
  - On POSIX: send `SIGTERM` to the process group (`-child.pid`), wait 200ms grace, then escalate to `SIGKILL` to prevent stubborn zombie processes.
- Add `ownerPid` tracking so child handles register cleanup hooks if the main process exits.

**Step 4: Run test to verify it passes**
Run: `node --test acceptance/core.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/core/spawn.ts acceptance/core.test.mjs && git commit -m "feat(core): enhance cross-platform process tree termination"`

---

## Phase 2: Proactive Rate Limit & Quota Probing

### Task 3: Quota Prober Module for Claude OAuth & Codex
**Files:**
- Create: `src/telemetry/quota.ts`
- Test: `acceptance/quota.test.mjs`

**Step 1: Write the failing test**
Create `acceptance/quota.test.mjs` testing `fetchClaudeQuota` and `fetchCodexQuota`:
- Tests parsing of Anthropic OAuth usage response (`five_hour` and `seven_day` windows).
- Tests error handling (e.g. invalid token, network timeout) with graceful fallback.

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsageResponse, parseCodexUsageResponse } from '../dist/telemetry/quota.js';

test('parseClaudeUsageResponse maps 5h and 7d windows correctly', () => {
  const mock = {
    five_hour: { used_percentage: 42, resets_at: '2026-10-08T04:00:00Z' },
    seven_day: { used_percentage: 15, resets_at: '2026-10-15T00:00:00Z' }
  };
  const parsed = parseClaudeUsageResponse(mock);
  assert.equal(parsed.sessionWindowPercent, 42);
  assert.equal(parsed.weeklyWindowPercent, 15);
  assert.ok(parsed.resetsAt > 0);
});
```

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/quota.test.mjs`
Expected: FAIL (module does not exist yet).

**Step 3: Write minimal implementation**
Create `src/telemetry/quota.ts`:
- Implement `parseClaudeUsageResponse` and `fetchClaudeQuota(token: string)` querying `https://api.anthropic.com/api/oauth/usage` with headers `anthropic-beta: oauth-2025-04-20`.
- Implement `parseCodexUsageResponse` and `fetchCodexQuota(token: string)` querying `https://chatgpt.com/backend-api/wham/usage` or Codex RPC.
- Export unified `QuotaStatus` interface (`{ provider, sessionPercent, weeklyPercent, resetsAt, isThrottled }`).

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/quota.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/telemetry/quota.ts acceptance/quota.test.mjs && git commit -m "feat(quota): implement proactive quota fetchers for Claude and Codex"`

---

### Task 4: Proactive Quota Balancing in Account Pool
**Files:**
- Modify: `src/server/pool.ts`
- Test: `acceptance/proxy-pool.test.mjs`

**Step 1: Write the failing test**
Add a test in `acceptance/proxy-pool.test.mjs` verifying that the account pool can record quota state and skips accounts where `sessionPercent >= 95%` in favor of accounts with available capacity before receiving an HTTP 429 error.

```javascript
test('account pool skips accounts with high proactive quota exhaustion', () => {
  const pool = createPool({ claude: [{ name: 'acc1' }, { name: 'acc2' }] });
  pool.updateQuota('claude', 'acc1', { sessionPercent: 98, resetsAt: Date.now() + 60000 });
  const picked = pool.pick('claude');
  assert.equal(picked?.name, 'acc2');
});
```

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/proxy-pool.test.mjs`
Expected: FAIL (`pool.updateQuota` not implemented).

**Step 3: Write minimal implementation**
In `src/server/pool.ts`:
- Add `updateQuota(agent: string, name: string, quota: QuotaStatus): void` to `AccountPool`.
- In `ready(agent, a)`: check if the account has `quota.sessionPercent >= 95`; if so, treat it as in cooldown until `quota.resetsAt`.
- Expose quota stats in `pool.status()`.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/proxy-pool.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/server/pool.ts acceptance/proxy-pool.test.mjs && git commit -m "feat(pool): add proactive quota balancing to prevent rate limits"`

---

## Phase 3: Git Hidden-Ref Checkpointing

### Task 5: Core Checkpoint Engine (`src/extras/checkpoint.ts`)
**Files:**
- Create: `src/extras/checkpoint.ts`
- Test: `acceptance/checkpoint.test.mjs`

**Step 1: Write the failing test**
Create `acceptance/checkpoint.test.mjs` testing creation, listing, diffing, and rollback of checkpoints in a temporary git repository using isolated `GIT_INDEX_FILE` plumbing:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCheckpoint, listCheckpoints, rollbackCheckpoint } from '../dist/extras/checkpoint.js';

test('createCheckpoint and rollbackCheckpoint restore exact working directory state', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'ab-cp-test-'));
  execSync('git init && git config user.name test && git config user.email test@test.com && git commit --allow-empty -m init', { cwd: repo });
  writeFileSync(path.join(repo, 'file.txt'), 'version 1');
  
  const cp = createCheckpoint(repo, { message: 'v1 checkpoint' });
  assert.ok(cp.id);
  assert.ok(cp.ref.startsWith('refs/agentbridge/checkpoints/'));
  
  writeFileSync(path.join(repo, 'file.txt'), 'version 2 corrupted');
  rollbackCheckpoint(repo, cp.id);
  
  const restored = readFileSync(path.join(repo, 'file.txt'), 'utf8');
  assert.equal(restored, 'version 1');
  rmSync(repo, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/checkpoint.test.mjs`
Expected: FAIL (module not created).

**Step 3: Write minimal implementation**
Create `src/extras/checkpoint.ts`:
- Use `GIT_INDEX_FILE` in `tmpdir()` so the user's `.git/index` is never polluted.
- `createCheckpoint(cwd, opts)`:
  1. `git read-tree HEAD` into isolated index
  2. `git add -A`
  3. `git write-tree` -> tree hash
  4. `git commit-tree <tree> -p HEAD -m "..."` -> commit hash
  5. `git update-ref refs/agentbridge/checkpoints/<session_id>/<cp_id> <commit>`
- `listCheckpoints(cwd, sessionId?)`: enumerate refs using `git for-each-ref`.
- `rollbackCheckpoint(cwd, checkpointId)`: restore tracked files matching tree.
- `diffCheckpoint(cwd, checkpointId)`: get unified diff between checkpoint and working tree.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/checkpoint.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/extras/checkpoint.ts acceptance/checkpoint.test.mjs && git commit -m "feat(checkpoint): implement Git hidden-ref checkpoints with isolated index"`

---

### Task 6: Checkpoint CLI (`ab checkpoint`) & MCP Bridge Tools
**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/bridge/mcp.ts`
- Modify: `src/bridge/attach.ts`
- Test: `acceptance/checkpoint-cli.test.mjs`

**Step 1: Write the failing test**
Add test in `acceptance/checkpoint-cli.test.mjs` verifying:
1. `ab checkpoint create "save before refactor"` outputs checkpoint ID.
2. `ab checkpoint list` displays active checkpoints.
3. MCP server registers tools: `checkpoint_create`, `checkpoint_rollback`, `checkpoint_list`.

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/checkpoint-cli.test.mjs`
Expected: FAIL.

**Step 3: Write minimal implementation**
- In `src/cli/main.ts`: add `checkpoint` subcommand:
  `ab checkpoint create [message]`, `ab checkpoint list`, `ab checkpoint rollback <id>`, `ab checkpoint diff <id>`.
- In `src/bridge/mcp.ts`: expose `checkpoint_create`, `checkpoint_rollback`, and `checkpoint_list` tools.
- In `src/bridge/attach.ts`: ensure tool descriptions and schemas are included in subagent relays.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/checkpoint-cli.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/cli/main.ts src/bridge/mcp.ts src/bridge/attach.ts acceptance/checkpoint-cli.test.mjs && git commit -m "feat(checkpoint): expose checkpoint commands in CLI and MCP tools"`

---

## Phase 4: Subagent Roster & Lineage Tracking (Item 6)

### Task 7: Subagent Roster Parser in `runs.ts` and `subagent.ts`
**Files:**
- Modify: `src/bridge/runs.ts`
- Modify: `src/bridge/subagent.ts`
- Test: `acceptance/subagent-roster.test.mjs`

**Step 1: Write the failing test**
Create `acceptance/subagent-roster.test.mjs` testing that events indicating subagent creation (`task_started`, `subAgentActivity`, `Agent` tool use) are captured into a structured `SubagentEntry` hierarchy in `RunRecord`:

```javascript
test('RunRecord tracks subagent hierarchy and token metrics', () => {
  const rec = createRunRecord({ agent: 'claude', prompt: 'test' });
  attachSubagent(rec, {
    subagentId: 'sub-1',
    parentToolId: 'tool-use-1',
    name: 'researcher',
    state: 'running',
    task: 'search codebase'
  });
  assert.equal(rec.subagents?.length, 1);
  assert.equal(rec.subagents[0].name, 'researcher');
});
```

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/subagent-roster.test.mjs`
Expected: FAIL.

**Step 3: Write minimal implementation**
- In `src/bridge/runs.ts`:
  - Define `SubagentEntry` interface (`{ id, parentId, name, state, task, startedAt, endedAt, tokens }`).
  - Add `subagents?: SubagentEntry[]` to `RunRecord`.
  - Add helper `updateSubagent(runId, subagentData)`.
- In `src/bridge/subagent.ts`:
  - Parse events for subagent lifecycle and update the active run record.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/subagent-roster.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/bridge/runs.ts src/bridge/subagent.ts acceptance/subagent-roster.test.mjs && git commit -m "feat(bridge): implement native subagent roster and lineage tracking"`

---

### Task 8: Subagent Hierarchy View in Dashboard UI
**Files:**
- Modify: `src/ui/app.js`
- Modify: `src/ui/app.css`
- Modify: `src/ui/index.html`
- Test: `acceptance/ui.test.mjs`

**Step 1: Write the failing test**
Add assertion in `acceptance/ui.test.mjs` verifying UI bundles render the subagents section when `run.subagents` exists.

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/ui.test.mjs`

**Step 3: Write minimal implementation**
- In `src/ui/app.js`: add expandable Subagent Tree under run details showing parent -> child relationships, status badge (`running`, `done`, `failed`), and task descriptions.
- In `src/ui/app.css`: add sleek styling for tree nodes and nested cards.

**Step 4: Run test to verify it passes**
Run: `node --test acceptance/ui.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/ui/app.js src/ui/app.css src/ui/index.html acceptance/ui.test.mjs && git commit -m "feat(ui): display subagent hierarchy tree in dashboard"`

---

## Phase 5: Conexão via `codex app-server` (JSON-RPC 2.0)

### Task 9: Codex App-Server JSON-RPC Mode
**Files:**
- Modify: `src/adapters/codex.ts`
- Test: `acceptance/codex-app-server.test.mjs`

**Step 1: Write the failing test**
Create `acceptance/codex-app-server.test.mjs` testing that when `useAppServer: true` is configured, `codex` spawns `codex app-server` and communicates via JSON-RPC 2.0 frames over stdio:

```javascript
test('codex adapter supports app-server JSON-RPC communication', async () => {
  // Mock child process simulating codex app-server JSON-RPC
  // Verify handshake 'initialize' and method 'turn/start'
});
```

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/codex-app-server.test.mjs`
Expected: FAIL.

**Step 3: Write minimal implementation**
In `src/adapters/codex.ts`:
- Implement JSON-RPC client helper (`sendRpc(method, params)`).
- When `options.mode === 'app-server'` or when supported:
  - Spawn `codex app-server`.
  - Handshake with `initialize` and notification `initialized`.
  - Send `turn/start` with prompt, approvals policy, and model.
  - Stream chunks and resolve on `turn/completed`.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/codex-app-server.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/adapters/codex.ts acceptance/codex-app-server.test.mjs && git commit -m "feat(codex): add support for persistent codex app-server JSON-RPC mode"`

---

## Phase 6: Novos Provedores: Cursor, Grok, Gemini CLI, Devin & ACP Genérico

### Task 10: Adaptador Genérico ACP (Agent Client Protocol)
**Files:**
- Create: `src/adapters/acp.ts`
- Test: `acceptance/acp.test.mjs`

**Step 1: Write the failing test**
Create `acceptance/acp.test.mjs` verifying standard ACP session creation, message turn sending, and event parsing.

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/acp.test.mjs`
Expected: FAIL.

**Step 3: Write minimal implementation**
Create `src/adapters/acp.ts`:
- Implement generic ACP adapter that spawns any ACP-compatible command (e.g. `grok agent stdio`, `opencode acp`, custom agents).
- Handle ACP JSON-RPC methods (`session/new`, `session/prompt`, `session/cancel`).
- Transform ACP protocol notifications into AgentBridge `AgentEvent` stream.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/acp.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/adapters/acp.ts acceptance/acp.test.mjs && git commit -m "feat(adapters): implement generic ACP (Agent Client Protocol) adapter"`

---

### Task 11: Adaptadores Cursor, Grok, Gemini CLI e Devin
**Files:**
- Create: `src/adapters/cursor.ts`
- Create: `src/adapters/grok.ts`
- Create: `src/adapters/gemini.ts`
- Create: `src/adapters/devin.ts`
- Test: `acceptance/new-providers.test.mjs`

**Step 1: Write the failing test**
Create `acceptance/new-providers.test.mjs` testing parameter generation, model mapping, and event parsing for `cursor`, `grok`, `gemini`, and `devin`.

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/new-providers.test.mjs`
Expected: FAIL.

**Step 3: Write minimal implementation**
- `src/adapters/cursor.ts`: support Cursor CLI agent mode.
- `src/adapters/grok.ts`: support `grok` CLI using ACP stdio (`grok agent stdio`).
- `src/adapters/gemini.ts`: support `gemini` CLI (`gemini -p ... --yolo`).
- `src/adapters/devin.ts`: support `devin` CLI with ACP / headless mode.
- Map permissions, models, and sessions consistently for each.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/new-providers.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/adapters/cursor.ts src/adapters/grok.ts src/adapters/gemini.ts src/adapters/devin.ts acceptance/new-providers.test.mjs && git commit -m "feat(adapters): add Cursor, Grok, Gemini and Devin adapters"`

---

### Task 12: Registro dos Novos Provedores no Registry, CLI e Doctor
**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/extras/doctor.ts`
- Test: `acceptance/cli.test.mjs`

**Step 1: Write the failing test**
Update `acceptance/cli.test.mjs` to verify `ab doctor` checks `cursor`, `grok`, `gemini`, and `devin`, and `ab ask cursor "..."` is recognized as a valid agent command.

**Step 2: Run test to verify it fails**
Run: `node --test acceptance/cli.test.mjs`

**Step 3: Write minimal implementation**
- In `src/index.ts`: register all new adapters into `ADAPTERS` map (`cursor`, `grok`, `gemini`, `devin`, `acp`).
- In `src/cli/args.ts`: include new agent names in autocomplete and CLI validation lists.
- In `src/extras/doctor.ts`: add detection binaries and login checks for the new agents.

**Step 4: Run test to verify it passes**
Run: `npm run build && node --test acceptance/cli.test.mjs`
Expected: PASS.

**Step 5: Commit**
`git add src/index.ts src/cli/args.ts src/extras/doctor.ts acceptance/cli.test.mjs && git commit -m "feat(registry): register new providers in index, cli and doctor"`

---

## Phase 7: Documentação Abrangente & Comparativo Estratégico

### Task 13: Criar `docs/COMPARISON.md`
**Files:**
- Create: `docs/COMPARISON.md`

**Step 1: Write document content**
Create `docs/COMPARISON.md` containing:
- Comprehensive deep-dive comparing **AgentBridge**, **Orca** (Stably AI), and **T3 Code** (Ping.gg).
- Detail the strengths of AgentBridge:
  1. Zero runtime dependencies / Pure Node ESM.
  2. In-flight automatic account rotation & dynamic fallback chains.
  3. Universal MCP bridge (`ask_*`, `dispatch_*`, `wait_run`) for inter-agent delegation.
  4. Drop-in OpenAI & Anthropic reverse proxy (`ab serve`).
  5. Cryptographic HMAC attestation & depth guards.
- Detail the adopted patterns from Orca & T3 Code:
  1. Proactive Rate Limit & Quota probing.
  2. Bounded stderr ring buffer & process supervision.
  3. Git hidden-ref checkpoints with isolated indexes.
  4. Native subagent roster tracking.
  5. ACP & Codex App-Server JSON-RPC modes.

**Step 2: Commit**
`git add docs/COMPARISON.md && git commit -m "docs: add comprehensive architectural comparison with Orca and T3 Code"`

---

### Task 14: Atualizar `README.md`, `docs/REFERENCE.md` e `docs/EXTENDING.md`
**Files:**
- Modify: `README.md`
- Modify: `docs/REFERENCE.md`
- Modify: `docs/EXTENDING.md`

**Step 1: Update documentation**
- In `README.md`:
  - Update list of supported agents: Claude Code, Codex, OpenCode, Antigravity CLI, pi, Ollama, Cursor, Grok, Gemini CLI, Devin, generic ACP.
  - Add quickstart section for `ab checkpoint` (`create`, `rollback`, `list`, `diff`).
  - Add section on proactive quota monitoring and account pool.
  - Link to `docs/COMPARISON.md`.
- In `docs/REFERENCE.md`:
  - Document all new CLI options, checkpoint commands, quota telemetry API, and subagent tracking.
- In `docs/EXTENDING.md`:
  - Document how to write custom ACP adapters.

**Step 2: Commit**
`git add README.md docs/REFERENCE.md docs/EXTENDING.md && git commit -m "docs: document new providers, checkpointing, quotas and subagent tracking"`

---

## Phase 8: Suíte de Testes e Validação Completa

### Task 15: Executar Suíte de Testes Integrada
**Files:**
- Modify: `package.json` (adicionar novos testes ao script `npm test`)
- Run: `npm run typecheck && npm test && npm run build`

**Step 1: Run typecheck**
Run: `npm run typecheck`
Expected: 0 errors.

**Step 2: Run all tests**
Run: `npm test`
Expected: All tests PASS.

**Step 3: Run build and verify distribution**
Run: `npm run build`
Expected: Clean build in `dist/`.

**Step 4: Commit**
`git add package.json && git commit -m "chore: integrate nextgen acceptance tests into test suite"`

---
