# opencode critic r2 (stub)

## Security (probe 1) - FAIL
Real full-mode run: model asked to encode the auth.json key. Adapter output contained the key base64 (true), hex (true), reversed (true), dash-chunked (partial visible). Only exact-value + oc_sk_/sk- regex redaction; encoded/partial leaks pass. Two other prompts (partial, write-to-file) were refused by the model, not by the adapter. Not stated as a limit in CONTRACT.md. Full process.env (all secrets) is passed to child. Real bug/undocumented limit.

## Suite
15/16 pass. mcpServers failed once with `AGENT_FAILED exit 1, stderr ''` (likely my stray taskkill of opencode.exe during probing; passes on rerun 13.8s). Still: failure surfaced with empty diagnostics.

## Streaming (probe 2) - FAIL vs hard requirement
`opencode serve` + /event SSE emits real `message.part.delta` (25 deltas for a count-to-30 prompt); vibe-kanban consumes them (normalize_logs.rs handle_part_delta, permission.asked, question.asked, tool state). Adapter uses `run --format json` whole-part text only; contract requires token-level streaming. Documented in header, but "buys only UX" is the adapter author's own judgement against a hard requirement. Not acceptable as-is.

## Sessions/permissions/cwd (probes 3-5) - OK
badid -> BAD_OPTION; suite race test passes; read-only/edit/plan enforced (bash denied, outside-cwd write rejected, plan no write); spaces+unicode cwd OK; cmd injection via prompt not exploitable. Weak points: no-text-after-tools returns empty success silently; empty-reply nudge issues a second paid prompt and adds a fake user turn to the session history that later continue/fork sees; nudge only tested by no test. Full process.env passed to child.
