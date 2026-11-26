// node test.mjs: the format's functions, from slop.js (outside a browser it returns only those)
import { readFile, writeFile, mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { markup } from './markup.mjs';
import { moveJsx } from './jsx.mjs';
import slopEditor from './vite.mjs';

const Slop = new Function(`${await readFile(new URL('slop.js', import.meta.url), 'utf8')}\nreturn Slop;`)();

test('typing makes the new words mine, the rest keeps its author', () => {
    assert.deepEqual(Slop.applyEdit('The cat sat.', 'The black cat sat.'), ['The ', { me: 'black ' }, 'cat sat.']);
    assert.deepEqual(Slop.applyEdit(['A ', { data: '42' }, ' b'], 'A 42 bc'), ['A ', { data: '42' }, ' b', { me: 'c' }]);
    assert.equal(Slop.applyEdit('same', 'same'), 'same');
});

test('typing over a selection makes what\'s typed mine, even a letter that matches the one it replaced', () => {
    assert.deepEqual(Slop.applyEdit('The cat sat.', 'The c sat.', undefined, [4, 7]), ['The ', { me: 'c' }, ' sat.']);
    assert.deepEqual(Slop.applyEdit('The cat sat.', 'The cat sat.', undefined, [4, 7]), ['The ', { me: 'cat' }, ' sat.']);
    // a stretch that doesn't fit the edit (a deletion at the caret) falls back to comparing the two versions
    assert.deepEqual(Slop.applyEdit('abb', 'ab', undefined, [2, 2]), 'ab');
    assert.deepEqual(Slop.applyEdit('The cat', 'The cart', undefined, [6, 6]), ['The ca', { me: 'r' }, 't']);
    // and an undo gives the whole word back to the AI
    assert.equal(Slop.applyEdit(['The ', { me: 'c' }, ' sat.'], 'The cat sat.', 'The cat sat.'), 'The cat sat.');
});

test('an undo gives the restored words back to whoever wrote them', () => {
    const before = ['The ', { ok: 'cat' }, ' sat.'];
    const typed = Slop.applyEdit(before, 'The dog sat.');
    assert.deepEqual(typed, ['The ', { me: 'dog' }, ' sat.']);
    assert.deepEqual(Slop.applyEdit(typed, 'The cat sat.', before), before);
    // an approval made since stays: only the restored stretch comes from the earlier version
    const approved = Slop.unslop(typed);
    assert.deepEqual(Slop.applyEdit(approved, 'The cat sat.', before), [{ ok: 'The cat sat.' }]);
});

test('the slop switch approves the AI\'s words and takes that back; typed words and data stay put', () => {
    const v = ['AI ', { me: 'mine ' }, { data: '1999' }];
    assert.deepEqual(Slop.unslop(v), [{ ok: 'AI ' }, { me: 'mine ' }, { data: '1999' }]);
    assert.deepEqual(Slop.reslop(Slop.unslop(v)), v);
    assert.equal(Slop.reslop(Slop.unslop('all AI')), 'all AI');
});

test('marking a stretch as a category, built-in or the page\'s own', () => {
    assert.deepEqual(Slop.assign('one two three', 4, 7, 'bob'), ['one ', { bob: 'two' }, ' three']);
    assert.deepEqual(Slop.assign(['a', { bob: 'b' }], 0, 2, 'ai'), 'ab');
    assert.deepEqual(Slop.applyEdit([{ bob: 'Hello' }], 'Hello!'), [{ bob: 'Hello' }, { me: '!' }]);
});

test('pasted words keep the authors they were copied with', () => {
    const pasted = Slop.applyEdit(['Hi. ', { me: 'Me.' }], 'Hi. Me.AI m');
    assert.deepEqual(Slop.overlay(pasted, 7, ['ai', 'ai', 'ai', 'me']), ['Hi. ', { me: 'Me.' }, 'AI ', { me: 'm' }]);
    assert.equal(Slop.overlay('all AI', 0, ['ai']), 'all AI');
});

test('makeup counts every category, data included', () => {
    const m = Slop.makeup([['ab ', { me: 'cd' }, { ok: 'e' }, { bob: 'fg' }, { data: 'h' }, '{n}']]);
    assert.deepEqual(m.counts, { ai: 2, me: 2, ok: 1, bob: 2, data: 1 });
    assert.equal(m.letters, 8);
});

test('code is a fact: shown and counted as data, whoever wrote it', () => {
    const m = Slop.makeup([['run ', '`npx x`', ' or ', { me: 'type `ls`' }]]);
    assert.deepEqual(m.counts, { ai: 5, data: 6, me: 4 });
    assert.match(Slop.render('run `npx x`'), /<span class="code"><span class="slop-data">npx x<\/span><\/span>/);
});

test('share: what is mine (typed or approved), not counting spaces, data or values', () => {
    const s = Slop.share([['ab ', { me: 'c ' }, { ok: 'd ' }, { data: 'zzzz' }, '{n}']]);
    assert.equal(s.fraction, 0.5);
    assert.equal(s.words, 2);
    assert.equal(s.allWords, 3);
});

test('repeated text: the same words in several places, whoever wrote each copy', () => {
    const sets = Slop.repeats([
        ['nav.how', 'How it works'],
        ['how.title', [{ me: 'How it works' }]],
        ['footer.how', 'How  it works '],
        ['how.p1', 'Something else.'],
        ['a.x', 'OK'], ['b.x', 'OK'], // too short
        ['a.q', [{ data: 'A quote, twice' }]], ['b.q', [{ data: 'A quote, twice' }]], // data only
    ]);
    assert.deepEqual(sets, [{ words: 'How it works', paths: ['nav.how', 'how.title', 'footer.how'] }]);
});

test('rebase: a copy saved in the browser keeps its edits where the author didn\'t change the text', () => {
    const base = { version: 1, _show: 'pie', _categories: { bob: { label: 'Bob' } }, a: { t: 'Title', p1: 'One.', p2: 'Two.', gone: 'Old.' } };
    const mine = { version: 1, _show: 'colors', _categories: { bob: { label: 'Bob' }, sue: { label: 'Sue' } }, a: { t: [{ ok: 'Title' }], p1: [{ me: 'Mine.' }], p3: 'Added here.', p2: 'Two.', gone: 'Old.' } };
    const page = { version: 2, _show: 'pie', _categories: { bob: { label: 'Robert' } }, a: { t: 'Title', p1: 'One.', p2: 'Two, rewritten.', p4: 'New.' }, b: { t: 'A new section' } };
    const out = Slop.rebase(base, mine, page);
    assert.deepEqual(out, {
        version: 2, _show: 'colors', _categories: { bob: { label: 'Robert' }, sue: { label: 'Sue' } },
        a: { t: [{ ok: 'Title' }], p1: [{ me: 'Mine.' }], p3: 'Added here.', p2: 'Two, rewritten.', p4: 'New.' }, b: { t: 'A new section' },
    });
    assert.deepEqual(Object.keys(out.a), ['t', 'p1', 'p3', 'p2', 'p4']);
    // a text the copy removed stays removed, unless the author changed it
    assert.deepEqual(Slop.rebase({ a: { x: '1', y: '2' } }, { a: {} }, { a: { x: '1', y: '3' } }), { a: { y: '3' } });
});

test('lists without marking: a group\'s paragraphs in alike elements with one parent', () => {
    const p = (path, parent, attrs, tag = 'P') => ({ path, parent, tag, attrs });
    const found = (...items) => Object.fromEntries(Slop.listsIn(items));
    assert.deepEqual(found(p('a.p1', 'A', {}), p('a.title', 'A', {}, 'H2'), p('a.p2', 'A', {}), p('b.c.p1', 'B', { class: 'x' }), p('b.c.p2', 'B', { class: 'x' })), { a: 'A', 'b.c': 'B' });
    // scroll steps told apart by an attribute aren't a list
    assert.deepEqual(found(p('pure.p1', 'S', { 'data-b': '0' }), p('pure.p2', 'S', { 'data-b': '1' })), {});
    // nor paragraphs in two parents, in different tags, or one on its own
    assert.deepEqual(found(p('ring.p1', 'C', {}), p('ring.p2', 'Q', {}), p('ring.p3', 'Q', {})), {});
    assert.deepEqual(found(p('a.p1', 'A', {}), p('a.p2', 'A', {}, 'LI')), {});
    assert.deepEqual(found(p('a.p1', 'A', {}), p('a.note', 'A', {})), {});
    assert.deepEqual(found(p('a.p1', 'A', { id: 'x' }), p('a.p2', 'A', {})), {});
});

test('paragraphs: a blank line splits a text, each part keeping its authors', () => {
    assert.deepEqual(Slop.paragraphsOf('One line\nand the next'), ['One line\nand the next']);
    assert.deepEqual(Slop.paragraphsOf(['First. ', { me: 'Mine.\n\nSecond, ' }, 'by the AI.\n  \n\n']), [['First. ', { me: 'Mine.' }], [{ me: 'Second, ' }, 'by the AI.']]);
    assert.deepEqual(Slop.paragraphsOf(''), ['']);
    assert.deepEqual(Slop.paragraphsOf('\n\n'), ['\n\n']);
});

test('markup: links, emphasis, code, values', () => {
    const runs = Slop.runs(['See [the **docs**](https://x.y) and ', { me: '`code`' }, ' {n}']);
    assert.equal(runs.find((r) => r.b).text, 'docs');
    assert.equal(runs.find((r) => r.b).link.href, 'https://x.y');
    assert.equal(runs.find((r) => r.code).by, 'data');
    assert.equal(runs.find((r) => r.v).v, 'n');
    assert.equal(Slop.readable('a {n} b'.replace('{n}', '\\{n}')), 'a {n} b');
});

test('install --auto: prose moves into the block, labels, code and other markup stay', () => {
    const r = markup('<body><nav><p>Not in the nav at all</p></nav><h1>Big News</h1>'
        + '<p>Hello <b>there</b>, see <a href="https://a.b">the docs</a> &amp; [more] now.</p><p>Short one</p>'
        + '<ul><li>First item is here</li><li>Has <span>a span in it</span></li></ul>'
        + '<div><p id="a" data-slop="x.y">Already marked up here</p><p>Second {x} para here.</p></div>'
        + '<script>var a = "<p>no way here ok</p>"</script></body>');
    assert.deepEqual(r.block, {
        version: 1,
        'big-news': { title: 'Big News', p1: 'Hello **there**, see [the docs](https://a.b) & \\[more\\] now.', li2: 'First item is here', p3: 'Second \\{x\\} para here.' },
    });
    assert.equal(r.skipped, 1);
    assert.ok(r.html.includes('<h1 data-slop="big-news.title"></h1>'));
    assert.ok(r.html.includes('<p>Short one</p>') && r.html.includes('<nav><p>Not in the nav at all</p></nav>'));
    assert.equal(Slop.readable(r.block['big-news'].p3), 'Second {x} para here.');
});

test('edit: a page that inlines old code gets the current code; one that links it is served it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-edit-'));
    const page = path.join(dir, 'page.html');
    const block = '<script type="application/json" id="slop-text">{"version": 1}</script>';
    await writeFile(page, `<style id="slop-css">old</style><p>hi</p>${block}<script id="slop-js">old</script>`);
    await writeFile(path.join(dir, 'linked.html'), `<link rel="stylesheet" href="/slop/slop.css">${block}<script src="/slop/slop.js"></script>`);
    const server = spawn(process.execPath, [new URL('cli.mjs', import.meta.url).pathname, 'edit', page, '--no-open', '--port', '5251'], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
        const link = await new Promise((resolve) => server.stdout.on('data', (d) => { const m = /http:\/\/\S+/.exec(String(d)); if (m) resolve(m[0]); }));
        const html = await readFile(page, 'utf8');
        assert.ok(html.includes((await readFile(new URL('slop.js', import.meta.url), 'utf8')).slice(0, 200)));
        assert.ok(!html.includes('>old<'));
        const js = await fetch(new URL('/slop/slop.js', link));
        assert.equal(js.status, 200);
        assert.match(js.headers.get('content-type'), /javascript/);
        assert.equal((await fetch(new URL('/slop/slop.css', link))).status, 200);
        assert.equal((await fetch(new URL('/slop/other.js', link))).status, 404);
        // only the page being edited gets the editor: another page in its folder would save into this one
        const hello = (from) => fetch(new URL('/__slop', link), { headers: { referer: new URL(from, link).href } }).then((r) => r.text());
        assert.equal(await hello('/page.html'), 'slop-editor');
        assert.equal(await hello('/linked.html'), 'another page');
        assert.equal((await fetch(new URL('/__slop', link), { method: 'POST', body: '{"version":1}', headers: { referer: new URL('/linked.html', link).href } })).status, 403);
    } finally {
        server.kill();
    }
});

