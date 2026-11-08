'use strict';
const fs = require('fs').promises;
const path = require('path');

const MAX_AGE = 3 * 3600 * 1000;
// shortcut: rollout format is internal and reads keep only the latest 1 MiB; prefer lifecycle hooks if the format changes.
const READ_LIMIT = 1024 * 1024;

async function readRows(file, cursor) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (stat.size < cursor.offset) cursor.offset = 0;
    const start = Math.max(cursor.offset, stat.size - READ_LIMIT);
    const buffer = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    const end = bytes.lastIndexOf(10);
    if (end < 0) return [];
    const first = start > cursor.offset ? bytes.indexOf(10) + 1 : 0;
    cursor.offset = start + end + 1;
    return bytes.subarray(first, end).toString('utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; }
      catch (_) { return []; }
    });
  } finally {
    if (handle) await handle.close();
  }
}

function applyRow(session, row) {
  const payload = row.payload;
  if (!payload || typeof payload !== 'object') return;
  let state, text;
  if (row.type === 'event_msg') {
    switch (payload.type) {
      case 'task_started': case 'user_message': state = 'W'; text = 'thinking'; break;
      case 'task_complete': state = 'D'; text = 'done'; break;
      case 'turn_aborted': state = 'I'; text = 'interrupted'; break;
      case 'exec_approval_request': case 'apply_patch_approval_request': state = 'A'; text = 'needs approval'; break;
      case 'request_user_input': state = 'I'; text = 'your turn'; break;
      default: return;
    }
  } else if (row.type === 'response_item') {
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const name = String(payload.name || 'tool').split('.').pop();
      state = name === 'request_user_input' ? 'I' : 'W';
      text = state === 'I' ? 'your turn' : name;
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      state = 'W'; text = 'thinking';
    } else return;
  } else return;
  session.state = state;
  session.text = text;
  session.at = Date.parse(row.timestamp) || session.at;
}

function createCodexMonitor(home, onSession, onRemove, onError) {
  const files = new Map();
  const titles = new Map();
  const index = { offset: 0 };
  let scanning = false, nextScan = 0;

  async function discover(directory, now) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await discover(file, now);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && !files.has(file)) {
        let handle;
        try {
          const stat = await fs.stat(file);
          if (now - stat.mtimeMs > MAX_AGE) continue;
          handle = await fs.open(file, 'r');
          const buffer = Buffer.alloc(Math.min(stat.size, READ_LIMIT));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const end = buffer.subarray(0, bytesRead).indexOf(10);
          if (end < 0) continue;
          const row = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          const meta = row.payload;
          if (row.type !== 'session_meta' || !meta || typeof meta.id !== 'string') continue;
          if (meta.parent_thread_id || (meta.source && typeof meta.source === 'object')) continue;
          files.set(file, { offset: 0, id: meta.id, cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
            state: 'I', text: 'ready', at: Date.parse(row.timestamp || meta.timestamp) || stat.mtimeMs,
            initial: true, published: '' });
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) onError(error);
        } finally { if (handle) await handle.close(); }
      }
    }
  }

  return async function poll(now = Date.now()) {
    if (scanning) return;
    scanning = true;
    try {
      if (now >= nextScan) {
        nextScan = now + 10000;
        await discover(path.join(home, 'sessions'), now);
      }
      try {
        for (const row of await readRows(path.join(home, 'session_index.jsonl'), index)) {
          if (typeof row.id === 'string' && typeof row.thread_name === 'string') titles.set(row.id, row.thread_name);
        }
      } catch (error) { if (error.code !== 'ENOENT') onError(error); }
      for (const [file, session] of files) {
        try {
          for (const row of await readRows(file, session)) applyRow(session, row);
          const update = { id: session.id, cwd: session.cwd, title: titles.get(session.id) || '',
            state: session.state, text: session.text, at: session.at };
          const signature = JSON.stringify(update);
          if (signature !== session.published) {
            onSession(update, session.initial);
            session.published = signature;
          }
          session.initial = false;
        } catch (error) {
          if (error.code === 'ENOENT') { onRemove(session.id); files.delete(file); }
          else onError(error);
        }
      }
    } catch (error) { onError(error); }
    finally { scanning = false; }
  };
}

module.exports = { createCodexMonitor };
