const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createCodexMonitor } = require('../codex-sessions');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-codex-'));
const directory = path.join(home, 'sessions', '2026', '01', '01');
fs.mkdirSync(directory, { recursive: true });
let now = Date.now();
const row = (type, payload) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload }) + '\n';
const event = type => row('event_msg', { type });
const first = path.join(directory, 'rollout-first.jsonl');
const second = path.join(directory, 'rollout-second.jsonl');
const meta = id => row('session_meta', { id, cwd: '/projects/api', source: 'cli' });
const seen = new Map(), removed = [], errors = [], notifications = [];
const poll = createCodexMonitor(home, (session, initial) => {
  seen.set(session.id, session); notifications.push({ session, initial });
}, id => { removed.push(id); seen.delete(id); }, error => errors.push(error));

(async () => {
  fs.writeFileSync(first, meta('thread-one') + event('task_started'));
  fs.writeFileSync(second, meta('thread-two') + event('task_complete'));
  fs.writeFileSync(path.join(directory, 'child.jsonl'), row('session_meta', {
    id: 'child', parent_thread_id: 'thread-one', source: { subagent: {} },
  }));
  const old = path.join(directory, 'old.jsonl');
  fs.writeFileSync(old, meta('old'));
  fs.utimesSync(old, new Date(now - 4 * 3600000), new Date(now - 4 * 3600000));
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: 'thread-one', thread_name: 'API fix' }) + '\n');
  await poll(now);
  assert.equal(seen.size, 2);
  assert.equal(seen.get('thread-one').state, 'W');
  assert.equal(seen.get('thread-two').state, 'D');
  assert.equal(seen.get('thread-one').title, 'API fix');
  assert(notifications.every(update => update.initial));
  await poll(now);
  assert.equal(notifications.length, 2, 'unchanged sessions are not republished');

  now += 1000;
  const partial = event('task_complete');
  fs.appendFileSync(first, partial.slice(0, -1));
  await poll(now);
  assert.equal(seen.get('thread-one').state, 'W', 'wait for complete JSONL lines');
  fs.appendFileSync(first, '\n');
  await poll(now);
  assert.equal(seen.get('thread-one').state, 'D');
  assert.equal(notifications.at(-1).initial, false);

  now += 1000;
  fs.appendFileSync(first, 'invalid json\n' + event('task_started') + row('response_item', {
    type: 'function_call', name: 'functions.request_user_input', arguments: '{}',
  }));
  await poll(now);
  assert.equal(seen.get('thread-one').state, 'I');
  assert.equal(seen.get('thread-one').text, 'your turn');
  fs.appendFileSync(first, row('response_item', { type: 'function_call_output' }));
  await poll(now);
  assert.equal(seen.get('thread-one').state, 'W');
  fs.appendFileSync(first, event('turn_aborted'));
  await poll(now);
  assert.equal(seen.get('thread-one').text, 'interrupted');

  fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: 'thread-one', thread_name: 'Renamed' }) + '\n');
  await poll(now);
  assert.equal(seen.get('thread-one').title, 'Renamed');
  now += 10000;
  fs.writeFileSync(first, meta('thread-one') + event('task_started'));
  fs.writeFileSync(path.join(directory, 'new.jsonl'), meta('thread-three'));
  fs.unlinkSync(second);
  await poll(now);
  assert.equal(seen.get('thread-one').state, 'W', 'truncated files can be read again');
  assert(seen.has('thread-three'), 'discover sessions created while running');
  assert(removed.includes('thread-two'));
  await poll(now + 4 * 3600000);
  assert.equal(seen.size, 2, 'known sessions stay listed even after hours without activity');
  fs.unlinkSync(first);
  await poll(now + 4 * 3600000);
  assert(!seen.has('thread-one'), 'removed rollouts are still retired');
  assert.deepEqual(errors, []);

  const configHome = path.join(home, 'config-home');
  const codex = path.join(configHome, '.codex');
  fs.mkdirSync(codex, { recursive: true });
  const original = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } };
  const config = 'notify = ["computer-use", "turn-ended"]\n[features]\nhooks = true\n';
  const hookFile = path.join(codex, 'hooks.json');
  fs.writeFileSync(hookFile, JSON.stringify(original));
  fs.writeFileSync(path.join(codex, 'config.toml'), config);
  function install(...args) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../install-hooks.js'), '--codex-only', ...args], {
      env: { ...process.env, CLAUDE_LINK_HOME: configHome }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  install(); install();
  const installed = JSON.parse(fs.readFileSync(hookFile));
  assert.equal(installed.hooks.SessionStart.length, 2, 'installation is idempotent and preserves other hooks');
  for (const name of ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd', 'UserPromptSubmit']) {
    assert.equal(installed.hooks[name].length, 1);
    assert(installed.hooks[name][0].hooks[0].command.includes('/codex'));
  }
  assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), config, 'preserve Computer Use notify');
  assert(!fs.existsSync(path.join(configHome, '.claude')), 'Codex-only installation leaves Claude untouched');
  install('--uninstall');
  assert.deepEqual(JSON.parse(fs.readFileSync(hookFile)), original);
  fs.writeFileSync(path.join(codex, 'config.toml'), 'notify = ["curl", "http://127.0.0.1:47821/codex"] # claude-link\n[features]\nhooks = true\n');
  install();
  assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), '[features]\nhooks = true\n');
  console.log('PASS: Codex discovery, state transitions, names, partial writes, idle retention, and hook installation');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(home, { recursive: true, force: true }));
