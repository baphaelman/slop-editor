// node test.mjs: the format's functions, from slop.js (outside a browser it returns only those)
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

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
