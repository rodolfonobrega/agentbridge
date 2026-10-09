import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installIde, getIdeConfigPath } from '../dist/cli/install-ide.js';

test('installIde into Cursor: project and user scope', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-ide-cursor-'));
  try {
    // Project scope
    const projRes = installIde('cursor', { scope: 'project', cwd: tmp });
    assert.equal(projRes.path, path.join(tmp, '.cursor', 'mcp.json'));
    assert.equal(projRes.modified, true);
    assert.ok(existsSync(projRes.path));

    const projJson = JSON.parse(readFileSync(projRes.path, 'utf8'));
    assert.equal(projJson.mcpServers.agentbridge.command, process.execPath);
    assert.deepEqual(projJson.mcpServers.agentbridge.args.slice(-1), ['bridge']);

    // Idempotent run: modified is false
    const projIdem = installIde('cursor', { scope: 'project', cwd: tmp });
    assert.equal(projIdem.modified, false);

    // Direct configPath override for user scope simulation
    const mockUserPath = path.join(tmp, 'user', '.cursor', 'mcp.json');
    const userRes = installIde('cursor', { configPath: mockUserPath });
    assert.equal(userRes.path, mockUserPath);
    assert.equal(userRes.modified, true);

    const userJson = JSON.parse(readFileSync(mockUserPath, 'utf8'));
    assert.equal(userJson.mcpServers.agentbridge.command, process.execPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installIde into VS Code: project scope and preserving existing settings with 2-space indentation', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-ide-vscode-'));
  try {
    const configPath = path.join(tmp, '.vscode', 'mcp.json');
    // Pre-seed with existing custom settings
    const existing = {
      version: '0.2.0',
      mcpServers: {
        existing_tool: {
          command: 'python',
          args: ['tool.py'],
        },
      },
      otherSettings: {
        active: true,
      },
    };
    const dir = path.dirname(configPath);
    import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

    const res = installIde('vscode', { scope: 'project', cwd: tmp });
    assert.equal(res.path, configPath);
    assert.equal(res.modified, true);

    const raw = readFileSync(configPath, 'utf8');
    // Check 2-space indentation
    assert.ok(raw.includes('  "mcpServers": {'));
    assert.ok(raw.includes('    "agentbridge": {'));

    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, '0.2.0');
    assert.equal(parsed.otherSettings.active, true);
    assert.equal(parsed.mcpServers.existing_tool.command, 'python');
    assert.equal(parsed.mcpServers.agentbridge.command, process.execPath);
    assert.deepEqual(parsed.mcpServers.agentbridge.args.slice(-1), ['bridge']);

    // Second run is idempotent
    const secondRun = installIde('vscode', { scope: 'project', cwd: tmp });
    assert.equal(secondRun.modified, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installIde into Claude Desktop: merges config and updates server definition', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-ide-claude-'));
  try {
    const mockClaudeConfig = path.join(tmp, 'claude_desktop_config.json');
    const existing = {
      mcpServers: {
        other_mcp: {
          command: 'docker',
          args: ['run', 'mcp-server'],
        },
      },
    };
    writeFileSync(mockClaudeConfig, JSON.stringify(existing, null, 2), 'utf8');

    const res = installIde('claude', { configPath: mockClaudeConfig });
    assert.equal(res.path, mockClaudeConfig);
    assert.equal(res.modified, true);

    const merged = JSON.parse(readFileSync(mockClaudeConfig, 'utf8'));
    assert.equal(merged.mcpServers.other_mcp.command, 'docker');
    assert.equal(merged.mcpServers.agentbridge.command, process.execPath);
    assert.deepEqual(merged.mcpServers.agentbridge.args.slice(-1), ['bridge']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installIde into Zed and Windsurf', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-ide-zed-'));
  try {
    // Zed: injects mcpServers and context_servers
    const zedConfig = path.join(tmp, 'zed_settings.json');
    const zedRes = installIde('zed', { configPath: zedConfig });
    assert.equal(zedRes.modified, true);

    const zedParsed = JSON.parse(readFileSync(zedConfig, 'utf8'));
    assert.ok(zedParsed.mcpServers.agentbridge);
    assert.ok(zedParsed.context_servers.agentbridge);
    assert.equal(zedParsed.context_servers.agentbridge.command, process.execPath);

    // Windsurf
    const windsurfConfig = path.join(tmp, 'mcp_config.json');
    const wsRes = installIde('windsurf', { configPath: windsurfConfig });
    assert.equal(wsRes.modified, true);

    const wsParsed = JSON.parse(readFileSync(windsurfConfig, 'utf8'));
    assert.equal(wsParsed.mcpServers.agentbridge.command, process.execPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installIde throws on unknown target', () => {
  assert.throws(
    () => installIde('unknown-ide'),
    /Unknown IDE target/
  );
});
