// Centralized catalog of supported agents and runtime models
export const BUILTIN_AGENTS = [
  'claude',
  'codex',
  'opencode',
  'agy',
  'pi',
  'cursor',
  'grok',
  'gemini',
  'devin',
  'acp',
] as const;

export type BuiltinAgentName = (typeof BUILTIN_AGENTS)[number];

export const VALID_ACCOUNT_AGENTS = [
  ...BUILTIN_AGENTS,
  'ollama',
] as const;

export type ValidAccountAgentName = (typeof VALID_ACCOUNT_AGENTS)[number];

export function isBuiltinAgent(name: string): name is BuiltinAgentName {
  return BUILTIN_AGENTS.includes(name.toLowerCase().trim() as BuiltinAgentName);
}

export function isValidAccountAgent(name: string): name is ValidAccountAgentName {
  return VALID_ACCOUNT_AGENTS.includes(name.toLowerCase().trim() as ValidAccountAgentName);
}
