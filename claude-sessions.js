'use strict';
const fs = require('fs').promises;
const path = require('path');

// shortcut: Claude's local registry is internal; revisit this reader if its schema changes.
function createClaudeMonitor(home, onSession, onRemove, onError) {
  const known = new Map();
  let scanning = false;
  return async function poll() {
    if (scanning) return;
    scanning = true;
    try {
      const directory = path.join(home, 'sessions');
      let names;
      try { names = await fs.readdir(directory); }
      catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
      const present = new Set(names.filter(name => /^\d+\.json$/.test(name)));
      const retired = new Set();
      for (const name of present) {
        try {
          const record = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
          if (!record || typeof record.sessionId !== 'string' || !record.sessionId ||
              !Number.isInteger(record.pid) || record.pid <= 0 || name !== `${record.pid}.json`) continue;
          if (record.spare || !['interactive', 'bg'].includes(record.kind)) { present.delete(name); continue; }
          try { process.kill(record.pid, 0); }
          catch (error) {
            if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
            if (error.code === 'ESRCH') { present.delete(name); retired.add(record.sessionId); continue; }
          }
          const state = record.waitingFor ? 'A' : record.status === 'busy' ? 'W' : 'I';
          const update = { id: record.sessionId, cwd: typeof record.cwd === 'string' ? record.cwd : '',
            title: typeof record.name === 'string' ? record.name : '', state,
            text: state === 'W' ? 'thinking' : state === 'A' ? String(record.waitingFor) : 'idle',
            at: Number(record.statusUpdatedAt || record.updatedAt || record.startedAt) || 0 };
          const previous = known.get(name);
          if (previous && previous.id !== update.id) retired.add(previous.id);
          const signature = JSON.stringify(update);
          if (!previous || previous.signature !== signature) onSession(update);
          known.set(name, { id: update.id, signature });
        } catch (error) {
          if (error.code === 'ENOENT') present.delete(name);
          else onError(error);
        }
      }
      const liveIds = new Set([...known].filter(([name]) => present.has(name)).map(([, value]) => value.id));
      for (const [name, previous] of known) {
        if (!present.has(name)) {
          known.delete(name);
          retired.add(previous.id);
        }
      }
      for (const id of retired) if (!liveIds.has(id)) onRemove(id);
    } catch (error) { onError(error); }
    finally { scanning = false; }
  };
}

module.exports = { createClaudeMonitor };