test('pending: categories the user asked an agent to find, and the session hook\'s context', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-pending-'));
    const cats = { bob: { label: 'Bob', about: 'My co-author: the methods section', find: true }, sue: { label: 'Sue' } };
    await writeFile(path.join(dir, 'page.html'), `<p>hi</p><script type="application/json" id="slop-text">${JSON.stringify({ version: 1, _categories: cats })}</script>`);
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'text.json'), JSON.stringify({ version: 3, _categories: { ann: { find: true } } }));
    await mkdir(path.join(dir, 'node_modules'));
    await writeFile(path.join(dir, 'node_modules', 'x.json'), JSON.stringify({ version: 1, _categories: { no: { find: true } } }));
    const run = (...a) => execFileSync(process.execPath, [new URL('cli.mjs', import.meta.url).pathname, 'pending', ...a], { cwd: dir, encoding: 'utf8' });
    const out = run();
    assert.match(out, /page\.html: "Bob" \(id `bob`\): My co-author: the methods section/);
    assert.match(out, /src\/text\.json: "ann"/);
    assert.ok(!/Sue|node_modules/.test(out));
    const hook = JSON.parse(run('--hook'));
    assert.equal(hook.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(hook.hookSpecificOutput.additionalContext, /"Bob"[\s\S]*Categories to find/);
    await writeFile(path.join(dir, 'page.html'), '<p>no block</p>');
    await writeFile(path.join(dir, 'src', 'text.json'), '{}');
    assert.equal(run('--hook'), ''); // nothing waiting: nothing said
});

