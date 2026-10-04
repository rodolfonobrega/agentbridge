// Install / login hints appended to NOT_INSTALLED and NOT_LOGGED_IN messages.
export const INSTALL_HINT = {
  claude: 'install Claude Code (npm i -g @anthropic-ai/claude-code), then run `claude` once to log in',
  codex: 'install Codex CLI (npm i -g @openai/codex), then run `codex login`',
  opencode: 'install opencode (npm i -g opencode-ai), then run `opencode auth login`',
  agy: 'install the Antigravity CLI (agy) and sign in with it once',
  pi: 'install pi (npm i -g @earendil-works/pi-coding-agent) and configure a model/provider',
};
export const LOGIN_HINT = {
  claude: 'run `claude` and log in (or `claude setup-token`)',
  codex: 'run `codex login`',
  opencode: 'run `opencode auth login`',
  agy: 'open `agy` and sign in',
  pi: 'run `pi` and configure a provider (`/login`)',
};

export function hintFor(name, code) {
  const h = code === 'NOT_INSTALLED' ? INSTALL_HINT[name] : LOGIN_HINT[name];
  return h ? ` — ${h}` : '';
}
