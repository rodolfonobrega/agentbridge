// Devin CLI adapter.
// Drives the Devin CLI agent using existing logins and configurations.

import { cliJsonLinesAdapter } from './cli-json-lines.js'

const MODELS = ['default', 'devin-default']

const adapter = cliJsonLinesAdapter({
  name: 'devin',
  cmd: 'devin',
  models: MODELS,
  defaultModel: 'devin-default',
  buildArgs(o, prompt) {
    // Devin takes no model flag: the CLI picks its own model per login/plan.
    const args: string[] = ['run', '--json']
    if (o.permissions === 'full') args.push('--permission-mode', 'bypass')
    if (o.cwd) args.push('--cwd', o.cwd)
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String))
    args.push('-p', prompt)
    return args
  },
  authRe: /auth|login|token/i,
  authMessage: (blob) => `Devin CLI authentication missing: ${blob}`,
})

export default adapter