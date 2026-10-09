#!/usr/bin/env node
// Automated release & version bump helper for AgentBridge.
// Usage:
//   node scripts/release.mjs [patch|minor|major|<version>] [--dry-run]
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
}

function runOutput(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

export const SEMVER_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(v) {
  const clean = v.replace(/^v/, '');
  const m = clean.match(SEMVER_REGEX);
  if (!m) throw new Error(`Invalid semver: ${v}`);
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] || null,
    build: m[5] || null,
  };
}

export function bumpVersion(current, type) {
  const parsed = parseSemver(current);
  if (type === 'major') {
    return `${parsed.major + 1}.0.0`;
  }
  if (type === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (type === 'patch') {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  // Explicit version string
  try {
    parseSemver(type);
    return type.replace(/^v/, '');
  } catch {
    throw new Error(`Unknown bump type or invalid semver version: "${type}". Use patch, minor, major, or explicit X.Y.Z`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const positional = args.filter((a) => !a.startsWith('-'));
  const bumpType = positional[0] || 'patch';
  const dryRun = flags.has('--dry-run');

  console.log('\x1b[36m⚡ AGENTBRIDGE — Release Automation\x1b[0m\n');

  // Check git status
  const dirty = runOutput('git status --porcelain');
  if (dirty && !dryRun) {
    console.error('\x1b[31mError: Git working tree has uncommitted changes:\x1b[0m');
    console.error(dirty);
    console.error('\nPlease commit or stash changes before releasing.');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;
  const nextVersion = bumpVersion(currentVersion, bumpType);

  console.log(`Current version: \x1b[33mv${currentVersion}\x1b[0m`);
  console.log(`Target version:  \x1b[32mv${nextVersion}\x1b[0m (${bumpType})\n`);

  // Verification: Build & Typecheck
  console.log('\x1b[34m✦ Validating TypeScript build and typecheck...\x1b[0m');
  run('npm run typecheck');
  run('npm run build');

  // Run tests
  console.log('\n\x1b[34m✦ Running acceptance test suite...\x1b[0m');
  run('npm test');

  if (dryRun) {
    console.log('\n\x1b[33m--dry-run enabled: skipping version bump, changelog update, and git tag.\x1b[0m');
    return;
  }

  // Update package.json
  pkg.version = nextVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`\n\x1b[32m✔ Updated package.json to v${nextVersion}\x1b[0m`);

  // Sync package-lock.json
  try {
    console.log('\x1b[34m✦ Syncing package-lock.json with new version...\x1b[0m');
    run('npm install --package-lock-only', { silent: true });
    console.log('\x1b[32m✔ package-lock.json synchronized\x1b[0m');
  } catch (err) {
    console.warn('\x1b[33mWarning: Failed to sync package-lock.json via npm:\x1b[0m', err.message);
  }

  // Update CHANGELOG.md if present
  try {
    let changelog = readFileSync(changelogPath, 'utf8');
    const today = new Date().toISOString().split('T')[0];
    const header = `## [${nextVersion}] - ${today}`;
    if (!changelog.includes(`## [${nextVersion}]`)) {
      // Find latest git commits since last tag
      const lastTag = runOutput('git describe --tags --abbrev=0') || '';
      const gitLogCmd = lastTag ? `git log ${lastTag}..HEAD --oneline` : 'git log -n 10 --oneline';
      const recentCommits = runOutput(gitLogCmd)
        .split('\n')
        .filter(Boolean)
        .map((l) => `  - ${l}`)
        .join('\n');

      const entry = `\n${header}\n\n### Changes\n${recentCommits || '  - Release ' + nextVersion}\n`;

      // Insert after # Changelog title
      const titleMatch = changelog.match(/^# Changelog.*$/m);
      if (titleMatch) {
        const idx = titleMatch.index + titleMatch[0].length;
        changelog = changelog.slice(0, idx) + '\n' + entry + changelog.slice(idx);
      } else {
        changelog = `# Changelog\n\n${entry}\n${changelog}`;
      }
      writeFileSync(changelogPath, changelog);
      console.log(`\x1b[32m✔ Added section for v${nextVersion} in CHANGELOG.md\x1b[0m`);
    }
  } catch {
    console.log('\x1b[33mNote: CHANGELOG.md not found or skipped.\x1b[0m');
  }

  // Re-build dist so embedded version or artifacts match
  run('npm run build');

  // Git Commit and Tag
  console.log('\n\x1b[34m✦ Creating git commit and tag...\x1b[0m');
  run('git add package.json CHANGELOG.md');
  if (runOutput('git ls-files package-lock.json')) run('git add package-lock.json');
  run(`git commit -m "chore(release): v${nextVersion}"`);
  run(`git tag -a "v${nextVersion}" -m "Release v${nextVersion}"`);

  console.log(`\n\x1b[32m🎉 Successfully released v${nextVersion}!\x1b[0m`);
  console.log('\x1b[1mNext steps:\x1b[0m');
  console.log('  1. Push release commit and tags to trigger GitHub Actions publishing:');
  console.log(`     \x1b[36mgit push origin main --follow-tags\x1b[0m\n`);
  console.log('  2. Or publish manually to npm:');
  console.log('     \x1b[36mnpm publish --access public\x1b[0m\n');
}

const isCLI = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCLI) {
  main().catch((err) => {
    console.error('\n\x1b[31mRelease failed:\x1b[0m', err.message);
    process.exit(1);
  });
}
