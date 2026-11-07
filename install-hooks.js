#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.CLAUDE_LINK_PORT || 47821);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid CLAUDE_LINK_PORT');
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest'];
const OTHER_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop'];
const uninstall = process.argv.includes('--uninstall');
const home = process.env.CLAUDE_LINK_HOME || os.homedir();
const codexHome = process.env.CLAUDE_LINK_HOME ? path.join(home, '.codex') : process.env.CODEX_HOME || path.join(home, '.codex');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function backup(file) {
  if (!fs.existsSync(file)) return;
  const destination = `${file}.claude-link-backup-${stamp}`;
  fs.copyFileSync(file, destination);
  console.log('  backup:', destination);
}

function installHooks(file, endpoint, events) {
  if (uninstall && !fs.existsSync(file)) return;
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Invalid settings: ${file}`);
  const hooks = settings.hooks || {};
  if (typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error(`Invalid hooks: ${file}`);
  const marker = new RegExp(`http://127\\.0\\.0\\.1:\\d+/${endpoint}(?:\\s|$)`);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !group || !Array.isArray(group.hooks))) {
      throw new Error(`Invalid hook groups for ${event}: ${file}`);
    }
    hooks[event] = groups.map(group => ({ ...group,
      hooks: group.hooks.filter(hook => !marker.test(String(hook.command || ''))),
    })).filter(group => group.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  if (!uninstall) {
    const command = `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${PORT}/${endpoint} || true`;
    for (const event of events) {
      const group = { hooks: [{ type: 'command', command, timeout: 2 }] };
      if (TOOL_EVENTS.includes(event)) group.matcher = '*';
      (hooks[event] = hooks[event] || []).push(group);
    }
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  ${uninstall ? 'removed' : 'installed'} claude-link hooks: ${file}`);
}

try {
  if (!process.argv.includes('--codex-only')) {
    installHooks(path.join(home, '.claude', 'settings.json'), 'hook', [...TOOL_EVENTS, ...OTHER_EVENTS, 'Notification']);
  }
  installHooks(path.join(codexHome, 'hooks.json'), 'codex', [...TOOL_EVENTS, ...OTHER_EVENTS, 'Interrupt']);
  const tomlPath = path.join(codexHome, 'config.toml');
  if (fs.existsSync(tomlPath)) {
    const toml = fs.readFileSync(tomlPath, 'utf8');
    const updated = toml.split('\n').filter(line =>
      !(/^\s*notify\s*=/.test(line) && line.includes('# claude-link') && /127\.0\.0\.1:\d+\/codex/.test(line))
    ).join('\n');
    if (updated !== toml) { backup(tomlPath); fs.writeFileSync(tomlPath, updated); }
  }
  console.log(uninstall ? '\nDone.' : '\nDone. Restart the helper and your sessions. In Codex, open /hooks and review/trust the new claude-link hooks. Existing notify commands are preserved.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
