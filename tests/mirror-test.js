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
const PORT = Number(process.env.CLAUDE_LINK_PORT || 47821);
const CMD = `curl -s -m 1 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${PORT}/hook || true`;
function hook(ev) { return new Promise((res) => { const t0 = Date.now(); const p = exec(CMD, { shell: '/bin/bash' }, () => { times.push(Date.now() - t0); res(); }); p.stdin.end(JSON.stringify(ev)); }); }
const base = (sid, cwd) => ({ session_id: sid, cwd, transcript_path: '/tmp/t', permission_mode: 'default' });
const snap = () => readText(BOX + 460, 256);
const results = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const OUT = process.env.OUT;
(async () => {
  await wait(800);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
  const errs = [];
  p.on('pageerror', e => { if (!/remove|multiplayerState/.test(e.message)) errs.push(e.message); });
  await p.goto(`http://127.0.0.1:${PORT}/mirror`); await p.waitForTimeout(2500);
  await p.waitForFunction(() => devicePhoto.complete && devicePhoto.naturalWidth === 1132);
  assert.deepEqual(await p.evaluate(() => [stage.width, stage.height]), [547, 782]);
  const transparentCorners = () => p.evaluate(() => [[20, 20], [520, 20], [20, 770], [520, 770]].map(([posX, posY]) => ctx.getImageData(posX, posY, 1, 1).data[3]));
  assert.deepEqual(await transparentCorners(), [0, 0, 0, 0], 'device background is transparent');
  const buttonPixel = button => p.evaluate(button => {
    const [centerX, centerY] = DEVICE.buttons[button];
    return [...ctx.getImageData(centerX, centerY, 1, 1).data];
  }, button);
  for (const button of ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'MENU']) {
    const resting = await buttonPixel(button);
    serial('D ' + button);
    await wait(150);
    assert.equal(await p.evaluate(button => pressed[button], button), true);
    assert.notDeepEqual(await buttonPixel(button), resting, button + ' highlights at its physical location');
    serial('U ' + button);
    await wait(150);
    assert.deepEqual(await buttonPixel(button), resting, button + ' restores the photo on release');
  }
  const shot = async (n) => { await p.locator('#stage').screenshot({ path: `${OUT}/${n}.png` }); };
  await shot('mirror-1-idle');
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'SessionStart', source: 'startup' });
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/server.ts' } });
  await wait(600); await shot('mirror-2-working');
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  serial('D A');                       // real button held on the "device"
  await wait(700); await shot('mirror-3-approve-A-pressed');
  serial('U A');
  // record ~2 s while things change
  await p.keyboard.press('r'); await wait(300);
  const dl = p.waitForEvent('download');
  await hook({ ...base('s2', '/Users/a/Projects/web'), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} });
  await hook({ ...base('s1', '/Users/a/Projects/api'), hook_event_name: 'Stop', stop_hook_active: false });
  await wait(1800);
  await p.keyboard.press('r');
  const d = await dl; const vp = `${OUT}/` + d.suggestedFilename(); await d.saveAs(vp);
  serial('D B');
  await wait(500); await shot('mirror-4-done-B-held');
  serial('U B');
  await p.keyboard.press('v'); await wait(400); await shot('mirror-5-screen-only');
  assert.deepEqual(await p.evaluate(() => [stage.width, stage.height]), [640, 512]);
  await p.keyboard.press('v');
  await p.setViewportSize({ width: 390, height: 844 });
  await wait(300);
  const mobile = await p.locator('#stage').boundingBox();
  assert(mobile.width <= 390 && mobile.height <= 844);
  assert(Math.abs(mobile.width / mobile.height - 547 / 782) < 0.01, 'portrait frame keeps its aspect ratio on mobile');
  assert.deepEqual(await transparentCorners(), [0, 0, 0, 0], 'returning from screen-only preserves transparency');
  await shot('mirror-6-mobile');
  const fs = require('fs');
  origLog('video', vp, fs.statSync(vp).size, 'bytes'); origLog('page errors', errs.length, errs.slice(0, 2));
  const ok = fs.statSync(vp).size > 10000 && errs.length === 0;
  await b.close();
  origLog(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
})();
