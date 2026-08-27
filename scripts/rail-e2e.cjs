/* Floating rail end-to-end check.
 *
 *   node scripts/rail-e2e.cjs            # against dist-dev (what `npm run dev` writes)
 *   node scripts/rail-e2e.cjs dist       # against a release build
 *
 * Launches a headed Chrome with the extension, serves a few local pages, groups them into
 * two spaces, then drives the rail with real input events: hover-open, stationary pointer
 * under tab-title churn, leave-to-hide, row click + handover, space switch, close button,
 * Ctrl+S, plain tab switch, and an extension reload with the pages still open.
 *
 * Harness notes, each of which cost a false failure before it was understood:
 *   - defaultViewport must be null: Puppeteer otherwise emulates 800x600 and silently drops
 *     mouse events dispatched outside it, so a "move away to x=800" never reaches the page.
 *   - Rects are read only after the slide-in transition (170ms) has finished.
 *   - After chrome.runtime.reload() the OLD service worker target lingers; wait for a new one.
 *   - Rail closure state lives in the extension's isolated world; it is read through a CDP
 *     session bound to that execution context via window.__arcifyRailDebug().
 */
const path = require('path');
const http = require('http');
const fs = require('fs');

const ARCIFY = path.resolve(__dirname, '..');
const puppeteer = require(path.join(ARCIFY, 'node_modules/puppeteer'));
const EXT = path.join(ARCIFY, process.argv[2] || 'dist-dev');
const OUT = path.join(ARCIFY, 'tests', 'e2e', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
let currentStep = '';
const logs = [];
function log(...a) { const s = a.join(' '); logs.push(s); console.log(s); }

async function step(name, fn) {
  currentStep = name;
  try { await fn(); results.push({ name, ok: true }); log(`PASS ${name}`); }
  catch (e) { results.push({ name, ok: false, err: String(e && e.stack || e) }); log(`FAIL ${name}: ${e && e.message || e}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }

async function until(fn, ms = 3000, label = 'condition') {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout (${ms}ms) waiting for ${label}; last=${JSON.stringify(last)}`);
}

// --- local pages ------------------------------------------------------------
const server = http.createServer((req, res) => {
  const name = req.url.replace(/^\//, '').split('?')[0] || 'index';
  res.setHeader('content-type', 'text/html');
  // /slow* streams its body over ~3s, so the load event - and document_idle with it - is
  // far away. This is what a real site on a slow connection looks like to the rail.
  if (name.startsWith('slow')) {
    res.write(`<!doctype html><title>Page ${name.toUpperCase()}</title><body style="margin:0;height:3000px;background:#fafafa"><h1>slow</h1>`);
    let i = 0;
    const t = setInterval(() => { res.write(`<p>chunk ${i}</p>`); if (++i >= 6) { clearInterval(t); res.end('</body>'); } }, 500);
    return;
  }
  res.end(`<!doctype html><title>Page ${name.toUpperCase()}</title><body style="margin:0;height:3000px;background:#fafafa">
  <h1 style="margin-left:300px">page ${name}</h1><a id="lnk" href="#" style="position:fixed;left:0;top:500px">edge link</a></body>`);
});

// --- rail probes (run inside a page, main world) -----------------------------
const railProbe = () => {
  const hosts = document.querySelectorAll('#arcify-rail-host');
  const host = hosts[0];
  if (!host || !host.shadowRoot) return { hosts: hosts.length, present: false };
  const panel = host.shadowRoot.querySelector('.panel');
  const rows = [...host.shadowRoot.querySelectorAll('.tab[data-tab-id]')].map(r => {
    const b = r.getBoundingClientRect();
    const c = r.querySelector('.close').getBoundingClientRect();
    return { id: Number(r.dataset.tabId), title: r.querySelector('.tab-title').textContent, active: r.classList.contains('active'),
      cx: b.x + b.width / 2, cy: b.y + b.height / 2, closeX: c.x + c.width / 2, closeY: c.y + c.height / 2 };
  });
  const spaces = [...host.shadowRoot.querySelectorAll('.space[data-space-id]')].map(s => {
    const b = s.getBoundingClientRect();
    return { id: Number(s.dataset.spaceId), name: s.querySelector('.space-name').textContent, active: s.classList.contains('active'), cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
  });
  const pinBtn = host.shadowRoot.querySelector('.pin');
  return {
    hosts: hosts.length, present: true,
    open: panel.classList.contains('open'),
    pinned: pinBtn.classList.contains('active'),
    width: panel.getBoundingClientRect().width,
    title: host.shadowRoot.querySelector('.title').textContent,
    rows, spaces,
    visibility: document.visibilityState,
    mmlog: window.__mmlog || [],
  };
};

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const url = (n) => `http://127.0.0.1:${PORT}/${n}`;
  log(`server on ${PORT}; extension ${EXT}`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    protocolTimeout: 20000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--enable-unsafe-extension-debugging',
      '--no-sandbox', '--disable-dev-shm-usage',
      '--window-size=1300,850', '--window-position=40,40',
    ],
  });

  const pageLogs = new Map();
  const attachLogs = (page, tag) => {
    pageLogs.set(tag, []);
    page.on('console', m => { const s = `[${tag}] ${m.type()}: ${m.text()}`; pageLogs.get(tag).push(s); if (/ArcifyRail|invalidated|Error/i.test(s)) log(s); });
    page.on('pageerror', e => log(`[${tag}] PAGEERROR ${e.message}`));
  };

  const swTarget = async () => until(async () => {
    const t = browser.targets().find(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'));
    return t || null;
  }, 8000, 'service worker');
  let sw = await (await swTarget()).worker();
  const extId = (await swTarget()).url().split('/')[2];
  log('extension id', extId);
  const swEval = (fn, ...args) => sw.evaluate(fn, ...args);

  // Evaluate inside the extension's isolated world of a page (where rail.js closures live).
  const railWorlds = new Map();
  async function railDebug(page) {
    let s = railWorlds.get(page);
    if (!s) {
      s = { session: await page.createCDPSession(), ctxs: [] };
      s.session.on('Runtime.executionContextCreated', e => s.ctxs.push(e.context));
      s.session.on('Runtime.executionContextDestroyed', e => { s.ctxs = s.ctxs.filter(c => c.id !== e.executionContextId); });
      await s.session.send('Runtime.enable');
      await sleep(150);
      railWorlds.set(page, s);
    }
    const ctx = [...s.ctxs].reverse().find(c => c.origin && c.origin.startsWith(`chrome-extension://${extId}`));
    if (!ctx) return { noContext: true, ctxs: s.ctxs.map(c => `${c.name}|${c.origin}|${JSON.stringify(c.auxData)}`) };
    const r = await s.session.send('Runtime.evaluate', { contextId: ctx.id, expression: 'JSON.stringify(typeof __arcifyRailDebug==="function" ? __arcifyRailDebug() : null)', returnByValue: true });
    return r.result.value ? JSON.parse(r.result.value) : { noDebugHook: true, raw: r };
  }

  await sleep(1500);
  for (const p of await browser.pages()) { if (p.url().startsWith('chrome-extension://')) await p.close().catch(() => {}); }

  // --- pages ---
  const open = async (n) => {
    const p = await browser.newPage(); attachLogs(p, n);
    await p.goto(url(n), { waitUntil: 'load' });
    await p.evaluate(() => { window.__mmlog = []; addEventListener('mousemove', e => { window.__mmlog.push([Math.round(performance.now()), e.clientX, e.clientY, e.isTrusted ? 'T' : 'F']); if (window.__mmlog.length > 12) window.__mmlog.shift(); }); });
    return p;
  };
  const pA = await open('a'); const pB = await open('b'); const pC = await open('c'); const pD = await open('d'); const pE = await open('e');
  const pages = { a: pA, b: pB, c: pC, d: pD, e: pE };
  for (const p of await browser.pages()) { if (p.url() === 'about:blank') await p.close().catch(() => {}); }

  const tabIdFor = async (n) => (await swEval(async (u) => (await chrome.tabs.query({ url: u + '*' }))[0]?.id, url(n)));
  const ids = {}; for (const n of Object.keys(pages)) ids[n] = await tabIdFor(n);
  log('tab ids', JSON.stringify(ids));

  const groups = await swEval(async (ids) => {
    const g1 = await chrome.tabs.group({ tabIds: [ids.a, ids.b, ids.c] });
    await chrome.tabGroups.update(g1, { title: 'Work', color: 'blue' });
    const g2 = await chrome.tabs.group({ tabIds: [ids.d, ids.e] });
    await chrome.tabGroups.update(g2, { title: 'Play', color: 'green' });
    return { work: g1, play: g2 };
  }, ids);
  log('groups', JSON.stringify(groups));

  const activeTabId = async () => swEval(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  const pageOf = (id) => Object.entries(ids).find(([, v]) => v === id)?.[0];
  const probe = (p) => p.evaluate(railProbe);
  const shot = (p, name) => p.screenshot({ path: path.join(OUT, `rail-${name}.png`) }).catch(() => {});
  const dump = async (p, tag) => { const pr = await probe(p); log(`  [${tag}] open=${pr.open} vis=${pr.visibility} mmlog=${JSON.stringify(pr.mmlog)}`); log(`  [${tag}] rail=${JSON.stringify(await railDebug(p))}`); };

  await pA.bringToFront();
  await sleep(600);

  await step('rail attached in page A (single host)', async () => {
    const s = await until(async () => { const r = await probe(pA); return r.present ? r : null; }, 5000, 'host');
    assert(s.hosts === 1, `expected 1 host, got ${s.hosts}`);
    assert(!s.open, 'panel should start closed');
    log('  debug:', JSON.stringify(await railDebug(pA)));
  });

  await step('hover left edge opens panel with Work tabs', async () => {
    await pA.mouse.move(500, 300); await sleep(50);
    await pA.mouse.move(2, 300);
    const s = await until(async () => { const r = await probe(pA); return r.open && r.rows.length ? r : null; }, 2500, 'open');
    log('  rows:', s.rows.map(r => `${r.title}${r.active ? '*' : ''}`).join(', '), '| spaces:', s.spaces.map(x => x.name + (x.active ? '*' : '')).join(', '), '| width', s.width);
    assert(s.title === 'Work', `title ${s.title}`);
    assert(s.rows.some(r => r.title === 'Page B'), 'row for B missing');
    assert(s.rows.find(r => r.title === 'Page A')?.active, 'A should be active row');
    await shot(pA, 'hover-open');
  });

  await step('stationary pointer inside panel survives title churn (no phantom hide)', async () => {
    await pA.mouse.move(20, 300); await sleep(120);
    for (let i = 0; i < 12; i++) { await pC.evaluate((i) => { document.title = 'Page C ' + i; }, i); await sleep(70); }
    await sleep(400);
    const s = await probe(pA);
    assert(s.open, 'panel hid during churn while pointer inside');
    // pointer is inside, so the refresh is deferred until it leaves; verify deferral, then release
    await pA.mouse.move(700, 300);
    await until(async () => !(await probe(pA)).open, 1500, 'hide');
    await pA.mouse.move(2, 300);
    const s2 = await until(async () => { const r = await probe(pA); return r.open && r.rows.some(x => /Page C 11/.test(x.title)) ? r : null; }, 2500, 'refreshed rows');
    assert(s2, 'rows not refreshed');
  });

  await step('pointer leaving panel hides it; returning re-opens; moving inside keeps it', async () => {
    await pA.mouse.move(700, 300);
    await until(async () => !(await probe(pA)).open, 1500, 'hide');
    await pA.mouse.move(2, 300);
    await until(async () => (await probe(pA)).open, 1500, 'reopen');
    await pA.mouse.move(120, 300); await sleep(300);
    assert((await probe(pA)).open, 'moving inside the panel must not hide it');
  });

  await step('click tab row B: B activates, rail handed over and open in B', async () => {
    const s = await probe(pA);
    const row = s.rows.find(r => r.title === 'Page B');
    await pA.mouse.move(row.cx, row.cy); await sleep(60);
    await pA.mouse.down(); await pA.mouse.up();
    await until(async () => (await activeTabId()) === ids.b, 3000, 'B active');
    // The panel is shown the moment the class lands; the state fetch that marks the active
    // row completes a moment later. Wait for it to settle rather than racing it.
    const sb = await until(async () => {
      const r = await probe(pB);
      return r.open && r.rows.find(x => x.title === 'Page B')?.active ? r : null;
    }, 3000, 'B rail open with B marked active');
    assert(sb.rows.find(r => r.title === 'Page B')?.active, 'B row should be active in B');
    await sleep(900);
    assert((await probe(pB)).open, 'B rail closed by itself after handover');
    assert(!(await probe(pA)).open, 'A rail should be dropped when hidden');
    await dump(pB, 'B after handover');
    await shot(pB, 'handover-b');
  });

  await step('in B: moving pointer away hides handed-over panel', async () => {
    await pB.mouse.move(120, 300); await sleep(100);
    await dump(pB, 'B after move inside');
    assert((await probe(pB)).open, 'still open while inside');
    await pB.mouse.move(800, 300);
    await sleep(120);
    await dump(pB, 'B after move outside');
    await until(async () => !(await probe(pB)).open, 1500, 'hide');
  });

  await step('click Play space chip: D activates with Play rail', async () => {
    await pB.mouse.move(2, 300);
    await until(async () => { const r = await probe(pB); return r.open && r.spaces.length ? r : null; }, 2500, 'open');
    await sleep(300); // let the slide-in transition finish before trusting rects
    const s = await probe(pB);
    const chip = s.spaces.find(x => x.name === 'Play');
    assert(chip, `no Play chip: ${JSON.stringify(s.spaces)}`);
    await pB.mouse.move(chip.cx, chip.cy); await sleep(60);
    await pB.mouse.down(); await pB.mouse.up();
    await until(async () => [ids.d, ids.e].includes(await activeTabId()), 3000, 'D/E active');
    const active = await activeTabId();
    const pActive = pages[pageOf(active)];
    const sd = await until(async () => { const r = await probe(pActive); return r.open ? r : null; }, 3000, 'Play rail open');
    assert(sd.title === 'Play', `title ${sd.title}`);
    assert(sd.rows.length === 2, `expected 2 rows, got ${sd.rows.length}`);
    await shot(pActive, 'space-switch');
  });

  await step('close-button on a row closes that tab', async () => {
    const active = await activeTabId();
    const pActive = pages[pageOf(active)];
    const other = active === ids.d ? 'Page E' : 'Page D';
    const s = await probe(pActive);
    const row = s.rows.find(r => r.title === other);
    await pActive.mouse.move(row.closeX, row.closeY); await sleep(60);
    await pActive.mouse.down(); await pActive.mouse.up();
    await until(async () => { const t = await swEval(async () => (await chrome.tabs.query({})).map(t => t.id)); return !t.includes(row.id); }, 3000, 'tab closed');
    await until(async () => { const r = await probe(pActive); return r.rows.length === 1 ? r : null; }, 3000, 'row removed');
    assert((await probe(pActive)).open, 'rail should stay open after closing another tab');
  });

  await step('Ctrl+S toggles a pinned rail', async () => {
    const active = await activeTabId();
    const p = pages[pageOf(active)];
    await p.mouse.move(800, 400); await sleep(120);
    await dump(p, 'before ctrl+s');
    await until(async () => !(await probe(p)).open, 1500, 'closed first');
    await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control');
    const s = await until(async () => { const r = await probe(p); return r.open ? r : null; }, 1500, 'open via Ctrl+S');
    assert(s.pinned, 'Ctrl+S open should be pinned');
    await p.mouse.move(900, 500); await sleep(250);
    assert((await probe(p)).open, 'pinned rail must ignore pointer leaving');
    await p.keyboard.down('Control'); await p.keyboard.press('KeyS'); await p.keyboard.up('Control');
    await until(async () => !(await probe(p)).open, 1500, 'closed via Ctrl+S');
  });

  await step('plain tab switch (not via rail) hands rail over when window flag set', async () => {
    const active = await activeTabId();
    const p = pages[pageOf(active)];
    await p.mouse.move(2, 300);
    await until(async () => (await probe(p)).open, 1500, 'open');
    await swEval(async (id) => { await chrome.tabs.update(id, { active: true }); }, ids.a);
    await until(async () => (await activeTabId()) === ids.a, 2000, 'A active');
    await until(async () => (await probe(pA)).open, 3000, 'A rail handed over');
  });

  await step('rail survives a click onto a tab that is still loading', async () => {
    // The regression: handOverRail pushes at a document that navigation is about to
    // destroy; the replacement attaches later and nothing tells it to open.
    await pA.bringToFront();
    await pA.mouse.move(500, 300); await sleep(60); await pA.mouse.move(2, 300);
    await until(async () => (await probe(pA)).open, 2500, 'rail open in A');
    await sleep(300);
    pB.goto(url('slow1'), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(250);
    const row = (await probe(pA)).rows.find(r => r.id === ids.b);
    assert(row, 'no row for B');
    await pA.mouse.move(row.cx, row.cy); await sleep(60);
    await pA.mouse.down(); await pA.mouse.up();
    const t0 = Date.now();
    await until(async () => (await activeTabId()) === ids.b, 4000, 'B active');
    const s = await until(async () => { const r = await probe(pB); return r.open ? r : null; }, 12000, 'rail open on the slow page');
    log(`  rail open ${Date.now() - t0}ms after the click; readyState was still loading at click time`);
    assert(s.rows.length > 0, 'rail opened but rendered nothing');
  });

  await step('pinned tabs render real favicons, not grey placeholders', async () => {
    await swEval(async (id) => { await chrome.tabs.update(id, { pinned: true }); }, ids.c);
    await sleep(400);
    await pA.bringToFront();
    await pA.mouse.move(500, 300); await sleep(60); await pA.mouse.move(2, 300);
    await until(async () => (await probe(pA)).open, 2500, 'open');
    await sleep(400);
    const pins = await pA.evaluate(() => [...document.querySelector('#arcify-rail-host').shadowRoot.querySelectorAll('.pin-tab')]
      .map(b => ({ img: !!b.querySelector('img.favicon'), src: b.querySelector('img.favicon')?.getAttribute('src') || null })));
    log('  pinned:', JSON.stringify(pins));
    assert(pins.length > 0, 'no pinned tabs rendered');
    assert(pins.every(p => p.img), 'pinned tab fell back to a grey placeholder (missing url in railGetState)');
    assert(pins.every(p => /_favicon/.test(p.src)), 'pinned favicon not resolved through /_favicon/');
    // Pinning removes a tab from its group and unpinning does not put it back; restore it
    // so later steps still find a row for C.
    await swEval(async (a) => {
      await chrome.tabs.update(a.id, { pinned: false });
      await chrome.tabs.group({ tabIds: [a.id], groupId: a.groupId });
    }, { id: ids.c, groupId: groups.work });
    await sleep(500);
    // Refreshes are deliberately deferred while the pointer is inside the panel, so leave
    // and come back rather than waiting for a rebuild that is being held back on purpose.
    await pA.mouse.move(700, 300);
    await until(async () => !(await probe(pA)).open, 2000, 'closed');
    await pA.mouse.move(2, 300);
    await until(async () => (await probe(pA)).open, 2000, 'reopen');
    await until(async () => { const r = await probe(pA); return r.rows.some(x => /Page C/.test(x.title)); }, 3000, 'C back in Work');
  });

  await step('the extension new tab page has a rail too', async () => {
    // Ctrl+T lands on the newtab override, which is a chrome-extension:// page. Content
    // scripts never run there, so it is included as a plain script instead.
    const nt = await browser.newPage();
    attachLogs(nt, 'newtab');
    await nt.goto(await swEval(() => chrome.runtime.getURL('spotlight/newtab.html')), { waitUntil: 'load' });
    await sleep(1200);
    await nt.bringToFront(); await sleep(400);
    const host = await nt.evaluate(() => !!document.querySelector('#arcify-rail-host'));
    assert(host, 'no rail on the extension new tab page');
    await nt.mouse.move(500, 300); await sleep(60); await nt.mouse.move(2, 300);
    const opened = await until(async () => nt.evaluate(() => {
      const h = document.querySelector('#arcify-rail-host');
      const p = h && h.shadowRoot.querySelector('.panel');
      return p && p.classList.contains('open')
        ? [...h.shadowRoot.querySelectorAll('.tab[data-tab-id]')].length : 0;
    }), 3000, 'rail open on newtab');
    log(`  newtab rail open with ${opened} rows`);

    // Alt+S must reach this page too. supportsContentScripts() rejects chrome-extension://
    // URLs, so routing on that alone sent the shortcut to the side-panel fallback and the
    // rail here - which exists - was never asked to toggle.
    const ntTabId = await swEval(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id,
      await swEval(() => chrome.runtime.getURL('spotlight/newtab.html')));
    assert(ntTabId, 'could not find the newtab tab');
    await swEval(async (id) => { await chrome.tabs.sendMessage(id, { action: 'railToggle' }); }, ntTabId);
    await until(async () => nt.evaluate(() => {
      const h = document.querySelector('#arcify-rail-host');
      return !h.shadowRoot.querySelector('.panel').classList.contains('open');
    }), 2000, 'railToggle closed the newtab rail');
    log('  railToggle reaches the newtab page');
    await nt.close();
    await pA.bringToFront(); await sleep(400);
  });

  await step('changing a space colour repaints the rail itself, not just the side panel', async () => {
    // The pointer is by definition inside the panel when you click a swatch, and
    // queueRefresh() defers while it is - so the rail kept its old colour while the real
    // side panel (listening to tabGroups.onUpdated) repainted at once.
    await pA.bringToFront();
    await pA.mouse.move(500, 300); await sleep(60); await pA.mouse.move(2, 300);
    await until(async () => (await probe(pA)).open, 2500, 'open');
    await sleep(350);
    const bgOf = () => pA.evaluate(() => {
      const p = document.querySelector('#arcify-rail-host').shadowRoot.querySelector('.panel');
      return getComputedStyle(p).backgroundColor;
    });
    const before = await bgOf();
    // open the palette, pick a colour that is not the current one
    const pal = await pA.evaluate(() => {
      const sr = document.querySelector('#arcify-rail-host').shadowRoot;
      const b = sr.querySelector('.palette').getBoundingClientRect();
      return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    });
    await pA.mouse.move(pal.cx, pal.cy); await sleep(60);
    await pA.mouse.down(); await pA.mouse.up();
    await sleep(400);
    const sw = await pA.evaluate(() => {
      const sr = document.querySelector('#arcify-rail-host').shadowRoot;
      const el = [...sr.querySelectorAll('.swatch')].find(s => !s.classList.contains('selected'));
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { title: el.title, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    });
    assert(sw, 'no unselected swatch found');
    await pA.mouse.move(sw.cx, sw.cy); await sleep(60);
    await pA.mouse.down(); await pA.mouse.up();
    // Deliberately do NOT move the pointer away - that is the whole point.
    const after = await until(async () => { const b = await bgOf(); return b !== before ? b : null; }, 3000,
      `rail background to change from ${before} without moving the pointer`);
    log(`  rail repainted ${before} -> ${after} (picked "${sw.title}") with the pointer still inside`);
  });

  await step('rail holds a constant physical width across browser zoom', async () => {
    // A content script is measured in the page's CSS pixels, which zoom redefines. Without
    // compensation a 215px rail is physically 322px at 150% - wider than the 360px-floor
    // side panel it exists to undercut.
    await pA.bringToFront();
    const cssWidth = () => pA.evaluate(() => {
      const p = document.querySelector('#arcify-rail-host').shadowRoot.querySelector('.panel');
      return Math.round(p.getBoundingClientRect().width);
    });
    const openRail = async () => {
      await pA.mouse.move(500, 300); await sleep(80); await pA.mouse.move(2, 300);
      await until(async () => (await probe(pA)).open, 2500, 'open'); await sleep(300);
    };
    await openRail();
    const base = await cssWidth();
    const seen = [];
    for (const z of [1.5, 0.75, 1]) {
      await swEval(async (id, zz) => { await chrome.tabs.setZoom(id, zz); }, ids.a, z);
      await sleep(700);
      await openRail();
      const css = await cssWidth();
      const physical = Math.round(css * z);
      seen.push(`${z}x -> ${css}css = ${physical}phys`);
      assert(Math.abs(physical - base) <= 6,
        `physical width drifted at ${z}x: ${physical} vs base ${base} (css ${css})`);
    }
    log(`  base ${base}phys; ${seen.join(', ')}`);
    await swEval(async (id) => { await chrome.tabs.setZoom(id, 1); }, ids.a);
    await sleep(400);
  });

  await step('Alt+S routing: a railToggle message opens and closes the rail', async () => {
    // The manifest binds Alt+S to a toggleRail command; the browser cannot deliver a
    // command straight to a content script, so the background relays it as railToggle.
    // A real Alt+S cannot be synthesised headlessly, but the relay contract can.
    await pA.bringToFront();
    await pA.mouse.move(800, 400); await sleep(120);
    await until(async () => !(await probe(pA)).open, 2000, 'closed to start');
    const toggle = () => swEval(async (id) => {
      await chrome.tabs.sendMessage(id, { action: 'railToggle' });
    }, ids.a);
    await toggle();
    const s = await until(async () => { const r = await probe(pA); return r.open ? r : null; }, 2000, 'open via railToggle');
    assert(s.pinned, 'a keyboard-opened rail should pin itself, having no pointer to keep it alive');
    await pA.mouse.move(900, 500); await sleep(300);
    assert((await probe(pA)).open, 'pinned rail must survive the pointer moving away');
    await toggle();
    await until(async () => !(await probe(pA)).open, 2000, 'closed via railToggle');
    log('  railToggle opened (pinned) and closed the rail');
  });

  await step('extension reload: old copy retired, new copy attached, clicks work', async () => {
    const before = pageLogs.get('a').filter(l => /attached/.test(l)).length;
    const oldSw = await swTarget();
    await swEval(() => chrome.runtime.reload());
    const newSw = await until(async () => browser.targets().find(t => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://') && t !== oldSw) || null, 10000, 'new SW target');
    sw = await newSw.worker();
    log('  new SW acquired');
    await sleep(1500);
    log('  pages: ' + (await browser.pages()).map(p => p.url()).join(' | '));
    for (const p of await browser.pages()) { if (p.url().startsWith('chrome-extension://')) { log('  closing ' + p.url()); await p.close().catch(() => {}); } }
    log('  closed onboarding');
    await swEval(async (id) => { await chrome.tabs.update(id, { active: true }); }, ids.a);
    log('  activated A; probing');
    await until(async () => (await probe(pA)).visibility === 'visible', 3000, 'A visible again');
    log('  A visible');
    await sleep(300);
    const s = await probe(pA);
    const attached = pageLogs.get('a').filter(l => /attached/.test(l)).length;
    log(`  hosts after reload: ${s.hosts}; attach logs before=${before} after=${attached}`);
    await pA.mouse.move(500, 300); await sleep(50);
    await pA.mouse.move(2, 300);
    await sleep(600);
    await dump(pA, 'A after reload+hover');
    assert(attached > before, 'new build did not attach after reload (injection failed?)');
    assert((await probe(pA)).hosts === 1, `expected 1 host, got ${(await probe(pA)).hosts}`);
    await until(async () => { const r = await probe(pA); return r.open && r.rows.length ? r : null; }, 3000, 'open after reload');
    await sleep(300);
    const so = await probe(pA);
    const row = so.rows.find(r => /Page C/.test(r.title));
    assert(row, 'C row missing');
    await pA.mouse.move(row.cx, row.cy); await sleep(60);
    await pA.mouse.down(); await pA.mouse.up();
    await until(async () => (await activeTabId()) === ids.c, 3000, 'C active after reload');
    await until(async () => (await probe(pC)).open, 3000, 'C rail open after reload');
    await shot(pC, 'after-reload');
  });

  log('\n==== SUMMARY ====');
  for (const r of results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n      ' + r.err.split('\n')[0]}`);
  fs.writeFileSync(path.join(OUT, 'rail-e2e-console.txt'), [...pageLogs.entries()].map(([k, v]) => `--- ${k} ---\n${v.join('\n')}`).join('\n\n'));
  fs.writeFileSync(path.join(OUT, 'rail-e2e-log.txt'), logs.join('\n'));
  await browser.close();
  server.close();
  process.exit(results.every(r => r.ok) ? 0 : 1);
})().catch(async (e) => { log('FATAL', currentStep, e && e.stack || e); process.exit(2); });
