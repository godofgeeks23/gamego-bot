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

const fsx = require('fs');
const TR = __dirname + '/fake-transcript.jsonl';
fsx.writeFileSync(TR, '{"type":"user","message":{"role":"user","content":"hi"},"sessionId":"s9"}\n');
(async () => {
  await wait(700);
  await hook({ ...base('s9', '/Users/a/Projects/claude-link'), transcript_path: TR, hook_event_name: 'SessionStart', source: 'startup' });
  await wait(300); const before = snap();
  fsx.appendFileSync(TR, '{"type":"custom-title","customTitle":"gamego fw","sessionId":"s9"}\n{"type":"agent-name","agentName":"gamego fw","sessionId":"s9"}\n');
  await wait(2600); const after = snap();   // no hook fired: picked up by the 2s poll
  fsx.appendFileSync(TR, '{"type":"assistant","message":{"content":"x"}}\n{"type":"custom-title","customTitle":"hooks v2","sessionId":"s9"}\n');
  await hook({ ...base('s9', '/Users/a/Projects/claude-link'), transcript_path: TR, hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  await wait(300); const after2 = snap();
  origLog('[before]\n' + before + '\n[after rename]\n' + after + '\n[after 2nd rename]\n' + after2);
  const ok = /I\|claude-li/.test(before) && /\|gamego fw\|/.test(after) && /W\|hooks v2\|thinking/.test(after2);
  origLog(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
