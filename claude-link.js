#!/usr/bin/env node
/**
 * claude-link — Mac helper for the GameGo "CLAUDE LINK" firmware.
 *
 * Talks to the GameGo over USB using MakeCode's HF2 protocol:
 *   GameGo -> Mac : button events as serial lines ("D A", "U B", "R UP")
 *   Mac -> GameGo : heartbeat + status/legend text written into a RAM mailbox
 * Button events are turned into keystrokes for the frontmost app (your terminal
 * running Claude Code / Codex) according to config.json.
 *
 * Usage:  node claude-link.js            (normal)
 *         node claude-link.js --dry-run  (print events, send no keystrokes)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let usbLib;
try {
  usbLib = require('usb');
} catch (e) {
  console.error('Missing dependency. Run:  npm install   (in this folder)');
  process.exit(1);
}
const { usb, getDeviceList } = usbLib;

const DRY = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const CONFIG_PATH = path.join(__dirname, 'config.json');
let cfg = loadConfig();

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
  try {
    cfg = loadConfig();
    log('config.json reloaded');
    if (link) link.writeLegend().catch(() => {});
    mirrorPush();
  } catch (e) {
    log('config.json has an error, keeping old config: ' + e.message);
  }
});

function log(...a) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...a);
}

// ---------------------------------------------------------------- keystrokes
const KEYCODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, pageup: 116, pagedown: 121, home: 115, end: 119,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15,
  y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '=': 24, '9': 25, '7': 26,
  '-': 27, '8': 28, '0': 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
};
const MODS = { command: 'command down', cmd: 'command down', shift: 'shift down',
  control: 'control down', ctrl: 'control down', option: 'option down', alt: 'option down' };

let worker = null;
let onFront = null;
function startWorker() {
  worker = spawn('osascript', ['-l', 'JavaScript', path.join(__dirname, 'keys.jxa.js')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  worker.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith('FRONT ')) { if (onFront) onFront(line.slice(6)); }
      else if (line.startsWith('ERR ')) {
        log('keystroke error:', line.slice(4));
        if (/not allowed|1002|assistive/i.test(line))
          log('-> Give your terminal app Accessibility access: System Settings > Privacy & Security > Accessibility');
      }
    }
  });
  worker.on('exit', (code) => {
    log('keystroke worker exited (' + code + '), restarting');
    setTimeout(startWorker, 1000);
  });
}
function toWorker(obj) {
  if (worker && worker.stdin.writable) worker.stdin.write(JSON.stringify(obj) + '\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let actionCount = 0;
async function runAction(a) {
  if (!a) return;
  actionCount++;
  if (VERBOSE || DRY) log('->', a.label);
  if (!DRY) {
    for (const step of a.do || []) {
      if (step.delay) { await sleep(step.delay); continue; }
      if (step.text !== undefined) { toWorker({ t: String(step.text) }); continue; }
      if (step.key !== undefined) {
        const k = KEYCODES[String(step.key).toLowerCase()];
        if (k === undefined) { log('unknown key in config:', step.key); continue; }
        const m = (step.mods || []).map((x) => MODS[String(x).toLowerCase()]).filter(Boolean);
        toWorker({ k, m });
      }
    }
  }
  status.label = a.label || '';
  status.hint = a.hint || '';
  if (link) link.writeStatus().catch(() => {});
  mirrorPush();
}

// ---------------------------------------------------------------- button logic
const bState = { down: false, combo: false, at: 0 };
function onDeviceLine(line) {
  const [ev, btn] = line.trim().split(/\s+/);
  if (!ev || !btn) return;
  mirrorButton(ev, btn);
  if (VERBOSE) log('event', ev, btn);

  if (btn === 'B') {
    if (ev === 'D') { bState.down = true; bState.combo = false; bState.at = Date.now(); }
    else if (ev === 'U') {
      const tap = bState.down && !bState.combo && Date.now() - bState.at < (cfg.tapMs || 450);
      bState.down = false;
      if (tap) runAction(cfg.base.B);
    }
    return;
  }
  if (ev === 'U') return;
  if (bState.down) {
    if (ev === 'D') { bState.combo = true; runAction(cfg.combo[btn]); }
    return; // no auto-repeat inside the combo layer
  }
  const a = cfg.base[btn];
  if (!a) return;
  if (ev === 'R' && !a.repeat) return;
  runAction(a);
}

// ---------------------------------------------------------------- HF2 link
const HF2 = { INFO: 0x0002, WRITE_WORDS: 0x0009, DMESG: 0x0010 };
const FLAG = { BODY: 0x00, LAST: 0x40, SERIAL: 0x80, SERIAL_ERR: 0xc0, MASK: 0xc0 };
const MB = { HEARTBEAT: 4, SEQ: 8, STATUS: 12, STATUS_LEN: 128, LEGEND: 140, LEGEND_LEN: 320,
  CLAUDE: 460, CLAUDE_LEN: 256, MASCOT_SEQ: 716, MASCOT_MASK: 720, MASCOT: 724 };
const mascotLib = require('./mascot');
const MASCOT_DIR = path.join(__dirname, 'mascot');

const status = { label: 'READY', hint: 'press a button', app: '' };
function statusString() { return `${status.label}|${status.hint}|${status.app}|${actionCount}`; }
function legendString() {
  const lg = cfg.legend || {};
  return (lg.base || []).join(';') + '|' + (lg.combo || []).join(';');
}
let link = null;

class Link {
  constructor(dev, iface, inEp, outEp) {
    this.dev = dev; this.iface = iface; this.inEp = inEp; this.outEp = outEp;
    this.tag = 1; this.pending = new Map(); this.rx = []; this.serialBuf = '';
    this.queue = Promise.resolve(); this.closed = false;
    this.addr = 0; this.hb = 1; this.seq = 1; this.timers = [];
  }

  start() {
    this.inEp.on('data', (d) => this.onData(d));
    this.inEp.on('error', (e) => this.close('read error: ' + e.message));
    this.inEp.startPoll(3, 64);
  }

  onData(d) {
    for (let off = 0; off + 1 <= d.length; off += 64) {
      const pkt = d.subarray(off, off + 64);
      const tag = pkt[0];
      const size = tag & 63;
      const flag = tag & FLAG.MASK;
      const payload = pkt.subarray(1, 1 + size);
      if (flag === FLAG.SERIAL || flag === FLAG.SERIAL_ERR) {
        this.serialBuf += payload.toString('utf8');
        let i;
        while ((i = this.serialBuf.indexOf('\n')) >= 0) {
          const line = this.serialBuf.slice(0, i);
          this.serialBuf = this.serialBuf.slice(i + 1);
          if (line.trim()) onDeviceLine(line);
        }
      } else {
        this.rx.push(Buffer.from(payload));
        if (flag === FLAG.LAST) {
          const msg = Buffer.concat(this.rx);
          this.rx = [];
          if (msg.length >= 4) {
            const p = this.pending.get(msg.readUInt16LE(0));
            if (p) { this.pending.delete(msg.readUInt16LE(0)); clearTimeout(p.timer); p.resolve(msg); }
          }
        }
      }
    }
  }

  transfer(buf) {
    return new Promise((res, rej) => this.outEp.transfer(buf, (e) => (e ? rej(e) : res())));
  }

  // one command at a time; the device has a single command buffer
  cmd(id, data = Buffer.alloc(0)) {
    const run = async () => {
      if (this.closed) throw new Error('closed');
      const tag = (this.tag++ & 0x7fff) || 1;
      const msg = Buffer.alloc(8 + data.length);
      msg.writeUInt32LE(id, 0);
      msg.writeUInt16LE(tag, 4);
      data.copy(msg, 8);
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(tag); reject(new Error('timeout')); }, 2000);
        this.pending.set(tag, { resolve, reject, timer });
      });
      for (let off = 0; off < msg.length; off += 63) {
        const chunk = msg.subarray(off, off + 63);
        const last = off + 63 >= msg.length;
        const pkt = Buffer.alloc(64);
        pkt[0] = (last ? FLAG.LAST : FLAG.BODY) | chunk.length;
        chunk.copy(pkt, 1);
        await this.transfer(pkt);
      }
      const resp = await done;
      if (resp[2] !== 0) throw new Error('device status ' + resp[2]);
      return resp.subarray(4);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async writeWords(addr, buf) {
    for (let off = 0; off < buf.length; off += 240) {
      const part = buf.subarray(off, off + 240);
      const data = Buffer.alloc(8 + part.length);
      data.writeUInt32LE(addr + off, 0);
      data.writeUInt32LE(part.length / 4, 4);
      part.copy(data, 8);
      await this.cmd(HF2.WRITE_WORDS, data);
    }
  }

  async writeU32(addr, v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    await this.writeWords(addr, b);
  }

  textBuf(s, len) {
    const b = Buffer.alloc(len); // zero padded = null terminated
    b.write(String(s).replace(/[^\x20-\x7e\n]/g, '?').slice(0, len - 1), 'ascii');
    return b;
  }

  async bumpSeq() { await this.writeU32(this.addr + MB.SEQ, ++this.seq); }

  async writeStatus() {
    if (!this.addr) return;
    const s = statusString();
    await this.writeWords(this.addr + MB.STATUS, this.textBuf(s, MB.STATUS_LEN));
    await this.bumpSeq();
  }

  async writeLegend() {
    if (!this.addr) return;
    const s = legendString();
    await this.writeWords(this.addr + MB.LEGEND, this.textBuf(s, MB.LEGEND_LEN));
    await this.bumpSeq();
  }

  async writeMascot() {
    if (!this.addr) return;
    const m = mascotLib.loadMascot(MASCOT_DIR);
    for (const e of m.errors) log('mascot:', e);
    for (let i = 0; i < mascotLib.MOODS.length; i++) {
      if (m.mask & (1 << i)) await this.writeWords(this.addr + MB.MASCOT + i * mascotLib.FRAME_BYTES, m.frames[i]);
    }
    await this.writeU32(this.addr + MB.MASCOT_MASK, m.mask);
    this.mascotSeq = (this.mascotSeq || 0) + 1;
    await this.writeU32(this.addr + MB.MASCOT_SEQ, this.mascotSeq);
    log(m.found.length ? `mascot: custom frames for ${m.found.join(', ')} (others use Pip)` : 'mascot: using Pip (no PNGs in mascot/)');
  }

  async writeClaude() {
    if (!this.addr) return;
    await this.writeWords(this.addr + MB.CLAUDE, this.textBuf(claudeText(), MB.CLAUDE_LEN));
    await this.bumpSeq();
  }

  async findMailbox() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const d = (await this.cmd(HF2.DMESG)).toString('latin1');
      const all = [...d.matchAll(/PLNK (\d+)/g)];
      if (all.length) return parseInt(all[all.length - 1][1], 10);
      await sleep(1200); // device re-announces every 2s
    }
    throw new Error('could not find the mailbox — is the GameGo running the claude-link firmware?');
  }

  async init() {
    const info = (await this.cmd(HF2.INFO)).toString('utf8');
    const model = (info.match(/Model: (.*)/) || [])[1] || 'unknown';
    log('connected:', model.trim());
    this.addr = await this.findMailbox();
    if (VERBOSE) log('mailbox at 0x' + this.addr.toString(16));
    await this.writeU32(this.addr + MB.HEARTBEAT, this.hb);
    await this.writeLegend();
    await this.writeClaude();
    await this.writeStatus();
    await this.writeMascot();
    this.timers.push(setInterval(() => {
      this.writeU32(this.addr + MB.HEARTBEAT, ++this.hb).catch((e) => this.close('heartbeat failed: ' + e.message));
    }, 300));
    this.timers.push(setInterval(() => toWorker({ front: 1 }), 1000));
    mirrorPush();
    log('linked — press buttons on the GameGo' + (DRY ? ' (dry run: no keystrokes)' : ''));
  }

  close(why) {
    if (this.closed) return;
    this.closed = true;
    this.timers.forEach(clearInterval);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); }
    try { this.inEp.stopPoll(); } catch (e) {}
    try { this.iface.release(true, () => { try { this.dev.close(); } catch (e) {} }); } catch (e) {}
    if (why) log('disconnected:', why);
    if (link === this) link = null;
    mirrorPush();
  }
}

// ---------------------------------------------------------------- Claude / Codex sessions
// Claude Code hooks POST their JSON to http://127.0.0.1:<port>/hook (see install-hooks.js).
// Codex's `notify` POSTs to /codex. We track each session and push a summary to the GameGo.
const http = require('http');
const HOOK_PORT = Number(process.env.CLAUDE_LINK_PORT || cfg.hookPort || 47821);

const sessions = new Map(); // id -> { id, name, cwd, state, text, at }
let alert = { kind: '', seq: 0, head: '', detail: '', until: 0, sid: '' };

function shortDetail(tool, input) {
  input = input || {};
  const base = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
  switch (tool) {
    case 'Bash': return String(input.command || '').replace(/\s+/g, ' ').trim();
    case 'Edit': case 'MultiEdit': case 'Write': case 'Read': case 'NotebookEdit':
      return base(input.file_path || input.notebook_path);
    case 'Grep': case 'Glob': return String(input.pattern || '');
    case 'WebFetch': try { return new URL(input.url).host; } catch (e) { return ''; }
    case 'WebSearch': return String(input.query || '');
    case 'Task': case 'Agent': return String(input.description || '');
    default: return '';
  }
}

function sessionFor(ev) {
  const id = ev.session_id || 'unknown';
  let s = sessions.get(id);
  if (!s) {
    const cwd = ev.cwd || '';
    const folder = cwd.split('/').filter(Boolean).pop() || 'claude';
    s = { id, cwd, folder, name: folder, title: '', agentName: '', transcript: '', tOff: 0,
      state: 'I', text: 'ready', at: Date.now() };
    sessions.set(id, s);
  }
  if (ev.transcript_path && ev.transcript_path !== s.transcript) { s.transcript = ev.transcript_path; s.tOff = 0; }
  s.at = Date.now();
  refreshTitle(s);
  return s;
}

// `/rename` doesn't fire a hook; Claude Code appends {"type":"custom-title","customTitle":...}
// (and an "agent-name" entry) to the session transcript. Read only the new bytes each time.
const MAX_SCAN = 32 * 1024 * 1024;
function refreshTitle(s) {
  if (!s.transcript) return false;
  let size;
  try { size = fs.statSync(s.transcript).size; } catch (e) { return false; }
  if (size < s.tOff) s.tOff = 0; // file was rewritten
  if (size === s.tOff) return false;
  const start = Math.max(s.tOff, size - MAX_SCAN);
  let chunk;
  try {
    const fd = fs.openSync(s.transcript, 'r');
    chunk = Buffer.alloc(size - start);
    fs.readSync(fd, chunk, 0, chunk.length, start);
    fs.closeSync(fd);
  } catch (e) { return false; }
  const lastNl = chunk.lastIndexOf(10);
  if (lastNl < 0) return false; // wait for a complete line
  s.tOff = start + lastNl + 1;
  const text = chunk.subarray(0, lastNl).toString('utf8');
  if (text.includes('"custom-title"') || text.includes('"agent-name"')) {
    for (const line of text.split('\n')) {
      if (!line.includes('"custom-title"') && !line.includes('"agent-name"')) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; }
      const val = [o.customTitle, o.agentName, o.name, o.title].find((v) => typeof v === 'string' && v.trim());
      if (!val) continue;
      if (o.type === 'custom-title') s.title = val.trim();
      else if (o.type === 'agent-name') s.agentName = val.trim();
    }
  }
  const name = s.title || s.agentName || s.folder;
  if (name !== s.name) {
    s.name = name;
    if (VERBOSE) log(`session ${s.id.slice(0, 8)} is now "${name}"`);
    return true;
  }
  return false;
}
setInterval(() => {
  let any = false;
  for (const s of sessions.values()) if (refreshTitle(s)) any = true;
  if (any) changed();
}, 2000);

function raise(kind, head, detail, sid, holdMs) {
  alert = { kind, seq: alert.seq + 1, head, detail, sid, until: holdMs ? Date.now() + holdMs : 0 };
}

function refreshAlert() {
  // a pending approval anywhere always wins
  const waiting = [...sessions.values()].filter((s) => s.state === 'A').sort((a, b) => b.at - a.at)[0];
  if (waiting) {
    if (alert.kind !== 'A' || alert.sid !== waiting.id) raise('A', 'APPROVE?', `${waiting.name}: ${waiting.text}`, waiting.id);
    else alert.detail = `${waiting.name}: ${waiting.text}`;
    return;
  }
  if (alert.kind === 'A') alert = { ...alert, kind: '', head: '', detail: '' };
  if (alert.until && Date.now() > alert.until) alert = { ...alert, kind: '', head: '', detail: '', until: 0 };
}

function onClaudeHook(ev) {
  const e = ev.hook_event_name || '';
  if (VERBOSE) log('hook', e, ev.tool_name || ev.notification_type || '');
  if (e === 'SessionEnd') { sessions.delete(ev.session_id); return changed(); }
  const s = sessionFor(ev);
  switch (e) {
    case 'SessionStart': s.state = 'I'; s.text = 'ready'; break;
    case 'UserPromptSubmit': s.state = 'W'; s.text = 'thinking'; break;
    case 'PreToolUse': s.state = 'W'; s.text = `${ev.tool_name} ${shortDetail(ev.tool_name, ev.tool_input)}`.trim(); break;
    case 'PostToolUse': s.state = 'W'; s.text = 'thinking'; break; // also clears an approval
    case 'PermissionRequest':
      s.state = 'A'; s.text = `${ev.tool_name} ${shortDetail(ev.tool_name, ev.tool_input)}`.trim(); break;
    case 'Notification':
      if (ev.notification_type === 'permission_prompt' || /permission/i.test(ev.message || '')) {
        if (s.state !== 'A') { s.state = 'A'; s.text = (ev.message || 'needs permission').replace(/^Claude needs your permission to use /, ''); }
      } else if (ev.notification_type === 'idle_prompt' || /waiting for your input/i.test(ev.message || '')) {
        s.state = 'I'; s.text = 'your turn';
        raise('I', 'YOUR TURN', s.name, s.id, 6000);
      } else if (ev.notification_type === 'elicitation_dialog') {
        s.state = 'A'; s.text = 'question for you';
      }
      break;
    case 'Stop':
      s.state = 'D'; s.text = 'done';
      raise('D', 'DONE', s.name, s.id, 5000);
      break;
    default: break;
  }
  changed();
}

function onCodexNotify(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
  const rawId = ev.session_id || ev['thread-id'] || ev.thread_id;
  if (typeof rawId !== 'string' || !rawId) return;
  const id = 'codex:' + rawId;
  const event = ev.hook_event_name;
  if (event === 'SessionEnd') {
    codexEnded.set(id, Date.now()); sessions.delete(id); changed(); return;
  }
  const states = {
    SessionStart: ['I', 'ready'], UserPromptSubmit: ['W', 'thinking'],
    PreToolUse: ['W', String(ev.tool_name || 'tool')], PostToolUse: ['W', 'thinking'],
    PermissionRequest: ['A', `${ev.tool_name || 'tool'} ${shortDetail(ev.tool_name, ev.tool_input)}`.trim()],
    Stop: ['D', 'done'], Interrupt: ['I', 'interrupted'],
  };
  const state = event ? states[event] : ev.type === 'agent-turn-complete' ? ['D', 'done'] : null;
  if (!Array.isArray(state)) return;
  if (event === 'SessionStart') codexEnded.delete(id);
  updateCodexSession({ id: rawId, cwd: typeof ev.cwd === 'string' ? ev.cwd : '',
    state: state[0], text: state[1], at: Date.now() }, false);
}

const codexEnded = new Map();
function updateCodexSession(update, initial) {
  const id = 'codex:' + update.id;
  if ((codexEnded.get(id) || 0) >= update.at) return;
  codexEnded.delete(id);
  let session = sessions.get(id);
  const previousState = session && session.state;
  if (!session) {
    session = { id, cwd: update.cwd, title: '', state: 'I', text: 'ready', at: 0 };
    sessions.set(id, session);
    log('Codex session:', update.id.slice(-8), path.basename(update.cwd));
  }
  if (update.title !== undefined) session.title = update.title;
  session.name = 'C:' + (session.title || (path.basename(update.cwd || session.cwd) || 'codex').slice(0, 3) + '-' + update.id.slice(-3));
  if (update.at >= session.at) {
    session.state = update.state; session.text = update.text; session.at = update.at;
    if (!initial && session.state !== previousState) {
      if (session.state === 'D') raise('D', 'DONE', session.name, id, 5000);
      else if (session.state === 'I' && session.text === 'your turn') raise('I', 'YOUR TURN', session.name, id, 6000);
    }
  }
  changed();
}

function claudeText() {
  // an approval you answered with "No"/Esc sends no follow-up hook; don't nag forever
  for (const s of sessions.values())
    if (s.state === 'A' && Date.now() - s.at > 10 * 60 * 1000) { s.state = 'I'; s.text = 'your turn'; }
  refreshAlert();
  const order = { A: 0, W: 1, I: 2, D: 3 };
  const rows = [...sessions.values()]
    .filter((s) => Date.now() - s.at < 3 * 3600 * 1000)
    .sort((a, b) => order[a.state] - order[b.state] || b.at - a.at)
    .slice(0, 5)
    .map((s) => `${s.state}|${s.name.replace(/[|\r\n]/g, ' ').slice(0, 10)}|${s.text.replace(/[|\r\n]/g, ' ').slice(0, 15)}`);
  const head = `${alert.kind}|${alert.seq}|${alert.head}|${alert.detail.replace(/[|\n]/g, ' ').slice(0, 28)}`;
  let out = head;
  for (const r of rows) { if ((out + '\n' + r).length > MB.CLAUDE_LEN - 1) break; out += '\n' + r; }
  return out;
}

// coalesce bursts (PreToolUse/PostToolUse can fire many times a second)
let pushTimer = null;
function changed() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (link) link.writeClaude().catch(() => {});
    mirrorPush();
  }, 120);
}
// expire DONE / YOUR TURN banners
setInterval(() => {
  if ((alert.until && Date.now() > alert.until) ||
      [...sessions.values()].some(s => s.state === 'A' && Date.now() - s.at > 10 * 60 * 1000)) changed();
}, 500);

const codexHome = process.env.CLAUDE_LINK_CODEX_HOME || process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
const pollCodex = require('./codex-sessions').createCodexMonitor(codexHome, updateCodexSession, rawId => {
  const id = 'codex:' + rawId;
  if (sessions.delete(id)) changed();
}, error => { if (VERBOSE) log('Codex monitor:', error.message); });

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/mirror')) return mirrorHttp(req, res);
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    res.writeHead(204); res.end(); // answer immediately; never slow Claude down
    let ev;
    try { ev = JSON.parse(body || '{}'); } catch (e) { return; }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
    if (req.url.startsWith('/hook')) onClaudeHook(ev);
    else if (req.url.startsWith('/codex')) onCodexNotify(ev);
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log(`Another helper is already using 127.0.0.1:${HOOK_PORT}. Exiting without opening USB.`);
  else log('hook server error:', e.message);
  if (link) link.close();
  if (worker) { worker.removeAllListeners('exit'); worker.kill(); }
  process.exit(1);
});
server.listen(HOOK_PORT, '127.0.0.1', () => {
  log(`listening for Claude/Codex hooks on 127.0.0.1:${HOOK_PORT}`);
  log(`screen mirror: http://127.0.0.1:${HOOK_PORT}/mirror`);
  if (!DRY) startWorker();
  setInterval(tryConnect, 1000);
  tryConnect();
  setInterval(pollCodex, 2000);
  pollCodex();
});

// ---------------------------------------------------------------- screen mirror
// /mirror runs the same GameGo program in MakeCode's simulator in your browser and feeds it
// the same data the device gets (status, legend, Claude state, mascot) plus the real button
// presses, over Server-Sent Events. Great for projecting or recording a demo.
const MIRROR_DIR = path.join(__dirname, 'mirror');
const MIRROR_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };
const mirrorClients = new Set();
let mirrorMascot = { seq: 0, mask: 0, frames: [] };

function mirrorReloadMascot() {
  const m = mascotLib.loadMascot(MASCOT_DIR);
  mirrorMascot = { seq: mirrorMascot.seq + 1, mask: m.mask, frames: m.frames.map((b) => b.toString('base64')) };
  mirrorPush();
}

function mirrorSend(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }

function mirrorState() {
  return { t0: statusString(), t1: legendString(), t2: claudeText(), device: !!(link && link.addr), mascot: mirrorMascot };
}

let mirrorTimer = null;
function mirrorPush() {
  if (!mirrorClients.size || mirrorTimer) return;
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null;
    const st = mirrorState();
    for (const c of mirrorClients) mirrorSend(c, 'state', st);
  }, 40);
}

function mirrorButton(ev, btn) {
  for (const c of mirrorClients) mirrorSend(c, 'btn', { ev, btn });
}

function mirrorHttp(req, res) {
  const url = req.url.split('?')[0];
  if (url === '/mirror') { res.writeHead(302, { Location: '/mirror/' }); return res.end(); }
  if (url === '/mirror/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    mirrorClients.add(res);
    mirrorSend(res, 'state', mirrorState());
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); mirrorClients.delete(res); });
    return;
  }
  const name = url === '/mirror' || url === '/mirror/' ? 'index.html' : path.basename(url);
  const file = path.join(MIRROR_DIR, name);
  const type = MIRROR_TYPES[path.extname(name)];
  if (!type || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
mirrorReloadMascot();
setInterval(() => { if (mirrorClients.size) mirrorPush(); }, 1000); // keeps banners/expiry in sync

// re-upload the mascot whenever a PNG in mascot/ is added, changed or removed
let mascotTimer = null;
try {
  fs.mkdirSync(MASCOT_DIR, { recursive: true });
  fs.watch(MASCOT_DIR, (ev, file) => {
    if (file && !/\.png$/i.test(file)) return;
    clearTimeout(mascotTimer);
    mascotTimer = setTimeout(() => {
      if (link) link.writeMascot().catch((e) => log('mascot upload failed:', e.message));
      mirrorReloadMascot();
    }, 400);
  });
} catch (e) {
  log('cannot watch mascot/:', e.message);
}

onFront = (name) => {
  if (name !== status.app) {
    status.app = name;
    if (link) link.writeStatus().catch(() => {});
    mirrorPush();
  }
};

// Find the GameGo: an interface with vendor class 0xFF, subclass 42 (MakeCode HF2).
function findHF2() {
  for (const dev of getDeviceList()) {
    let cfgDesc;
    try { cfgDesc = dev.configDescriptor; } catch (e) { continue; }
    if (!cfgDesc) continue;
    for (const alts of cfgDesc.interfaces || []) {
      const d = alts[0];
      if (d && d.bInterfaceClass === 0xff && d.bInterfaceSubClass === 42 && d.endpoints.length >= 2)
        return { dev, ifaceNo: d.bInterfaceNumber };
    }
  }
  return null;
}

let connecting = false;
async function tryConnect() {
  if (link || connecting) return;
  const found = findHF2();
  if (!found) return;
  connecting = true;
  const { dev, ifaceNo } = found;
  try {
    dev.open();
    const iface = dev.interface(ifaceNo);
    iface.claim();
    const inEp = iface.endpoints.find((e) => e.direction === 'in');
    const outEp = iface.endpoints.find((e) => e.direction === 'out');
    const l = new Link(dev, iface, inEp, outEp);
    link = l;
    l.start();
    await l.init();
  } catch (e) {
    log('connect failed:', e.message);
    if (link) link.close();
    try { dev.close(); } catch (_) {}
  } finally {
    connecting = false;
  }
}

usb.on('detach', () => { if (link && !findHF2()) link.close('GameGo unplugged'); });

log('claude-link starting' + (DRY ? ' (dry run)' : '') + ' — waiting for GameGo…');

process.on('SIGINT', () => {
  if (link) link.close();
  if (worker) { worker.removeAllListeners('exit'); worker.kill(); }
  process.exit(0);
});
