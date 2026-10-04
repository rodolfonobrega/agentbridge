# Acceptance results

Generated: 2026-10-03T14:49:01.706Z

| file | result | tests | pass | fail | time |
|---|---|---|---|---|---|
| registry.test.mjs | PASS | 6 | 6 | 0 | 6.9s |
| registry2.test.mjs | PASS | 4 | 4 | 0 | 27.0s |
| core.test.mjs | PASS | 30 | 29 | 0 | 10.8s |
| cli.test.mjs | PASS | 21 | 21 | 0 | 74.5s |
| endpoint.test.mjs | PASS | 14 | 14 | 0 | 129.7s |
| context.test.mjs | PASS | 8 | 8 | 0 | 199.3s |
| telemetry.test.mjs | PASS | 11 | 11 | 0 | 37.3s |
| hooks.test.mjs | PASS | 7 | 7 | 0 | 10.3s |
| extras.test.mjs | PASS | 15 | 15 | 0 | 44.3s |
| proxy.test.mjs | PASS | 24 | 24 | 0 | 151.2s |
| keydelivery.test.mjs | PASS | 5 | 5 | 0 | 62.2s |
| bridge.test.mjs | PASS | 15 | 15 | 0 | 128.1s |
| pairs.test.mjs | FAIL | 15 | 14 | 1 | 841.5s |

**Total: tests=175 pass=173 fail=1 — FAILURES PRESENT**

