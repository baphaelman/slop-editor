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
  Slop.start(location.protocol === 'file:' ? { edit: 'local' } : {});
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
let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}

try {
    // ---------- the browser editor (file://), which saves in localStorage ----------
    const local = await fixture();
    let p = await open(`file://${local}`);

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

    await p.click('.slop-edit-btn');
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
        await p.click('.slop-edit-btn');
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
        assert.ok(await p.$eval('.slop-panel', (x) => x.hidden)); // nothing kept, so the editor stays closed
    });

    await check('a hidden text is shown on the page while it\'s edited', async () => {
        await p.click('.slop-edit-btn');
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
    await p.close();

    // ---------- the browser editor after the author publishes a new version ----------
    const republished = await fixture();
    p = await open(`file://${republished}`);
    await check('edits saved in the browser survive a new version: the author\'s changes win, the rest stays', async () => {
        await p.click('.slop-edit-btn');
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
        await p.click('.slop-edit-btn');
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
        await p.click('.slop-edit-btn');
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
        await p.waitForFunction(() => document.querySelectorAll('#auto > p').length === 3);
        assert.deepEqual(await shown(), ['H2.:Unmarked', 'P.lede:One.', 'P.lede:Added.', 'P.lede:Two.', 'ASIDE.:Not a text.']);
        await p.click('.sp-save');
        // the page still has two of them; the saved one is drawn in its place
        await p.reload();
        await p.waitForFunction(() => document.querySelectorAll('#auto > p').length === 3);
        assert.deepEqual(await shown(), ['H2.:Unmarked', 'P.lede:One.', 'P.lede:Added.', 'P.lede:Two.', 'ASIDE.:Not a text.']);
        assert.equal(await p.$$eval('#steps > p, #off > p', (xs) => xs.length), 4);
    });
    await p.close();

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
            await p.click('.slop-edit-btn');
            await all(p);
            await p.click(`${field('how.p1')} .sp-toggle`);
            assert.equal((await block(file)).version, 1); // nothing written before Save
            await p.keyboard.press('Meta+s');
            await p.waitForFunction(() => document.querySelector('.sp-save').textContent === 'Saved');
            const saved = await block(file);
            assert.equal(saved.version, 2);
            assert.deepEqual(saved.how.p1, [{ ok: 'The agent wrote this.' }]);
            await stale.click('.slop-edit-btn');
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
