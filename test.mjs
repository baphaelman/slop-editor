// node test.mjs: the format's functions, from slop.js (outside a browser it returns only those)
import { readFile, writeFile, mkdtemp, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { markup } from './markup.mjs';

const Slop = new Function(`${await readFile(new URL('slop.js', import.meta.url), 'utf8')}\nreturn Slop;`)();

test('typing makes the new words mine, the rest keeps its author', () => {
    assert.deepEqual(Slop.applyEdit('The cat sat.', 'The black cat sat.'), ['The ', { me: 'black ' }, 'cat sat.']);
    assert.deepEqual(Slop.applyEdit(['A ', { data: '42' }, ' b'], 'A 42 bc'), ['A ', { data: '42' }, ' b', { me: 'c' }]);
    assert.equal(Slop.applyEdit('same', 'same'), 'same');
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

test('makeup counts every category, data included', () => {
    const m = Slop.makeup([['ab ', { me: 'cd' }, { ok: 'e' }, { bob: 'fg' }, { data: 'h' }, '{n}']]);
    assert.deepEqual(m.counts, { ai: 2, me: 2, ok: 1, bob: 2, data: 1 });
    assert.equal(m.letters, 8);
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

test('markup: links, emphasis, code, values', () => {
    const runs = Slop.runs(['See [the **docs**](https://x.y) and ', { me: '`code`' }, ' {n}']);
    assert.equal(runs.find((r) => r.b).text, 'docs');
    assert.equal(runs.find((r) => r.b).link.href, 'https://x.y');
    assert.equal(runs.find((r) => r.code).by, 'me');
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
    await writeFile(path.join(dir, 'node_modules/react/index.js'), 'export const createElement = (type, props) => ({ type, props }); export const useSyncExternalStore = (s, get) => get();');
    await copyFile(new URL('react.mjs', import.meta.url), path.join(dir, 'react.mjs'));
    const listeners = [];
    globalThis.Slop = { ...Slop, onChange: (fn) => listeners.push(fn), html: (p, v) => Slop.render('Hi {n}', v), words: (p, v) => Slop.readable('Hi {n}', v) };
    const R = await import(path.join(dir, 'react.mjs'));
    assert.equal(listeners.length, 1);
    assert.deepEqual(R.SlopText({ path: 'a.b', as: 'p', vars: { n: 2 }, id: 'x' }), {
        type: 'p', props: { id: 'x', 'data-slop-ref': 'a.b', dangerouslySetInnerHTML: { __html: '<span class="slop-ai">Hi </span><span class="slop-data">2</span>' } },
    });
    assert.deepEqual(R.slopAttrs({ alt: 'a.img', title: 'a.tip' }, { n: 3 }), { alt: 'Hi 3', title: 'Hi 3', 'data-slop-attr': 'alt:a.img title:a.tip', 'data-slop-vars': '{"n":3}' });
    assert.deepEqual(R.SlopMeter({ path: 'a', className: 'big' }).props, { className: 'slop-meter big', 'data-slop-meter': 'a' });
    delete globalThis.Slop;
});
