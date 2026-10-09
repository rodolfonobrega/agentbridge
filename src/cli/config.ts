import {
  loadConfig,
  setConfigValue,
  getConfigValue,
  resetConfigValue,
  globalConfigFile,
  projectConfigFile,
  getDefaultPermissions,
  getPermissionsCeiling,
} from '../core/config.js';
import { UsageError } from './args.js';

export async function cmdConfig(
  args: string[],
  flags: Record<string, any>,
  io: { out: (s: any) => void; err: (s: any) => void }
): Promise<void> {
  const sub = args[0] || 'list';
  const isGlobal = Boolean(flags.global);
  const cwd = flags.cwd || process.cwd();

  switch (sub) {
    case 'list': {
      const cfg = loadConfig(cwd);
      const effectiveDef = getDefaultPermissions(process.env, cwd);
      const effectiveCeil = getPermissionsCeiling(process.env, cwd);

      if (flags.json) {
        io.out({
          config: cfg,
          effective: {
            defaultPermissions: effectiveDef,
            permissionsCeiling: effectiveCeil,
          },
          paths: {
            global: globalConfigFile(),
            project: projectConfigFile(cwd),
          },
        });
        return;
      }

      io.out('\n⚙  AGENTBRIDGE CONFIGURATION\n');
      io.out(`  • Default Permission:  ${effectiveDef} (used when no --permissions flag is passed)`);
      io.out(`  • Permission Ceiling:  ${effectiveCeil} (maximum allowed without reconfiguring)`);
      if (cfg.defaultAgent) io.out(`  • Default Agent:       ${cfg.defaultAgent}`);
      if (cfg.autoRollback !== undefined) io.out(`  • Auto Rollback:       ${cfg.autoRollback}`);

      io.out('\nLocations:');
      io.out(`  Project: ${projectConfigFile(cwd)}`);
      io.out(`  Global:  ${globalConfigFile()}\n`);
      io.out('Available Keys:');
      io.out('  default-permissions (read-only | plan | edit | full)');
      io.out('  permissions-ceiling (read-only | plan | edit | full)');
      io.out('  default-agent (claude | codex | opencode | agy | pi | ollama | ...)');
      io.out('\nExamples:');
      io.out('  ab config set default-permissions edit --global');
      io.out('  ab config set permissions-ceiling full');
      io.out('  ab config get default-permissions');
      io.out('  ab config reset default-permissions\n');
      break;
    }

    case 'get': {
      const key = args[1];
      if (!key) throw new UsageError('usage: ab config get <key>');
      const val = getConfigValue(key, { cwd });
      if (flags.json) {
        io.out({ key, value: val ?? null });
      } else {
        io.out(val !== undefined ? String(val) : `(not set - using system default)`);
      }
      break;
    }

    case 'set': {
      const key = args[1];
      const val = args[2];
      if (!key || val === undefined) {
        throw new UsageError('usage: ab config set <key> <value> [--global]');
      }

      let parsedVal: any = val;
      if (val === 'true') parsedVal = true;
      else if (val === 'false') parsedVal = false;
      else if (/^\d+$/.test(val)) parsedVal = Number(val);

      setConfigValue(key, parsedVal, { global: isGlobal, cwd });
      io.out(`✔ set ${key} = ${val} (${isGlobal ? 'global' : 'project'} config)`);
      break;
    }

    case 'reset': {
      const key = args[1];
      resetConfigValue(key, { global: isGlobal, cwd });
      if (key) {
        io.out(`✔ reset ${key} (${isGlobal ? 'global' : 'project'} config)`);
      } else {
        io.out(`✔ cleared ${isGlobal ? 'global' : 'project'} configuration`);
      }
      break;
    }

    default:
      throw new UsageError(`unknown config action "${sub}". Expected list, get, set, reset.`);
  }
}
