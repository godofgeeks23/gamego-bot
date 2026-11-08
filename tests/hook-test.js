// Simulates the GameGo's HF2 firmware (ported from pxt hf2.cpp) behind a fake
// `usb` module, then runs claude-link.js against it in --dry-run mode.
const Module = require('module');
const { EventEmitter } = require('events');
const path = require('path');

const RAM = new Map(); // addr -> u32
const BOX = 0x20001230;
let dmesg = 'boot\nPLNK ' + BOX + '\n';
const INFO = 'UF2 Bootloader v2.7.5 W\nModel: TinkerGen Ltd. / TinkerGen GameGo\nBoard-ID: STM32F4xx-Arcade-Generic\n';

class InEp extends EventEmitter {
  constructor() { super(); this.direction = 'in'; this.q = []; }
  startPoll() { this.polling = true; }
  stopPoll() { this.polling = false; }
  push(pkt) { setImmediate(() => this.emit('data', pkt)); }
}
const inEp = new InEp();

function sendBuffer(flag, data, prepend) {
  // mirrors non-async sendBuffer in hf2.cpp
  let payload = data;
  if (prepend !== undefined) { const p = Buffer.alloc(4); p.writeUInt32LE(prepend >>> 0); payload = Buffer.concat([p, data]); }
  let off = 0;
  while (off < payload.length || payload.length === 0) {
    const s = Math.min(63, payload.length - off);
    const last = off + s >= payload.length;
    const pkt = Buffer.alloc(64);
    pkt[0] = (flag === 0x40 && !last ? 0x00 : flag) | s;
    payload.copy(pkt, 1, off, off + s);
    inEp.push(pkt);
    off += s;
    if (payload.length === 0) break;
  }
}

let rx = [];
let gotSomePacket = false;
function onCommand(msg) {
  gotSomePacket = true;
  const cmd = msg.readUInt32LE(0), tag = msg.readUInt16LE(4);
  const respHdr = Buffer.alloc(4); respHdr.writeUInt16LE(tag, 0);
  const respond = (data) => {
    if (data.length <= 256) sendBuffer(0x40, Buffer.concat([respHdr, data]));
    else sendBuffer(0x40, data, respHdr.readUInt32LE(0));
  };
  if (cmd === 2) return respond(Buffer.from(INFO));
  if (cmd === 0x10) return respond(Buffer.from(dmesg, 'latin1'));
  if (cmd === 9) {
    const addr = msg.readUInt32LE(8), n = msg.readUInt32LE(12);
    if (msg.length !== 16 + n * 4) throw new Error('bad write_words size ' + msg.length + ' vs ' + (16 + n * 4));
    for (let i = 0; i < n; i++) RAM.set(addr + i * 4, msg.readUInt32LE(16 + i * 4));
    return respond(Buffer.alloc(0));
  }
  respHdr[2] = 1; respond(Buffer.alloc(0));
}

const outEp = {
  direction: 'out',
  transfer(buf, cb) {
    const tag = buf[0], size = tag & 63, flag = tag & 0xc0;
    rx.push(buf.subarray(1, 1 + size));
    if (flag === 0x40) { const m = Buffer.concat(rx); rx = []; onCommand(m); }
    setImmediate(cb);
  },
};

const fakeDev = {
  configDescriptor: { interfaces: [
    [{ bInterfaceNumber: 0, bInterfaceClass: 0xff, bInterfaceSubClass: 0xff, endpoints: [] }],
    [{ bInterfaceNumber: 1, bInterfaceClass: 0xff, bInterfaceSubClass: 42, endpoints: [{}, {}] }],
  ] },
  open() {}, close() {},
  interface(n) { return { claim() {}, release(a, cb) { cb && cb(); }, endpoints: [inEp, outEp] }; },
};
const fakeUsb = { usb: new EventEmitter(), getDeviceList: () => [{ get configDescriptor() { throw new Error('no access'); } }, fakeDev] };

const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'usb' ? fakeUsb : origLoad.call(this, req, ...rest); };

function readText(addr, len) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i += 4) b.writeUInt32LE(RAM.get(addr + i) || 0, i);
  return b.toString('ascii').replace(/\0.*$/s, '');
}
function serial(line) { if (gotSomePacket) sendBuffer(0x80, Buffer.from(line + '\n')); }

const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };

process.argv.push('--dry-run');
require(process.argv[2]);