test('history: what each commit did to who wrote what', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-history-'));
    const page = path.join(dir, 'page.html');
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
    const save = async (block, message) => {
        await writeFile(page, `<p>hi</p><script type="application/json" id="slop-text">${JSON.stringify(block)}</script>`);
        git('add', '.');
        git('commit', '-qm', message);
    };
    git('init', '-q');
    await save({ version: 1, a: { p1: 'The agent wrote this.' } }, 'first');
    await save({ version: 2, a: { p1: [{ ok: 'The agent wrote this.' }] } }, 'approve');
    await save({ version: 3, a: { p1: [{ ok: 'The agent wrote this.' }] }, _show: 'pie' }, 'only the setting');
    const out = execFileSync(process.execPath, [new URL('cli.mjs', import.meta.url).pathname, 'history', page], { encoding: 'utf8' });
    const lines = out.split('\n').filter((l) => /^  \d/.test(l));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /slop 100%  AI-generated \+18  first/);
    assert.match(lines[1], /slop   0%  AI, approved \+18 · AI-generated −18  approve/);
});

test('react: texts, attributes and meters', async () => {
    // a stand-in for React, enough to see what the components ask it to draw
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-react-'));
    await mkdir(path.join(dir, 'node_modules/react'), { recursive: true });
    await writeFile(path.join(dir, 'node_modules/react/package.json'), '{"name":"react","type":"module","exports":"./index.js"}');
    await writeFile(path.join(dir, 'node_modules/react/index.js'), 'export const Fragment = \'Fragment\'; export const createElement = (type, props, ...children) => (children.length ? { type, props, children } : { type, props }); export const useSyncExternalStore = (s, get) => get();');
    await copyFile(new URL('react.mjs', import.meta.url), path.join(dir, 'react.mjs'));
    const listeners = [];
    globalThis.Slop = { ...Slop, onChange: (fn) => listeners.push(fn), html: (p, v) => Slop.render('Hi {n}', v), words: (p, v) => Slop.readable('Hi {n}', v), paragraphs: (p, v) => Slop.paragraphsOf(p === 'a.c' ? 'One\n\nTwo' : 'Hi {n}').map((x) => Slop.render(x, v)) };
    const R = await import(path.join(dir, 'react.mjs'));
    assert.equal(listeners.length, 1);
    assert.deepEqual(R.SlopText({ path: 'a.b', as: 'p', vars: { n: 2 }, id: 'x' }), {
        type: 'p', props: { id: 'x', 'data-slop-ref': 'a.b', dangerouslySetInnerHTML: { __html: '<span class="slop-ai">Hi </span><span class="slop-data">2</span>' } },
    });
    // a paragraph after a blank line gets an element of its own; the id stays on the first
    const two = R.SlopText({ path: 'a.c', as: 'p', id: 'y', className: 'k' });
    assert.equal(two.type, 'Fragment');
    assert.deepEqual(two.children.map((c) => [c.props.id, c.props.className, c.props['data-slop-ref'], c.props.dangerouslySetInnerHTML.__html]), [
        ['y', 'k', 'a.c', '<span class="slop-ai">One</span>'], [undefined, 'k', 'a.c', '<span class="slop-ai">Two</span>'],
    ]);
    assert.deepEqual(R.slopList('a'), { 'data-slop-list-ref': 'a' });
    assert.deepEqual(R.slopAttrs({ alt: 'a.img', title: 'a.tip' }, { n: 3 }), { alt: 'Hi 3', title: 'Hi 3', 'data-slop-attr': 'alt:a.img title:a.tip', 'data-slop-vars': '{"n":3}' });
    assert.deepEqual(R.SlopMeter({ path: 'a', className: 'big' }).props, { className: 'slop-meter big', 'data-slop-meter': 'a' });
    delete globalThis.Slop;
});

