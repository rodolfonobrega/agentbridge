// Cursor CLI adapter.
// Drives the Cursor command line agent using existing local Cursor credentials.

import { cliJsonLinesAdapter } from './cli-json-lines.js'

const MODELS = ['claude-3.7-sonnet', 'claude-3.5-sonnet', 'claude-3-5-sonnet', 'gpt-4o', 'cursor-small']

const adapter = cliJsonLinesAdapter({
  name: 'cursor',
  cmd: 'cursor',
  models: MODELS,
  defaultModel: 'claude-3.7-sonnet',
  buildArgs(o, prompt) {
    const args: string[] = ['agent', '--output-format', 'json']
    if (o.model) args.push('--model', o.model)
    if (o.permissions === 'full') args.push('--auto-approve')
    if (o.cwd) args.push('--workspace', o.cwd)
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String))
    args.push('--prompt', prompt)
    return args
  },
  textMatch: (j) => j.type === 'text' || j.type === 'message',
  textOf: (j) => j.delta || j.content || '',
  toolEvent: (j) => (j.type === 'tool' || j.type === 'tool_call' ? { name: j.name || 'tool', input: j.params } : null),
  authRe: /auth|login|unauthorized/i,
})

export default adapter