const { exec } = require('child_process');
const times = [];
const CMD = `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${Number(process.env.CLAUDE_LINK_PORT || 47821)}/hook || true`;
function hook(ev) { return new Promise((res) => { const t0 = Date.now(); const p = exec(CMD, { shell: '/bin/bash' }, () => { times.push(Date.now() - t0); res(); }); p.stdin.end(JSON.stringify(ev)); }); }
const base = (sid, cwd) => ({ session_id: sid, cwd, transcript_path: '/tmp/t', permission_mode: 'default' });
const snap = () => readText(BOX + 460, 256);
const results = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(700);
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'UserPromptSubmit', prompt: 'fix tests' });
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/Users/a/Projects/api/src/server.ts' } });
  await wait(300); results.working = snap();
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'UserPromptSubmit', prompt: 'run' });
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm   test --watch=false' } });
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  await wait(300); results.approval = snap();
  serial('D A'); serial('U A'); // user approves with A
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} });
  await wait(300); results.afterApprove = snap();
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'Stop', stop_hook_active: false });
  await wait(300); results.done = snap();
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  await wait(300); results.ended = snap();
  for (const [k, v] of Object.entries(results)) origLog(`\n[${k}]\n${v}`);
  const r = results;
  const assert = require('node:assert/strict');
  async function codex(ev) {
    await fetch(`http://127.0.0.1:${Number(process.env.CLAUDE_LINK_PORT || 47821)}/codex`, {
      method: 'POST', body: JSON.stringify(ev), headers: { 'Content-Type': 'application/json' },
    });
    await wait(200);
  }
  const cx = { session_id: 'codex-one', cwd: '/projects/api' };
  await codex({ ...cx, hook_event_name: 'SessionStart' });
  assert(snap().includes('I|C:api-one|ready'), snap());
  await codex({ session_id: 'codex-two', cwd: '/projects/api', hook_event_name: 'UserPromptSubmit' });
  assert(snap().includes('W|C:api-two|thinking'));
  await codex({ ...cx, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert(snap().startsWith('A|'));
  assert(snap().includes('A|C:api-one|Bash npm test'));
  await codex({ ...cx, hook_event_name: 'PostToolUse' });
  assert(snap().includes('W|C:api-one|thinking'));
  await codex({ ...cx, hook_event_name: 'Interrupt' });
  assert(snap().includes('I|C:api-one|interrupted'));
  await codex({ ...cx, hook_event_name: 'Stop' });
  assert(snap().startsWith('D|'));
  await codex({ 'thread-id': 'codex-two', type: 'agent-turn-complete', cwd: '/projects/api' });
  assert(snap().includes('D|C:api-two|done'));
  await codex({ ...cx, hook_event_name: 'SessionEnd' });
  assert(!snap().includes('\nD|C:api-one|'));
  await codex(null);
  await codex({ type: 'unknown', 'thread-id': 'unrecognised' });
  assert(!snap().includes('C:cod-sed'));
  const originalNow = Date.now;
  let clock = Math.ceil((originalNow() + 4 * 3600000) / 10000) * 10000;
  Date.now = () => clock;
  await hook({ ...base('idle', '/projects/idle'), hook_event_name: 'SessionStart' });
  await wait(200);
  assert(snap().includes('W|web|thinking'), 'Claude remains visible after four hours');
  assert(snap().includes('D|C:api-two|done'), 'Codex remains visible after four hours');
  assert(snap().includes('I|idle|ready'), 'idle sessions have their own status');
  await hook({ ...base('s2', '/projects/web'), hook_event_name: 'SessionEnd' });
  await hook({ ...base('idle', '/projects/idle'), hook_event_name: 'SessionEnd' });
  await codex({ session_id: 'codex-two', hook_event_name: 'SessionEnd' });
  for (let index = 0; index < 7; index++) {
    await hook({ ...base(`page${index}`, `/projects/page${index}`), hook_event_name: 'SessionStart' });
  }
  await wait(200);
  const pages = new Set(snap().split('\n').slice(1).map(row => row.split('|')[1]));
  assert.equal(pages.size, 5);
  clock += 5000;
  await wait(700);
  for (const row of snap().split('\n').slice(1)) pages.add(row.split('|')[1]);
  assert.equal(pages.size, 7, 'overflow pages expose every session instead of hiding idle rows');
  for (let index = 0; index < 7; index++) {
    await hook({ ...base(`page${index}`, `/projects/page${index}`), hook_event_name: 'SessionEnd' });
  }
  Date.now = originalNow;
  const fs = require('fs');
  const registry = path.join(process.env.CLAUDE_LINK_CLAUDE_HOME, 'sessions');
  fs.mkdirSync(registry, { recursive: true });
  const recordFile = path.join(registry, `${process.pid}.json`);
  const record = { pid: process.pid, sessionId: 'discovered', cwd: '/projects/discovered',
    kind: 'interactive', name: 'discovered', status: 'idle', statusUpdatedAt: Date.now() - 86400000 };
  fs.writeFileSync(recordFile, JSON.stringify(record));
  await wait(2300);
  assert(snap().includes('I|discovered|idle'), 'discover an already-idle Claude session without a hook');
  await hook({ ...base('discovered', record.cwd), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await wait(200);
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, name: 'renamed' }));
  await wait(2300);
  assert(snap().includes('A|renamed|Bash npm test'), 'old registry status cannot overwrite a newer approval hook');
  await hook({ ...base('discovered', record.cwd), hook_event_name: 'SessionEnd' });
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, name: 'closed' }));
  await wait(2300);
  assert(!snap().includes('\nI|closed|'), 'stale registry metadata cannot resurrect an ended session');
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, sessionId: 'other', name: 'resumed' }));
  await wait(2300);
  assert(snap().includes('I|resumed|idle'));
  fs.unlinkSync(recordFile);
  await wait(2300);
  assert(!snap().includes('|resumed|'), 'closed registered sessions leave the device list');
  const ok = /\|api\|Edit server\.ts/.test(r.working)
    && r.approval.startsWith('A|') && r.approval.includes('APPROVE?|web: Bash npm test') && /\nA\|web\|/.test(r.approval)
    && r.afterApprove.startsWith('|') && /W\|web\|thinking/.test(r.afterApprove)
    && r.done.startsWith('D|') && r.done.includes('|DONE|api') && /D\|api\|done/.test(r.done)
    && !r.ended.includes('|api|');
  origLog('hook round-trip ms: max', Math.max(...times), 'avg', Math.round(times.reduce((a,b)=>a+b,0)/times.length));
  origLog(ok ? '\nPASS' : '\nFAIL');
  process.exit(ok ? 0 : 1);
})();