## pairs.test.mjs (failed)
```
✔ initialize + tools/list schema (89.7336ms)
✔ recursion guard (direct) (86.1287ms)
✔ permission clamp: every parent x requested level (0.7309ms)
✔ errors: bad args / escalation / unknown run (91.8645ms)
✔ mcpConfigFor shape (1.0814ms)
✔ attestation: verifies only with the launcher key; callee-forged meta lines are rejected (1.7393ms)
[claude->claude] attempts=1 tools=["mcp__agentbridge__ask_claude","mcp__agentbridge__ask_claude"] meta={"agent":"claude","sessionId":"06f98e3e-1487-4156-ad03-3c9c848b55ee","depth":1,"model":"claude-haiku-4-5-20251001","textSha":"2cf184be493b9b0f5b9990b2385b86328297d38621f357d6499b19f81c59b94d","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"9ad88866032f1213ecc55fd3","callId":"7eeb57a4-a717-447c-95da-32c2beff2f34","hmac":"6a7811f462e51ea86800362b794dc3f7f84ffc9fc179fd9bf9c7a295cdeb468c"} text="TOK-4daa1dae9a96"
✔ pair claude -> claude (9847.3673ms)
[claude->codex] attempts=1 tools=["mcp__agentbridge__ask_codex","mcp__agentbridge__ask_codex"] meta={"agent":"codex","sessionId":"01a10230-c8b1-7a32-a3cd-924ca8471d8d","depth":1,"model":"gpt-5.6-luna","textSha":"4b7ec06741695a05d9197db94b133732d3c6cfb5c52f01b20977122963252291","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"832c23fc7eb42cf10b293a7d","callId":"241b2b15-8394-422c-9a58-6396fac53da1","hmac":"dc4cb225e4443e907d5bd1ddece2eeb7d2d465500716cb8de02e266e76a0bf9e"} text="TOK-7f47fb7c95a8"
✔ pair claude -> codex (17425.654ms)
[claude->opencode] attempts=1 tools=["mcp__agentbridge__ask_opencode","mcp__agentbridge__ask_opencode"] meta={"agent":"opencode","sessionId":"ses_efdcedfaaffeveHhzgFKL5JPP1","depth":1,"model":"opencode-go/glm-5.3-flash","textSha":"d8e9739aac2e7d49e123b2bb5062c7938ffd1854ca7154fb0b441122debb0acc","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"ef6ac3c4a484fd84c7ea647d","callId":"9ecda460-ad77-4bf7-817b-997854e63ee8","hmac":"23b3e2d71509bc24b4bfd50206d62fe4296b73d3dc181cd9a5b13baf77dea7c8"} text="TOK-c5bfdcedc0b9"
✔ pair claude -> opencode (74496.5341ms)
[codex->claude] attempts=1 tools=["agentbridge.ask_claude"] meta={"agent":"claude","sessionId":"937d9904-6759-447d-b70a-dd0709f1e7ad","depth":1,"model":"claude-haiku-4-5-20251001","textSha":"9948dde4e1325b82ce3454266c2e6dfbaac00a8dd101853df4c8ef359839eb92","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"7ba1cc4732a816e092d6ab53","callId":"8d62e2df-7cc7-48b7-9882-ce5845813f32","hmac":"af8d3f7b1dd96e1ad0453d8306e789c26ed00df9b6c57f1d1fde9f3a3e0fa97b"} text="TOK-f27f122c8370[agentbridge] {\"agent\":\"claude\",\"sessionId\":\"937d9904-6759-447d-"
✔ pair codex -> claude (24681.0703ms)
[codex->codex] attempts=1 tools=["agentbridge.ask_codex"] meta={"agent":"codex","sessionId":"01a10232-a04d-7f43-8081-56d2ea977676","depth":1,"model":"gpt-5.6-luna","textSha":"49d93c6351d0f6d749af378c7105360e9574caa73b6e7e5510db39892447f0c0","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"784ae65461db47ecfd10a1ac","callId":"1f8d3385-4df9-4bd9-9cc7-8668a185863a","hmac":"51967b7ac14e30aacef40f43469a1fb00b82663c214b710a56add24f7ecb8ae8"} text="TOK-7002e9e11750[agentbridge] {\"agent\":\"codex\",\"sessionId\":\"01a10232-a04d-7f43-8"
✔ pair codex -> codex (27103.9149ms)
[codex->opencode] attempts=1 tools=["agentbridge.ask_opencode"] meta=null text="tool call failed: timed out awaiting tools/call after 300s"
✖ pair codex -> opencode (318597.2391ms)
[opencode->claude] attempts=1 tools=["agentbridge_ask_claude","agentbridge_ask_claude"] meta={"agent":"claude","sessionId":"32018804-6c12-459b-ad21-8e73877d98ab","depth":1,"model":"claude-haiku-4-5-20251001","textSha":"9c00d304edbcf3fd03e4ef6a72aace508e2e8dbc9bec2fa903d4f427e31fafe5","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"63bba024f9ae0dd5d756fb29","callId":"f6629e6a-47b0-4570-a8a1-a15792095b15","hmac":"3fc6d76cc697e7ade74191a8c66e5658e240759b7f7203dc188ee2ff5520f80b"} text="TOK-6dc278593e5d\n\n[agentbridge] {\"agent\":\"claude\",\"sessionId\":\"32018804-6c12-459"
✔ pair opencode -> claude (13690.0786ms)
[opencode->codex] attempts=1 tools=["agentbridge_ask_codex","agentbridge_ask_codex"] meta={"agent":"codex","sessionId":"01a10238-4fd5-7222-b865-9c8ffc23a9bb","depth":1,"model":"gpt-5.6-luna","textSha":"864115bd5d2fa2607e262bbd904026144142dbf3751c0758bf40c6a61860b531","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"77765b038ae67cf2e2abc21f","callId":"0e1a3c8f-21d7-4cf9-b323-37d0adfb033b","hmac":"036eed6d5dc942faea9beef06bb902deb14ef234fb4f03e3b40858f71cd497eb"} text="TOK-cfd608e44784\n\n[agentbridge] {\"agent\":\"codex\",\"sessionId\":\"01a10238-4fd5-7222"
✔ pair opencode -> codex (35220.1126ms)
[opencode->opencode] attempts=1 tools=["agentbridge_ask_opencode","agentbridge_ask_opencode"] meta={"agent":"opencode","sessionId":"ses_efdc2b77cffeI0YORc07iQu6Q6","depth":1,"model":"opencode-go/glm-5.3-flash","textSha":"4fa314edcfb48d9f6f09143e5453637133fa52d308a3dbb232edf94c36c29662","promptSha":"86df45bab66e27867fb4db9fb45165eb5e3313fad779de0be01457d6adb03618","bind":"8f994bb389cb4d657454b9e1","callId":"15bbef3a-161d-4235-be07-4a7547a531aa","hmac":"d319f6ff57165ec49d2ecea326e743c4b666952a614a5dea938fb1ced925845a"} text="TOK-f585f6cec75d"
✔ pair opencode -> opencode (316962.4491ms)
ℹ tests 15
ℹ suites 0
ℹ pass 14
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 841418.3718

✖ failing tests:

test at acceptance\pairs.test.mjs:101:3
✖ pair codex -> opencode (318597.2391ms)
  AssertionError [ERR_ASSERTION]: ask_opencode must SUCCEED with a VERIFIED server attestation: ["{\"message\":\"tool call error: tool call failed for `agentbridge/ask_opencode`\\n\\nCaused by:\\n    timed out awaiting tools/call after 300s\"}"]
      at TestContext.<anonymous> (./acceptance/pairs.test.mjs:110:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }

```