test('install --auto --author: the moved text is the AI\'s unless the user says it\'s theirs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-author-'));
    const cli = (...a) => execFileSync(process.execPath, [new URL('cli.mjs', import.meta.url).pathname, 'install', ...a], { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const blockOf = async (name) => JSON.parse(/id="slop-text">([\s\S]*?)<\/script>/.exec(await readFile(path.join(dir, name), 'utf8'))[1]);
    for (const name of ['ai.html', 'default.html', 'me.html']) await writeFile(path.join(dir, name), '<body><h1>Big News</h1><p>Hello there, this is a paragraph.</p></body>');
    cli('--auto', 'default.html');
    cli('--auto', '--author', 'ai', 'ai.html');
    assert.match(cli('--auto', '--author', 'me', 'me.html'), /moved 2 texts into the block as yours/);
    assert.equal((await blockOf('default.html'))['big-news'].p1, 'Hello there, this is a paragraph.');
    assert.deepEqual(await blockOf('ai.html'), await blockOf('default.html'));
    assert.deepEqual((await blockOf('me.html'))['big-news'], { title: [{ me: 'Big News' }], p1: [{ me: 'Hello there, this is a paragraph.' }] });
    assert.throws(() => cli('--auto', '--author', 'someone', 'me.html'), /--author takes ai/);
    assert.throws(() => cli('--author', 'me', 'me.html'), /goes with --auto/);
});

