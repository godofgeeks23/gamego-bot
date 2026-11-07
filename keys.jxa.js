// Long-running keystroke worker. Reads one JSON command per line on stdin:
//   {"k": 36, "m": ["command down"]}   key code with modifiers
//   {"t": "continue"}                   type text
//   {"front": 1}                        reply with the frontmost app name on stdout
ObjC.import('Foundation');
const se = Application('System Events');
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
const stdout = $.NSFileHandle.fileHandleWithStandardOutput;

function reply(s) {
  stdout.writeData($(s + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

function handle(cmd) {
  if (cmd.k !== undefined) {
    if (cmd.m && cmd.m.length) se.keyCode(cmd.k, { using: cmd.m });
    else se.keyCode(cmd.k);
  } else if (cmd.t !== undefined) {
    se.keystroke(cmd.t);
  } else if (cmd.front) {
    let name = '';
    try { name = se.applicationProcesses.where({ frontmost: true }).name()[0] || ''; } catch (e) {}
    reply('FRONT ' + name);
  }
}

let buf = '';
while (true) {
  const data = stdin.availableData; // blocks until input
  if (data.length == 0) break;      // stdin closed: parent exited
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch (e) { reply('ERR ' + e); }
  }
}
