'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClaudeMonitor } = require('../claude-sessions');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gamego-claude-'));
const directory = path.join(home, 'sessions');
const seen = new Map(), errors = [], updates = [];
const alive = new Set([100, 101, 102]);
const originalKill = process.kill;
process.kill = (pid, signal) => {
  assert.equal(signal, 0);
  if (!alive.has(pid)) throw Object.assign(new Error('not running'), { code: 'ESRCH' });
  return true;
};
const poll = createClaudeMonitor(home, session => {
  seen.set(session.id, session); updates.push(session);
}, id => seen.delete(id), error => errors.push(error));
const old = Date.now() - 24 * 3600000;
const record = { pid: 100, sessionId: 'one', cwd: '/projects/api', kind: 'interactive',
  status: 'idle', statusUpdatedAt: old, name: 'Idle API' };
const write = value => fs.writeFileSync(path.join(directory, `${value.pid}.json`), JSON.stringify(value));

(async () => {
  await poll();
  assert.equal(seen.size, 0, 'missing registry is harmless');
  fs.mkdirSync(directory);
  write(record);
  write({ ...record, pid: 101, sessionId: 'two', status: 'busy', name: 'Same folder' });
  write({ ...record, pid: 102, sessionId: 'spare', spare: true });
  write({ ...record, pid: 999, sessionId: 'dead' });
  fs.writeFileSync(path.join(directory, '100.key'), 'not JSON');
  await poll();
  assert.equal(seen.size, 2, 'discover live sessions regardless of age, excluding dead processes and spares');
  assert.equal(seen.get('one').state, 'I');
  assert.equal(seen.get('one').text, 'idle');
  assert.equal(seen.get('two').state, 'W');
  await poll();
  assert.equal(updates.length, 2, 'idle sessions remain without duplicate updates');

  write({ ...record, name: 'Renamed', waitingFor: 'needs approval', statusUpdatedAt: Date.now() });
  await poll();
  assert.equal(seen.get('one').title, 'Renamed');
  assert.equal(seen.get('one').state, 'A');
  fs.writeFileSync(path.join(directory, '100.json'), '{');
  await poll();
  assert(seen.has('one'), 'partial registry writes do not remove sessions');
  assert(errors.pop() instanceof SyntaxError);
  write({ ...record, sessionId: 'resumed' });
  await poll();
  assert(!seen.has('one'));
  assert(seen.has('resumed'), 'resuming a different thread retires the old ID');
  write({ ...record, pid: 102, sessionId: 'resumed' });
  await poll();
  alive.delete(100);
  await poll();
  assert(seen.has('resumed'), 'one dead process cannot hide another live owner');
  alive.delete(102);
  await poll();
  assert(!seen.has('resumed'), 'process exit retires the session without a hook');
  fs.unlinkSync(path.join(directory, '101.json'));
  await poll();
  assert.equal(seen.size, 0, 'deleted registry files retire sessions');
  assert.deepEqual(errors, []);
  console.log('PASS: Claude discovery, idle retention, statuses, renaming, partial writes, and process closure');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { process.kill = originalKill; fs.rmSync(home, { recursive: true, force: true }); });