test('jsx: prose moves into the block as SlopText, with its markup, alt text and imports', () => {
    const src = `'use client';
import React from 'react';
import ExternalLink from './ExternalLink.jsx';
import { Other, Unused } from './x.js';

export default function Card({ n }) {
    const x = 1;
    return (
        <div>
            <h2 className="t">Big News</h2>
            <p>Hello <b>there</b>, see <ExternalLink href="https://a.b">the docs</ExternalLink> &amp; [more] now{" "}ok.</p>
            <p>Short one</p>
            <p>Count is {n} things</p>
            <p>A * B * C and 2 &gt; 1 are in it</p>
            <img src="a.png" alt="A diagram of it" title="Tip here" />
            <ul><li>First item is here</li></ul>
            <i>Some words loose in an italic</i>
            <Other />
        </div>
    );
}
`;
    const r = moveJsx(src, { name: 'card' });
    assert.deepEqual(r.block, {
        'big-news': { title: 'Big News', p1: 'Hello **there**, see [the docs](https://a.b) & \\[more\\] now ok.', p2: 'A \\* B \\* C and 2 > 1 are in it', li3: 'First item is here' },
        'alt-text': { 'a-diagram': 'A diagram of it' },
        tooltips: { 'tip-here': 'Tip here' },
    });
    assert.deepEqual([r.texts, r.attrs, r.skipped, r.loose], [4, 2, [13], [17]]);
    assert.equal(Slop.readable(r.block['big-news'].p2), 'A * B * C and 2 > 1 are in it');
    // the source changes only where it moved words: the 'use client' stays first, the unused link import goes, the hook is first in the component
    assert.ok(r.code.startsWith("'use client';\nimport React from 'react';\nimport { Other, Unused } from './x.js';\nimport { SlopText, slopAttrs, useSlop } from 'slop-editor/react';\n"));
    assert.ok(r.code.includes('export default function Card({ n }) {\n    useSlop();\n    const x = 1;'));
    assert.ok(r.code.includes('<SlopText path="card.big-news.title" as="h2" className="t" />'));
    assert.ok(r.code.includes('<img src="a.png" {...slopAttrs({ alt: \'card.alt-text.a-diagram\', title: \'card.tooltips.tip-here\' })} />'));
    assert.ok(r.code.includes('<p>Short one</p>') && r.code.includes('<p>Count is {n} things</p>') && r.code.includes('<i>Some words loose in an italic</i>'));
    // a second run finds nothing more, and a key it has used is never used again
    assert.equal(moveJsx(r.code, { name: 'card' }).texts, 0);
    const more = moveJsx('export const A = () => <div><p>One more paragraph here</p></div>;', { name: 'card', have: r.block });
    assert.deepEqual(more.block, { intro: { p1: 'One more paragraph here' } });
    // an import it already has gets the names added, not a second one
    const had = moveJsx("import Slop, { SlopMeter } from 'slop-editor/react';\nexport const A = () => <div><p>One more paragraph here</p></div>;", { name: 'a' });
    assert.ok(had.code.startsWith("import Slop, { SlopMeter, SlopText } from 'slop-editor/react';"));
});

