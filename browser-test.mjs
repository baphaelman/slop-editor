// node browser-test.mjs: a smoke test of the editor in headless Chrome, on a fixture page of its own (not the demo).
// Needs playwright-core and a Chrome: `npm i && npx playwright install chromium-headless-shell`,
// or point PLAYWRIGHT_CORE at a playwright-core folder and CHROME at a chrome(-headless-shell) binary.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(process.env.PLAYWRIGHT_CORE ? path.join(process.env.PLAYWRIGHT_CORE, 'x') : import.meta.url);
const { chromium } = require('playwright-core');

const FIXTURE = {
    version: 1,
    _show: 'colors',
    nav: { how: 'How it works' },
    how: { title: 'How it works', p1: 'The agent wrote this.', p2: ['There are {n} things, ', { me: 'I promise' }, '.'], note: 'Shown only sometimes.', photo: 'A diagram of the agent at work.' },
    deep: { far: 'Far down a panel that scrolls.' },
    list: { title: 'A list', p1: 'First item.', p2: ['Second, ', { me: 'all mine' }, '.'] },
};
const page = (text) => `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>
<link rel="stylesheet" href="slop.css"></head><body style="font: 16px Georgia; max-width: 600px; margin: 40px auto">
<div data-slop-meter></div><nav><a href="#" data-slop="nav.how"></a></nav>
<h1 data-slop="how.title"></h1><p data-slop="how.p1"></p><p data-slop="how.p2"></p><p id="note"></p>
<img id="photo" data-slop-attr="alt:how.photo title:how.photo" width="40" height="20" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<div id="list" data-slop-list="list"><h3 data-slop="list.title"></h3><p data-slop="list.p1"></p><aside id="aside">Not a text.</aside></div>
<div id="panel" style="height: 120px; overflow: auto"><div style="height: 900px"></div><button data-slop-ref="deep.far">Far down a panel that scrolls.</button></div>
<script type="application/json" id="slop-text">\n${JSON.stringify(text, null, 2)}\n</script>
<script src="slop.js"></script>
<script>
  Slop.vars.n = 7;
  let showNote = false;
  const draw = () => { const n = document.getElementById('note'); if (showNote) n.dataset.slop = 'how.note'; else { n.removeAttribute('data-slop'); n.textContent = ''; } Slop.fill(); };
  Slop.reveal('how.note', () => { showNote = true; draw(); return () => { showNote = false; draw(); }; });
  Slop.onChange(draw);
  Slop.start(location.protocol === 'file:' && location.hash !== '#read' ? { edit: 'local' } : {}); // #read: as readers see it
</script></body></html>`;

// lists the page didn't mark: one that is, scroll steps (data-b), paragraphs in two parents, and one opted out
const LISTS = {
    version: 1,
    auto: { title: 'Unmarked', p1: 'One.', p2: 'Two.' },
    steps: { p1: 'Step one.', p2: 'Step two.' },
    split: { p1: 'Here.', p2: 'There.' },
    off: { p1: 'Off one.', p2: 'Off two.' },
};
const listsPage = (text) => `<!doctype html><html><head><meta charset="utf-8"><title>Lists</title>
<link rel="stylesheet" href="slop.css"></head><body style="font: 16px Georgia; max-width: 600px; margin: 40px auto">
<div id="auto"><h2 data-slop="auto.title"></h2><p class="lede" data-slop="auto.p1"></p><p class="lede" data-slop="auto.p2"></p><aside>Not a text.</aside></div>
<div id="steps"><p data-b="0" data-slop="steps.p1"></p><p data-b="1" data-slop="steps.p2"></p></div>
<div><p data-slop="split.p1"></p></div><div><p data-slop="split.p2"></p></div>
<div id="off" data-slop-list="off"><p data-slop="off.p1"></p><p data-slop="off.p2"></p></div>
<script type="application/json" id="slop-text">\n${JSON.stringify(text, null, 2)}\n</script>
<script src="slop.js"></script>
<script>Slop.start({ edit: 'local' });</script></body></html>`;

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-editor-'));
    await Promise.all(['slop.js', 'slop.css'].map((f) => copyFile(path.join(here, f), path.join(dir, f))));
    await writeFile(path.join(dir, 'page.html'), page(FIXTURE));
    return path.join(dir, 'page.html');
}
const block = async (file) => JSON.parse(/id="slop-text">([\s\S]*?)<\/script>/.exec(await readFile(file, 'utf8'))[1]);

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const errors = [];
async function open(url) {
    const p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'warning' || (m.type() === 'error' && !/409/.test(m.text()))) errors.push(m.text()); });
    await p.goto(url);
    return p;
}
const get = (p, at) => p.evaluate((x) => Slop.get(x), at);
const field = (at) => `.sp-field[data-path="${at}"]`;
// the All tab, with every section open
async function all(p) {
    await p.click('.sp-tabs [data-tab="all"]');
    for (const det of await p.$$('.sp-group:not([open]) summary .sp-gname')) await det.click();
}
// the full panel: the editor opens as a bar unless the panel was open last time
async function panel(p) {
    await p.waitForSelector('.slop-panel');
    if (await p.$eval('.slop-panel', (x) => x.classList.contains('sp-mini'))) await p.click('.sp-mode');
}
let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}

