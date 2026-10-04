# Critic: claude adapter (round 1)

Verdict: TIE (blind-compared vs ai-sdk-provider-claude-code and claude-code-acp; theirs = SDK-based, richer; ours = leaner CLI driver, all 15 tests pass, 160s)

## Verified OK
15/15 acceptance pass. Probed: effort max ok; bogus effort/permissions/session.mode -> BAD_OPTION (in index.mjs); resume unknown id -> AGENT_FAILED "No conversation found"; bad model -> AGENT_FAILED; bad cwd -> BAD_OPTION; plan/ro do not write; ro cannot Bash; timeout/abort ~0.4s; 3 concurrent fork -> 3 distinct ids; concurrent continue same id all answer.
Empty ANTHROPIC_API_KEY: init shows apiKeySource "none" (subscription) - claim TRUE. A bogus non-empty key HUNG >100s, so stripping is essential (and o.env is spread AFTER? no: env spread then key blanked, so o.env cannot re-inject key - fine).

## Bugs
1. READ-ONLY NOT ENFORCED FOR MCP. `--tools Read,...` only restricts built-ins. Repro: run `claude -p --tools Read,Glob,Grep,WebFetch,WebSearch --output-format stream-json --verbose` and read init.tools: includes mcp__claude_ai_Claude_Docs__create/update/delete (user's connectors, plus any user/plugin MCP). read-only can mutate external state. Needs --strict-mcp-config with empty config (or --disallowedTools mcp__*) when no mcpServers given.
2. Loads full user environment (hooks, plugins, CLAUDE.md, 39 tools, plugin MCP servers pending). Slow (6s for PONG) and nondeterministic across machines; no --bare / --setting-sources isolation option.
3. Adapter.run does not validate options itself (BAD_OPTION only via index.mjs); direct adapter use with permissions:'bogus' silently falls to read-only.
4. Ephemeral emits a session event/sessionId that is unresumable (test confirms AGENT_FAILED); Result.sessionId should be undefined for ephemeral or documented.
5. continue/fork WITHOUT id and no prior session silently creates a fresh session (no error) - contract says "most recent in cwd"; silent success hides the mismatch.
6. NOT_LOGGED_IN regex /401|api key|credential/ can misclassify unrelated errors (any text containing "401").
7. Concurrent continue on the same id appends to one session file from 3 processes - no lock/serialization; result ordering undefined.
8. Effort 'xhigh' (supported by refs) not exposed; models() static list (hardcoded 'claude-*-4-5' ids will rot).
9. Tool events: tool results emitted as {name, input:undefined, output}; input and output never on the same event.

## Biggest gap
Permission enforcement is incomplete (MCP tools bypass read-only) and models() is not discovered; reference uses SDK-level permission callbacks, validated resume ids, model discovery.
