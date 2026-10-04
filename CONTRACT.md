# agentbridge contract (all builders MUST follow)

Plain Node ESM (.mjs), zero build step, Node >= 22. No API keys: drive the *installed* CLIs
(`claude`, `codex`, `opencode`) using their existing local logins. Windows + POSIX safe
(resolve `.cmd` shims; never `shell:true` with user input).

## Adapter interface  (src/adapters/<agent>.mjs, default export)
```js
export default {
  name: 'claude'|'codex'|'opencode',
  async models(): Promise<string[]>,          // best-effort list
  run(opts): AsyncGenerator<Event, Result>,   // streaming; generator return value = Result
}
```
### opts (RunOptions)
prompt:string, model?:string, effort?:'low'|'medium'|'high'|'max' (mapped per agent),
permissions?:'read-only'|'edit'|'full'|'plan' (mapped per agent, default 'read-only'),
cwd?:string, timeoutMs?:number, signal?:AbortSignal,
session?: { mode:'new'|'ephemeral'|'continue'|'fork', id?:string }   // continue/fork w/o id = most recent in cwd
systemPrompt?:string, mcpServers?:Record<string,{command,args,env}>, env?:object,
jsonSchema?:object, extraArgs?:string[]

### Event (normalized)
{type:'session',id} | {type:'text',delta} | {type:'thinking',delta} | {type:'tool',name,input,output?}
| {type:'usage',input,output,cost?} | {type:'error',message} | {type:'raw',data}

### Result
{ text, sessionId, usage:{input,output,cost?}, exitCode, model, durationMs, timedOut:boolean }

Errors: throw AgentError(code,message) from src/core/errors.mjs.
Codes: NOT_INSTALLED, NOT_LOGGED_IN, TIMEOUT, ABORTED, BAD_OPTION, AGENT_FAILED.

Session semantics: new = fresh persisted session; ephemeral = nothing persisted;
continue = append to session; fork = new session id branching from id's history (original untouched).
All adapters expose the SAME behavior; anything an agent cannot do throws BAD_OPTION, never silently ignored.

## Layout
src/core/{errors,spawn,events}.mjs · src/adapters/*.mjs · src/index.mjs (public API: run, ask, agents)
src/bridge/mcp.mjs  (stdio MCP server exposing ask_claude/ask_codex/ask_opencode so ANY agent can call ANY agent)
src/server/{openai,anthropic}.mjs (compat proxy) · src/cli/main.mjs · acceptance/*.test.mjs (REAL runs, no mocks)

## Process
Each piece: builder -> critic (fresh context, separate agent) executes code, compares BLIND vs strongest
reference in refs/, writes acceptance/critic/<piece>.md. Progress via:
`node scripts/progress.mjs set <piece> <status> "<note>" [--round N] [--verdict ours|theirs|tie] [--gap "..."]`
status: todo|building|criticizing|fixing|passed
