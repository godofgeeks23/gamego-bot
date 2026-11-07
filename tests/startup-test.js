const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const helper = process.argv[2] || path.join(__dirname, '../claude-link.js');
  const script = `
    const Module = require('module');
    const original = Module._load;
    const usb = { usb: new (require('events').EventEmitter)(), getDeviceList() {
      console.error('USB opened before port was acquired'); process.exit(98);
    } };
    Module._load = function(name, ...args) {
      return name === 'usb' ? usb : original.call(this, name, ...args);
    };
    require('child_process').spawn = () => {
      console.error('Keystroke worker started before port was acquired'); process.exit(99);
    };
    require(${JSON.stringify(helper)});
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, CLAUDE_LINK_PORT: String(server.address().port) },
    timeout: 5000,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { console.error(error); process.exitCode = 1; server.close(); });
  child.on('close', code => {
    try {
      assert.equal(code, 1, output);
      assert.match(output, /already using.*Exiting without opening USB/);
      console.log('PASS: duplicate launch exits before opening USB or starting the keystroke worker');
    } catch (error) { console.error(error); process.exitCode = 1; }
    finally { server.close(); }
  });
});
server.on('error', error => { console.error(error); process.exitCode = 1; });
