# opencode critic, round 1 (verdict: theirs / fixing)

## Real bugs
1. SECURITY: key injection is unnecessary and leaks. `opencode run -m opencode-go/glm-5.3-flash` works with NO
   OPENCODE_CONFIG_CONTENT (auth.json is read natively, verified). Yet goProvider() puts the apiKey in the child env
   of every run, `models`, `session list/delete`. In permissions:'full' the model ran bash and echoed
   OPENCODE_CONFIG_CONTENT: the full `oc_sk_...` key came back in Result.text (and would go to the model provider /
   any prompt-injected exfil). Not in argv (good), not leaked in events/errors in the non-bash cases I tried.
   Fix: delete goProvider injection (only merge permission/mcp/agent), or strip the var from tool env.
2. Tests flaky/failing: 'extraArgs' got empty text; 'sessions' test failed once at "original unchanged by fork"
   (orig answered YES). Standalone fork rerun was correct (fork id differs, orig NO), so model flake or race in
   continue-without-id (mostRecentInCwd is racy under concurrency: picks by updated time).
3. effort without model is passed unvalidated (no BAD_OPTION, may be silently ignored, contract says never ignore).
4. Errors carry raw ANSI codes ("\x1b[91m\x1b[1mError:") in message for session not found.
5. Empty-text successes (no error) return text '' silently.

## Verified OK
Timeout kills tree (ping grandchild gone, TIMEOUT at ~27s for 25s); unicode+space cwd; bogus session id ->
BAD_OPTION for continue/fork; ephemeral+id, bad perm, bad mode, bad effort -> BAD_OPTION; read-only/plan cannot
write; edit mode bash denied (writes via edit tool only); outside-cwd write blocked in edit, allowed in full;
MCP test passes; fork isolates original.

## Blind comparison
vibe-kanban (opencode serve + SSE, 5k lines): token-level streaming, permission.asked events, tool state,
server password, no key handling. Ours: simpler process-per-run, whole-part text only (no token streaming),
but portable and adds jsonSchema/session modes. Reference wins on fidelity and security hygiene. Verdict: theirs.
