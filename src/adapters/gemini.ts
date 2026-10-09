// Google Gemini CLI adapter.
// Drives the installed `gemini` CLI using the local Google authentication.

import { cliJsonLinesAdapter } from './cli-json-lines.js'

const MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
]

const adapter = cliJsonLinesAdapter({
  name: 'gemini',
  cmd: 'gemini',
  models: MODELS,
  defaultModel: 'gemini-2.5-flash',
  buildArgs(o, prompt) {
    const args: string[] = ['--output-format', 'json']
    if (o.model) args.push('-m', o.model)
    if (o.permissions === 'full') args.push('--yolo')
    if (o.systemPrompt) args.push('--system', o.systemPrompt)
    if (o.cwd) args.push('--cwd', o.cwd)
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String))
    args.push('-p', prompt)
    return args
  },
  imagesMessage: 'Multimodal images are not supported via Gemini CLI arguments',
  textMatch: (j) => j.type === 'text',
  textOf: (j) => j.content || j.delta || '',
  usageOf: (j) => ({ input: j.inputTokens || 0, output: j.outputTokens || 0, cost: j.cost ?? null }),
  authRe: /not logged in|login|auth/i,
  authMessage: (blob) => `Gemini CLI is not logged in: ${blob}`,
})

export default adapter