test('install --auto on a Vite app: the words file, the plugin, the entry, and --author', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-vite-'));
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'package.json'), '{"name":"app","dependencies":{"slop-editor":"*"}}');
    await writeFile(path.join(dir, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.jsx"></script>');
    await writeFile(path.join(dir, 'vite.config.js'), "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n");
    await writeFile(path.join(dir, 'src/main.jsx'), "import React from 'react';\nimport App from './App.jsx';\n\nrender(<App />);\n");
    await writeFile(path.join(dir, 'src/App.jsx'), 'export default function App() {\n    return <p>Words that the user wrote, once.</p>;\n}\n');
    const cli = (...a) => execFileSync(process.execPath, [new URL('cli.mjs', import.meta.url).pathname, 'install', ...a], { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const same = async () => [await readFile(path.join(dir, 'src/App.jsx'), 'utf8'), await readFile(path.join(dir, 'vite.config.js'), 'utf8')].join();
    const before = await same();
    assert.match(cli('--auto', '--dry-run', 'src'), /would move 1 text/);
    assert.equal(await same(), before); // a dry run changes nothing
    assert.throws(() => cli('--author', 'me', 'src'), /goes with --auto/);
    assert.match(cli('--auto', '--author', 'me', 'src'), /Put 1 texts in src\/slopText\.json as yours/);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'src/slopText.json'), 'utf8')), { version: 1, app: { intro: { p1: [{ me: 'Words that the user wrote, once.' }] } } });
    assert.match(await readFile(path.join(dir, 'vite.config.js'), 'utf8'), /import slopEditor from 'slop-editor\/vite';[\s\S]*plugins: \[slopEditor\(\), react\(\)\]/);
    assert.match(await readFile(path.join(dir, 'src/main.jsx'), 'utf8'), /import Slop from 'slop-editor\/react';\n\nSlop\.start\(\);\n/);
    assert.match(await readFile(path.join(dir, 'src/App.jsx'), 'utf8'), /<SlopText path="app\.intro\.p1" as="p" \/>/);
    // again: nothing moves, nothing is added twice, and the version only goes up when the file changed
    cli('--auto', 'src');
    assert.equal((await readFile(path.join(dir, 'vite.config.js'), 'utf8')).match(/slopEditor/g).length, 2);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'src/slopText.json'), 'utf8')).version, 1);
});