try {
    // ---------- the browser editor (file://), which saves in localStorage ----------
    const local = await fixture();
    let p = await open(`file://${local}#read`);

    await check('readers see what the page chose; the meter starts on', async () => {
        assert.equal(await p.$eval('.slop-meter', (m) => m.dataset.show), 'colors');
        assert.ok(await p.evaluate(() => document.documentElement.classList.contains('slop-on')));
        assert.ok((await p.textContent('.slop-legend')).includes('%'));
    });

    await check('a meter added later is built; with a path, it measures only that group', async () => {
        await p.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<section id="sec"><div data-slop-meter="how"></div><p id="sec-ai" data-slop="how.p1"></p><p data-slop="how.p2"></p></section>'));
        await p.waitForSelector('#sec .slop-meter .slop-key');
        const want = await p.evaluate(() => {
            const m = Slop.makeup(Slop.entries().filter(([at]) => at.startsWith('how.')).map(([, v]) => v));
            return Math.round(((m.counts.me ?? 0) / m.letters) * 100);
        });
        assert.match(await p.textContent('#sec .slop-key[data-id="me"]'), new RegExp(`${want}%`));
        assert.notEqual(await p.textContent('#sec .slop-legend'), await p.textContent('.slop-legend'));
    });

    await check('a section\'s switch follows the page\'s until flipped, and colors only its section', async () => {
        const color = (sel) => p.$eval(sel, (x) => getComputedStyle(x.querySelector('.slop-ai') ?? x).color);
        const ink = await p.evaluate(() => getComputedStyle(document.body).color);
        assert.equal(await p.$eval('#sec .slop-meter-btn', (b) => b.getAttribute('aria-pressed')), 'true');
        await p.click('#sec .slop-meter-btn');
        assert.ok(await p.$eval('#sec', (x) => x.classList.contains('slop-off')));
        assert.equal(await color('#sec-ai'), ink);
        assert.notEqual(await color('[data-slop="how.p1"]'), ink); // the rest of the page stays colored
        await p.click('.slop-meter-btn'); // the page's switch, off
        await p.click('#sec .slop-meter-btn'); // this section's, on
        assert.ok(!(await p.evaluate(() => document.documentElement.classList.contains('slop-on'))));
        assert.notEqual(await color('#sec-ai'), ink);
        assert.equal(await color('[data-slop="how.p1"]'), ink);
        await p.click('.slop-meter-btn');
    });

    await check('pointing at a tag dims everyone else\'s words, in its section', async () => {
        await p.hover('#sec .slop-key[data-id="me"]');
        assert.equal(await p.$eval('#sec', (x) => x.dataset.slopOnly), 'me');
        assert.equal(await p.$eval('#sec-ai .slop-ai, #sec-ai', (x) => getComputedStyle(x.querySelector('.slop-ai') ?? x).opacity), '0.3');
        assert.equal(await p.$eval('[data-slop="how.p1"]', (x) => getComputedStyle(x.querySelector('.slop-ai') ?? x).opacity), '1');
        await p.mouse.move(0, 0);
        assert.equal(await p.$eval('#sec', (x) => x.dataset.slopOnly), undefined);
        await p.evaluate(() => document.getElementById('sec').remove());
    });

    await check('onChange returns a function that unsubscribes', async () => {
        assert.ok(await p.evaluate(() => { let n = 0; const off = Slop.onChange(() => n++); off(); return typeof off === 'function'; }));
    });

    await p.close();
    p = await open(`file://${local}`);
    await panel(p);
    await check('the editor opens on repeated text that still has slop', async () => {
        assert.equal(await p.$eval('.sp-tabs [aria-selected="true"]', (t) => t.dataset.tab), 'repeats');
    });

    await all(p);
    await check('a copy\'s switch changes that copy only, and says so', async () => {
        await p.click(`${field('nav.how')} .sp-toggle`);
        assert.deepEqual(await get(p, 'nav.how'), [{ ok: 'How it works' }]);
        assert.equal(await get(p, 'how.title'), 'How it works');
        assert.match(await p.textContent(`${field('nav.how')} .sp-hint`), /Only this copy changed/);
        await p.click(`${field('nav.how')} .sp-hint button`);
        assert.deepEqual(await get(p, 'how.title'), [{ ok: 'How it works' }]);
    });

    await check('⌘Z with no text focused undoes the last switch', async () => {
        await p.click(`${field('how.p1')} .sp-toggle`);
        assert.deepEqual(await get(p, 'how.p1'), [{ ok: 'The agent wrote this.' }]);
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });

    await check('typing is mine; ⌘Z in the text gives the words back to the AI', async () => {
        const ta = p.locator(`${field('how.p1')} textarea`);
        await ta.click();
        await ta.evaluate((t) => t.setSelectionRange(4, 9)); // "agent"
        await p.keyboard.insertText('machine');
        assert.deepEqual(await get(p, 'how.p1'), ['The ', { me: 'machine' }, ' wrote this.']);
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });

    await check('typing over a selection is mine, even a letter that matches the first one selected', async () => {
        const ta = p.locator(`${field('how.p1')} textarea`);
        await ta.click();
        await ta.evaluate((t) => t.setSelectionRange(4, 9)); // "agent"
        await p.keyboard.type('a');
        assert.deepEqual(await get(p, 'how.p1'), ['The ', { me: 'a' }, ' wrote this.']);
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });

    await check('a text\'s pie sits next to its name, its switch at the end', async () => {
        assert.ok(await p.$eval(`${field('how.p1')} .sp-flabel label + .sp-pie`, (x) => !!x));
        assert.ok(await p.$eval(`${field('how.p1')} .sp-fend > .sp-ctl:last-child .sp-toggle`, (x) => !!x));
    });

    await check('marking a selection as a category', async () => {
        const ta = p.locator(`${field('how.p1')} textarea`);
        await ta.click();
        await ta.evaluate((t) => t.setSelectionRange(0, 3));
        await p.locator('.sp-assign .sp-as', { hasText: 'Data' }).click();
        assert.deepEqual(await get(p, 'how.p1'), [{ data: 'The' }, ' agent wrote this.']);
    });

    await check('the row says "Mark selection as" while a selection is still being dragged out', async () => {
        const ta = p.locator(`${field('how.p1')} textarea`);
        await ta.click();
        await ta.press('End');
        assert.equal(await p.textContent('.sp-assign-label'), 'Mark all as');
        // a drag fires selectionchange as it goes, and its select and pointerup only at the end. Read the row before those
        assert.equal(await ta.evaluate((t) => {
            t.selectionStart = 0;
            t.dispatchEvent(new Event('selectionchange'));
            return document.querySelector('.sp-assign-label').textContent;
        }), 'Mark selection as');
        await ta.press('End');
    });

    await check('words copied from a text keep their authors when pasted; from anywhere else, they\'re mine', async () => {
        const ta = p.locator(`${field('how.p2')} textarea`);
        await ta.click();
        // headless Chrome has no clipboard: the copy and the paste are events with a DataTransfer of their own, and the
        // paste puts the words in as the browser would
        const paste = (t, d) => {
            t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }));
            const words = d.getData('text/plain');
            const at = t.value.length;
            t.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', bubbles: true }));
            t.setRangeText(words, at, at, 'end');
            t.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
        };
        await ta.evaluate((t, src) => {
            const paste = eval(src);
            t.setSelectionRange(0, 25); // "There are {n} things, I p"
            const d = new DataTransfer();
            t.dispatchEvent(new ClipboardEvent('copy', { clipboardData: d, bubbles: true, cancelable: true }));
            t.setSelectionRange(t.value.length, t.value.length);
            paste(t, d);
        }, `(${paste})`);
        assert.deepEqual(await get(p, 'how.p2'), ['There are {n} things, ', { me: 'I promise' }, '.There are {n} things, ', { me: 'I p' }]);
        await ta.evaluate((t, src) => {
            const paste = eval(src);
            t.value = t.value.slice(0, 32);
            t.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
            const d = new DataTransfer();
            d.setData('text/plain', ' Elsewhere');
            paste(t, d);
        }, `(${paste})`);
        assert.deepEqual(await get(p, 'how.p2'), ['There are {n} things, ', { me: 'I promise' }, '.', { me: ' Elsewhere' }]);
        await ta.evaluate((t) => { t.value = t.value.slice(0, 32); t.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true })); });
        assert.deepEqual(await get(p, 'how.p2'), ['There are {n} things, ', { me: 'I promise' }, '.']);
    });

    await check('the editor\'s Colors switch turns the page\'s colors off and on; its text boxes keep theirs', async () => {
        const on = () => p.evaluate(() => document.documentElement.classList.contains('slop-on'));
        assert.equal(await p.$eval('.sp-colors', (b) => b.getAttribute('aria-checked')), 'true');
        assert.ok(await on());
        await p.click('.sp-colors');
        assert.ok(!(await on()));
        const ink = await p.evaluate(() => getComputedStyle(document.body).color);
        assert.notEqual(await p.$eval(`${field('how.p2')} .sp-mirror .slop-me`, (x) => getComputedStyle(x).color), ink);
        assert.equal(await p.$eval('.slop-meter-btn', (b) => b.getAttribute('aria-pressed')), 'false'); // the page's switch agrees
        await p.click('.slop-meter-btn');
        assert.ok(await on());
        assert.equal(await p.$eval('.sp-colors', (b) => b.getAttribute('aria-checked')), 'true');
    });

    await check('an open section\'s name stays at the top of the panel; closing it there goes back to its start', async () => {
        await p.setViewportSize({ width: 1280, height: 420 });
        await all(p);
        const sum = p.locator('.sp-group[data-group="how"] > summary');
        await p.$eval('.sp-body', (b) => { b.scrollTop += b.querySelector('[data-group="how"]').getBoundingClientRect().top - b.getBoundingClientRect().top + 120; });
        const top = await p.$eval('.sp-body', (b) => b.getBoundingClientRect().top);
        assert.ok(Math.abs((await sum.boundingBox()).y - top) < 1);
        await sum.locator('.sp-gname').click();
        await p.waitForFunction((t) => {
            const det = document.querySelector('.sp-group[data-group="how"]');
            return !det.open && det.getBoundingClientRect().top >= t - 1;
        }, top, { timeout: 3000 });
        await sum.locator('.sp-gname').click();
        await p.setViewportSize({ width: 1280, height: 860 });
    });

    await check('Revert goes back to the last save; Save saves', async () => {
        assert.match(await p.textContent('.sp-save'), /^Save \d/);
        await p.locator(`${field('how.p1')} .sp-revert`).click();
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
        await p.click('.sp-save');
        assert.equal(await p.textContent('.sp-save'), 'Saved');
        await p.reload();
        assert.deepEqual(await get(p, 'nav.how'), [{ ok: 'How it works' }]); // kept by the browser
    });

    await check('a reload asks first, and keeps the unsaved changes either way', async () => {
        await panel(p);
        await all(p);
        const ta = p.locator(`${field('how.title')} textarea`);
        await ta.click();
        await ta.press('End');
        await p.keyboard.type('!');
        let asked = '';
        p.once('dialog', (d) => { asked = d.type(); d.accept(); });
        await p.reload();
        assert.equal(asked, 'beforeunload');
        assert.match(await p.textContent('.sp-status'), /Unsaved changes from before the reload/);
        assert.deepEqual(await get(p, 'how.title'), [{ ok: 'How it works' }, { me: '!' }]);
        assert.match(await p.textContent('.sp-save'), /^Save 1/);
        await p.click('.sp-status .sp-link'); // Discard
        assert.deepEqual(await get(p, 'how.title'), [{ ok: 'How it works' }]);
        await p.reload();
        assert.doesNotMatch(await p.textContent('.sp-status'), /Unsaved/); // nothing kept
    });

    await check('a hidden text is shown on the page while it\'s edited', async () => {
        await panel(p);
        await all(p);
        assert.equal(await p.textContent('#note'), '');
        await p.click(`${field('how.note')} .sp-unseen`);
        assert.equal(await p.textContent('#note'), 'Shown only sometimes.');
        await p.click(`${field('how.p1')} textarea`);
        assert.equal(await p.textContent('#note'), '');
    });

    await check('alt text is filled, and has its own tab', async () => {
        assert.equal(await p.getAttribute('#photo', 'alt'), 'A diagram of the agent at work.');
        assert.equal(await p.textContent('.sp-tabs [data-tab="hidden"] span'), '1');
        await p.click('.sp-tabs [data-tab="hidden"]');
        assert.deepEqual(await p.$$eval('.sp-body .sp-field', (fs) => fs.map((f) => f.dataset.path)), ['how.photo']);
        assert.equal(await p.textContent(`${field('how.photo')} .sp-kind`), 'alt text');
        const ta = p.locator(`${field('how.photo')} textarea`);
        await ta.click();
        assert.ok(await p.$eval('#photo', (x) => x.classList.contains('slop-focus')));
        await ta.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length));
        await p.keyboard.insertText(' Mine.');
        await p.waitForFunction(() => document.getElementById('photo').alt.endsWith('Mine.'));
        await p.keyboard.press('Meta+z');
        await p.click('.sp-tabs [data-tab="all"]');
    });

    await check('a [data-slop-ref] text is found, and scrolled to inside a panel that scrolls', async () => {
        assert.equal(await p.$eval('#panel', (x) => x.scrollTop), 0);
        await p.click(`${field('deep.far')} textarea`);
        assert.ok(await p.$eval('[data-slop-ref]', (x) => x.classList.contains('slop-focus')));
        await p.waitForFunction(() => document.getElementById('panel').scrollTop > 500);
    });

    const order = () => p.evaluate(() => Object.keys(Slop.text.list).filter((k) => k !== 'title'));
    const shown = () => p.$$eval('#list > p', (xs) => xs.map((x) => x.textContent));
    await check('a list draws a copy of its first child for each text in its group', async () => {
        assert.deepEqual(await p.$$eval('#list > p', (xs) => xs.map((x) => x.dataset.slop)), ['list.p1', 'list.p2']);
        assert.deepEqual(await shown(), ['First item.', 'Second, all mine.']);
        // the group's other texts and the element's other children stay put, and only paragraphs get a trash can
        assert.deepEqual(await p.$$eval('#list > *', (xs) => xs.map((x) => x.dataset.slop ?? x.id)), ['list.title', 'list.p1', 'list.p2', 'aside']);
    });

    await check('a blank line starts a paragraph of its own on the page', async () => {
        const ta = p.locator(`${field('list.p1')} textarea`);
        await ta.click();
        await ta.evaluate((t) => t.setSelectionRange(t.value.length, t.value.length));
        await p.keyboard.insertText('\n\nA second paragraph.');
        await p.waitForSelector('[data-slop-more="list.p1"]');
        assert.deepEqual(await shown(), ['First item.', 'A second paragraph.', 'Second, all mine.']);
        await p.keyboard.press('Meta+z');
        await p.waitForFunction(() => !document.querySelector('[data-slop-more]'));
        assert.equal(await get(p, 'list.p1'), 'First item.');
    });

    await check('each text box shows its words in their authors\' colors', async () => {
        const spans = await p.$eval(`${field('list.p2')} .sp-mirror`, (m) => [...m.children].map((x) => [x.className, x.textContent, getComputedStyle(x).color]));
        assert.deepEqual(spans.map(([c, t]) => [c, t]), [['slop-ai', 'Second, '], ['slop-me', 'all mine'], ['slop-ai', '.']]);
        assert.notEqual(spans[0][2], spans[1][2]);
        assert.equal(await p.$eval(`${field('list.p2')} textarea`, (t) => getComputedStyle(t).color), 'rgba(0, 0, 0, 0)');
    });

    await check('in a list, a paragraph can be added below another, taken out, and restored', async () => {
        await p.hover(`${field('list.p1')} .sp-insert`);
        assert.equal(await p.$eval('#list > p', (x) => x.classList.contains('slop-insert-after')), true); // where it would go
        await p.click(`${field('list.p1')} .sp-insert`);
        assert.deepEqual(await order(), ['p1', 'p3', 'p2']);
        assert.equal(await p.$$eval('.slop-insert-after', (xs) => xs.length), 0);
        assert.equal(await p.evaluate(() => document.activeElement.closest('.sp-field')?.dataset.path), 'list.p3');
        assert.equal(await p.textContent(`${field('list.p3')} label`), 'Paragraph 2');
        await p.waitForFunction(() => document.querySelector('.sp-field[data-path="list.p3"] .sp-unseen').hidden); // on the page once drawn
        const shown = (sel) => p.$eval(`${field('list.p3')} ${sel}`, (r) => [...r.children].filter((x) => !x.hidden).map((x) => x.className.split(' ')[0]));
        assert.deepEqual(await shown('.sp-flabel'), ['', 'sp-pie', 'sp-fend']); // name and pie, then the rest at the end
        assert.deepEqual((await shown('.sp-fend')).slice(-2), ['sp-trash', 'sp-ctl']); // the trash can, then the switch
        await p.keyboard.insertText('Added.');
        assert.deepEqual(await get(p, 'list.p3'), [{ me: 'Added.' }]);
        await p.waitForFunction(() => document.querySelectorAll('#list > p')[1]?.textContent === 'Added.');
        const remove = p.locator(`${field('list.p2')} .sp-trash`);
        await remove.hover();
        assert.ok(await p.$eval('[data-slop="list.p2"]', (x) => x.classList.contains('slop-remove-hint')));
        await remove.click();
        assert.deepEqual(await order(), ['p1', 'p3', 'p2']); // one with words takes a second click, and is red until then
        assert.ok(await p.$eval('[data-slop="list.p2"]', (x) => x.classList.contains('slop-removing')));
        assert.equal(await remove.textContent(), 'Remove?');
        await remove.click();
        assert.deepEqual(await order(), ['p1', 'p3']);
        await p.waitForFunction(() => document.querySelectorAll('#list > p').length === 2);
        assert.match(await p.textContent('.sp-gone'), /Paragraph 2 removed/);
        await p.click('.sp-gone button');
        assert.deepEqual(await order(), ['p1', 'p2', 'p3']); // where it was at the last save: after p1
        assert.deepEqual(await get(p, 'list.p2'), ['Second, ', { me: 'all mine' }, '.']);
        await p.waitForFunction(() => document.querySelectorAll('#list > p').length === 3);
        assert.deepEqual(await p.$$eval('#list > *', (xs) => xs.map((x) => x.dataset.slop ?? x.id)), ['list.title', 'list.p1', 'list.p2', 'list.p3', 'aside']);
        assert.equal(await p.$$eval(`${field('list.title')} .sp-trash, ${field('list.title')} .sp-insert`, (xs) => xs.length), 0);
    });

    await check('the legend and the editor\'s categories list the biggest share first', async () => {
        const shares = (sel) => p.$$eval(sel, (xs) => xs.map((x) => (/(<?)(\d+)%/.exec(x.textContent) ?? [0, '', '0']).slice(1)).map(([lt, n]) => (lt ? 0.5 : +n)));
        const descending = (xs) => xs.every((x, i) => !i || xs[i - 1] >= x);
        const legend = await shares('body > [data-slop-meter] .slop-key');
        assert.ok(legend.length > 1 && descending(legend), String(legend));
        const chips = await shares('.sp-cat .sp-cat-pct');
        assert.ok(chips.length > 2 && descending(chips), String(chips));
    });

    await check('a category\'s color: its picker and eyedropper, or drag its dot onto the page; Revert colors', async () => {
        const color = () => p.evaluate(() => Slop.text._categories?.ai?.color);
        // the picker: a rectangle of shades, the eyedropper, the color and a hue bar, then its numbers
        await p.click('.sp-cat[data-id="ai"] .sp-swatch');
        assert.ok(await p.isVisible('.sp-pick'));
        const sv = await (await p.$('.sp-pick-sv')).boundingBox();
        await p.mouse.click(sv.x + sv.width - 14, sv.y + 14); // near the top right: the hue, nearly full
        assert.match(await color(), /^#[0-9a-f]{6}$/);
        await p.fill('.sp-pick-num input >> nth=0', '43');
        await p.fill('.sp-pick-num input >> nth=1', '159');
        await p.fill('.sp-pick-num input >> nth=2', '192');
        assert.equal(await color(), '#2b9fc0');
        assert.equal(await p.$eval('.sp-cat[data-id="ai"] .sp-swatch', (x) => getComputedStyle(x).backgroundColor), 'rgb(43, 159, 192)');
        await p.click('.sp-pick-swap');
        assert.equal(await p.inputValue('.sp-pick-num input'), '#2b9fc0'); // HEX
        await p.fill('.sp-pick-num input', '#336699');
        assert.equal(await color(), '#336699');
        await p.click('.sp-pick-swap'); // HSL
        assert.deepEqual(await p.$$eval('.sp-pick-num span', (xs) => xs.map((x) => x.textContent)), ['H', 'S', 'L']);
        await p.click('.sp-pick-swap'); // back to RGB
        // its eyedropper: the magnifier follows the pointer, beside it, until a click takes the color
        await p.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div id="paint2" style="position:fixed;left:20px;top:500px;width:80px;height:80px;background:#654321"></div>'));
        await p.click('.sp-pick-drop');
        await p.mouse.move(60, 540, { steps: 4 });
        assert.ok(await p.isVisible('.slop-sampler'));
        const away = await p.$eval('.slop-sampler-lens', (x) => { const r = x.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - 60, r.top + r.height / 2 - 540) > r.width / 2; });
        assert.ok(away, 'the magnifier is beside the pointer');
        await p.mouse.click(60, 540);
        assert.equal(await color(), '#654321');
        assert.equal(await p.$('.slop-sampler'), null);
        assert.ok(await p.isVisible('.sp-pick')); // still open, showing it
        assert.deepEqual(await p.$$eval('.sp-pick-num input', (xs) => xs.map((x) => x.value)), ['101', '67', '33']);
        await p.keyboard.press('Escape');
        assert.equal(await p.$('.sp-pick'), null);
        await p.evaluate(() => document.getElementById('paint2').remove());
        // drag the dot onto a color on the page: the ring is at the point, the color in a circle beside it, joined by a line
        await p.evaluate(() => {
            document.body.insertAdjacentHTML('beforeend', '<div id="paint" style="position:fixed;left:20px;top:300px;width:80px;height:80px;background:#123456"></div>'
                + '<span id="ink" style="position:fixed;left:20px;top:420px;font:60px/1 sans-serif;color:#aa0000">WW</span>');
        });
        const dot = await (await p.$('.sp-cat[data-id="ai"] .sp-swatch')).boundingBox();
        await p.mouse.move(dot.x + 9, dot.y + 9);
        await p.mouse.down();
        await p.mouse.move(200, 200, { steps: 4 });
        await p.mouse.move(60, 340, { steps: 4 });
        const lens = await p.$eval('.slop-sampler', (s) => {
            const rect = (q) => s.querySelector(q).getBoundingClientRect();
            const mid = (r) => [r.left + r.width / 2, r.top + r.height / 2];
            const big = rect('.slop-sampler-lens');
            const line = s.querySelector('line');
            const seen = s.querySelector('.slop-sampler-page #paint').getBoundingClientRect(); // the magnified copy of what's under the point
            return { ring: mid(rect('.slop-sampler-ring')), lens: mid(big), r: big.width / 2, rim: getComputedStyle(s.querySelector('.slop-sampler-lens')).borderTopColor, hex: s.querySelector('.slop-sampler-hex').textContent,
                line: ['x1', 'y1', 'x2', 'y2'].map((k) => +line.getAttribute(k)), seen: [seen.left, seen.top, seen.width] };
        });
        assert.deepEqual(lens.ring.map(Math.round), [60, 340]);
        // beside the point, clear of it
        assert.ok(Math.hypot(lens.lens[0] - 60, lens.lens[1] - 340) > lens.r + 20, 'the magnifier is beside the point, not over it');
        assert.deepEqual(lens.line.slice(0, 2).map(Math.round), [60, 340]);
        assert.ok(Math.abs(Math.hypot(lens.line[2] - lens.lens[0], lens.line[3] - lens.lens[1]) - lens.r) < 6, 'the line reaches its rim');
        // it shows the page around the point, three times bigger: the 80px square under it, now 240px, around its middle
        assert.equal(Math.round(lens.seen[2]), 240);
        assert.ok(lens.seen[0] < lens.lens[0] && lens.seen[0] + 240 > lens.lens[0] && lens.seen[1] < lens.lens[1] && lens.seen[1] + 240 > lens.lens[1]);
        assert.equal(Math.round(lens.lens[0] - lens.seen[0]), 40 * 3); // (60 - 20) px into the square
        assert.equal(lens.rim, 'rgb(18, 52, 86)');
        assert.equal(lens.hex, '#123456');
        await p.mouse.up();
        assert.equal(await color(), '#123456');
        assert.equal(await p.$('.slop-sampler'), null);
        // over a letter, the letter's color
        const ink = await (await p.$('#ink')).boundingBox();
        await p.mouse.move(dot.x + 9, dot.y + 9);
        await p.mouse.down();
        await p.mouse.move(ink.x + 22, ink.y + ink.height / 2, { steps: 6 });
        await p.mouse.up();
        assert.equal(await color(), '#aa0000');
        // Escape drops it
        await p.mouse.move(dot.x + 9, dot.y + 9);
        await p.mouse.down();
        await p.mouse.move(60, 340, { steps: 4 });
        await p.keyboard.press('Escape');
        await p.mouse.up();
        assert.equal(await color(), '#aa0000');
        await p.evaluate(() => { document.getElementById('paint').remove(); document.getElementById('ink').remove(); });
        // Revert colors: grey, no outline
        assert.deepEqual(await p.$eval('.sp-cat-revert', (x) => [getComputedStyle(x).borderTopStyle, getComputedStyle(x).backgroundColor]), ['none', 'rgba(0, 0, 0, 0)']);
        await p.click('.sp-cat-revert');
        assert.equal(await color(), undefined);
        assert.ok(await p.$eval('.sp-cat-revert', (x) => x.hidden));
        await p.click('.sp-status .sp-link'); // Undo
        assert.equal(await color(), '#aa0000');
    });

    await check('a new category asks whose words they are, and can ask an agent to find them', async () => {
        await p.click('.sp-cat-add');
        await p.keyboard.type('Bob');
        await p.keyboard.press('Enter');
        await p.waitForSelector('.sp-about');
        assert.match(await p.textContent('.sp-about-q'), /Whose words are Bob\?/);
        assert.ok(await p.$eval('.sp-about textarea', (x) => document.activeElement === x));
        await p.keyboard.type('My co-author: the methods section');
        const bob = () => p.evaluate(() => Slop.text._categories.bob);
        assert.equal((await bob()).about, 'My co-author: the methods section');
        assert.ok(await p.$eval('.sp-about-note', (x) => x.hidden));
        await p.click('.sp-check');
        assert.equal((await bob()).find, true);
        assert.match(await p.textContent('.sp-about-note'), /Waiting for an agent/);
        await p.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.copied = t; } }, configurable: true }));
        await p.click('.sp-about-note .sp-link');
        await p.waitForFunction(() => window.copied);
        assert.match(await p.evaluate(() => window.copied), /"Bob" \(My co-author: the methods section\)[\s\S]*Categories to find/);
        assert.match(await p.textContent('.sp-status'), /Prompt copied/);
        await p.click('.sp-about-done');
        assert.equal(await p.$('.sp-about'), null);
        await p.click('.sp-cat[data-id="bob"] .sp-cat-pct'); // selecting it opens it again
        assert.equal(await p.inputValue('.sp-about textarea'), 'My co-author: the methods section');
        assert.ok(await p.$eval('.sp-cat[data-id="bob"]', (x) => x.classList.contains('sp-cat-on')));
        // a built-in category has a description too; an agent can find facts and quotes, never the author's words
        const unsaved = await p.textContent('.sp-save');
        await p.click('.sp-cat[data-id="me"] .sp-cat-pct');
        assert.match(await p.textContent('.sp-about-q'), /Whose words are My words\?/);
        assert.ok(await p.$eval('.sp-about .sp-check', (x) => x.hidden));
        assert.equal(await p.textContent('.sp-save'), unsaved); // opening it changes nothing
        await p.fill('.sp-about textarea', 'Mine, typed or dictated');
        assert.equal(await p.evaluate(() => Slop.text._categories.me.about), 'Mine, typed or dictated');
        await p.fill('.sp-about textarea', '');
        assert.equal(await p.evaluate(() => Slop.text._categories.me), undefined);
        await p.click('.sp-cat[data-id="data"] .sp-cat-pct');
        assert.ok(await p.$eval('.sp-about .sp-check', (x) => !x.hidden));
        await p.click('.sp-about-done');
        assert.equal(await p.$('.sp-cat-on'), null);
    });

    await check('what an agent marked waits for Keep or Undo', async () => {
        const mark = () => p.evaluate(() => {
            const was = Slop.get('how.p1');
            Slop.set('how.p1', [{ bob: 'The agent wrote this.' }]);
            const bob = Slop.text._categories.bob;
            delete bob.find;
            bob.found = { on: '2026-11-25', before: { 'how.p1': was } };
            Slop.refresh();
            return was;
        });
        const was = await mark();
        assert.match(await p.textContent('.sp-found'), /An agent marked 1 text as Bob on Nov 25/);
        await p.click('.sp-found .sp-link:text("Undo")');
        assert.deepEqual(await get(p, 'how.p1'), was);
        assert.equal(await p.evaluate(() => Slop.text._categories.bob.found), undefined);
        assert.equal(await p.$('.sp-found'), null);
        await mark();
        await p.click('.sp-found .sp-link:text("Keep")');
        assert.deepEqual(await get(p, 'how.p1'), [{ bob: 'The agent wrote this.' }]);
        assert.deepEqual(await p.evaluate(() => Slop.text._categories.bob.found), { on: '2026-11-25' });
        await p.click('.sp-cat[data-id="bob"] .sp-cat-name');
        assert.match(await p.textContent('.sp-about-note'), /Found by an agent · Nov 25/);
    });
    await p.close();

    // ---------- editing on the page ----------
    p = await open(`file://${await fixture()}`);
    await check('on the page: the panel shrinks to a bar, and a text is typed into where it is', async () => {
        assert.ok(await p.$eval('.slop-panel', (x) => !x.hidden && x.classList.contains('sp-mini'))); // open, as a bar
        assert.equal(await p.$('.slop-edit-btn, .sp-close'), null);
        await p.click('[data-slop="how.p1"]');
        await p.keyboard.press('Meta+ArrowDown');
        await p.keyboard.type(' Mine*');
        assert.deepEqual(await get(p, 'how.p1'), ['The agent wrote this.', { me: ' Mine\\*' }]);
        assert.equal(await p.textContent('[data-slop="how.p1"]'), 'The agent wrote this. Mine*');
        assert.ok(await p.$eval('.slop-float', (x) => !x.hidden));
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });

    await check('on the page: Enter starts a paragraph, Backspace at its start joins it back', async () => {
        await p.keyboard.press('Enter');
        await p.keyboard.type('Two');
        assert.deepEqual(await get(p, 'how.p1'), ['The agent wrote this.', { me: '\n\nTwo' }]);
        assert.equal(await p.evaluate(() => document.activeElement.dataset.slopMore), 'how.p1');
        for (let i = 0; i < 4; i++) await p.keyboard.press('Backspace');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
        assert.equal(await p.evaluate(() => document.activeElement.dataset.slop), 'how.p1');
    });

    await check('on the page: a {name} is deleted whole, a link isn\'t followed, and marking works', async () => {
        await p.$eval('[data-slop="how.p2"] [data-slop-v]', (x) => {
            const r = document.createRange();
            r.setStartAfter(x);
            x.closest('[contenteditable="true"]').focus();
            getSelection().removeAllRanges();
            getSelection().addRange(r);
        });
        await p.keyboard.press('Backspace');
        assert.deepEqual(await get(p, 'how.p2'), ['There are  things, ', { me: 'I promise' }, '.']);
        await p.click('[data-slop="nav.how"]');
        assert.ok(!p.url().endsWith('#'));
        await p.keyboard.press('Home');
        await p.keyboard.press('Shift+ArrowRight');
        await p.waitForFunction(() => document.querySelector('.slop-float .sp-assign-label').textContent === 'Mark selection as');
        await p.click('.slop-float .sp-as:has-text("Data")');
        assert.equal(JSON.stringify(await get(p, 'nav.how')).includes('"data"'), true);
    });

    await check('on the page: a + in the row makes a category, with whose words it means, and marks the selection', async () => {
        await p.click('[data-slop="how.title"]');
        await p.keyboard.press('Home');
        await p.keyboard.press('Shift+ArrowRight');
        await p.keyboard.press('Shift+ArrowRight');
        await p.keyboard.press('Shift+ArrowRight');
        await p.click('.slop-float .sp-as-new');
        await p.fill('.slop-float .sp-newcat-name', 'Editor');
        await p.keyboard.press('Enter');
        await p.keyboard.type('Our copy editor');
        await p.keyboard.press('Enter');
        assert.deepEqual(await p.evaluate(() => Slop.text._categories.editor), { label: 'Editor', color: '#e0662b', about: 'Our copy editor' });
        assert.deepEqual(await get(p, 'how.title'), [{ editor: 'How' }, ' it works']);
        assert.ok(await p.$('.slop-float .sp-as:has-text("Editor")'));
    });

    await check('on the page: ⌘B, ⌘I and ⌘E restyle the selection, ⌘K links it; the words keep their authors', async () => {
        await p.click('[data-slop="how.p1"]');
        await p.keyboard.press('Meta+ArrowUp');
        for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowRight');
        await p.keyboard.press('Meta+b');
        assert.equal(await get(p, 'how.p1'), '**The** agent wrote this.');
        assert.equal(await p.textContent('[data-slop="how.p1"] strong'), 'The');
        await p.keyboard.press('Meta+b');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
        await p.keyboard.press('Meta+k');
        await p.fill('.slop-float .sp-linkform input', 'example.com');
        await p.keyboard.press('Enter');
        assert.equal(await get(p, 'how.p1'), '[The](https://example.com) agent wrote this.');
        await p.keyboard.press('Meta+k');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
        await p.keyboard.press('Meta+i');
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });

    await check('with the panel open, a text on the page is typed into, and its box follows', async () => {
        await p.click('.sp-mode');
        assert.ok(await p.$eval('.slop-panel', (x) => !x.classList.contains('sp-mini')));
        await p.click('[data-slop="how.p1"]');
        await p.keyboard.press('Meta+ArrowDown');
        await p.keyboard.type(' Yes.');
        assert.deepEqual(await get(p, 'how.p1'), ['The agent wrote this.', { me: ' Yes.' }]);
        assert.equal(await p.$eval(`${field('how.p1')} textarea`, (t) => t.value), 'The agent wrote this. Yes.');
        await p.click('.sp-mode');
        assert.ok(await p.$eval('.slop-panel', (x) => x.classList.contains('sp-mini')));
    });
    await p.close();

    // ---------- one history for everything, and a heading's switch ----------
    p = await open(`file://${await fixture()}`);
    const selected = () => p.evaluate(() => getSelection().toString());
    await check('on the page: ⌘Z takes back a mark and selects its words again, after typing too; ⌘⇧Z does it again', async () => {
        await p.click('[data-slop="how.p1"]');
        await p.keyboard.press('Meta+ArrowDown');
        await p.keyboard.type(' Mine');
        await p.keyboard.press('Meta+ArrowUp');
        for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowRight');
        await p.waitForFunction(() => document.querySelector('.slop-float .sp-assign-label').textContent === 'Mark selection as');
        await p.click('.slop-float .sp-as:has-text("Data")');
        const marked = [{ data: 'The' }, ' agent wrote this.', { me: ' Mine' }];
        assert.deepEqual(await get(p, 'how.p1'), marked);
        // shown at once, and still selected, to mark as something else
        assert.match(await p.innerHTML('[data-slop="how.p1"]'), /^<span class="slop-data">The<\/span>/);
        assert.equal(await selected(), 'The');
        assert.equal(await p.textContent('.slop-float .sp-assign-label'), 'Mark selection as');
        await p.keyboard.press('Meta+z');
        assert.deepEqual(await get(p, 'how.p1'), ['The agent wrote this.', { me: ' Mine' }]);
        assert.equal(await selected(), 'The');
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
        await p.keyboard.press('Meta+Shift+z');
        await p.keyboard.press('Meta+Shift+z');
        assert.deepEqual(await get(p, 'how.p1'), marked);
        assert.equal(await selected(), 'The');
        assert.match(await p.textContent('.sp-status'), /Marked the selection as Data/);
        await p.keyboard.press('Meta+z');
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });

    await check('in a box: ⌘Z takes back a mark and selects its words again; ⌘⇧Z does it again', async () => {
        await panel(p);
        await all(p);
        const ta = p.locator(`${field('how.p1')} textarea`);
        await ta.click();
        await ta.evaluate((t) => t.setSelectionRange(4, 9)); // "agent"
        await p.locator(`${field('how.p1')} .sp-as`, { hasText: 'Data' }).click();
        assert.deepEqual(await get(p, 'how.p1'), ['The ', { data: 'agent' }, ' wrote this.']);
        const box = () => p.evaluate(() => { const a = document.activeElement; return [a.closest('.sp-field')?.dataset.path, a.selectionStart, a.selectionEnd]; });
        assert.deepEqual(await box(), ['how.p1', 4, 9]); // still selected
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
        assert.deepEqual(await box(), ['how.p1', 4, 9]);
        await p.keyboard.press('Meta+Shift+z');
        assert.deepEqual(await get(p, 'how.p1'), ['The ', { data: 'agent' }, ' wrote this.']);
        await p.keyboard.press('Meta+z');
        // on the Slop tab, which is drawn again after a mark, too
        await p.click('.sp-tabs [data-tab="slop"]');
        await ta.click();
        await ta.evaluate((t) => t.setSelectionRange(4, 9));
        await p.locator(`${field('how.p1')} .sp-as`, { hasText: 'Data' }).click();
        assert.deepEqual(await box(), ['how.p1', 4, 9]);
        await p.keyboard.press('Meta+z');
        await all(p);
    });

    await check('⌘⇧Z with no text focused does the last switch again', async () => {
        await p.click(`${field('how.p1')} .sp-toggle`);
        await p.keyboard.press('Meta+z');
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
        assert.match(await p.textContent('.sp-status'), /^Undone: Approved .* · Redo$/);
        await p.keyboard.press('Meta+Shift+z');
        assert.deepEqual(await get(p, 'how.p1'), [{ ok: 'The agent wrote this.' }]);
        await p.keyboard.press('Meta+z');
        await p.click('.sp-mode');
    });

    await check('a heading\'s switch covers its section, and switched back takes back only what it approved', async () => {
        const slop = (at) => p.evaluate((x) => Slop.makeup([Slop.get(x)]).counts.ai ?? 0, at);
        await p.click('[data-slop="how.p1"]');
        await p.click('.slop-float .sp-toggle'); // this paragraph on its own, first
        assert.deepEqual(await get(p, 'how.p1'), [{ ok: 'The agent wrote this.' }]);
        await p.mouse.click(5, 400); // away: the row goes, and no longer covers the heading
        await p.waitForSelector('.slop-float', { state: 'hidden' });
        await p.click('[data-slop="how.title"]');
        assert.match(await p.getAttribute('.slop-float .sp-toggle', 'title'), /^This heading and 3 texts under it: Slop/);
        const before = await p.evaluate(() => JSON.stringify(Slop.text));
        await p.click('.slop-float .sp-toggle');
        for (const at of ['how.title', 'how.p1', 'how.p2', 'how.photo']) assert.equal(await slop(at), 0, at);
        assert.equal(await get(p, 'list.title'), 'A list'); // another group
        assert.match(await p.textContent('.sp-status'), /and 3 texts under it/);
        await p.click('.slop-float .sp-toggle');
        assert.equal(await p.evaluate(() => JSON.stringify(Slop.text)), before);
        await p.click('.slop-float .sp-toggle');
        await p.mouse.click(5, 400);
        await p.waitForSelector('.slop-float', { state: 'hidden' });
        await p.click('[data-slop="how.p1"]');
        await p.click('.slop-float .sp-toggle'); // a switch with nothing of its own to take back makes it all slop
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });
    await p.close();

    // ---------- the browser editor after the author publishes a new version ----------
    const republished = await fixture();
    p = await open(`file://${republished}`);
    await check('edits saved in the browser survive a new version: the author\'s changes win, the rest stays', async () => {
        await panel(p);
        await all(p);
        for (const at of ['how.p1', 'how.title']) {
            const ta = p.locator(`${field(at)} textarea`);
            await ta.click();
            await ta.press('End');
            await p.keyboard.type(' Mine.');
        }
        await p.click('.sp-save');
        assert.equal(await p.textContent('.sp-save'), 'Saved');
        const next = JSON.parse(JSON.stringify(FIXTURE));
        Object.assign(next, { version: 2 });
        next.how.title = 'How it all works';
        next.list.p3 = 'Third, new.';
        await writeFile(republished, page(next));
        await p.reload();
        assert.deepEqual(await get(p, 'how.p1'), ['The agent wrote this.', { me: ' Mine.' }]);
        assert.equal(await get(p, 'how.title'), 'How it all works');
        assert.equal(await get(p, 'list.p3'), 'Third, new.');
        assert.equal(await p.evaluate(() => Slop.text.version), 2);
        assert.deepEqual(await p.$$eval('#list > p', (xs) => xs.map((x) => x.textContent)), ['First item.', 'Second, all mine.', 'Third, new.']);
        assert.equal(await p.textContent('.sp-save'), 'Saved');
    });
    await check('a copy saved without the page it was based on (before 0.4) is dropped on a new version', async () => {
        await p.evaluate((key) => localStorage.setItem(key, JSON.stringify({ base: 1, text: { version: 1, how: { p1: 'Old copy.' } } })), `slop-text:${new URL(`file://${republished}`).pathname}`);
        await p.reload();
        assert.equal(await get(p, 'how.p1'), 'The agent wrote this.');
    });
    await check('a save the browser refuses says so', async () => {
        await p.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('blocked'); }; });
        await panel(p);
        await all(p);
        await p.click(`${field('how.p1')} .sp-toggle`);
        await p.click('.sp-save');
        assert.equal(await p.textContent('.sp-status'), "Couldn't save in this browser");
        assert.match(await p.textContent('.sp-save'), /^Save 1/);
    });
    await p.close();

    // ---------- lists without marking ----------
    const lists = await fixture();
    await writeFile(lists, listsPage(LISTS));
    p = await open(`file://${lists}`);
    await check('a group\'s paragraphs in alike elements with one parent are a list without marking', async () => {
        await panel(p);
        await all(p);
        const plus = (at) => p.$$eval(`${field(at)} .sp-insert`, (xs) => xs.length);
        assert.equal(await plus('auto.p1'), 1);
        assert.equal(await plus('auto.title'), 0);
        // scroll steps (data-b="0", "1"), paragraphs in two parents, and data-slop-list="off" aren't lists
        for (const at of ['steps.p1', 'split.p1', 'off.p1']) assert.equal(await plus(at), 0, at);
        assert.match(await p.textContent(`${field('auto.p2')} .sp-flabel`), /Paragraph 2/);
        await p.click(`${field('auto.p1')} .sp-insert`);
        await p.keyboard.insertText('Added.');
        const shown = () => p.$$eval('#auto > *', (xs) => xs.map((x) => `${x.tagName}.${[...x.classList].filter((c) => !c.startsWith('slop-')).join(' ')}:${x.textContent}`));
        await p.waitForFunction(() => [...document.querySelectorAll('#auto > p')].some((x) => x.textContent === 'Added.'));
        assert.deepEqual(await shown(), ['H2.:Unmarked', 'P.lede:One.', 'P.lede:Added.', 'P.lede:Two.', 'ASIDE.:Not a text.']);
        await p.click('.sp-save');
        // the page still has two of them; the saved one is drawn in its place
        await p.reload();
        await p.waitForFunction(() => [...document.querySelectorAll('#auto > p')].some((x) => x.textContent === 'Added.'));
        assert.deepEqual(await shown(), ['H2.:Unmarked', 'P.lede:One.', 'P.lede:Added.', 'P.lede:Two.', 'ASIDE.:Not a text.']);
        assert.equal(await p.$$eval('#steps > p, #off > p', (xs) => xs.length), 4);
    });
    await p.close();

    // ---------- a page that names where its copy is saved (a host that gives each version its own address) ----------
    await check('with Slop.start({key}), edits saved in the browser follow the page to a new address', async () => {
        const named = (text) => listsPage(text).replace("Slop.start({ edit: 'local' })", "Slop.start({ edit: 'local', key: 'lists-page' })");
        const first = await fixture();
        await writeFile(first, named(LISTS));
        p = await open(`file://${first}`);
        await panel(p);
        await all(p);
        await p.click(`${field('auto.title')} .sp-toggle`);
        await p.click('.sp-save');
        assert.ok(await p.evaluate(() => localStorage.getItem('slop-text:lists-page') !== null));
        const moved = await fixture(); // another folder: another path, in the same browser
        await writeFile(moved, named({ ...LISTS, version: 2, auto: { ...LISTS.auto, p3: 'Three.' } }));
        await p.goto(`file://${moved}`);
        assert.deepEqual(await get(p, 'auto.title'), [{ ok: 'Unmarked' }]);
        assert.equal(await get(p, 'auto.p3'), 'Three.');
        await p.close();
    });

    // ---------- the file editor, under `slop-editor edit` ----------
    const file = await fixture();
    const server = spawn(process.execPath, [path.join(here, 'cli.mjs'), 'edit', file, '--no-open'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const url = await new Promise((resolve, reject) => {
        server.stdout.on('data', (d) => { const m = /http:\/\/\S+/.exec(String(d)); if (m) resolve(m[0]); });
        server.on('exit', () => reject(new Error('the edit server stopped')));
    });
    try {
        p = await open(url);
        const stale = await open(url);
        await check('Save writes the file and bumps its version; a stale tab can\'t overwrite it', async () => {
            await panel(p);
            await all(p);
            await p.click(`${field('how.p1')} .sp-toggle`);
            assert.equal((await block(file)).version, 1); // nothing written before Save
            await p.keyboard.press('Meta+s');
            await p.waitForFunction(() => document.querySelector('.sp-save').textContent === 'Saved');
            const saved = await block(file);
            assert.equal(saved.version, 2);
            assert.deepEqual(saved.how.p1, [{ ok: 'The agent wrote this.' }]);
            await panel(stale);
            await all(stale);
            await stale.click(`${field('how.title')} .sp-toggle`);
            await stale.click('.sp-save');
            await stale.waitForFunction(() => /Couldn't save/.test(document.querySelector('.sp-status').textContent));
            assert.equal((await block(file)).version, 2);
        });

        await check('a paragraph added in a list is saved in its place, and drawn from the file', async () => {
            await p.click(`${field('list.p1')} .sp-insert`);
            await p.keyboard.insertText('Saved in the middle.');
            await p.keyboard.press('Meta+s');
            await p.waitForFunction(() => document.querySelector('.sp-save').textContent === 'Saved');
            const saved = await block(file);
            assert.deepEqual(Object.keys(saved.list), ['title', 'p1', 'p3', 'p2']);
            assert.deepEqual(saved.list.p3, [{ me: 'Saved in the middle.' }]);
            await p.reload();
            assert.deepEqual(await p.$$eval('#list > p', (xs) => xs.map((x) => x.textContent)), ['First item.', 'Saved in the middle.', 'Second, all mine.']);
        });
    } finally {
        server.kill();
    }

    assert.deepEqual(errors, [], 'no page errors or warnings');
    console.log(`\n${passed} passed`);
} finally {
    await browser.close();
}
