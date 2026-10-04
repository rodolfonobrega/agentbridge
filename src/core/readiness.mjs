// Which agent CLIs are installed on this machine, and what to tell the user when one is not (or is not logged in).
import { hintFor } from './hints.mjs';
export { INSTALL_HINT, LOGIN_HINT, hintFor } from './hints.mjs';
import { resolveBinary } from './spawn.mjs';
import { findBinary as findAgy } from '../adapters/agy.mjs';
import { findBinary as findPi } from '../adapters/pi.mjs';

export const CLI_AGENTS = ['claude', 'codex', 'opencode', 'agy', 'pi'];

export function binaryOf(name) {
  return name === 'agy' ? findAgy() : name === 'pi' ? findPi() : resolveBinary(name);
}
export function isInstalled(name) { return CLI_AGENTS.includes(name) ? !!binaryOf(name) : true; }
export function installedAgents() { return CLI_AGENTS.filter(isInstalled); }

/** One line per agent CLI: ready / missing (with how to install) — printed when the proxy starts. */
export function readinessReport() {
  const lines = [];
  for (const n of CLI_AGENTS) lines.push(binaryOf(n) ? `  [ok]      ${n}` : `  [missing] ${n}${hintFor(n, 'NOT_INSTALLED')}`);
  return lines;
}
