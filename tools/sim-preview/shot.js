const { chromium } = require('playwright');
const LEG = 'A=Enter;B=Esc;PAD=Arrows;MENU=Shift+Tab;hold B=more...|B+A=Ctrl+C;B+UP=continue;B+DOWN=Esc Esc;B+LEFT=prev tab;B+RIGHT=next tab;B+MENU=/ cmds';
const SESS = (rows) => rows.join('\n');
const scenes = [
  ['1-no-mac', { live: false, hb: 0 }],
  ['2-legend', { live: true, t0: 'ENTER|send / approve|Terminal|1', t1: LEG, t2: '|0||' }],
  ['3-working', { t0: 'DOWN|navigate|iTerm2|2', t2: SESS(['|0||', 'W|api-gateway-service|Edit server.ts', 'W|web|Bash npm run test:integration', 'I|my-very-long-project-name|ready', 'D|docs|done']) }],
  ['4-approve', { t2: SESS(['A|1|APPROVE?|web: Bash npm run test:integration --watch=false', 'A|web|Bash npm run test:integration', 'W|api-gateway-service|Edit server.ts', 'D|docs|done']) }],
  ['5-done', { t2: SESS(['D|2|DONE|api-gateway-service', 'D|api-gateway-service|done', 'W|web|thinking']) }],
  ['6-your-turn', { t2: SESS(['I|3|YOUR TURN|docs', 'I|docs|your turn', 'W|web|Grep handleRequest']) }],
];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 700, height: 560 } });
  p.on('pageerror', e => { if (!/remove/.test(e.message)) console.log('pageerror:', e.message.slice(0, 200)); });
  await p.goto('http://127.0.0.1:8765/index.html'); await p.waitForTimeout(2500);
  await p.evaluate(() => {
    const out = document.getElementById('out'), ctx = out.getContext('2d');
    setInterval(() => {
      const s = pxsim.runtime.board.screenState;
      if (!s.screen) return;
      out.width = s.width; out.height = s.height;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(s.screen.buffer.slice(0)), s.width, s.height), 0, 0);
    }, 30);
    document.getElementById('wrap').style.display = 'none';
  });
  for (const [name, st] of scenes) {
    await p.evaluate((st) => { Object.assign(MB, st); MB.seq++; }, st);
    await p.waitForTimeout(name === '5-done' ? 450 : 900);
    await p.locator('#out').screenshot({ path: `${name}.png` });
    console.log('shot', name, await p.evaluate(() => { const s = pxsim.runtime.board.screenState; return s.width + 'x' + s.height; }));
  }
  // B layer: hold the B key (sim maps X to B)
  await p.evaluate(() => { MB.t2 = '|0||\nW|web|thinking'; MB.seq++; });
  await p.keyboard.down('x'); await p.waitForTimeout(500);
  await p.locator('#out').screenshot({ path: '7-b-layer.png' });
  await p.keyboard.up('x');
  await b.close();
})();