test('slop-editor/vite: the block and the code go in the page, and the editor saves into the file, version-checked', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slop-plugin-'));
    await mkdir(path.join(dir, 'src'));
    const file = path.join(dir, 'src/slopText.json');
    await writeFile(file, JSON.stringify({ version: 4, a: { b: 'Hi </script>' } }));
    const plugin = slopEditor();
    plugin.configResolved({ root: dir });
    const tags = await plugin.transformIndexHtml();
    const block = tags.find((t) => t.attrs?.id === 'slop-text');
    assert.deepEqual(JSON.parse(block.children.replace(/\\u003c/g, '<')), { version: 4, a: { b: 'Hi </script>' } });
    assert.ok(!block.children.includes('</script>') && tags.some((t) => t.tag === 'style') && tags.some((t) => t.tag === 'script' && t.children.includes('const Slop')));
    let handler;
    plugin.configureServer({ watcher: { add() {}, on() {} }, middlewares: { use: (at, fn) => { handler = fn; } }, ws: { send() {} } });
    const call = (method, body) => new Promise((resolve) => {
        const req = { method, on: (e, fn) => { if (e === 'data' && body) fn(body); if (e === 'end') setTimeout(fn, 0); } };
        const res = { statusCode: 200, end: (out) => resolve([res.statusCode, out]) };
        handler(req, res);
    });
    assert.deepEqual(await call('GET'), [200, 'slop-editor']);
    assert.deepEqual(await call('POST', JSON.stringify({ version: 4, a: { b: 'Edited' } })), [200, '5']);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 5, a: { b: 'Edited' } });
    assert.equal((await call('POST', JSON.stringify({ version: 4, a: { b: 'Stale' } })))[0], 409); // a page that loaded version 4
    assert.equal((await call('POST', 'not json'))[0], 400);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).a.b, 'Edited');
});
