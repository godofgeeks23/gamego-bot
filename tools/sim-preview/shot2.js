const { chromium } = require('playwright');
const mascot = require('./mascot.json');
const LEG = 'A=Enter;B=Esc;PAD=Arrows;MENU=Shift+Tab;hold B=more...|B+A=Ctrl+C;B+UP=continue;B+DOWN=Esc Esc;B+LEFT=prev tab;B+RIGHT=next tab;B+MENU=/ cmds';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 700, height: 560 } });
  p.on('pageerror', e => { if (!/remove|multiplayerState/.test(e.message)) console.log('pageerror:', e.message.slice(0, 200)); });
  await p.goto('http://127.0.0.1:8765/index.html'); await p.waitForTimeout(2500);
  await p.evaluate(() => {
    const out = document.getElementById('out'), ctx = out.getContext('2d');
    setInterval(() => { const s = pxsim.runtime.board.screenState; if (!s.screen) return; out.width = s.width; out.height = s.height;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(s.screen.buffer.slice(0)), s.width, s.height), 0, 0); }, 30);
    document.getElementById('wrap').style.display = 'none';
  });
  const shots = [
    ['m1-custom-idle', { live: true, t0: 'ENTER|send / approve|iTerm2|1', t1: LEG, t2: '|0||', mseq: 1, mmask: mascot.mask, mframes: mascot.frames }],
    ['m2-custom-work', { t2: '|0||\nW|api|Edit server.ts\nI|web|ready' }],
    ['m3-pip-fallback-alert', { t2: 'A|1|APPROVE?|web: Bash npm test\nA|web|Bash npm test\nW|api|Edit server.ts' }],
  ];
  for (const [name, st] of shots) {
    await p.evaluate((st) => { Object.assign(MB, st); MB.seq++; }, st);
    await p.waitForTimeout(900);
    await p.locator('#out').screenshot({ path: `${name}.png` });
  }
  await b.close();
})();
