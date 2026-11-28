/* Slop editor: who wrote every word on a page. MIT license.

   The words live in the page's text block, a JSON script element with the id "slop-text": an object with a
   top-level "version" and groups (objects) of texts in reading order. A text is a plain string (the AI's words) or a
   list of pieces: a string (the AI's), {"me": "..."} (mine: typed in the editor, or dictated word for word),
   {"ok": "..."} (the AI's words, approved as they are), {"data": "..."} (a fact, or someone else's words quoted), or
   {"<category>": "..."} for a category the page defines. A list is always one text.
   Top-level keys that start with "_" aren't text: "_categories" holds the page's own categories and colors,
   {"<id>": {"label": "...", "color": "#rrggbb"}}, for built-in ones too, and "_show" what readers see: "nothing" (the
   default), "pie" (a pie of who wrote what, with a legend) or "colors" (the Slop-o-meter switch, which colors the words).
   Inside any text: [label](url) is a link, **bold**, *italic*, `code` (a fact, shown as data), [[key]] a key cap,
   {name} a value the page fills in (Slop.vars), and \ makes the next character literal.

   A blank line starts a new paragraph in a <p>, <li> or <dd>.

   Elements with data-slop="group.key" are filled from the block. Code renders the rest with Slop.html(path). An
   element with data-slop-list="group" shows each text in that group in a copy of its first child, and the editor can
   add and remove texts there (data-slop-list-ref: the page draws them itself). A group's paragraphs in alike elements
   with one parent are a list without marking (data-slop-list="off" on the parent: not one).
   An element with data-slop-meter becomes the Slop-o-meter switch. Under `slop-editor edit`, the page also gets the
   editor, which saves back into the file; with Slop.start({edit: 'local'}) it gets one that saves in the browser. */
const Slop = (() => {
    'use strict';

    /* ---------- the format ---------- */

    // the built-in categories. Slop is the AI's words; the slop switch approves them (ok) or takes that back.
    // `me` has no color of its own: my words keep the page's
    const BUILTIN = {
        me: { label: 'My words', light: null, dark: null },
        ok: { label: 'AI, approved', light: '#17805a', dark: '#5ccf9c' },
        data: { label: 'Data & quotes', light: '#8a5600', dark: '#e6b45c' },
        ai: { label: 'AI-generated', light: '#6d35d0', dark: '#b892ff' },
    };
    // colors for the page's own categories, in the order they're made
    const PALETTE = ['#e0662b', '#2b9fc0', '#d4469a', '#3b7be0', '#b8860b', '#8b5cf6'];

    const authorOf = (piece) => (typeof piece === 'string' ? 'ai' : Object.keys(piece)[0] ?? 'ai');
    const textOf = (piece) => (typeof piece === 'string' ? piece : String(Object.values(piece)[0] ?? ''));
    const pieceOf = (author, s) => (author === 'ai' ? s : { [author]: s });

    // the text with its markup, as the editor shows it
    const plain = (value) => (typeof value === 'string' ? value : value.map(textOf).join(''));

    // who wrote each character
    function authorsByChar(value) {
        if (typeof value === 'string') return new Array(value.length).fill('ai');
        return value.flatMap((piece) => new Array(textOf(piece).length).fill(authorOf(piece)));
    }

    function fromChars(text, authors) {
        if (authors.every((author) => author === 'ai')) return text;
        const pieces = [];
        for (let i = 0; i < text.length;) {
            let j = i;
            while (j < text.length && authors[j] === authors[i]) j++;
            pieces.push(pieceOf(authors[i], text.slice(i, j)));
            i = j;
        }
        return pieces;
    }

    // `value` after its plain text became `next` in the editor. An edit is one stretch replaced (typing, deleting,
    // pasting): what both versions share at the start and the end keeps its author, and the new middle is mine.
    // Unless it's an undo or a redo: then `was`, an earlier version whose plain text is `next`, says who wrote it.
    // `at`, the [start, end) of `value` the edit replaced (the selection typed over), when the editor knows it: typing
    // "c" over a selected "cat" makes that "c" mine, though it matches the letter that was there
    function applyEdit(value, next, was, at) {
        const prev = plain(value);
        const typedOver = at && at[1] > at[0];
        if (prev === next && !typedOver) return value;
        let start = 0;
        let end = 0;
        if (at && next.startsWith(prev.slice(0, at[0])) && next.endsWith(prev.slice(at[1])) && next.length - (prev.length - at[1]) >= at[0]) {
            start = at[0];
            end = prev.length - at[1];
        } else {
            while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
            while (end < prev.length - start && end < next.length - start
                && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end++;
        }
        const authors = authorsByChar(value);
        if (was != null && plain(was) === next) {
            // an undo takes back what was typed: my letters at the edges of the stretch that the earlier version doesn't
            // have as mine (an "a" typed over "agent" matches the "a" there, so it looks shared) go back with it
            const old = authorsByChar(was);
            while (start > 0 && authors[start - 1] === 'me' && old[start - 1] !== 'me') start--;
            while (end > 0 && authors[prev.length - end] === 'me' && old[next.length - end] !== 'me') end--;
        }
        const middle = was != null && plain(was) === next
            ? authorsByChar(was).slice(start, next.length - end)
            : new Array(next.length - start - end).fill('me');
        return fromChars(next, [...authors.slice(0, start), ...middle, ...authors.slice(prev.length - end)]);
    }

    // `value` with one author's words handed to another, the text unchanged
    const reattribute = (value, from, to) => fromChars(plain(value), authorsByChar(value).map((a) => (a === from ? to : a)));
    // unslopify (the slop switch, off): the AI's words, approved as they are
    const unslop = (value) => reattribute(value, 'ai', 'ok');
    // re-slopify (the slop switch, on): approved words go back to being slop. What I typed stays mine
    const reslop = (value) => reattribute(value, 'ok', 'ai');
    // characters start to end (of the plain text) marked as one author's
    const assign = (value, start, end, to) => fromChars(plain(value), authorsByChar(value).map((a, i) => (i >= start && i < end ? to : a)));
    // characters from `start` on given these authors, one each (what was pasted keeps who wrote it), the text unchanged
    const overlay = (value, start, authors) => fromChars(plain(value), authorsByChar(value).map((a, i) => authors[i - start] ?? a));

    const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/y;
    const VAR = /\{(\w+)\}/y;
    const same = (a, b) => a.by === b.by && a.link === b.link && a.b === b.b && a.i === b.i && a.code === b.code && a.key === b.key;

    // the text as it reads: runs of one author's words (`by`: the category) with their formatting (b, i, code, key)
    // and the link they sit in, if any. A {name} is a run of its own with `v` set. Code is a fact: whoever wrote it,
    // a command or a file name reads as data
    // Each run also has `at`, where each of its characters is in the plain text (a {name}: where it starts, and `len`).
    // `marks` are the markup's characters, [start, length, the mark it pairs with], for editing the words as they read
    function parse(value) {
        const text = plain(value);
        const authors = authorsByChar(value);
        const out = [];
        const marks = [];
        const st = { b: false, i: false, code: false, key: false, link: null };
        const opened = {}; // the mark that turned each one on
        let linkEnd = -1;
        let linkTail = 0;
        const push = (s, by, src, v, len) => {
            const run = { text: s, by: st.code ? 'data' : by, link: st.link, b: st.b, i: st.i, code: st.code, key: st.key, v, at: [src], len };
            const last = out[out.length - 1];
            if (last && !last.v && !v && same(last, run)) { last.text += s; last.at.push(src); } else out.push(run);
        };
        const mark = (kind, start, length) => {
            const m = [start, length, null];
            if (opened[kind]) { m[2] = opened[kind]; opened[kind][2] = m; opened[kind] = null; } else opened[kind] = m;
            marks.push(m);
        };
        for (let i = 0; i < text.length;) {
            const c = text[i];
            if (i === linkEnd) { st.link = null; mark('link', i, linkTail); i += linkTail; linkEnd = -1; continue; }
            if (c === '\\' && i + 1 < text.length) { marks.push([i, 1, null]); push(text[i + 1], authors[i + 1], i + 1); i += 2; continue; }
            if (c === '[' && text[i + 1] === '[' && !st.key) { st.key = true; mark('key', i, 2); i += 2; continue; }
            if (c === ']' && text[i + 1] === ']' && st.key) { st.key = false; mark('key', i, 2); i += 2; continue; }
            if (c === '[' && !st.link) {
                LINK.lastIndex = i;
                const m = LINK.exec(text);
                if (m) { st.link = { href: m[2] }; mark('link', i, 1); linkEnd = i + 1 + m[1].length; linkTail = m[0].length - m[1].length - 1; i++; continue; }
            }
            if (c === '`') { st.code = !st.code; mark('code', i, 1); i++; continue; }
            if (c === '*' && !st.code) {
                if (text[i + 1] === '*') { st.b = !st.b; mark('b', i, 2); i += 2; } else { st.i = !st.i; mark('i', i, 1); i++; }
                continue;
            }
            if (c === '{') {
                VAR.lastIndex = i;
                const m = VAR.exec(text);
                if (m) { push('', authors[i], i, m[1], m[0].length); i += m[0].length; continue; }
            }
            push(c, authors[i], i);
            i++;
        }
        return { runs: out, marks };
    }
    const runs = (value) => parse(value).runs;

    // the words as they read, one character each, with where each is in the plain text. A {name} reads as one
    // character, OBJ, as the editor shows it: one block that can't be typed into
    const OBJ = '￼';
    function readOf(value) {
        let words = '';
        const at = [];
        const len = [];
        runs(value).forEach((run) => {
            if (run.v) { words += OBJ; at.push(run.at[0]); len.push(run.len); return; }
            words += run.text;
            run.at.forEach((i) => { at.push(i); len.push(1); });
        });
        return { words, at, len };
    }
    // `value` after the words as they read, from `start` to `end`, were replaced with `typed` (typed by me): letters
    // typed are escaped, the markup around and inside the stretch stays, and markup left with nothing in it goes
    function editRead(value, start, end, typed, by = 'me') {
        const text = plain(value);
        const authors = authorsByChar(value);
        const { at, len } = readOf(value);
        const { marks } = parse(value);
        const gone = new Set();
        for (let k = start; k < end; k++) for (let n = 0; n < len[k]; n++) gone.add(at[k] + n);
        // an escaped letter takes its backslash with it
        marks.forEach(([s, l, pair]) => { if (l === 1 && !pair && text[s] === '\\' && gone.has(s + 1)) gone.add(s); });
        // where the typing goes: after the letter before it, so it takes that letter's bold, link or code
        const to = start > 0 ? at[start - 1] + len[start - 1] : 0;
        const escaped = typed.replace(/[\\*`[\]{]/g, '\\$&');
        // marks whose pair now holds nothing go too
        const markup = new Set(marks.flatMap(([s, l]) => [...Array(l).keys()].map((n) => s + n)));
        const holds = (from, until) => {
            for (let i = from; i < until; i++) if (!gone.has(i) && !markup.has(i)) return true;
            return Boolean(escaped) && to >= from && to <= until;
        };
        marks.forEach(([s, l, pair]) => {
            if (!pair || s > pair[0] || holds(s + l, pair[0])) return;
            for (let n = 0; n < l; n++) gone.add(s + n);
            for (let n = 0; n < pair[1]; n++) gone.add(pair[0] + n);
        });
        let next = '';
        const who = [];
        for (let i = 0; i <= text.length; i++) {
            if (i === to) { next += escaped; who.push(...new Array(escaped.length).fill(by)); }
            if (i < text.length && !gone.has(i)) { next += text[i]; who.push(authors[i]); }
        }
        return fromChars(next, who);
    }
    // `value` with the words as they read, from `start` to `end`, made bold, italic or code (`b`, `i`, `code`: on unless
    // they all are already, then off) or a link (`link`: {href}, or null for none). The text's markup is written again,
    // as few marks as it takes; every letter and {name} keeps its author, and a mark takes the author of the letter
    // after it (the one before, at the end)
    function restyle(value, start, end, how) {
        const text = plain(value);
        const authors = authorsByChar(value);
        const chars = [];
        runs(value).forEach((run) => {
            const style = { b: run.b, i: run.i, code: run.code, key: run.key, link: run.link };
            if (run.v) chars.push({ ...style, v: text.slice(run.at[0], run.at[0] + run.len), by: authors[run.at[0]] });
            else for (let k = 0; k < run.text.length; k++) chars.push({ ...style, c: run.text[k], by: authors[run.at[k]] });
        });
        const [key, to] = Object.entries(how)[0];
        const picked = chars.slice(start, end);
        const on = key === 'link' ? to : !picked.filter((c) => !c.v).every((c) => c[key]);
        picked.forEach((c) => { c[key] = on; });
        let out = '';
        const who = [];
        const put = (str, by) => { out += str; who.push(...new Array(str.length).fill(by)); };
        const now = { b: false, i: false, code: false, key: false, link: null };
        // marks are toggles, so their order only matters for brackets: a [[key]] opens before a [link] in it
        const shift = (want, by) => {
            if (now.link && now.link !== want.link) { put(`](${now.link.href})`, by); now.link = null; }
            if (now.code && !want.code) { put('`', by); now.code = false; }
            if (now.key && !want.key) { put(']]', by); now.key = false; }
            if (!now.code && !want.code) {
                if (now.b !== want.b) { put('**', by); now.b = want.b; }
                if (now.i !== want.i) { put('*', by); now.i = want.i; }
            }
            if (want.key && !now.key) { put('[[', by); now.key = true; }
            if (want.link && !now.link) { put('[', by); now.link = want.link; }
            if (want.code && !now.code) {
                if (now.b !== want.b) { put('**', by); now.b = want.b; }
                if (now.i !== want.i) { put('*', by); now.i = want.i; }
                put('`', by);
                now.code = true;
            }
        };
        chars.forEach((c) => {
            shift(c, c.by);
            if (c.v) put(c.v, c.by);
            else put(/[\\*`[\]{]/.test(c.c) ? `\\${c.c}` : c.c, c.by);
        });
        shift({ b: false, i: false, code: false, key: false, link: null }, chars.at(-1)?.by ?? 'ai');
        return fromChars(out, who);
    }
    // where a stretch of the words as they read is in the plain text: [start, end)
    function readSpan(value, start, end) {
        const { at, len } = readOf(value);
        const text = plain(value);
        if (start >= end) { const i = start > 0 ? at[start - 1] + len[start - 1] : 0; return [i, i]; }
        return [at[start] ?? text.length, end > 0 ? at[end - 1] + len[end - 1] : 0];
    }

    // a text in paragraphs: split at blank lines, each keeping its authors. Without a blank line it's one paragraph
    // where each paragraph is in the plain text: [[start, end)]. Empty ones are left out unless `empty` (an editor
    // where a new paragraph is typed into)
    function paragraphSpans(value, empty) {
        const text = plain(value);
        const spans = [];
        const gap = /\n[ \t]*\n(?:[ \t]*\n)*/g; // more blank lines too, but not the spaces a paragraph starts with
        let at = 0;
        for (let m; (m = gap.exec(text));) { spans.push([at, m.index]); at = m.index + m[0].length; }
        spans.push([at, text.length]);
        const kept = empty ? spans : spans.filter(([s, e]) => text.slice(s, e).trim());
        return spans.length > 1 && kept.length ? kept : [[0, text.length]];
    }
    const slice = (value, s, e) => fromChars(plain(value).slice(s, e), authorsByChar(value).slice(s, e));
    function paragraphsOf(value) {
        const spans = paragraphSpans(value);
        return spans.length > 1 ? spans.map(([s, e]) => slice(value, s, e)) : [value];
    }
    // `value` with plain characters start to end replaced by `part` (a value), each keeping its author
    const splice = (value, s, e, part) => fromChars(plain(value).slice(0, s) + plain(part) + plain(value).slice(e),
        [...authorsByChar(value).slice(0, s), ...authorsByChar(part), ...authorsByChar(value).slice(e)]);

    // values the page fills in: {html, data} (data: a fact, shown in the data color; otherwise it takes the color of
    // whoever wrote the {name}), or a plain string or number (a fact)
    const vars = {};
    const config = { code: 'code' };
    // while the words are edited on the page, a {name} is one block that can't be typed into
    const live = { on: false };
    // where the browser editor keeps this page's copy: its path, or the page's own name for it (Slop.start({key}))
    const pageKey = () => config.key ?? location.pathname;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const stripTags = (h) => h.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    // the class a category's words render with
    const cls = (id) => `slop-${String(id).replace(/[^\w-]/g, '_')}`;
    function lookup(name, local) {
        const v = local?.[name] ?? vars[name];
        if (v == null) { console.warn(`slop: no value for {${name}}`); return { html: esc(`{${name}}`), data: false }; }
        return typeof v === 'object' ? v : { html: esc(v), data: true };
    }

    // the text as it reads, in one string (for labels, titles and alt text)
    const readable = (value, local) => runs(value).map((run) => (run.v ? stripTags(lookup(run.v, local).html) : run.text)).join('');

    // the text as HTML: each author's words in a span (slop-ai, slop-me, slop-ok, slop-data, …), links open in a new tab
    function render(value, local) {
        const all = runs(value);
        const one = (run) => {
            let h;
            let by = run.by;
            if (run.v) {
                const v = lookup(run.v, local);
                h = v.html;
                if (v.data) by = 'data';
            } else h = esc(run.text);
            // spaces at either end of a line, or after another space, would collapse: the browser would drop one when
            // you type next to it, and the caret couldn't go after one just typed. While editing they're drawn so they don't
            if (live.on && !run.v) {
                const i = all.indexOf(run);
                const nb = (m) => '&nbsp;'.repeat(m.length);
                h = h.replace(/ +(?=\n)/g, nb).replace(/(?<=\n) +/g, nb).replace(/ {2,}/g, (m) => `${nb(m.slice(1))} `);
                if (i === all.length - 1 || all[i + 1].text?.startsWith('\n')) h = h.replace(/ +$/, nb);
                if (i === 0 || /[\n ]$/.test(all[i - 1].text ?? '')) h = h.replace(/^ +/, nb);
            }
            if (!run.v) h = h.replace(/\n/g, '<br>');
            h = `<span class="${cls(by)}"${run.v && live.on ? ' contenteditable="false" data-slop-v=""' : ''}>${h}</span>`;
            if (run.key) h = `<kbd>${h}</kbd>`;
            if (run.code) h = `<span class="${config.code}">${h}</span>`;
            if (run.i) h = `<em>${h}</em>`;
            if (run.b) h = `<strong>${h}</strong>`;
            return h;
        };
        const parts = [];
        all.forEach((run) => {
            const last = parts[parts.length - 1];
            if (!run.link) parts.push(run);
            else if (last?.link === run.link) last.runs.push(run);
            else parts.push({ link: run.link, runs: [run] });
        });
        return parts.map((part) => (part.runs
            ? `<a href="${esc(part.link.href)}" target="_blank" rel="noopener">${part.runs.map(one).join('')}</a>`
            : one(part))).join('');
    }

    // what these texts are made of, as they read: written letters (spaces and filled-in values aside) and words, by
    // category. {counts: {ai: 120, me: 30, …}, letters, words: {…}, allWords}
    function makeup(values) {
        const counts = {};
        const words = {};
        let letters = 0;
        let allWords = 0;
        values.forEach((value) => {
            runs(value).forEach((run) => {
                if (run.v) return;
                const n = run.text.replace(/\s/g, '').length;
                const w = run.text.split(/\s+/).filter(Boolean).length;
                counts[run.by] = (counts[run.by] ?? 0) + n;
                words[run.by] = (words[run.by] ?? 0) + w;
                letters += n;
                allWords += w;
            });
        });
        return { counts, letters, words, allWords };
    }

    // how much of these texts is mine (typed or approved), facts and quotes aside
    function share(values) {
        const m = makeup(values);
        const letters = m.letters - (m.counts.data ?? 0);
        const mine = (m.counts.me ?? 0) + (m.counts.ok ?? 0);
        return {
            fraction: letters ? mine / letters : 0,
            letters,
            words: (m.words.me ?? 0) + (m.words.ok ?? 0),
            allWords: m.allWords - (m.words.data ?? 0),
        };
    }

    function percent(fraction) {
        if (fraction > 0 && fraction < 0.01) return '<1%';
        if (fraction < 1 && fraction > 0.99) return '>99%';
        return `${Math.round(fraction * 100)}%`;
    }

    // repeated text: the same words in more than one place (a header that's also in the nav, a tagline in the hero
    // and the footer). Each copy keeps its own authorship, so a copy is slop until it's approved, like any text.
    // [[path, value]] → [{words, paths}], in reading order. Data-only and very short texts don't count
    const wordsOf = (value) => plain(value).replace(/\s+/g, ' ').trim();
    function repeats(list) {
        const byWords = new Map();
        list.forEach(([path, value]) => {
            const w = wordsOf(value);
            if (w.replace(/\W/g, '').length < 3 || !share([value]).letters) return;
            if (!byWords.has(w)) byWords.set(w, []);
            byWords.get(w).push(path);
        });
        return [...byWords].filter(([, paths]) => paths.length > 1).map(([words, paths]) => ({ words, paths }));
    }

    // a copy of the block saved in the browser, carried over to a page the author has changed since: text by text,
    // the copy's value stays where the page's is still the one the copy was based on, and the page's wins where the
    // author changed, added or removed it. Groups (and _categories) merge key by key; what the copy added keeps its
    // place after the key it followed
    function rebase(base, mine, page) {
        const group = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        if (!group(base) || !group(mine) || !group(page)) return JSON.stringify(page) === JSON.stringify(base) ? mine : page;
        const keys = Object.keys(page);
        Object.keys(mine).forEach((k, i, order) => {
            if (keys.includes(k)) return;
            const after = order.slice(0, i).reverse().find((x) => keys.includes(x));
            keys.splice(after === undefined ? 0 : keys.indexOf(after) + 1, 0, k);
        });
        const out = {};
        keys.forEach((k) => {
            const v = rebase(base[k], mine[k], page[k]);
            if (v !== undefined) out[k] = v;
        });
        return out;
    }

    // a group's paragraphs (keys p1, p2…) are a list without marking when the page has two or more of them in
    // elements that share one parent and are alike: the same tag and the same other attributes, so steps told apart by
    // an attribute (data-b="0", "1"…) aren't one. [{path, parent, tag, attrs}] → Map group → parent
    const isParagraph = (key) => /^p\d+$/.test(key);
    function listsIn(items) {
        const byGroup = new Map();
        items.forEach((x) => {
            const keys = x.path.split('.');
            if (keys.length < 2 || !isParagraph(keys.at(-1))) return;
            const g = keys.slice(0, -1).join('.');
            if (!byGroup.has(g)) byGroup.set(g, []);
            byGroup.get(g).push(x);
        });
        const look = (x) => `${x.tag}\n${JSON.stringify(Object.entries(x.attrs ?? {}).sort())}`;
        const out = new Map();
        byGroup.forEach((xs, g) => {
            const [a] = xs;
            if (xs.length < 2 || a.parent == null || new Set(xs.map((x) => x.path)).size < xs.length) return;
            if (xs.every((x) => x.parent === a.parent && look(x) === look(a))) out.set(g, a.parent);
        });
        return out;
    }

    const core = { BUILTIN, plain, applyEdit, readOf, editRead, readSpan, restyle, paragraphSpans, splice, reslop, unslop, assign, overlay, reattribute, runs, readable, render, makeup, share, percent, repeats, rebase, listsIn, wordsOf, paragraphsOf, vars };
    if (typeof document === 'undefined') return core; // Node (the CLI and the tests) only needs the format

    /* ---------- the block ---------- */

    let text = { version: 0 };
    try {
        text = JSON.parse(document.getElementById('slop-text').textContent);
    } catch (e) {
        console.error('slop: the slop-text block is missing or not valid JSON', e);
    }
    const original = JSON.stringify(text);
    const isText = (v) => typeof v === 'string' || Array.isArray(v);
    const isMeta = (key) => key === 'version' || key.startsWith('_');
    const keysOf = (path) => (Array.isArray(path) ? path : path.split('.'));
    const dotted = (path) => keysOf(path).join('.');
    function get(path) {
        let node = text;
        for (const key of keysOf(path)) node = node?.[key];
        if (!isText(node)) { console.warn(`slop: no text at ${dotted(path)}`); return ''; }
        return node;
    }
    const nodeAt = (root, path) => keysOf(path).reduce((node, key) => node?.[key], root);
    // the keys of a group's texts, in order
    const textKeys = (node) => (node && typeof node === 'object' && !isText(node) ? Object.keys(node).filter((k) => isText(node[k])) : []);
    function set(path, value) {
        const keys = keysOf(path);
        let node = text;
        keys.slice(0, -1).forEach((key) => { node[key] ??= {}; node = node[key]; });
        node[keys[keys.length - 1]] = value;
    }
    // every text in a group (or the whole block), in reading order: [[path, value]] with dotted paths
    function entries(node = text, at = []) {
        return Object.entries(node).flatMap(([key, v]) => {
            if (!at.length && isMeta(key)) return [];
            if (isText(v)) return [[[...at, key].join('.'), v]];
            return v && typeof v === 'object' ? entries(v, [...at, key]) : [];
        });
    }
    const groupKeys = () => Object.keys(text).filter((k) => !isMeta(k) && text[k] && (isText(text[k]) || typeof text[k] === 'object'));
    // the texts an element holds in its attributes, from data-slop-attr="alt:hero.photo title:hero.tip": [[name, path]]
    const attrsOf = (x) => (x.dataset.slopAttr ?? '').split(/\s+/).map((s) => [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)]).filter(([n, p]) => n && p);
    // the elements that show a text: [data-slop] ones, which fill() writes, [data-slop-ref] ones, which the page writes
    // itself (words inside a button or a link it builds) but the editor can still find, [data-slop-more] ones (the
    // paragraphs after a blank line) and [data-slop-attr] ones
    const elementsOf = (path) => {
        const at = dotted(path);
        const q = CSS.escape(at);
        return [...document.querySelectorAll(`[data-slop="${q}"], [data-slop-ref="${q}"], [data-slop-more="${q}"], [data-slop-attr*=":${q}"]`)]
            .filter((x) => x.dataset.slop === at || x.dataset.slopRef === at || x.dataset.slopMore === at || attrsOf(x).some(([, p]) => p === at));
    };
    const pathOf = (x) => x.dataset.slop || x.dataset.slopRef || x.dataset.slopMore || attrsOf(x)[0]?.[1];
    // a text the page has but doesn't show as words (alt text, a tooltip, a label): the attribute it's in, or ''
    function attrOf(path) {
        const at = dotted(path);
        for (const x of document.querySelectorAll('[data-slop-attr]')) {
            const hit = attrsOf(x).find(([, p]) => p === at);
            if (hit) return hit[0];
        }
        return '';
    }

    // texts the page's code has rendered (Slop.html, Slop.words): with the [data-slop] elements, what's on the page
    const rendered = new Set();
    const html = (path, local) => { rendered.add(dotted(path)); return render(get(path), local); };
    const words = (path, local) => { rendered.add(dotted(path)); return readable(get(path), local); };
    // the text as HTML, one string per paragraph, for code that draws a <p> for each
    const paragraphs = (path, local) => { rendered.add(dotted(path)); return paragraphsOf(get(path)).map((v) => render(v, local)); };
    const onPage = (path) => rendered.has(dotted(path)) || elementsOf(path).length > 0;
    // how to show a text the page shows only some of the time: Slop.reveal(path, fn), where fn puts the page in a state
    // that shows it and returns a function that undoes that. A group's key covers all its texts
    const revealers = new Map();
    const reveal = (path, fn) => { revealers.set(dotted(path), fn); };
    const revealerOf = (path) => revealers.get(dotted(path)) ?? revealers.get(keysOf(path)[0]);
    // fill every [data-slop] element (data-slop-vars: a JSON object of extra values)
    // fill an element: its words from data-slop, its attributes from data-slop-attr (as plain text)
    // a <p>, <li> or <dd> shows a text's first paragraph, and a copy of it after it shows each of the others. An
    // element whose text is empty gets .slop-empty, which hides it
    const SPLITS = /^(P|LI|DD)$/;
    const spills = new WeakMap(); // element → the copies after it
    const ownerOf = new WeakMap(); // copy → its element
    // what the browser gives back as an element's innerHTML once it's set to h (a " in the words comes back bare, not
    // as &quot;): compared with that, an element that already shows its text isn't written again, and keeps the caret
    let shape = null;
    const asSet = (h) => { shape ??= document.createElement('template'); shape.innerHTML = h; return shape.innerHTML; };
    function fillOne(el) {
        const local = el.dataset.slopVars ? JSON.parse(el.dataset.slopVars) : undefined;
        if (el.dataset.slop) {
            const value = get(el.dataset.slop);
            const parts = !SPLITS.test(el.tagName) ? [value] : live.on ? paragraphSpans(value, true).map(([s, e]) => slice(value, s, e)) : paragraphsOf(value);
            const h = render(parts[0], local);
            if (el.innerHTML !== asSet(h)) el.innerHTML = h;
            el.classList.toggle('slop-empty', !plain(value).trim());
            spill(el, parts.slice(1).map((v) => render(v, local)));
        }
        attrsOf(el).forEach(([name, path]) => {
            const v = readable(get(path), local);
            if (el.getAttribute(name) !== v) el.setAttribute(name, v);
        });
    }
    function spill(el, htmls) {
        const copies = spills.get(el) ?? [];
        while (copies.length > htmls.length) copies.pop().remove();
        htmls.forEach((h, i) => {
            let c = copies[i];
            if (!c) {
                c = el.cloneNode(false);
                ['id', 'data-slop', 'data-slop-attr', 'contenteditable'].forEach((a) => c.removeAttribute(a));
                c.classList.remove('slop-focus', 'slop-copy', 'slop-empty');
                ownerOf.set(c, el);
                copies.push(c);
            }
            c.dataset.slopMore = el.dataset.slop;
            if (c.innerHTML !== asSet(h)) c.innerHTML = h;
            const before = i ? copies[i - 1] : el;
            if (before.nextElementSibling !== c) before.after(c);
        });
        if (copies.length) spills.set(el, copies); else spills.delete(el);
    }
    // a list: an element with data-slop-list="group" shows the group's paragraphs (p1, p2, …), in order, each in a copy
    // of the first. The group's other texts (a title, a caption) and the element's other children stay where they
    // are. (With data-slop-list-ref, the page draws them itself.) Either way, the editor can add and remove paragraphs
    const templates = new WeakMap(); // list → the element its paragraphs are copies of
    // lists the page didn't mark (listsIn): [data-slop] elements, filled here, not drawn by the page's code. Its
    // paragraphs that aren't on the page yet are drawn after the others, as in a marked list. Once found, a list stays
    // one while its element is on the page. data-slop-list="off" on the parent opts out
    const autos = new Map(); // parent → group
    const marked = (x) => (x.dataset.slopList && x.dataset.slopList !== 'off' ? x.dataset.slopList : '');
    const listOf = (box) => marked(box) || autos.get(box);
    // an element's attributes but data-slop and the classes slop.js adds
    const own = (x) => Object.fromEntries([...x.attributes].filter((a) => a.name !== 'data-slop')
        .map((a) => [a.name, a.name === 'class' ? [...x.classList].filter((c) => !c.startsWith('slop-')).sort().join(' ') : a.value])
        .filter(([name, v]) => name !== 'class' || v));
    function findLists() {
        autos.forEach((g, box) => { if (!box.isConnected) autos.delete(box); });
        const taken = new Set([...document.querySelectorAll('[data-slop-list], [data-slop-list-ref]')].map((x) => marked(x) || x.dataset.slopListRef).filter(Boolean));
        autos.forEach((g) => taken.add(g));
        const els = [...document.querySelectorAll('[data-slop]')].filter((x) => !x.closest('.slop-panel'));
        listsIn(els.map((x) => ({ path: x.dataset.slop, parent: x.parentElement, tag: x.tagName, attrs: own(x) }))).forEach((box, g) => {
            if (taken.has(g) || box.dataset.slopList === 'off' || autos.has(box)) return;
            // the page's code shows one of them some other way: not a list of ours
            const paths = textKeys(nodeAt(text, g)).filter(isParagraph).map((k) => `${g}.${k}`);
            if (paths.some((p) => rendered.has(p) || revealers.has(p) || elementsOf(p).some((x) => !x.dataset.slop && !x.dataset.slopMore))) return;
            autos.set(box, g);
        });
    }
    function fillList(box) {
        const at = listOf(box);
        if (!at) return;
        const ours = (x) => x.dataset.slop?.startsWith(`${at}.`) && isParagraph(x.dataset.slop.slice(at.length + 1));
        if (!templates.has(box)) {
            const first = [...box.children].find(ours);
            if (!first) return;
            const t = first.cloneNode(false);
            ['id', 'data-slop', 'contenteditable'].forEach((a) => t.removeAttribute(a));
            templates.set(box, t);
        }
        const paths = textKeys(nodeAt(text, at)).filter(isParagraph).map((k) => `${at}.${k}`);
        const have = new Map([...box.children].filter(ours).map((x) => [x.dataset.slop, x]));
        have.forEach((x, p) => { if (!paths.includes(p)) { spill(x, []); x.remove(); } });
        // a new one goes after the paragraph before it (and the paragraphs that one spilled into), or else before the
        // one after it
        const shown = (p) => [...box.children].find((x) => x.dataset.slop === p);
        paths.forEach((p, i) => {
            if (have.has(p)) return;
            const x = templates.get(box).cloneNode(false);
            x.dataset.slop = p;
            const before = paths.slice(0, i).reverse().map(shown).find(Boolean);
            const after = paths.slice(i + 1).map(shown).find(Boolean);
            if (before) (spills.get(before)?.at(-1) ?? before).after(x);
            else if (after) after.before(x);
            else box.append(x);
        });
    }
    const fill = (root = document) => {
        if (root === document || root.matches?.('[data-slop]') || root.querySelector?.('[data-slop]')) findLists();
        root.querySelectorAll('[data-slop-list]').forEach(fillList);
        autos.forEach((g, box) => { if (root.contains(box) && !marked(box)) fillList(box); });
        root.querySelectorAll('[data-slop], [data-slop-attr]').forEach(fillOne);
        // paragraphs whose element the page took away, or no longer shows that text in
        root.querySelectorAll('[data-slop-more]').forEach((c) => {
            const el = ownerOf.get(c);
            if (!el?.isConnected || el.dataset.slop !== c.dataset.slopMore) c.remove();
        });
    };
    // the editor's "not on the page" tags, checked again once the page has drawn what changed (a text just added or
    // restored has no element until then, and a single-page app draws later still)
    let reseen = () => {};
    let seenPending = false;
    const seenSoon = () => {
        if (seenPending) return;
        seenPending = true;
        requestAnimationFrame(() => { seenPending = false; reseen(); });
    };
    // the [data-slop] elements and meters in what the page added after start (a single-page app draws late)
    function added(n) {
        if (n.nodeType !== 1 || n.closest('.slop-panel, .slop-sampler')) return;
        seenSoon();
        if (n.matches('[data-slop-list]')) fillList(n);
        if (n.matches('[data-slop], [data-slop-attr]')) fillOne(n);
        fill(n);
        if (n.matches('[data-slop-meter]')) meter(n);
        n.querySelectorAll('[data-slop-meter]').forEach(meter);
    }

    const listeners = [];
    // returns a function that stops calling fn
    const onChange = (fn) => {
        listeners.push(fn);
        return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    };
    let pending = false;
    function changed() { // after an edit: refill the page, then let the page redo whatever it built from the text
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            fill();
            listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
            paintMeters();
            seenSoon();
        });
    }

    /* ---------- categories and their colors ---------- */

    let dark = false;
    const ink = () => getComputedStyle(document.body).color;
    // any CSS color as #rrggbb, for the color pickers
    const hex = (color) => {
        const x = document.createElement('canvas').getContext('2d');
        x.fillStyle = '#000';
        x.fillStyle = color;
        const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(x.fillStyle);
        return m ? `#${m.slice(1, 4).map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('')}` : x.fillStyle;
    };
    // a category's color: the page's choice (in the block, or --slop-<id> in its CSS), or the default for the theme.
    // null for my words, unless picked: they keep the page's color
    function colorOf(id, n) {
        const own = text._categories?.[id]?.color;
        if (own && CSS.supports('color', own)) return own;
        const css = getComputedStyle(document.documentElement).getPropertyValue(`--slop-${id}`).trim();
        if (css) return css;
        if (BUILTIN[id]) return BUILTIN[id][dark ? 'dark' : 'light'];
        return PALETTE[n % PALETTE.length];
    }
    // every category, in the order they're shown: mine, approved, the page's own, data, slop
    function categories() {
        const own = text._categories ?? {};
        const used = entries().flatMap(([, v]) => (typeof v === 'string' ? [] : v.map(authorOf)));
        const custom = [...new Set([...Object.keys(own), ...used])].filter((id) => !(id in BUILTIN));
        return ['me', 'ok', ...custom, 'data', 'ai'].map((id) => ({
            id,
            label: own[id]?.label || BUILTIN[id]?.label || id,
            color: colorOf(id, custom.indexOf(id)),
            builtin: id in BUILTIN,
        }));
    }
    const swatch = (cat) => cat.color ?? ink();

    // the colors go in a stylesheet of their own: each category's words inside a .slop-on (the page, while the
    // Slop-o-meter is on, or a section whose own switch is) but not inside a .slop-off (a section switched off), and
    // --slop-c-<id> for anything else that wants them. Inside a [data-slop-only="<id>"] (a meter's tag is pointed at),
    // everyone else's words are dimmed. :where keeps these as easy to override as html.slop-on .slop-<id> was
    let sheet = null;
    function applyColors() {
        sheet ??= document.head.appendChild(Object.assign(document.createElement('style'), { id: 'slop-colors' }));
        const all = categories();
        const cats = all.filter((c) => c.color);
        sheet.textContent = `:root{${cats.map((c) => `--${cls(c.id).replace('slop-', 'slop-c-')}:${c.color}`).join(';')}}\n`
            + cats.map((c) => `:where(.slop-on) .${cls(c.id)}:not(:where(.slop-off) .${cls(c.id)}){color:${c.color}}`).join('\n')
            + `\n${all.map((c) => `[data-slop-only]:not([data-slop-only="${CSS.escape(c.id)}"]) .${cls(c.id)}{opacity:.3}`).join('\n')}`;
    }

    // a pie of what these texts are made of, and the same in words for its tooltip
    function gradient(m, cats) {
        if (!m.letters) return '';
        let at = 0;
        const stops = cats.filter((c) => m.counts[c.id]).map((c) => {
            const from = at;
            at += (m.counts[c.id] / m.letters) * 100;
            return `${swatch(c)} ${from.toFixed(2)}% ${at.toFixed(2)}%`;
        });
        return `conic-gradient(${stops.join(', ')})`;
    }
    const breakdown = (m, cats) => (m.letters ? cats.filter((c) => m.counts[c.id]).map((c) => `${c.label} ${percent(m.counts[c.id] / m.letters)}`).join(' · ') : 'No text');

    /* ---------- colors follow the page: dark or light, whatever the system says ---------- */

    function background(el) {
        for (; el; el = el.parentElement) {
            const m = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?/.exec(getComputedStyle(el).backgroundColor);
            if (m && (m[4] === undefined || parseFloat(m[4]) > 0)) return m.slice(1, 4).map(Number);
        }
        return null;
    }
    let repaint = () => {};
    function theme(force) {
        const rgb = background(document.body);
        const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        const now = rgb ? 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]) < 0.2
            : matchMedia('(prefers-color-scheme: dark)').matches;
        if (now === dark && force !== true) return;
        dark = now;
        document.documentElement.classList.toggle('slop-dark', dark);
        applyColors();
        paintMeters();
        repaint();
    }

    /* ---------- Slop-o-meter: a switch, a pie of what the page is made of, and what its colors mean ---------- */

    const storage = (area) => ({
        get: (k) => { try { return area().getItem(k); } catch { return null; } },
        set: (k, v) => { try { area().setItem(k, v); return true; } catch { return false; } },
        drop: (k) => { try { area().removeItem(k); } catch { /* optional */ } },
    });
    const store = storage(() => localStorage);
    const session = storage(() => sessionStorage); // this tab only: the unsaved draft
    // what readers see is the page's choice, "nothing" unless it says otherwise. While the editor is open, its
    // author sees the colors whatever readers get, until they switch them off to compare (editColors)
    const SHOW = ['nothing', 'pie', 'colors'];
    const shows = () => (SHOW.includes(text._show) ? text._show : 'nothing');
    const meters = [];
    const built = new WeakMap(); // element → its meter
    let meterOn = false;
    let editing = false;
    let editColors = true;
    let editSwitch = null; // the editor's own Slop-o-meter switch, in its header
    function setMeter(on) {
        meterOn = on;
        paintShow();
    }
    // a meter with a path (data-slop-meter="games.othello") measures the texts under it, and its switch colors only
    // its section: the closest [data-slop-section], or its parent. A bare one measures the page and switches it
    const inScope = (at) => ([path]) => !at || path === at || path.startsWith(`${at}.`);
    const sectionOf = (m) => (m.at && m.el.parentElement ? m.el.closest('[data-slop-section]') ?? m.el.parentElement : document.documentElement);
    function paintShow() {
        const mode = shows();
        document.documentElement.classList.toggle('slop-on', editing ? editColors : mode === 'colors' && meterOn);
        editSwitch?.setAttribute('aria-checked', String(editColors));
        meters.forEach((m) => {
            m.el.dataset.show = mode;
            const section = sectionOf(m);
            if (m.section && m.section !== section) m.section.classList.remove('slop-on', 'slop-off');
            m.section = section;
            // a section's switch follows the page's until it's flipped. The editor shows the author every color
            if (m.at) {
                const own = mode === 'colors' && !editing ? m.own : null;
                section.classList.toggle('slop-on', own === true);
                section.classList.toggle('slop-off', own === false);
            }
            m.btn.setAttribute('aria-pressed', String(editing ? editColors : m.own ?? meterOn));
        });
    }
    function paintMeters() {
        // a meter the page took out of the document is dropped; it comes back if the page puts it back
        meters.splice(0, meters.length, ...meters.filter((m) => m.el.isConnected));
        paintShow();
        if (!meters.length) return;
        const cats = categories();
        const all = entries();
        const byScope = new Map();
        meters.forEach(({ at, pie, legend }) => {
            if (!byScope.has(at)) byScope.set(at, makeup(all.filter(inScope(at)).map(([, v]) => v)));
            const m = byScope.get(at);
            pie.style.background = gradient(m, cats);
            pie.title = breakdown(m, cats);
            pie.setAttribute('aria-label', pie.title);
            // each category in its own color, with its share of the text
            legend.innerHTML = cats.filter((c) => m.counts[c.id]).sort((a, b) => m.counts[b.id] - m.counts[a.id])
                .map((c) => `<span class="slop-key" tabindex="0" data-id="${esc(c.id)}" style="color:${swatch(c)}"><i style="background:${swatch(c)}"></i>${esc(c.label)}<b class="slop-pct">${percent(m.counts[c.id] / m.letters)}</b></span>`).join('');
        });
    }
    function buildMeter(el) {
        el.classList.add('slop-meter');
        el.innerHTML = '<button type="button" class="slop-meter-btn" aria-pressed="false"><span class="slop-switch" aria-hidden="true"></span>Slop-o-meter</button>'
            + '<span class="slop-meter-key"><span class="slop-pie" role="img"></span><span class="slop-legend"></span></span>';
        const m = { el, at: el.dataset.slopMeter || '', own: null, section: null, btn: el.querySelector('button'), pie: el.querySelector('.slop-pie'), legend: el.querySelector('.slop-legend') };
        m.btn.addEventListener('click', () => {
            if (editing) { editColors = !editColors; paintShow(); return; } // the editor's switch, while it's open
            const on = !(m.own ?? meterOn);
            if (m.at) { m.own = on; paintShow(); return; } // only the page-wide choice is remembered
            setMeter(on);
            store.set('slop-o-meter', on ? 'on' : 'off');
        });
        // pointing at a tag dims everyone else's words, in the meter's section
        const only = (e) => {
            const key = e.type === 'mouseover' || e.type === 'focusin' ? e.target.closest('.slop-key') : null;
            const section = m.section ?? sectionOf(m);
            if (key) section.dataset.slopOnly = key.dataset.id;
            else delete section.dataset.slopOnly;
        };
        ['mouseover', 'mouseout', 'focusin', 'focusout'].forEach((type) => m.legend.addEventListener(type, only));
        built.set(el, m);
        return m;
    }
    // build a meter (or take back one the page moved), and paint it
    function meter(el) {
        const m = built.get(el) ?? buildMeter(el);
        if (!meters.includes(m)) meters.push(m);
        paintMeters();
    }

    /* ---------- the editor ---------- */

    const human = (key) => {
        const p = /^p(\d+)$/.exec(key);
        if (p) return `Paragraph ${p[1]}`;
        const s = key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
        return s.charAt(0).toUpperCase() + s.slice(1);
    };
    // a section is named after its title, if it has a short one, or its key
    const groupTitle = (key) => {
        const node = text[key];
        const title = node && !isText(node) && isText(node.title) ? readable(node.title) : '';
        return title && title.length <= 32 ? title : human(key);
    };
    // the groups the page shows as lists, where the editor can add and remove texts
    const listed = () => new Set([...document.querySelectorAll('[data-slop-list], [data-slop-list-ref]')].map((x) => marked(x) || x.dataset.slopListRef).filter(Boolean)
        .concat([...autos].filter(([box]) => box.isConnected).map(([, g]) => g)));
    // keys[i], for people. In a list, a paragraph is named by where it is: "Paragraph 3", even when its key is p7
    function keyName(keys, i) {
        const group = keys.slice(0, i).join('.');
        if (!isParagraph(keys[i]) || !listed().has(group)) return human(keys[i]);
        return `Paragraph ${textKeys(nodeAt(text, group)).filter(isParagraph).indexOf(keys[i]) + 1}`;
    }
    // where a text is, for people: "Introduction · Paragraph 2"
    const where = (path) => {
        const keys = keysOf(path);
        return [groupTitle(keys[0]), ...keys.slice(1).map((k, i) => keyName(keys, i + 1))].join(' · ');
    };
    const count = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
    const isLong = (path, value) => plain(value).length > 48 || /^p\d+$/.test(keysOf(path).at(-1));
    const el = (tag, className, html = '') => Object.assign(document.createElement(tag), { className, innerHTML: html });

    // what a hidden text is, by the attribute it's in
    const KINDS = { alt: 'alt text', title: 'tooltip', 'aria-label': 'label', 'aria-description': 'description', placeholder: 'placeholder' };

    // the editor opens on repeated text that still has slop, or on any text that does, or on everything
    const slopIn = (path) => (makeup([get(path)]).counts.ai ?? 0) > 0;
    const startTab = () => (repeats(entries()).some((s) => s.paths.some(slopIn)) ? 'repeats' : entries().some(([p]) => slopIn(p)) ? 'slop' : 'all');

    function editor(mode) {
        const LOCAL = `slop-text:${pageKey()}`;
        // open: the first section, and any the page adds later (pasted text, say)
        // it opens on Repeats, or on Slop left when nothing is repeated
        const state = { tab: startTab(), open: new Set(groupKeys().slice(0, 1)), known: new Set(groupKeys()), focus: null };
        let sets = repeats(entries());
        let controls = []; // [{el, paths}] in the current view, repainted by numbers()

        const aside = el('aside', 'slop-panel', `
          <header class="sp-head" title="Drag to move, or drag an edge to resize. Double-click to put it back">
            <span class="sp-grip" aria-hidden="true"></span>
            <div><h2>Edit text</h2><p class="sp-status" role="status" aria-live="polite"></p></div>
            <button type="button" class="sp-mode"></button>
            <button type="button" class="sp-colors" role="switch" title="Slop-o-meter: color the page's words by who wrote them. Only for you, while you edit"><span class="sp-switch" aria-hidden="true"></span>Colors</button>
            <button type="button" class="sp-save" title="Save (⌘S)" disabled>Saved</button>
          </header>
          <div class="sp-cover">
            <div class="sp-cats"></div>
            <div class="sp-show"><span>Readers see</span><div class="sp-seg" role="radiogroup" aria-label="What readers see">
              <button type="button" role="radio" data-show="nothing" title="No sign of the slop editor on the published page">Nothing</button>
              <button type="button" role="radio" data-show="pie" title="A pie of who wrote what, with a legend">Pie chart</button>
              <button type="button" role="radio" data-show="colors" title="The Slop-o-meter: a switch that colors every word by who wrote it, and the pie">Colors</button>
            </div></div>
          </div>
          <div class="sp-tabs" role="tablist">
            <button type="button" role="tab" data-tab="repeats">Repeats <span></span></button>
            <button type="button" role="tab" data-tab="slop">Slop left <span></span></button>
            <button type="button" role="tab" data-tab="all">All <span></span></button>
            <button type="button" role="tab" data-tab="hidden" title="Words the page has but doesn't show: alt text, tooltips, labels">Hidden <span></span></button>
          </div>
          <div class="sp-body" role="tabpanel"></div>
          ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((e) => `<div class="sp-edge" data-edge="${e}" aria-hidden="true"></div>`).join('')}`);
        aside.hidden = true;
        aside.setAttribute('aria-label', 'Edit text');
        document.body.append(aside);
        const $ = (sel) => aside.querySelector(sel);
        const body = $('.sp-body');
        const statusEl = $('.sp-status');
        aside.classList.add('slop-on'); // the text boxes keep their colors when the page's are off
        const modeBtn = $('.sp-mode');
        editSwitch = $('.sp-colors');
        editSwitch.addEventListener('click', () => { editColors = !editColors; paintShow(); });

        function status(msg, kind = '', action) {
            statusEl.textContent = msg;
            statusEl.dataset.kind = kind;
            if (!action) return;
            const b = el('button', 'sp-link', esc(action.label));
            b.type = 'button';
            b.addEventListener('click', action.run);
            statusEl.append(' · ', b);
        }
        const savedStatus = () => (mode === 'local'
            ? status('Saved in this browser', '', { label: 'Reset', run: reset })
            : status(`Saved · version ${text.version}`));

        /* one history for every change to the words or who wrote them: typing (on the page or in a box), a switch, a
           mark, a revert, a category deleted. ⌘Z undoes the last step wherever the focus is, and ⌘⇧Z does it again. A
           step keeps only the top-level keys it changed, before and after, so undoing it leaves the rest as it is now */
        const undos = []; // [{what, at, typing, typed, order: [keys before, after], keys: {key: [JSON before, after]}}]
        const redos = [];
        let noted = false; // the status line names the last step, with its Undo or Redo
        let lastPush = 0;
        const snap = () => Object.fromEntries(Object.keys(text).filter((k) => k !== 'version').map((k) => [k, JSON.stringify(text[k])]));
        // `at`: the text it was made in, to put the focus back ({path, where: 'page' or 'panel', owner, sel}); `typing`:
        // keystrokes of one kind in one text join the step before them; `typed`: only words changed, nothing to redraw
        function track(change, { what = '', at = null, typing = '', typed = false } = {}) {
            const a = snap();
            change();
            const b = snap();
            const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
            if (!keys.length) return false;
            const now = performance.now();
            const top = undos.at(-1);
            if (typing && !redos.length && top?.typing === typing && top.at?.path === at?.path && now - lastPush < 800) {
                keys.forEach((k) => { if (k in top.keys) top.keys[k][1] = b[k]; else top.keys[k] = [a[k], b[k]]; });
                top.order[1] = Object.keys(b);
            } else {
                undos.push({ what, at, typing, typed, order: [Object.keys(a), Object.keys(b)], keys: Object.fromEntries(keys.map((k) => [k, [a[k], b[k]]])) });
                if (undos.length > 300) undos.shift();
            }
            lastPush = now;
            redos.length = 0;
            return true;
        }
        function note(what, undone) {
            noted = true;
            status(undone ? `Undone: ${what}` : what, '', undone ? { label: 'Redo', run: () => step(false) } : { label: 'Undo', run: () => step(true) });
        }
        // a change made with a button (a switch, a mark, a revert, deleting a category), named in the status line
        function withUndo(what, change, at = null) {
            if (!track(change, { what, at })) return false;
            touched();
            if (state.tab === 'slop') render(); else numbers();
            // a mark: the page shows it now, not a frame later, and its words stay selected to mark again
            if (at) { fill(); liven(); putBack(at); }
            note(what, false);
            return true;
        }
        // undo (back) or redo the last step, and put the focus back where it was made
        function step(back) {
            const u = (back ? undos : redos).pop();
            if (!u) return false;
            (back ? redos : undos).push(u);
            lastPush = 0;
            const i = back ? 0 : 1;
            const was = u.at ? valueAt(text, u.at.path) : undefined;
            // the focus stays in a text a step made elsewhere passes over
            const a = document.activeElement;
            const kept = liveOf(a) ? { x: a, sel: selIn(a) } : a?.tagName === 'TEXTAREA' && body.contains(a) ? { path: a.closest('.sp-field')?.dataset.path, sel: [a.selectionStart, a.selectionEnd] } : null;
            const next = { version: text.version };
            const order = u.order[i];
            [...order, ...Object.keys(text).filter((k) => !order.includes(k))].forEach((k) => {
                if (k === 'version') return;
                const v = k in u.keys ? u.keys[k][i] : JSON.stringify(text[k]);
                if (v !== undefined) next[k] = JSON.parse(v);
            });
            text = next;
            noted = false;
            if ('_categories' in u.keys) applyColors();
            fill(); // now, so the caret put back below isn't lost to the next frame's fill
            liven();
            if (u.typed) body.querySelectorAll('.sp-field').forEach((f) => { if (f.input) { f.input.value = plain(valueAt(text, f.dataset.path) ?? ''); grow(f.input); } });
            touched();
            if (!u.typed) render();
            if (u.at) putBack(u.at, was);
            else if (kept?.x?.isConnected) {
                kept.x.focus({ preventScroll: true });
                const n = domWords(kept.x).length;
                if (kept.sel) caret(kept.x, Math.min(kept.sel[0], n), Math.min(kept.sel[1], n));
            } else if (kept?.path) {
                const box = boxOf(kept.path)?.input;
                box?.focus({ preventScroll: true });
                box?.setSelectionRange(...kept.sel);
            }
            if (u.what) note(u.what, back);
            return true;
        }
        const boxOf = (path) => [...body.querySelectorAll('.sp-field')].find((f) => f.paths().includes(path));
        // the caret back in the text a step was made in: on the selection it was made on, or after what came back
        function putBack({ path, where, owner, sel }, was) {
            const value = valueAt(text, path);
            if (value === undefined) return;
            let [s, e] = sel ?? [];
            if (!sel) {
                const x = plain(was ?? '');
                const y = plain(value);
                let pre = 0;
                let end = 0;
                while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
                while (end < x.length - pre && end < y.length - pre && x[x.length - 1 - end] === y[y.length - 1 - end]) end++;
                s = e = y.length - end;
            }
            const box = !inPlace && boxOf(path)?.input;
            const x = owner?.isConnected ? owner : elementsOf(path).find((y) => y.dataset.slop && y.isContentEditable);
            if (box && (where === 'panel' || !x)) {
                box.focus();
                box.setSelectionRange(s, e);
                return;
            }
            if (!x) return;
            // on the page: the paragraph it's in, and how far into its words
            const spans = SPLITS.test(x.tagName) ? paragraphSpans(value, true) : [[0, plain(value).length]];
            const j = Math.max(0, spans.findIndex(([, b]) => s <= b));
            const y = shownAt(x, j) ?? x;
            const { at } = readOf(value);
            const k = (n) => at.filter((m) => m >= spans[j][0] && m < Math.min(n, spans[j][1])).length;
            if (document.activeElement !== y) y.focus();
            caret(y, k(s), k(e));
            paintFloat();
        }

        /* the slop switch, next to a pie of what the texts are made of. A text's or section's row takes the pie out, to
           sit by its name, and puts the switch at the end (c.pie, c.toggle). Switched back on, a switch takes back only
           what it approved, where the words are still as it left them, so what was approved before stays approved; with
           none of that left, it makes every approved word slop again. `id` names the switch, `what` (a string or a
           function) the texts, and `scope` (a function) says in its tooltip what it covers */
        const approvals = new Map(); // path → {by, was, now}: the last switch that approved it, and the text before and after
        function control(paths, what, { after, id = what, scope } = {}) {
            const c = el('span', 'sp-ctl', '<span class="sp-pie" role="img"></span>'
                + '<button type="button" class="sp-toggle" role="switch"><span class="sp-switch" aria-hidden="true"></span>slop</button>');
            const toggle = c.querySelector('.sp-toggle');
            toggle.addEventListener('click', (e) => {
                e.preventDefault(); // in a section's summary, don't open or close it
                const on = toggle.getAttribute('aria-checked') === 'true';
                const ps = paths();
                const name = typeof what === 'function' ? what() : what;
                const mine = on ? [] : ps.filter((p) => approvals.get(p)?.by === id && approvals.get(p).now === JSON.stringify(get(p)));
                const done = withUndo(on ? `Approved ${name}` : `Back to slop: ${name}`, () => ps.forEach((p) => {
                    const was = get(p);
                    if (on) {
                        set(p, unslop(was));
                        if (JSON.stringify(get(p)) !== JSON.stringify(was)) approvals.set(p, { by: id, was, now: JSON.stringify(get(p)) });
                    } else if (!mine.length) set(p, reslop(was));
                    else if (mine.includes(p)) set(p, approvals.get(p).was);
                }));
                if (done) after?.(on);
            });
            c.pie = c.querySelector('.sp-pie');
            c.toggle = toggle;
            c.paths = paths;
            c.scope = scope;
            controls.push({ el: c, paths });
            return c;
        }
        function paintControl({ el: c, paths }, cats) {
            const m = makeup(paths().map((p) => valueAt(text, p) ?? '')); // a text just taken out is painted once more
            const { pie } = c;
            pie.style.background = gradient(m, cats);
            pie.title = breakdown(m, cats);
            pie.setAttribute('aria-label', pie.title);
            const { toggle } = c;
            const on = (m.counts.ai ?? 0) > 0;
            toggle.setAttribute('aria-checked', String(on));
            toggle.disabled = !on && !m.counts.ok;
            toggle.title = (c.scope ? `${c.scope()}: ` : '') + (on ? 'Slop. Switch it off to approve the AI\'s words as they are'
                : m.counts.ok ? 'Approved. Switch it on to make it slop again' : 'No AI-generated words here');
        }

        /* categories: a color picker and a name for each, and how much of the page is theirs */
        const own = (id) => { text._categories ??= {}; return (text._categories[id] ??= {}); };
        const slug = (label) => {
            const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
            let id = base;
            for (let n = 2; id in BUILTIN || text._categories?.[id] || categories().some((c) => c.id === id); n++) id = `${base}-${n}`;
            return id;
        };
        // the categories, the one with most of the page first (as the meters' legends). A category of the page's own
        // can say whose words it means and ask an agent to find them (about, find); what an agent marked waits for
        // Keep or Undo (found.before)
        function renderCats() {
            closePicker();
            const box = $('.sp-cats');
            box.innerHTML = '';
            const counts = makeup(entries().map(([, v]) => v)).counts;
            categories().sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0)).forEach((cat) => {
                const row = el('span', 'sp-cat', `<button type="button" class="sp-swatch" title="Click to pick a color for ${esc(cat.label)}, or drag onto the page to take one from it" aria-label="Pick a color for ${esc(cat.label)}"></button>`
                    + `<input class="sp-cat-name" aria-label="Category name" spellcheck="false"><b class="sp-cat-pct"></b>`
                    + (cat.builtin ? '' : `<button type="button" class="sp-cat-x" title="Delete ${esc(cat.label)}: its words become AI-generated">×</button>`));
                row.dataset.id = cat.id;
                const dot = row.querySelector('.sp-swatch');
                const pick = (color) => {
                    setColor(cat.id, color);
                    dot.style.background = color;
                    applyColors();
                    touched();
                };
                dot.style.background = swatch(cat);
                dragColor(dot, pick);
                dot.addEventListener('click', (e) => { if (!e.defaultPrevented) picker(cat.id, dot, pick); });
                const name = row.querySelector('.sp-cat-name');
                name.value = cat.label;
                name.size = Math.max(3, cat.label.length);
                name.addEventListener('input', () => {
                    name.size = Math.max(3, name.value.length);
                    own(cat.id).label = name.value.trim();
                    touched();
                });
                name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
                // selecting a category opens whose words it means, under the categories
                name.addEventListener('focus', () => about(cat.id));
                row.addEventListener('click', (e) => { if (!e.target.closest('.sp-swatch, .sp-cat-x, .sp-cat-name')) about(cat.id); });
                row.querySelector('.sp-cat-x')?.addEventListener('click', () => {
                    withUndo(`Deleted "${cat.label}"`, () => {
                        entries().forEach(([p, v]) => set(p, reattribute(v, cat.id, 'ai')));
                        delete text._categories?.[cat.id];
                    });
                    applyColors();
                    render();
                });
                box.append(row);
            });
            const add = el('button', 'sp-cat-add', '+ Category');
            add.type = 'button';
            add.title = 'Another author or source: a co-author, an editor, a paper you quote';
            add.addEventListener('click', () => {
                const input = el('input', 'sp-cat-new');
                input.placeholder = 'Name, then Enter';
                add.replaceWith(input);
                input.focus();
                let finished = false;
                let made = null;
                const done = (keep) => {
                    if (finished) return;
                    finished = true;
                    const label = input.value.trim();
                    if (keep && label) {
                        made = slug(label);
                        const color = PALETTE[categories().filter((c) => !c.builtin).length % PALETTE.length];
                        Object.assign(own(made), { label, color });
                        applyColors();
                        touched();
                    }
                    render();
                    if (made) about(made, true); // whose words they are, next
                };
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
                input.addEventListener('blur', () => done(true), { once: true });
            });
            box.append(add);
            // every picked color back to the default, in one undoable step. Shown while there's one (numbers())
            const back = el('button', 'sp-cat-revert', 'Revert colors');
            back.type = 'button';
            back.title = 'Every category back to its default color';
            back.addEventListener('click', () => {
                withUndo('Colors back to the defaults', () => Object.keys(text._categories).forEach((id) => setColor(id, null)));
                applyColors();
                render();
            });
            box.append(back);
            if (aboutOpen && categories().some((c) => c.id === aboutOpen)) about(aboutOpen);
            // what an agent marked, for the author to keep or undo
            Object.entries(text._categories ?? {}).forEach(([id, c]) => {
                const before = c.found?.before;
                if (!before || !Object.keys(before).length) return;
                const n = Object.keys(before).length;
                const label = categories().find((x) => x.id === id)?.label ?? id;
                const note = el('p', 'sp-found', `${esc(`An agent marked ${count(n, 'text')} as ${label}${c.found.on ? ` on ${day(c.found.on)}` : ''}`)} · `);
                note.dataset.id = id;
                const keep = el('button', 'sp-link', 'Keep');
                keep.type = 'button';
                keep.title = 'Keep what the agent marked';
                keep.addEventListener('click', () => { withUndo(`Kept the agent's marks for ${label}`, () => { delete c.found.before; }); render(); });
                const undoBtn = el('button', 'sp-link', 'Undo');
                undoBtn.type = 'button';
                undoBtn.title = 'Give those texts back to whoever had them before (texts whose words changed since stay as they are)';
                undoBtn.addEventListener('click', () => {
                    withUndo(`Undid the agent's marks for ${label}`, () => {
                        Object.entries(before).forEach(([p, was]) => {
                            const now = valueAt(text, p);
                            if (now !== undefined && plain(now) === plain(was)) set(p, was);
                        });
                        delete c.found;
                    });
                    render();
                });
                note.append(keep, ' · ', undoBtn);
                box.append(note);
            });
        }
        const day = (iso) => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(+d) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

        /* whose words a category means, and whether an agent should find them: under the categories while open */
        let aboutOpen = null;
        // an agent can find the words of a category of the page's own, or facts and quotes. Only the author can say which
        // words are theirs or approved, and slop is whatever's left
        const findable = (id) => !(id in BUILTIN) || id === 'data';
        // a category's entry, dropped once it says nothing
        function tidy(id) {
            const c = text._categories?.[id];
            if (c && !Object.keys(c).length) delete text._categories[id];
            if (text._categories && !Object.keys(text._categories).length) delete text._categories;
        }
        function about(id, focus) {
            aboutOpen = id;
            const box = $('.sp-cats');
            box.querySelector('.sp-about')?.remove();
            box.querySelectorAll('.sp-cat').forEach((x) => x.classList.toggle('sp-cat-on', x.dataset.id === id));
            const c = () => text._categories?.[id] ?? {};
            const label = () => categories().find((x) => x.id === id)?.label ?? id;
            const panel = el('div', 'sp-about', `<label class="sp-about-q" for="sp-about-${esc(id)}"></label>`
                + `<textarea id="sp-about-${esc(id)}" rows="2" spellcheck="true" placeholder="Who wrote them, or where they come from"></textarea>`
                + '<div class="sp-about-row"><label class="sp-check"><input type="checkbox"> Ask an agent to find them</label><button type="button" class="sp-link sp-about-done">Done</button></div>'
                + '<p class="sp-about-note"></p>');
            panel.dataset.id = id;
            panel.querySelector('.sp-about-q').textContent = `Whose words are ${label()}?`;
            const desc = panel.querySelector('textarea');
            const ask = panel.querySelector('input[type="checkbox"]');
            const note = panel.querySelector('.sp-about-note');
            panel.querySelector('.sp-check').hidden = !findable(id);
            desc.value = c().about ?? '';
            ask.checked = !!c().find;
            const paint = () => {
                note.innerHTML = '';
                if (c().find) {
                    note.append('Waiting for an agent: it finds them the next time one works on this page, once you save. ');
                    const copy = el('button', 'sp-link', 'Copy a prompt');
                    copy.type = 'button';
                    copy.title = 'To ask an agent now';
                    copy.addEventListener('click', () => {
                        const page = decodeURIComponent(location.pathname.split('/').pop() || '') || 'this page';
                        const prompt = `In ${page}, find the words that belong to the slop-editor category "${label()}"${c().about ? ` (${c().about})` : ''} and mark them, following the slop-editor skill's "Categories to find".`;
                        Promise.resolve(navigator.clipboard?.writeText(prompt)).then(() => status('Prompt copied')).catch(() => status("Couldn't copy the prompt", 'error'));
                    });
                    note.append(copy);
                } else if (c().found?.on) note.append(`Found by an agent · ${day(c().found.on)}`);
                note.hidden = !note.childNodes.length;
            };
            desc.addEventListener('input', () => {
                if (desc.value.trim()) own(id).about = desc.value.trim();
                else { delete text._categories?.[id]?.about; tidy(id); }
                touched();
            });
            ask.addEventListener('change', () => {
                if (ask.checked) own(id).find = true;
                else { delete text._categories?.[id]?.find; tidy(id); }
                paint();
                touched();
            });
            panel.querySelector('.sp-about-done').addEventListener('click', () => {
                aboutOpen = null;
                panel.remove();
                box.querySelectorAll('.sp-cat-on').forEach((x) => x.classList.remove('sp-cat-on'));
            });
            paint();
            box.querySelector('.sp-found') ? box.querySelector('.sp-found').before(panel) : box.append(panel);
            if (focus) desc.focus();
        }

        /* the color picker, under a category's dot, laid out like the browser's own: a rectangle of shades, then the
           eyedropper, the color and a hue bar, then its numbers (RGB, HEX or HSL: the arrows switch). Its eyedropper shows
           the page magnified beside the pointer, not over it */
        const rgbOf = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
        const hexOf = (rgb) => `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
        function toHsv(color) {
            const [r, g, b] = rgbOf(color).map((v) => v / 255);
            const max = Math.max(r, g, b);
            const d = max - Math.min(r, g, b);
            const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
        }
        function fromHsv({ h, s, v }) {
            const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
            return hexOf([f(5), f(3), f(1)].map((x) => x * 255));
        }
        function hslOf(color) {
            const [r, g, b] = rgbOf(color).map((v) => v / 255);
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const l = (max + min) / 2;
            const d = max - min;
            const s = !d ? 0 : d / (1 - Math.abs(2 * l - 1));
            return [Math.round(toHsv(color).h), Math.round(s * 100), Math.round(l * 100)];
        }
        function fromHsl([h, s, l]) {
            const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
            const f = (n) => { const k = (n + h / 30) % 12; return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
            return hexOf([f(0), f(8), f(4)].map((x) => x * 255));
        }
        const FORMATS = {
            rgb: { labels: ['R', 'G', 'B'], read: rgbOf, write: hexOf, max: [255, 255, 255] },
            hex: { labels: ['HEX'], read: (c) => [c], write: ([v]) => (/^#?[0-9a-f]{6}$/i.test(v.trim()) ? `#${v.trim().replace('#', '').toLowerCase()}` : null) },
            hsl: { labels: ['H', 'S', 'L'], read: hslOf, write: fromHsl, max: [359, 100, 100] },
        };
        const DROPPER = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10.4 2.4a1.9 1.9 0 0 1 2.7 2.7l-1.6 1.6.8.8-1.1 1.1-.8-.8-5.2 5.2H3v-2.2l5.2-5.2-.8-.8 1.1-1.1.8.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
        let pickEl = null;
        let pickFormat = 'rgb';
        let dropping = false;
        function closePicker() {
            pickEl?.remove();
            pickEl = null;
        }
        function picker(id, dot, pick) {
            const again = pickEl?.dataset.id === id;
            closePicker();
            if (again) return; // a second click on the dot closes it
            const cat = () => categories().find((c) => c.id === id);
            const p = el('div', 'sp-pick', '<div class="sp-pick-sv" tabindex="0" role="slider" aria-label="Shade: right for more color, down for darker"><i></i></div>'
                + `<div class="sp-pick-row"><button type="button" class="sp-pick-drop" title="Take a color from the page" aria-label="Take a color from the page">${DROPPER}</button>`
                + '<b class="sp-pick-now"></b><input type="range" class="sp-pick-hue" min="0" max="359" step="1" aria-label="Hue"></div>'
                + '<div class="sp-pick-nums"></div>');
            p.dataset.id = id;
            pickEl = p;
            const sv = p.querySelector('.sp-pick-sv');
            const handle = sv.querySelector('i');
            const hue = p.querySelector('.sp-pick-hue');
            const now = p.querySelector('.sp-pick-now');
            const nums = p.querySelector('.sp-pick-nums');
            let hsv = toHsv(hex(swatch(cat())));
            function fields() {
                const f = FORMATS[pickFormat];
                nums.innerHTML = f.labels.map((l) => `<label class="sp-pick-num"><input spellcheck="false" aria-label="${l}"><span>${l}</span></label>`).join('')
                    + '<button type="button" class="sp-pick-swap" title="RGB, HEX or HSL" aria-label="Switch between RGB, HEX and HSL"><svg viewBox="0 0 12 16" width="10" height="14" aria-hidden="true"><path d="M2 6l4-4 4 4M2 10l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
                const inputs = [...nums.querySelectorAll('input')];
                inputs.forEach((input) => input.addEventListener('input', () => {
                    const vals = inputs.map((x) => (f.max ? Number(x.value) : x.value));
                    if (f.max && vals.some((v, i) => !Number.isFinite(v) || v < 0 || v > f.max[i])) return;
                    const c = f.write(vals);
                    if (!c) return;
                    hsv = toHsv(c);
                    apply();
                }));
                inputs.forEach((input) => input.addEventListener('blur', paint));
                nums.querySelector('.sp-pick-swap').addEventListener('click', () => {
                    const order = Object.keys(FORMATS);
                    pickFormat = order[(order.indexOf(pickFormat) + 1) % order.length];
                    fields();
                    paint();
                });
            }
            function paint() {
                const c = fromHsv(hsv);
                sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`;
                Object.assign(handle.style, { left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: c });
                hue.value = Math.round(hsv.h);
                hue.style.setProperty('--hue', `hsl(${hsv.h} 100% 50%)`);
                now.style.background = c;
                sv.setAttribute('aria-valuetext', c);
                const vals = FORMATS[pickFormat].read(c);
                nums.querySelectorAll('input').forEach((x, i) => { if (document.activeElement !== x) x.value = vals[i]; });
            }
            function apply() {
                pick(fromHsv(hsv));
                paint();
            }
            const at = (e) => {
                const r = sv.getBoundingClientRect();
                hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
                hsv.v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
                apply();
            };
            sv.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                sv.focus();
                sv.setPointerCapture(e.pointerId);
                at(e);
                const move = (ev) => at(ev);
                const up = () => { sv.removeEventListener('pointermove', move); sv.removeEventListener('pointerup', up); };
                sv.addEventListener('pointermove', move);
                sv.addEventListener('pointerup', up);
            });
            sv.addEventListener('keydown', (e) => {
                const step = e.shiftKey ? 0.1 : 0.02;
                const d = { ArrowLeft: ['s', -step], ArrowRight: ['s', step], ArrowUp: ['v', step], ArrowDown: ['v', -step] }[e.key];
                if (!d) return;
                e.preventDefault();
                hsv[d[0]] = clamp(hsv[d[0]] + d[1], 0, 1);
                apply();
            });
            hue.addEventListener('input', () => { hsv.h = +hue.value; apply(); });
            p.querySelector('.sp-pick-drop').addEventListener('click', (e) => eyedrop(e, (c) => { hsv = toHsv(c); apply(); }));
            p.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dropping) { e.stopPropagation(); closePicker(); dot.focus(); } });
            aside.append(p);
            // under the dot, inside the editor
            const a = aside.getBoundingClientRect();
            const r = dot.getBoundingClientRect();
            p.style.top = `${r.bottom - a.top + 8}px`;
            p.style.left = `${clamp(r.left - a.left - 10, 8, a.width - p.offsetWidth - 8)}px`;
            fields();
            paint();
        }
        // the eyedropper: the magnifier follows the pointer until a click takes the color under it (Escape: none)
        function eyedrop(start, done) {
            dropping = true;
            const lens = sampler();
            let color = null;
            const move = (e) => { color = colorAt(e.clientX, e.clientY); lens.show(e.clientX, e.clientY, color); };
            move(start);
            const off = new AbortController();
            const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
            const finish = (keep) => {
                off.abort();
                lens.remove();
                dropping = false;
                if (keep && color) done(color);
                // the click that took it mustn't reach the page (or the next press clears that)
                const after = new AbortController();
                addEventListener('click', (e) => { stop(e); after.abort(); }, { capture: true, signal: after.signal });
                addEventListener('pointerdown', () => after.abort(), { capture: true, signal: after.signal });
            };
            addEventListener('pointermove', move, { capture: true, signal: off.signal });
            addEventListener('pointerdown', (e) => { stop(e); move(e); finish(true); }, { capture: true, signal: off.signal });
            addEventListener('keydown', (e) => { if (e.key === 'Escape') { stop(e); finish(false); } }, { capture: true, signal: off.signal });
        }
        // a press anywhere but the picker or a dot closes it
        addEventListener('pointerdown', (e) => {
            if (pickEl && !dropping && !pickEl.contains(e.target) && !e.target.closest?.('.sp-swatch')) closePicker();
        }, true);

        /* drag a category's dot onto the page to take a color from it: the point is a ring, and the color shows in a
           circle beside it, joined by a line, so the pointer never hides it. A click still opens the browser's picker */
        function dragColor(dot, pick) {
            let dragged = false; // the click that ends a drag mustn't open the picker
            dot.addEventListener('click', (e) => { if (dragged) { e.preventDefault(); dragged = false; } });
            dot.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                dragged = false;
                const x0 = e.clientX;
                const y0 = e.clientY;
                let lens = null;
                let color = null;
                const move = (ev) => {
                    if (!lens) {
                        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
                        lens = sampler();
                        dot.setPointerCapture(ev.pointerId);
                    }
                    color = colorAt(ev.clientX, ev.clientY);
                    lens.show(ev.clientX, ev.clientY, color);
                };
                let cancelled = false;
                const up = (ev) => {
                    removeEventListener('pointermove', move, true);
                    removeEventListener('pointerup', up, true);
                    removeEventListener('keydown', esc, true);
                    if (!lens) return;
                    lens.remove();
                    dragged = true;
                    ev.preventDefault();
                    if (!cancelled && color) pick(color);
                };
                // Escape drops it: the color stays as it was
                const esc = (ev) => {
                    if (ev.key !== 'Escape' || !lens) return;
                    ev.preventDefault();
                    cancelled = true;
                    lens.remove();
                    removeEventListener('pointermove', move, true);
                };
                addEventListener('pointermove', move, true);
                addEventListener('pointerup', up, true);
                addEventListener('keydown', esc, true);
            });
        }
        // a magnifier beside the point, not over it: a copy of the page, scaled up around the point, in a circle up and to
        // the right (or wherever there's room), joined to a ring at the point by a line. The circle's rim is the color
        const LENS = { r: 64, zoom: 3, off: 96 };
        function sampler() {
            const lens = el('div', 'slop-sampler', '<svg aria-hidden="true"><line></line></svg><i class="slop-sampler-ring"></i>'
                + '<b class="slop-sampler-lens"><span class="slop-sampler-page"></span><i class="slop-sampler-dot"></i></b><span class="slop-sampler-hex"></span>');
            const [line, ring, big, view, label] = ['line', '.slop-sampler-ring', '.slop-sampler-lens', '.slop-sampler-page', '.slop-sampler-hex'].map((q) => lens.querySelector(q));
            Object.assign(big.style, { width: `${LENS.r * 2}px`, height: `${LENS.r * 2}px` });
            const root = getComputedStyle(document.documentElement).backgroundColor;
            const body = getComputedStyle(document.body).backgroundColor;
            view.style.background = /rgba\([^)]*,\s*0\)|transparent/.test(body) ? root : body;
            view.style.width = `${document.documentElement.clientWidth}px`;
            const copy = document.body.cloneNode(true);
            view.append(copy);
            document.body.append(lens);
            document.documentElement.classList.add('slop-sampling');
            place(document.body, copy, view);
            return {
                show(x, y, color) {
                    const { r, zoom, off } = LENS;
                    const cx = x + (x > innerWidth - off - r - 8 ? -off : off);
                    const cy = y + (y < off + r + 8 ? off : -off);
                    Object.assign(ring.style, { left: `${x}px`, top: `${y}px` });
                    Object.assign(big.style, { left: `${cx}px`, top: `${cy}px`, borderColor: color ?? '#fff' });
                    view.style.transform = `translate(${r - (x + scrollX) * zoom}px, ${r - (y + scrollY) * zoom}px) scale(${zoom})`;
                    Object.assign(label.style, { left: `${cx}px`, top: `${cy + r + 18}px` });
                    label.textContent = color ?? '';
                    // the line runs from the ring to the circle's rim
                    const d = Math.hypot(cx - x, cy - y);
                    const ex = cx - ((cx - x) / d) * (r + 3);
                    const ey = cy - ((cy - y) / d) * (r + 3);
                    [['x1', x], ['y1', y], ['x2', ex], ['y2', ey]].forEach(([k, v]) => line.setAttribute(k, v));
                },
                remove() { lens.remove(); document.documentElement.classList.remove('slop-sampling'); },
            };
        }
        // the copy shows the page as it is on screen: what's fixed or sticky where it is now, panels scrolled as they are,
        // and canvases drawn
        function place(from, to, view) {
            const a = document.createTreeWalker(from, NodeFilter.SHOW_ELEMENT);
            const b = document.createTreeWalker(to, NodeFilter.SHOW_ELEMENT);
            const pinned = [];
            const scrolled = [];
            for (let x = a.currentNode, y = b.currentNode; x && y; x = a.nextNode(), y = b.nextNode()) {
                if (x.classList?.contains('slop-sampler')) break; // the magnifier itself, if it got copied
                const pos = getComputedStyle(x).position;
                if (pos === 'fixed' || pos === 'sticky') pinned.push([x, y]);
                if (x.scrollTop || x.scrollLeft) scrolled.push([x, y]);
                if (x instanceof HTMLCanvasElement && y instanceof HTMLCanvasElement) {
                    try { y.getContext('2d').drawImage(x, 0, 0); } catch { /* a canvas it can't read */ }
                }
            }
            const box = view.getBoundingClientRect();
            pinned.forEach(([x, y]) => {
                const want = x.getBoundingClientRect();
                const got = y.getBoundingClientRect();
                y.style.translate = `${want.left + scrollX - (got.left - box.left)}px ${want.top + scrollY - (got.top - box.top)}px`;
            });
            scrolled.forEach(([x, y]) => { y.scrollTop = x.scrollTop; y.scrollLeft = x.scrollLeft; });
        }
        // the color on the page at a point: a letter's color over a letter, a shape's fill, an image's pixel (when the
        // browser lets it be read), or else the first background that isn't see-through
        function colorAt(x, y) {
            const els = document.elementsFromPoint(x, y);
            const top = els[0];
            if (!top) return null;
            const seen = (c) => { const m = /rgba?\([^)]*?([\d.]+)\)$/.exec(c); return c && c !== 'transparent' && !(c.startsWith('rgba') && m && +m[1] === 0); };
            if (top instanceof HTMLImageElement || top instanceof HTMLCanvasElement) {
                try {
                    const r = top.getBoundingClientRect();
                    const w = top.naturalWidth ?? top.width;
                    const h = top.naturalHeight ?? top.height;
                    const c = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');
                    c.drawImage(top, ((x - r.left) / r.width) * w, ((y - r.top) / r.height) * h, 1, 1, 0, 0, 1, 1);
                    const [rr, g, b, a] = c.getImageData(0, 0, 1, 1).data;
                    if (a) return hex(`rgb(${rr}, ${g}, ${b})`);
                } catch { /* another site's image: its pixels can't be read */ }
            }
            const caret = document.caretRangeFromPoint?.(x, y) ?? (() => { const p = document.caretPositionFromPoint?.(x, y); if (!p) return null; const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r; })();
            const node = caret?.startContainer;
            if (node?.nodeType === 3 && top.contains(node)) {
                for (const i of [caret.startOffset - 1, caret.startOffset]) {
                    if (i < 0 || i >= node.length || !node.data[i].trim()) continue;
                    const r = document.createRange();
                    r.setStart(node, i);
                    r.setEnd(node, i + 1);
                    const b = r.getBoundingClientRect();
                    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return hex(getComputedStyle(node.parentElement).color);
                }
            }
            if (top instanceof SVGElement && seen(getComputedStyle(top).fill)) return hex(getComputedStyle(top).fill);
            for (const e of els) {
                const bg = getComputedStyle(e).backgroundColor;
                if (seen(bg)) return hex(bg);
            }
            return hex(getComputedStyle(document.documentElement).backgroundColor) || '#ffffff';
        }

        // a category's own color, or (null) its default
        function setColor(id, color) {
            if (color) { own(id).color = color; return; }
            const c = text._categories?.[id];
            if (!c) return;
            delete c.color;
            if (!Object.keys(c).length) delete text._categories[id];
            if (!Object.keys(text._categories).length) delete text._categories;
        }

        /* marking text: the focused field gets a row of categories. A selection, or the whole text, becomes theirs */
        const assignEl = el('div', 'sp-assign');
        function showAssign(wrap, input, paths) {
            assignEl.innerHTML = '<span class="sp-assign-label"></span>';
            categories().forEach((cat) => {
                const b = el('button', 'sp-as', `<i style="background:${swatch(cat)}"></i>${esc(cat.label)}`);
                b.type = 'button';
                b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the focus and the selection
                b.addEventListener('click', () => {
                    let [s, e, n] = selOf(input);
                    const at = markedIn(input, paths[0], [s, e]);
                    const whole = s === e;
                    if (whole) [s, e] = [0, n];
                    withUndo(`Marked ${whole ? 'the text' : 'the selection'} as ${cat.label}`, () => paths.forEach((p) => set(p, assign(get(p), s, e, cat.id))), at);
                });
                assignEl.append(b);
            });
            assignEl.append(newCategory(wrap, input, paths));
            assignLabel(input);
            if (wrap.insert) wrap.insert.before(assignEl); else wrap.append(assignEl); // the + stays last
        }
        // a category made where the words are: its name and whose words it means, and the selection marked as it
        function newCategory(wrap, input, paths) {
            const plus = el('button', 'sp-as sp-as-new', '+');
            plus.type = 'button';
            plus.title = 'A new category: another author or source';
            plus.setAttribute('aria-label', 'New category');
            plus.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection until it's read
            plus.addEventListener('click', () => {
                const [s, e] = selOf(input);
                const form = el('span', 'sp-newcat', '<input class="sp-newcat-name" placeholder="Name" aria-label="New category\'s name" spellcheck="false">'
                    + '<input class="sp-newcat-about" placeholder="Whose words are they?" aria-label="Whose words the new category means">'
                    + `<button type="button" class="sp-newcat-add">${s < e ? 'Add and mark' : 'Add'}</button><button type="button" class="sp-newcat-x" aria-label="Cancel">×</button>`);
                const [name, desc] = form.querySelectorAll('input');
                plus.replaceWith(form);
                name.focus();
                const back = () => { showAssign(wrap, input, paths); input.focus(); if (input.setSelectionRange) input.setSelectionRange(s, e); };
                const add = () => {
                    const label = name.value.trim();
                    if (!label) { name.focus(); return; }
                    const id = slug(label);
                    const color = PALETTE[categories().filter((c) => !c.builtin).length % PALETTE.length];
                    withUndo(s < e ? `Added "${label}" and marked the selection as it` : `Added "${label}"`, () => {
                        Object.assign(own(id), { label, color }, desc.value.trim() ? { about: desc.value.trim() } : {});
                        if (s < e) paths.forEach((p) => set(p, assign(get(p), s, e, id)));
                    }, markedIn(input, paths[0], [s, e]));
                    applyColors();
                    if (!inPlace) renderCats();
                    back();
                };
                name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); desc.focus(); } if (ev.key === 'Escape') back(); });
                desc.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } if (ev.key === 'Escape') back(); });
                form.querySelector('.sp-newcat-add').addEventListener('click', add);
                form.querySelector('.sp-newcat-x').addEventListener('click', back);
            });
            return plus;
        }
        // where a mark was made, so ⌘Z there takes it back and selects the words again
        const markedIn = (input, path, sel) => (input.tagName === 'TEXTAREA' ? { path, where: 'panel', sel } : { path, where: 'page', owner: spot(input)?.owner, sel });
        const assignLabel = (input) => {
            const [s, e] = selOf(input);
            if (assignEl.firstChild) assignEl.firstChild.textContent = s === e ? 'Mark all as' : 'Mark selection as';
        };
        // while a selection is being dragged out too, so the row doesn't change under the pointer once it's let go
        document.addEventListener('selectionchange', () => {
            const a = document.activeElement;
            if ((a?.tagName === 'TEXTAREA' && assignEl.parentNode?.contains(a)) || (a === liveEl && assignEl.parentNode === float)) assignLabel(a);
        });

        /* copying a text's words keeps who wrote them: pasted into a text (here, or in another page's editor), they keep
           their authors. Words from anywhere else are mine, as typed */
        const CLIP = 'application/x-slop-editor';
        let clip = null; // {words, authors}, the last copied here: for a browser that keeps only plain text
        function copyOut(e, input, path) {
            const [s, t] = [input.selectionStart, input.selectionEnd];
            if (s === t || !e.clipboardData) return;
            clip = { words: input.value.slice(s, t), authors: authorsByChar(get(path)).slice(s, t) };
            e.preventDefault();
            e.clipboardData.setData('text/plain', clip.words);
            e.clipboardData.setData(CLIP, JSON.stringify(clip));
            if (e.type === 'cut') document.execCommand('delete'); // as an edit, so ⌘Z brings it back
        }
        function pastedIn(e) {
            const words = (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
            let c = clip;
            try { c = JSON.parse(e.clipboardData.getData(CLIP)) ?? clip; } catch { /* plain text only */ }
            if (!c || c.words !== words || !Array.isArray(c.authors) || c.authors.length !== words.length) return null;
            return { words, authors: c.authors.map((a) => (typeof a === 'string' && a ? a : 'me')) };
        }

        /* the views */
        const setOf = (path) => sets.find((s) => s.paths.includes(path));
        const hasSlop = (path) => (makeup([get(path)]).counts.ai ?? 0) > 0;
        const hint = (wrap, message, action) => {
            const h = wrap.querySelector('.sp-hint');
            h.innerHTML = esc(message);
            h.hidden = false;
            h.dataset.at = performance.now();
            if (!action) return;
            const b = el('button', 'sp-link', esc(action.label));
            b.type = 'button';
            b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the focus in the field
            b.addEventListener('click', () => { h.hidden = true; action.run(); });
            h.append(' ', b);
        };
        let pressed = false;
        addEventListener('pointerdown', () => { pressed = true; }, true);
        addEventListener('pointerup', () => { setTimeout(() => { pressed = false; }); }, true);
        const afterClick = (fn) => {
            if (!pressed) { fn(); return; }
            addEventListener('pointerup', () => setTimeout(fn), { once: true, capture: true });
        };

        function field(path, { all } = {}) {
            const value = get(path);
            const wrap = el('div', 'sp-field');
            wrap.dataset.path = path;
            const fid = `sp-${path.replace(/\W/g, '-')}${all ? '-all' : ''}`;
            const keys = keysOf(path);
            const name = all ? `${all.paths.length} copies` : keys.slice(1).map((k, i) => keyName(keys, i + 1)).join(' · ') || human(path);
            wrap.innerHTML = `<div class="sp-flabel"><label for="${fid}">${esc(name)}</label>`
                + '<span class="sp-fend"><span class="sp-kind" hidden></span><button type="button" class="sp-unseen" hidden></button></span></div>'
                + `<div class="sp-ink"><div class="sp-mirror" aria-hidden="true"></div><textarea id="${fid}" rows="1" spellcheck="true"></textarea></div>`
                + '<p class="sp-hint" hidden></p>';
            const row = wrap.querySelector('.sp-fend'); // the meter sits by the name; the rest at the end of the row
            const input = wrap.querySelector('textarea');
            input.value = plain(value);
            if (!isLong(path, value)) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
            const paths = () => (all ? all.paths : [path]);
            // back to how it was at the last save, words and authorship
            const revert = el('button', 'sp-revert', 'Revert');
            revert.type = 'button';
            revert.title = 'Back to how this was at the last save';
            revert.addEventListener('click', () => {
                withUndo(`Reverted "${all ? all.words : where(path)}"`, () => paths().forEach((p) => { if (savedAt(p) !== undefined) set(p, savedAt(p)); }));
                render();
            });
            const group = keys.slice(0, -1).join('.');
            const listItem = !all && group && listed().has(group) && isParagraph(keys.at(-1));
            if (listItem) {
                wrap.insert = plusRow(path, group);
                wrap.append(wrap.insert);
            }
            row.append(revert);
            if (!all) {
                const rep = el('button', 'sp-rep');
                rep.type = 'button';
                rep.addEventListener('click', () => { const s = setOf(path); if (s) show('repeats', s.paths[0]); });
                row.append(rep);
            }
            // a copy's switch changes that copy only, and says so. A Repeats card's switch changes every copy.
            // The row reads: name and pie, then at the end anything else, the trash can and the switch
            const ctl = control(paths, all ? count(all.paths.length, 'copy', 'copies') : `"${where(path)}"`, { id: all ? `copies:${all.paths.join(' ')}` : `text:${path}`, after: all ? null : (approved) => {
                const others = (setOf(path)?.paths ?? []).filter((p) => p !== path);
                if (!others.length) return;
                const how = approved ? unslop : reslop;
                hint(wrap, `Only this copy changed. ${count(others.length, 'other copy', 'other copies')} didn't.`, {
                    label: others.length === 1 ? 'Change it too' : 'Change them too',
                    run: () => withUndo(`${approved ? 'Approved' : 'Back to slop:'} ${count(others.length + 1, 'copy', 'copies')}`, () => others.forEach((p) => set(p, how(get(p))))),
                });
            } });
            row.before(ctl.pie);
            if (listItem) row.append(removeButton(path, wrap));
            row.append(ctl);
            // the stretch a keystroke or a paste replaces: the selection, or nothing at the caret
            input.addEventListener('beforeinput', (e) => {
                input.at = [input.selectionStart, input.selectionEnd];
                if (/^history/.test(e.inputType) && e.cancelable) { e.preventDefault(); step(e.inputType === 'historyUndo'); } // from the Edit menu
            });
            // ⌘Z is the editor's: it takes back marks and switches too, and the words come back with their authors
            input.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); step(!e.shiftKey); }
            });
            input.addEventListener('input', (e) => {
                const restoring = /^history(Undo|Redo)$/.test(e.inputType);
                const pasted = e.inputType === 'insertFromPaste' ? input.pasted : null;
                edit(paths(), input, restoring, restoring || e.isComposing || /Composition/.test(e.inputType) ? undefined : input.at, pasted);
                input.at = undefined;
                input.pasted = null;
            });
            input.addEventListener('copy', (e) => copyOut(e, input, paths()[0]));
            input.addEventListener('cut', (e) => copyOut(e, input, paths()[0]));
            input.addEventListener('paste', (e) => { input.pasted = pastedIn(e); });
            ['select', 'selectionchange', 'keyup', 'pointerup'].forEach((t) => input.addEventListener(t, () => assignLabel(input)));
            input.addEventListener('focus', () => { focus(path, all, input, wrap); showAssign(wrap, input, paths()); });
            input.addEventListener('blur', () => {
                mark(false);
                // after the click that moved the focus lands: removing these first would move what's being clicked
                afterClick(() => {
                    if (document.activeElement === input || assignEl.contains(document.activeElement)) return;
                    wrap.querySelector('.sp-hint').hidden = true;
                    if (assignEl.parentNode === wrap) assignEl.remove();
                });
            });
            wrap.querySelector('.sp-unseen').addEventListener('click', () => input.focus());
            wrap.input = input;
            wrap.mirror = wrap.querySelector('.sp-mirror');
            wrap.rep = wrap.querySelector('.sp-rep');
            wrap.kind = wrap.querySelector('.sp-kind');
            wrap.revert = revert;
            wrap.paths = paths;
            return wrap;
        }

        function groupView(key, paths) {
            const det = el('details', 'sp-group', `<summary><span class="sp-gname">${esc(groupTitle(key))}</span><span class="sp-gnote"></span></summary>`);
            det.dataset.group = key;
            det.open = state.open.has(key) || state.tab === 'hidden'; // there are few, so all of them show
            const all = () => entries(text[key], [key]).map(([p]) => p);
            const ctl = control(all, `"${groupTitle(key)}"`, { id: `group:${key}` });
            det.querySelector('.sp-gname').after(ctl.pie);
            det.querySelector('summary').append(ctl);
            det.addEventListener('toggle', () => {
                if (det.open) { state.open.add(key); det.querySelectorAll('textarea').forEach(grow); return; }
                state.open.delete(key);
                // closed from its name stuck at the top: back to where the section starts
                const above = det.getBoundingClientRect().top - body.getBoundingClientRect().top;
                if (above < 0) body.scrollTop += above;
            });
            paths.forEach((p) => det.append(field(p)));
            if (state.tab === 'all') listRows(key, det);
            return det;
        }

        // the words behind a text box, each in its author's color. The box's own letters are see-through
        function paintInk(wrap) {
            const value = valueAt(text, wrap.paths()[0]) ?? ''; // a text just taken out is drawn once more
            const key = JSON.stringify(value);
            if (wrap.inked === key) return;
            wrap.inked = key;
            const s = plain(value);
            const authors = authorsByChar(value);
            let h = '';
            for (let i = 0; i < s.length;) {
                let j = i;
                while (j < s.length && authors[j] === authors[i]) j++;
                h += `<span class="${cls(authors[i])}">${esc(s.slice(i, j))}</span>`;
                i = j;
            }
            wrap.mirror.innerHTML = `${h} `; // the space holds a last empty line open, as the box does
        }

        /* lists: where the page shows a group as a list, texts can be added and taken out */
        const inList = (key) => [...listed()].some((g) => g === key || g.startsWith(`${key}.`));
        // a key for a new paragraph in a group: the p<n> after any the group had in the file, at the last save or now
        function freshKey(group) {
            const taken = [text, saved, JSON.parse(original)].flatMap((root) => Object.keys(nodeAt(root, group) ?? {})).filter(isParagraph);
            return `p${1 + Math.max(0, ...taken.map((k) => +k.slice(1)))}`;
        }
        // a text put in a group after the key `after` (or first), the rest in the order they were
        function insert(group, after, key, value) {
            const node = nodeAt(text, group) ?? {};
            const next = after == null ? { [key]: value } : {};
            Object.entries(node).forEach(([k, v]) => { next[k] = v; if (k === after) next[key] = value; });
            if (!(key in next)) next[key] = value;
            set(group, next);
        }
        function addText(group, after) {
            const key = freshKey(group);
            withUndo('Added a paragraph', () => insert(group, after, key, ''));
            show('all', `${group}.${key}`);
        }
        const TRASH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 4.5h11M6.2 4.5V2.8h3.6v1.7M4 4.5l.7 8.7h6.6l.7-8.7M6.7 7v4M9.3 7v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        // a class on the page's elements for a text (`last`: only the last of them), off everything else
        const FLAGS = ['slop-insert-after', 'slop-remove-hint', 'slop-removing'];
        function flag(name, path, last) {
            document.querySelectorAll(`.${name}`).forEach((x) => x.classList.remove(name));
            if (!path) return;
            const els = elementsOf(path);
            (last ? els.slice(-1) : els).forEach((x) => x.classList.add(name));
        }
        // the + under a text in a list: pointing at it shows on the page where the new paragraph would go
        function plusRow(path, group) {
            const b = el('button', 'sp-insert', '<span class="sp-plus" aria-hidden="true">+</span><span class="sp-insert-label" aria-hidden="true">Add paragraph</span>');
            b.type = 'button';
            b.title = 'Add a paragraph below this one';
            b.setAttribute('aria-label', 'Add a paragraph below this one');
            const show = (on) => flag('slop-insert-after', on && path, true);
            ['pointerenter', 'focus'].forEach((t) => b.addEventListener(t, () => show(true)));
            ['pointerleave', 'blur'].forEach((t) => b.addEventListener(t, () => show(false)));
            b.addEventListener('click', () => { show(false); addText(group, keysOf(path).at(-1)); });
            return b;
        }
        // Remove: pointing at it outlines the text on the page in red. One with words takes a second click, and stays
        // red, here and on the page, until then
        function removeButton(path, wrap) {
            const drop = el('button', 'sp-trash', TRASH);
            drop.type = 'button';
            drop.title = 'Remove this paragraph';
            drop.setAttribute('aria-label', 'Remove this paragraph');
            const armed = () => 'armed' in drop.dataset;
            const hint = (on) => flag('slop-remove-hint', on && path);
            const arm = (on) => {
                if (on) drop.dataset.armed = ''; else delete drop.dataset.armed;
                drop.innerHTML = on ? `${TRASH}Remove?` : TRASH;
                wrap.classList.toggle('sp-removing', on);
                flag('slop-removing', on && path);
            };
            ['pointerenter', 'focus'].forEach((t) => drop.addEventListener(t, () => hint(true)));
            ['pointerleave', 'blur'].forEach((t) => drop.addEventListener(t, () => hint(false)));
            drop.addEventListener('click', () => {
                if (plain(get(path)).trim() && !armed()) {
                    arm(true);
                    setTimeout(() => { if (drop.isConnected && armed()) arm(false); }, 3000);
                    return;
                }
                hint(false);
                arm(false);
                withUndo(`Removed "${where(path)}"`, () => remove(path));
                render();
            });
            return drop;
        }
        // in the All tab, each list's removed texts until the next save, each with Restore, and a way to start an empty one
        function listRows(key, box) {
            [...listed()].filter((g) => g === key || g.startsWith(`${key}.`)).forEach((group) => {
                const now = textKeys(nodeAt(text, group)).filter(isParagraph);
                const was = textKeys(nodeAt(saved, group)).filter(isParagraph);
                const fieldOf = (k) => [...box.querySelectorAll(':scope > .sp-field')].find((f) => f.dataset.path === `${group}.${k}`);
                was.forEach((k, i) => {
                    if (now.includes(k)) return;
                    const before = was.slice(0, i).reverse().find((x) => now.includes(x)); // the nearest earlier one that's still there
                    const name = /^p\d+$/.test(k) ? `Paragraph ${i + 1}` : human(k);
                    const row = el('p', 'sp-gone', `${esc(name)} removed · `);
                    const b = el('button', 'sp-link', 'Restore');
                    b.type = 'button';
                    b.addEventListener('click', () => {
                        withUndo(`Restored "${name}"`, () => insert(group, before ?? null, k, JSON.parse(JSON.stringify(nodeAt(saved, `${group}.${k}`)))));
                        render();
                    });
                    row.append(b);
                    let at = before ? fieldOf(before) : null;
                    while (at?.nextElementSibling?.classList.contains('sp-gone')) at = at.nextElementSibling;
                    const first = now.length ? fieldOf(now[0]) : null;
                    if (at) at.after(row); else if (first) first.before(row); else box.append(row);
                });
                if (now.length) return;
                const start = el('button', 'sp-cat-add sp-start', '+ Paragraph');
                start.type = 'button';
                start.title = `Start "${where(group)}" again`;
                start.addEventListener('click', () => addText(group, Object.keys(nodeAt(text, group) ?? {}).at(-1) ?? null)); // at the group's end
                box.append(start);
            });
        }

        function render() {
            FLAGS.forEach((name) => flag(name)); // the elements pointed at may be gone
            controls = [];
            sets = repeats(entries());
            groupKeys().forEach((k) => { if (!state.known.has(k)) { state.known.add(k); state.open.add(k); } });
            renderCats();
            const top = body.scrollTop;
            body.innerHTML = '';
            aside.querySelectorAll('.sp-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
            if (state.tab === 'repeats') {
                body.insertAdjacentHTML('beforeend', '<p class="sp-intro">The same words in more than one place. Each copy is slop until it\'s approved. Here, editing or switching a card changes every copy.</p>');
                if (!sets.length) body.insertAdjacentHTML('beforeend', '<p class="sp-empty">No repeated text on this page.</p>');
                sets.forEach((s) => {
                    const card = field(s.paths[0], { all: s });
                    card.classList.add('sp-set');
                    const list = el('ul', 'sp-where');
                    s.paths.forEach((p) => {
                        const li = document.createElement('li');
                        const go = el('button', 'sp-goto', `<span class="sp-pie sp-mini"></span>${esc(where(p))}`);
                        go.type = 'button';
                        go.dataset.path = p;
                        go.addEventListener('click', () => show('all', p));
                        go.addEventListener('pointerenter', () => mark(true, [p]));
                        go.addEventListener('pointerleave', () => mark(false));
                        li.append(go);
                        list.append(li);
                    });
                    card.append(list);
                    body.append(card);
                });
            } else {
                const tab = state.tab;
                const keep = tab === 'slop' ? hasSlop : tab === 'hidden' ? attrOf : () => true;
                if (tab === 'hidden') body.insertAdjacentHTML('beforeend', '<p class="sp-intro">Words the page has but doesn\'t show: alt text for when an image doesn\'t load, tooltips, labels for screen readers. Readers\' colors can\'t show them, so read them here.</p>');
                let shown = 0;
                groupKeys().forEach((key) => {
                    const paths = (isText(text[key]) ? [key] : entries(text[key], [key]).map(([p]) => p)).filter(keep);
                    if (!paths.length && !(tab === 'all' && inList(key))) return; // an emptied list stays, to start again
                    shown += paths.length;
                    body.append(isText(text[key]) ? field(key) : groupView(key, paths));
                });
                if (tab === 'slop' && !shown) body.insertAdjacentHTML('beforeend', '<p class="sp-empty">No slop left. Every word here is yours, approved, or someone else\'s.</p>');
                if (tab === 'hidden' && !shown) body.insertAdjacentHTML('beforeend', '<p class="sp-empty">No hidden text on this page. Mark an element\'s with <code>data-slop-attr="alt:group.key"</code>.</p>');
            }
            aside.classList.add('sp-still'); // new switches appear as they are, without sliding there
            numbers();
            body.querySelectorAll('textarea').forEach(grow);
            body.scrollTop = top;
            requestAnimationFrame(() => requestAnimationFrame(() => aside.classList.remove('sp-still')));
        }

        // every number, pie and switch in the editor, after any change
        function numbers() {
            const cats = categories();
            const all = entries();
            const page = makeup(all.map(([, v]) => v));
            aside.querySelectorAll('.sp-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.show === shows())));
            const revert = $('.sp-cat-revert');
            if (revert) revert.hidden = !Object.values(text._categories ?? {}).some((c) => c.color);
            aside.querySelectorAll('.sp-cat').forEach((row) => {
                row.querySelector('.sp-cat-pct').textContent = percent(page.letters ? (page.counts[row.dataset.id] ?? 0) / page.letters : 0);
            });
            controls.forEach((c) => paintControl(c, cats));
            if (floatCtl && !controls.some((c) => c.el === floatCtl)) paintControl({ el: floatCtl, paths: floatCtl.paths }, cats);
            body.querySelectorAll('.sp-goto').forEach((go) => {
                const m = makeup([get(go.dataset.path)]);
                go.querySelector('.sp-pie').style.background = gradient(m, cats);
                go.title = breakdown(m, cats);
            });
            const live = repeats(all);
            const hidden = new Map(all.map(([p]) => [p, attrOf(p)]).filter(([, a]) => a));
            const tabs = { all: all.length, slop: all.filter(([p]) => hasSlop(p)).length, repeats: live.length, hidden: hidden.size };
            aside.querySelectorAll('.sp-tabs button').forEach((b) => {
                b.querySelector('span').textContent = tabs[b.dataset.tab];
                if (b.dataset.tab === 'hidden') b.hidden = !hidden.size && state.tab !== 'hidden'; // only on pages that have some
            });
            body.querySelectorAll('.sp-field').forEach((f) => {
                paintInk(f);
                f.revert.hidden = !f.paths().some((p) => differs(p) && savedAt(p) !== undefined);
                paintSeen(f);
                const kind = f.paths().map((p) => hidden.get(p)).find(Boolean);
                f.kind.hidden = !kind;
                f.kind.textContent = KINDS[kind] ?? kind ?? '';
                f.kind.title = kind ? `Not shown as words: the page's ${kind} attribute` : '';
            });
            paintSave();
            body.querySelectorAll('.sp-field:not(.sp-set)').forEach((f) => {
                const s = live.find((r) => r.paths.includes(f.dataset.path));
                f.rep.hidden = !s;
                if (!s) return;
                f.rep.textContent = `${s.paths.length}×`;
                f.rep.title = `Same words in ${count(s.paths.length - 1, 'other place')}: ${s.paths.filter((p) => p !== f.dataset.path).map(where).join(', ')}`;
            });
            body.querySelectorAll('.sp-group').forEach((det) => {
                const paths = entries(text[det.dataset.group], [det.dataset.group]);
                const left = paths.filter(([p]) => hasSlop(p)).length;
                det.querySelector('.sp-gnote').textContent = left ? `${left} of ${paths.length} with slop` : 'no slop';
            });
            paintMeters();
        }
        repaint = () => { if (!aside.hidden) render(); };
        reseen = () => { if (!aside.hidden) { body.querySelectorAll('.sp-field').forEach(paintSeen); liven(); } };
        // a text the page doesn't show right now is tagged, with a way to show it if the page says how
        function paintSeen(f) {
            const tag = f.querySelector('.sp-unseen');
            const shown = revealed && f.paths().includes(revealed.path);
            tag.hidden = !shown && f.paths().some(onPage);
            tag.disabled = shown || !revealerOf(f.paths()[0]);
            tag.textContent = shown ? 'shown while editing' : tag.disabled ? 'not on the page' : 'not on the page · show it';
            tag.title = shown ? 'The page normally hides this. It\'s shown while you edit it'
                : tag.disabled ? 'Not on the page right now: the page shows it only some of the time, or not at all. A page can say how to show it with Slop.reveal'
                    : 'Show the page the way it looks with this text';
        }

        // the page and the editor point at each other
        function mark(on, paths = state.focus?.paths ?? [], scroll = false, tries = 0) {
            document.querySelectorAll('.slop-focus, .slop-copy').forEach((x) => x.classList.remove('slop-focus', 'slop-copy'));
            if (!on) return;
            paths.forEach((p, i) => elementsOf(p).forEach((x) => x.classList.add(i ? 'slop-copy' : 'slop-focus')));
            const target = paths.map((p) => elementsOf(p)[0]).find(Boolean);
            if (!scroll) return;
            // a text the page only just revealed may not be drawn yet (React and the like draw on the next frame)
            if (!target) {
                if (tries < 10) requestAnimationFrame(() => { if (state.focus?.paths === paths) mark(true, paths, true, tries + 1); });
                return;
            }
            // scroll whatever holds it (the window, or a panel of the page's that scrolls on its own) to bring it to
            // the middle of what's visible, unless it's already well in view
            const box = scroller(target);
            const r = target.getBoundingClientRect();
            const top = box ? Math.max(box.getBoundingClientRect().top, 0) : 0;
            const bottom = Math.min(box ? box.getBoundingClientRect().bottom : innerHeight, innerWidth <= 900 ? aside.getBoundingClientRect().top : innerHeight);
            const pad = Math.min(120, (bottom - top) / 5); // room for a header that stays put
            if (r.top < top + pad || r.bottom > bottom - 8) (box ?? window).scrollBy({ top: r.top - (top + bottom - r.height) / 2, behavior: 'smooth' });
        }
        // the nearest element around `el` that scrolls, or null for the window
        function scroller(el) {
            for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
                if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
            }
            return null;
        }
        function focus(path, all, input, wrap) {
            const s = all ?? setOf(path);
            const paths = all ? all.paths : [path, ...(s ? s.paths.filter((p) => p !== path) : [])];
            state.focus = { path, paths, copies: all || !s ? [] : s.paths.filter((p) => p !== path), was: wordsOf(get(path)), wrap, linked: null };
            if (revealed && !paths.includes(revealed.path)) unreveal();
            if (!paths.some(onPage)) showHidden(paths[0]);
            mark(true, paths, true);
        }
        // a text the page hides: shown while it's being edited, if the page says how
        let revealed = null; // {path, undo}
        function showHidden(path) {
            const fn = revealerOf(path);
            if (!fn || revealed?.path === path) return;
            try { revealed = { path, undo: fn() }; } catch (e) { console.error(e); return; }
            fill();
            numbers();
        }
        function unreveal() {
            if (!revealed) return;
            const { undo: hide } = revealed;
            revealed = null;
            try { hide?.(); } catch (e) { console.error(e); }
            numbers();
        }
        // show one text: in this tab if it's there, otherwise in All
        function show(tab, path) {
            state.tab = tab;
            if (tab !== 'repeats') state.open.add(keysOf(path)[0]);
            render();
            const f = [...body.querySelectorAll('.sp-field')].find((x) => x.dataset.path === path);
            if (!f) return;
            f.scrollIntoView({ block: 'center', behavior: 'smooth' });
            f.input.focus({ preventScroll: true });
            f.classList.add('sp-flash');
            setTimeout(() => f.classList.remove('sp-flash'), 900);
        }

        // the box of a text being typed into on the page, scrolled to in the panel without taking the focus
        function seek(path) {
            const find = () => [...body.querySelectorAll('.sp-field')].find((x) => x.paths().includes(path));
            if (!find() || state.tab === 'hidden') {
                state.tab = state.tab === 'slop' && hasSlop(path) ? 'slop' : 'all';
                state.open.add(keysOf(path)[0]);
                render();
            }
            const f = find();
            if (!f) return;
            f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            f.classList.add('sp-flash');
            setTimeout(() => f.classList.remove('sp-flash'), 900);
        }
        const grow = (x) => { x.style.height = 'auto'; x.style.height = `${x.scrollHeight + 2}px`; };

        // typing: what you type is yours, the rest keeps its author
        // the browser's own undo, where it can't be stopped (the Edit menu, in some browsers): the words come back with
        // whoever wrote them, from each text's recent versions
        const past = new Map(); // path → [value, …], oldest first
        function remember(p) {
            const list = past.get(p) ?? [];
            const v = get(p);
            if (JSON.stringify(list.at(-1)) !== JSON.stringify(v)) list.push(v);
            past.set(p, list.slice(-200));
        }
        const recall = (p, words) => past.get(p)?.findLast((v) => plain(v) === words);
        // `pasted`: words copied from a text, with their authors, now at `at`
        function edit(paths, input, restoring, at, pasted) {
            noted = false;
            const f = state.focus;
            const keep = pasted && at && input.value.startsWith(pasted.words, at[0]);
            const kind = input.value.length < plain(get(paths[0])).length ? 'delete' : 'type';
            track(() => [...paths, ...(f?.linked ?? [])].forEach((p) => {
                remember(p);
                const next = applyEdit(get(p), input.value, restoring ? recall(p, input.value) : undefined, at);
                set(p, keep ? overlay(next, at[0], pasted.authors) : next);
                remember(p);
            }), { at: { path: paths[0], where: 'panel' }, typing: restoring || pasted ? '' : kind, typed: true });
            grow(input);
            if (f?.copies.length && !f.linked) {
                // a copy changed on its own: offer to change the others the same way
                const stale = f.copies.filter((p) => wordsOf(get(p)) === f.was);
                if (!stale.length || wordsOf(input.value) === f.was) f.wrap.querySelector('.sp-hint').hidden = true;
                else {
                    hint(f.wrap, `Changed here only. ${count(stale.length, 'other copy', 'other copies')} still ${stale.length === 1 ? 'says' : 'say'} the old words.`, {
                        label: stale.length === 1 ? 'Change it too' : 'Change them too',
                        run: () => { // and keep them in step while this field has the focus
                            stale.forEach((p) => set(p, applyEdit(get(p), input.value)));
                            f.linked = stale;
                            touched();
                        },
                    });
                }
            }
            touched();
        }

        /* editing on the page: while the editor is open, every text on the page can be typed into where it is (the
           panel can shrink to its header, `inPlace`). The browser changes the words; each change is read back as the words that read differently (`reconcile`),
           made into the text with editRead (what's typed is mine, the markup stays), and the element drawn again */
        let inPlace = store.get('slop-editor-place') !== 'panel'; // the bar, unless the panel was open last time
        let liveEl = null; // the element being typed into
        let floatCtl = null;
        const float = el('div', 'slop-float slop-on');
        float.hidden = true;
        document.body.append(float);
        const canLive = (x) => !x.closest('.slop-panel, .slop-float, button, select, label, [data-slop-ref]') && (x.dataset.slop || x.dataset.slopMore);
        const liveOf = (t) => (!aside.hidden ? t?.closest?.('[contenteditable="true"][data-slop], [contenteditable="true"][data-slop-more]') : null);
        function liven() {
            const on = !aside.hidden;
            document.querySelectorAll('[data-slop], [data-slop-more]').forEach((x) => {
                if (on && canLive(x)) { if (x.contentEditable !== 'true') { x.contentEditable = 'true'; x.spellcheck = true; } } else if (x.hasAttribute('contenteditable')) x.removeAttribute('contenteditable');
            });
        }
        function setPlace(on) {
            inPlace = on;
            store.set('slop-editor-place', on ? 'page' : 'panel');
            aside.classList.toggle('sp-mini', on);
            modeBtn.innerHTML = on ? 'Panel' : SHRINK;
            modeBtn.title = on ? 'Show every text in the panel' : 'Shrink the editor to a bar. You type into the page either way';
            modeBtn.setAttribute('aria-label', on ? 'Show the panel' : 'Shrink to a bar');
            place();
            if (!on && !aside.hidden) render();
        }
        const SHRINK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="3.5" y="9.5" width="9" height="2" rx="1" fill="currentColor"/></svg>';
        function livePage() {
            const on = !aside.hidden;
            document.documentElement.classList.toggle('slop-live', on);
            if (live.on !== on) { live.on = on; fill(); }
            liven();
        }
        // which text an element shows, and which of its paragraphs: {path, owner (its [data-slop] element), j, s, e, part}
        function spot(x) {
            const owner = x.dataset.slop ? x : ownerOf.get(x);
            if (!owner) return null;
            const path = owner.dataset.slop;
            const value = get(path);
            const spans = SPLITS.test(owner.tagName) ? paragraphSpans(value, true) : [[0, plain(value).length]];
            const j = x === owner ? 0 : (spills.get(owner) ?? []).indexOf(x) + 1;
            if (!spans[j]) return null;
            const [s, e] = spans[j];
            return { path, owner, j, s, e, value, spans, part: slice(value, s, e) };
        }
        const shownAt = (owner, j) => (j ? spills.get(owner)?.[j - 1] : owner);

        // the words an element shows, as readOf has them: a {name} is one character, a <br> a line break
        function domWords(root) {
            let out = '';
            const walk = (n) => {
                if (n.nodeType === 3) out += n.data.replace(/ /g, ' ');
                else if (n.nodeType === 1 && n.hasAttribute('data-slop-v')) out += OBJ;
                else if (n.nodeName === 'BR') out += '\n';
                else n.childNodes.forEach(walk);
            };
            root.childNodes.forEach(walk);
            return out;
        }
        // how far into an element's words a point is
        function indexAt(root, node, offset) {
            const r = document.createRange();
            r.selectNodeContents(root);
            try { r.setEnd(node, offset); } catch { return 0; }
            return domWords(r.cloneContents()).length;
        }
        const selIn = (root) => {
            const sel = getSelection();
            if (!sel.rangeCount || !root.contains(sel.anchorNode)) return null;
            const r = sel.getRangeAt(0);
            return [indexAt(root, r.startContainer, r.startOffset), indexAt(root, r.endContainer, r.endOffset)];
        };
        // the caret at k of an element's words, or the selection k to k2
        function caret(root, k, k2 = k) {
            const r = document.createRange();
            r.setStart(...pointAt(root, k));
            r.setEnd(...pointAt(root, Math.max(k, k2)));
            const sel = getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
        }
        function pointAt(root, k) {
            let n = 0;
            let at = null;
            const walk = (x) => {
                if (at) return;
                if (x.nodeType === 3) {
                    if (k <= n + x.length) { at = [x, k - n]; return; }
                    n += x.length;
                } else if (x.nodeType === 1 && (x.hasAttribute('data-slop-v') || x.nodeName === 'BR')) {
                    if (k === n) { at = [x.parentNode, [...x.parentNode.childNodes].indexOf(x)]; return; }
                    n++;
                    if (k === n && x.nextSibling?.nodeType !== 3) at = [x.parentNode, [...x.parentNode.childNodes].indexOf(x) + 1];
                } else x.childNodes.forEach(walk);
            };
            root.childNodes.forEach(walk);
            return at ?? [root, root.childNodes.length];
        }
        // the selection in source terms, for "Mark as": [start, end, length] of the whole text's plain text
        function selOf(x) {
            if (x.tagName === 'TEXTAREA') return [x.selectionStart, x.selectionEnd, x.value.length];
            const sp = spot(x);
            const [a, b] = selIn(x) ?? [0, 0];
            if (!sp) return [0, 0, 0];
            const [s, e] = readSpan(sp.part, a, b);
            return [sp.s + s, sp.s + e, plain(sp.value).length];
        }

        // the words in an element, after a change: into the text, and the element (and every other showing it) redrawn
        // `coalesce`: a keystroke, which joins the ones before it in one step of ⌘Z
        function commit(sp, value, j, at, coalesce, to = at) {
            const kind = plain(value).length < plain(sp.value).length ? 'delete' : 'type';
            put(sp.path, value, sp.owner, j, at, to, coalesce ? kind : '');
        }
        function put(path, value, owner, j, at, to = at, typing = '') {
            noted = false;
            track(() => set(path, value), { at: { path, where: 'page', owner }, typing, typed: true });
            fill();
            liven();
            body.querySelectorAll('.sp-field').forEach((f) => {
                if (!f.paths().includes(path) || !f.input) return;
                f.input.value = plain(get(f.dataset.path));
                grow(f.input);
            });
            touched();
            const x = shownAt(owner, j) ?? shownAt(owner, Math.max(0, (spills.get(owner)?.length ?? 0)));
            if (!x) return;
            if (document.activeElement !== x) x.focus({ preventScroll: true });
            const n = domWords(x).length;
            caret(x, Math.min(at, n), Math.min(to, n));
            paintFloat();
        }
        let replaced = null; // the selection a change replaces, from beforeinput
        function reconcile(x) {
            const sp = spot(x);
            if (!sp) return;
            const before = readOf(sp.part).words.replace(/\u00a0/g, ' '); // as domWords reads the page: a non-breaking space in the words stays
            let now = domWords(x);
            if (now.endsWith('\n') && !before.endsWith('\n') && x.lastChild?.nodeName === 'BR') now = now.slice(0, -1); // the browser's placeholder
            if (now === before) return;
            const at = selIn(x)?.[1] ?? now.length;
            let a = 0;
            let b = 0;
            if (replaced && now.startsWith(before.slice(0, replaced[0])) && now.endsWith(before.slice(replaced[1])) && now.length - (before.length - replaced[1]) >= replaced[0]) {
                [a, b] = replaced;
            } else {
                while (a < before.length && a < now.length && before[a] === now[a]) a++;
                let end = 0;
                while (end < before.length - a && end < now.length - a && before[before.length - 1 - end] === now[now.length - 1 - end]) end++;
                b = before.length - end;
            }
            const typed = now.slice(a, now.length - (before.length - b)).replaceAll(OBJ, '');
            replaced = null;
            commit(sp, splice(sp.value, sp.s, sp.e, editRead(sp.part, a, b, typed)), sp.j, at, true);
        }
        // ⌘B, ⌘I, ⌘E (code) and ⌘K (a link) on the selection: its words stay, written again with the markup
        function format(x, how) {
            const sp = spot(x);
            const [a, b] = selIn(x) ?? [0, 0];
            if (!sp || a === b) { status('Select some words first'); return; }
            commit(sp, splice(sp.value, sp.s, sp.e, restyle(sp.part, a, b, how)), sp.j, a, false, b);
        }
        function linkAt(x) {
            const sp = spot(x);
            const [a, b] = selIn(x) ?? [0, 0];
            if (!sp || a === b) { status('Select some words first'); return; }
            // already a link: ⌘K takes it off
            const { at } = readOf(sp.part);
            const linked = runs(sp.part).filter((r) => r.link && !r.v).flatMap((r) => r.at);
            if (at.slice(a, b).every((i) => linked.includes(i))) { format(x, { link: null }); return; }
            float.querySelector('.sp-linkform')?.remove();
            const form = el('span', 'sp-newcat sp-linkform', '<input class="sp-newcat-about" placeholder="Link to https://…" aria-label="Link to" spellcheck="false">'
                + '<button type="button" class="sp-newcat-add">Link</button><button type="button" class="sp-newcat-x" aria-label="Cancel">×</button>');
            float.append(form);
            const input = form.querySelector('input');
            input.focus();
            const back = () => { form.remove(); x.focus(); caret(x, a, b); };
            const go = () => {
                const href = input.value.trim();
                form.remove();
                if (!href) { back(); return; }
                x.focus();
                caret(x, a, b);
                format(x, { link: { href: /^[a-z][\w+.-]*:|^[/#?.]/i.test(href) ? href : `https://${href}` } });
            };
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') back(); });
            form.querySelector('.sp-newcat-add').addEventListener('click', go);
            form.querySelector('.sp-newcat-x').addEventListener('click', back);
        }
        // typing that isn't left to the browser: a new paragraph, a line break, joining paragraphs, formatting
        function typeAt(x, words) {
            const sp = spot(x);
            const [a, b] = selIn(x) ?? [0, 0];
            commit(sp, splice(sp.value, sp.s, sp.e, editRead(sp.part, a, b, words)), sp.j, a + words.length);
        }
        document.addEventListener('beforeinput', (e) => {
            const x = liveOf(e.target);
            if (!x) return;
            replaced = selIn(x);
            const t = e.inputType;
            const sp = spot(x);
            if (!sp) { e.preventDefault(); return; }
            const long = isLong(sp.path, sp.value);
            if (/^format|^history|FromDrop$/.test(t)) {
                e.preventDefault();
                if (t === 'historyUndo') step(true);
                if (t === 'historyRedo') step(false);
                if (t === 'formatBold') format(x, { b: true });
                if (t === 'formatItalic') format(x, { i: true });
                return;
            }
            if (t === 'insertParagraph' || t === 'insertLineBreak') {
                e.preventDefault();
                if (t === 'insertParagraph' && SPLITS.test(sp.owner.tagName)) {
                    // a new paragraph: the words after the caret move to the element after this one
                    const [a, b] = replaced ?? [0, 0];
                    const part = editRead(sp.part, a, b, '');
                    const [s] = readSpan(part, a, a);
                    const next = splice(sp.value, sp.s, sp.e, fromChars(`${plain(part).slice(0, s)}\n\n${plain(part).slice(s)}`,
                        [...authorsByChar(part).slice(0, s), 'me', 'me', ...authorsByChar(part).slice(s)]));
                    commit(sp, next, sp.j + 1, 0);
                } else if (long) typeAt(x, '\n');
                return;
            }
            const [a, b] = replaced ?? [0, 0];
            // backspace at the start of a paragraph joins it to the one before; delete at its end, to the one after
            const join = a === b && ((t === 'deleteContentBackward' && a === 0 && sp.j > 0) || (t === 'deleteContentForward' && a === readOf(sp.part).words.length && sp.j < sp.spans.length - 1));
            if (join) {
                e.preventDefault();
                const k = t === 'deleteContentBackward' ? sp.j - 1 : sp.j;
                const keep = readOf(slice(sp.value, ...sp.spans[k])).words.length;
                commit(sp, splice(sp.value, sp.spans[k][1], sp.spans[k + 1][0], ''), k, keep);
            }
        });
        document.addEventListener('input', (e) => { const x = liveOf(e.target); if (x && !e.isComposing) reconcile(x); });
        document.addEventListener('compositionstart', (e) => { const x = liveOf(e.target); if (x) replaced = selIn(x); });
        document.addEventListener('compositionend', (e) => { const x = liveOf(e.target); if (x) reconcile(x); });
        document.addEventListener('paste', (e) => {
            const x = liveOf(e.target);
            if (!x) return;
            e.preventDefault();
            const sp = spot(x);
            const pasted = pastedIn(e);
            const words = pasted?.words ?? (e.clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n');
            const [a, b] = selIn(x) ?? [0, 0];
            let part = editRead(sp.part, a, b, words, pasted ? '\u0000' : 'me');
            if (pasted) {
                // copied from a text: each letter keeps its author (and an escape takes its letter's)
                const who = [];
                for (let i = 0; i < words.length; i++) { if (/[\\*`[\]{]/.test(words[i])) who.push(pasted.authors[i]); who.push(pasted.authors[i]); }
                part = overlay(part, authorsByChar(part).indexOf('\u0000'), who);
            }
            commit(sp, splice(sp.value, sp.s, sp.e, part), sp.j, a + words.length);
        }, true);
        document.addEventListener('drop', (e) => { if (liveOf(e.target)) e.preventDefault(); }, true);
        document.addEventListener('keydown', (e) => {
            const x = liveOf(e.target);
            if (!x) return;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); step(!e.shiftKey); return; }
            const style = { b: 'b', i: 'i', e: 'code' }[e.key.toLowerCase()];
            if ((e.metaKey || e.ctrlKey) && !e.altKey && style) { e.preventDefault(); format(x, { [style]: true }); return; }
            if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); linkAt(x); return; }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); return; }
            if (e.key === 'Escape') x.blur();
            e.stopPropagation(); // the page's own shortcuts stay out of the typing
        }, true);
        // the page's own handlers stay out of a click into a text, and a link in it isn't followed
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'].forEach((type) => document.addEventListener(type, (e) => {
            if (!liveOf(e.target)) return;
            e.stopPropagation();
            if (type === 'click' && e.target.closest('a')) e.preventDefault();
        }, true));
        document.addEventListener('focusin', (e) => {
            const x = liveOf(e.target);
            // the caret is in my color, as what's typed will be, not in the color of the words it's in. caret-color's
            // currentColor would be the words' own, so it's set here: my category's color, or the element's ink
            if (x) x.style.caretColor = colorOf('me', 0) ?? getComputedStyle(x).color;
            if (!x || x === liveEl) return;
            liveEl = x;
            const sp = spot(x);
            if (!sp) return;
            document.querySelectorAll('.slop-focus, .slop-copy').forEach((y) => y.classList.remove('slop-focus', 'slop-copy'));
            elementsOf(sp.path).forEach((y) => y.classList.add('slop-focus'));
            float.innerHTML = '';
            // a heading's switch covers its section
            const { owner, path } = sp;
            const paths = () => (rankOf(owner) ? sectionUnder(owner) : [path]);
            const under = () => paths().length - 1;
            floatCtl = control(paths, () => `"${where(path)}"${under() ? ` and ${count(under(), 'text')} under it` : ''}`, {
                id: `${rankOf(owner) ? 'section' : 'text'}:${path}`,
                scope: rankOf(owner) ? () => `This heading and ${count(under(), 'text')} under it` : null,
            });
            floatCtl.prepend(floatCtl.pie);
            float.append(floatCtl);
            showAssign(float, x, [sp.path]);
            float.hidden = false;
            numbers();
            paintFloat();
        });
        document.addEventListener('focusout', (e) => {
            if (!liveOf(e.target) && !float.contains(e.target)) return;
            // focus going to another text, or into the row (its switch, ⌘K's link form): the row stays. Without a click, focusout
            // comes before the focus lands, so where it's going is relatedTarget
            const to = e.relatedTarget;
            if (to && (liveOf(to) || float.contains(to))) return;
            afterClick(() => {
                const a = document.activeElement;
                if (liveOf(a) || float.contains(a)) return;
                hideFloat();
            });
        });
        // a heading's section on the page: it and every text after it up to the next heading as big or bigger, in the
        // heading's group of the block (so a page's title isn't the whole page)
        const rankOf = (x) => { const m = /^H([1-6])$/.exec(x.tagName); return m ? +m[1] : x.getAttribute('role') === 'heading' ? +(x.getAttribute('aria-level') || 2) : 0; };
        function sectionUnder(owner) {
            const path = owner.dataset.slop;
            const top = keysOf(path)[0];
            const out = [path];
            const all = [...document.querySelectorAll('[data-slop], [data-slop-attr], h1, h2, h3, h4, h5, h6, [role="heading"]')].filter((x) => !x.closest('.slop-panel, .slop-float, .slop-sampler'));
            if (!all.includes(owner)) return out;
            for (const x of all.slice(all.indexOf(owner) + 1)) {
                const r = rankOf(x);
                if (r && r <= rankOf(owner)) break;
                [x.dataset.slop, ...attrsOf(x).map(([, p]) => p)].forEach((p) => { if (p && keysOf(p)[0] === top && !out.includes(p) && valueAt(text, p) !== undefined) out.push(p); });
            }
            return out;
        }
        function hideFloat() {
            liveEl = null;
            floatCtl = null;
            float.hidden = true;
            document.querySelectorAll('.slop-focus, .slop-copy').forEach((y) => y.classList.remove('slop-focus', 'slop-copy'));
        }
        // above the text, or under it when there's no room
        function paintFloat() {
            if (!liveEl || float.hidden) return;
            const r = liveEl.getBoundingClientRect();
            const h = float.offsetHeight;
            const w = float.offsetWidth;
            const top = r.top - h - 10 > 8 ? r.top - h - 10 : r.bottom + 10;
            float.style.top = `${Math.round(top)}px`;
            float.style.left = `${Math.round(Math.min(Math.max(8, r.left), innerWidth - w - 8))}px`;
        }
        addEventListener('scroll', paintFloat, { capture: true, passive: true });
        addEventListener('resize', paintFloat);
        new ResizeObserver(paintFloat).observe(float); // a row that grows (a new category's form) moves up

        // saving: only with the Save button (or ⌘S), one request at a time, each carrying the version it was based on.
        // `saved` is the text as of the last save, for the Save button's count and each text's Revert
        let saved = JSON.parse(JSON.stringify(text));
        let busy = false;
        let stale = false;
        function valueAt(root, p) {
            let node = root;
            for (const key of keysOf(p)) node = node?.[key];
            return isText(node) ? node : undefined;
        }
        const savedAt = (p) => valueAt(saved, p);
        const differs = (p) => JSON.stringify(valueAt(text, p)) !== JSON.stringify(savedAt(p));
        // how many texts changed since the last save (and the categories, as one)
        function unsaved() {
            const paths = new Set([...entries(), ...entries(saved)].map(([p]) => p));
            let n = [...paths].filter(differs).length;
            const metaKeys = new Set([...Object.keys(text), ...Object.keys(saved)].filter((k) => k.startsWith('_')));
            n += [...metaKeys].filter((k) => JSON.stringify(text[k] ?? null) !== JSON.stringify(saved[k] ?? null)).length;
            return n;
        }
        const saveBtn = $('.sp-save');
        function paintSave() {
            const n = unsaved();
            saveBtn.disabled = !n || busy;
            saveBtn.textContent = busy ? 'Saving…' : n ? `Save ${n}` : 'Saved';
            saveBtn.title = n ? `Save ${count(n, 'change')} (⌘S)` : 'Everything is saved';
        }
        async function save() {
            if (busy || !unsaved()) return;
            if (stale) { status('This page is out of date: reload it to save (copy any edits first)', 'error'); return; }
            const body = JSON.stringify(text);
            if (mode === 'local') {
                // with the page as it was published, so the copy can be carried over to the author's next version
                const kept = store.set(LOCAL, JSON.stringify({ base: JSON.parse(original).version, baseText: JSON.parse(original), text: JSON.parse(body) }));
                if (!kept) { status("Couldn't save in this browser", 'error'); return; }
                saved = JSON.parse(body);
                keepDraft();
                savedStatus();
                numbers();
                return;
            }
            busy = true;
            paintSave();
            try {
                const res = await fetch('/__slop', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
                const out = await res.text();
                if (res.status === 409) { stale = true; throw new Error(out); }
                if (!res.ok) throw new Error(out || res.statusText);
                text.version = Number(out);
                saved = { ...JSON.parse(body), version: text.version };
                keepDraft();
                savedStatus();
            } catch (e) {
                status(`Couldn't save: ${e.message}`, 'error');
            } finally {
                busy = false;
                numbers();
            }
        }
        saveBtn.addEventListener('click', save);
        function touched() {
            numbers();
            changed();
            keepDraft();
            if (!stale && !noted) status(unsaved() ? 'Not saved yet' : 'No changes since the last save', unsaved() ? 'dirty' : '');
        }
        function reset() {
            store.drop(LOCAL);
            session.drop(DRAFT);
            text = JSON.parse(original);
            saved = JSON.parse(original);
            undos.length = 0;
            redos.length = 0;
            noted = false;
            applyColors();
            changed();
            render();
            savedStatus();
        }
        addEventListener('beforeunload', (e) => { if (busy || unsaved()) { e.preventDefault(); e.returnValue = ''; } });
        // a reload keeps what isn't saved, in this tab, still unsaved: a page in a frame (or a browser that skips the
        // prompt) can't ask before it goes. Kept only while the page's version is the one it was based on
        const DRAFT = `slop-draft:${pageKey()}`;
        const keepDraft = () => {
            if (unsaved() && !stale) session.set(DRAFT, JSON.stringify({ base: saved.version, text }));
            else session.drop(DRAFT);
        };
        addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && !aside.hidden) { e.preventDefault(); save(); }
            // ⌘Z and ⌘⇧Z outside a text too (a text's are caught there; a name or a link's address keeps its own)
            if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z' && !aside.hidden && !e.defaultPrevented && !e.target.closest?.('textarea, input, [contenteditable="true"]')) {
                e.preventDefault();
                step(!e.shiftKey);
            }
        });
        body.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.sp-hint')) return;
            const at = performance.now(); // a hint this click makes stays
            afterClick(() => body.querySelectorAll('.sp-hint').forEach((h) => { if (!(h.dataset.at > at)) h.hidden = true; }));
        });

        // while the editor is open, a click on a text opens it in the editor
        document.addEventListener('click', (e) => {
            if (aside.hidden || aside.contains(e.target) || float.contains(e.target)) return;
            const target = e.target.closest('[data-slop], [data-slop-ref], [data-slop-more], [data-slop-attr]');
            if (!target) return;
            // typed into where it is: the panel only shows its box
            if (liveOf(e.target)) { if (!inPlace) seek(pathOf(target)); return; }
            e.preventDefault();
            e.stopPropagation();
            const path = pathOf(target);
            if (!path) return;
            const s = setOf(path);
            if (state.tab === 'repeats' && s) show('repeats', s.paths[0]);
            else show(state.tab === 'slop' && hasSlop(path) ? 'slop' : 'all', path);
        }, true);

        /* moving and resizing: drag the header to move the editor, or an edge to resize it. On a narrow screen it's a
           sheet along the bottom, and dragging changes its height. Double-click the header to put it back */
        const RECT = 'slop-editor-rect';
        const MIN = { w: 300, h: 240 };
        const narrow = () => innerWidth <= 900;
        const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
        let rect = {};
        try { rect = JSON.parse(store.get(RECT)) ?? {}; } catch { /* docked */ }
        function place() {
            aside.removeAttribute('style');
            if (inPlace) return;
            if (narrow()) {
                if (rect.sheet) aside.style.height = `${clamp(rect.sheet, 200, innerHeight - 16)}px`;
                return;
            }
            if (!rect.box) return;
            const w = clamp(rect.box.w, MIN.w, innerWidth - 16);
            const h = clamp(rect.box.h, MIN.h, innerHeight - 16);
            Object.assign(aside.style, {
                left: `${clamp(rect.box.l, 8, innerWidth - w - 8)}px`, top: `${clamp(rect.box.t, 8, innerHeight - h - 8)}px`,
                width: `${w}px`, height: `${h}px`, right: 'auto', bottom: 'auto',
            });
        }
        function drag(e, edge) {
            if (e.button !== 0) return;
            e.preventDefault();
            const start = aside.getBoundingClientRect();
            const x0 = e.clientX;
            const y0 = e.clientY;
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            document.documentElement.classList.add('slop-dragging');
            const move = (ev) => {
                const dx = ev.clientX - x0;
                const dy = ev.clientY - y0;
                if (narrow()) { rect.sheet = Math.max(200, start.height - dy); place(); return; }
                let { left: l, top: t, width: w, height: h } = start;
                const sides = edge === 'move' ? '' : edge;
                if (edge === 'move') { l += dx; t += dy; }
                if (sides.includes('e')) w = Math.max(MIN.w, start.width + dx);
                if (sides.includes('s')) h = Math.max(MIN.h, start.height + dy);
                if (sides.includes('w')) { w = Math.max(MIN.w, start.width - dx); l = start.right - w; }
                if (sides.includes('n')) { h = Math.max(MIN.h, start.height - dy); t = start.bottom - h; }
                rect.box = { l, t, w, h };
                place();
            };
            const up = () => {
                target.removeEventListener('pointermove', move);
                target.removeEventListener('pointerup', up);
                target.removeEventListener('pointercancel', up);
                document.documentElement.classList.remove('slop-dragging');
                store.set(RECT, JSON.stringify(rect));
            };
            target.addEventListener('pointermove', move);
            target.addEventListener('pointerup', up);
            target.addEventListener('pointercancel', up);
        }
        const head = $('.sp-head');
        head.addEventListener('pointerdown', (e) => { if (!e.target.closest('button') && !inPlace) drag(e, 'move'); });
        head.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return;
            rect = {};
            store.drop(RECT);
            place();
        });
        aside.querySelectorAll('.sp-edge').forEach((x) => x.addEventListener('pointerdown', (e) => drag(e, x.dataset.edge)));
        addEventListener('resize', () => { if (!aside.hidden) place(); });

        const open = (on) => {
            aside.hidden = !on;
            document.documentElement.classList.toggle('slop-editing', on);
            editing = on;
            paintShow();
            livePage();
            if (!on) { mark(false); unreveal(); closePicker(); hideFloat(); return; }
            place();
            render();
        };
        modeBtn.addEventListener('click', () => setPlace(!inPlace));
        aside.querySelectorAll('.sp-seg button').forEach((b) => b.addEventListener('click', () => {
            if (b.dataset.show === shows()) return;
            withUndo(`Readers see: ${b.textContent.toLowerCase()}`, () => {
                if (b.dataset.show === 'nothing') delete text._show; // the default, so the block needn't say it
                else text._show = b.dataset.show;
            });
        }));
        aside.querySelectorAll('.sp-tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
        setPlace(inPlace);
        savedStatus();
        try {
            const draft = JSON.parse(session.get(DRAFT));
            if (draft?.base === saved.version && JSON.stringify(draft.text) !== JSON.stringify(text)) {
                text = draft.text;
                applyColors();
                changed();
                open(true);
                status('Unsaved changes from before the reload', 'dirty', {
                    label: 'Discard',
                    run: () => { text = JSON.parse(JSON.stringify(saved)); undos.length = 0; redos.length = 0; noted = false; session.drop(DRAFT); applyColors(); changed(); render(); savedStatus(); },
                });
            }
        } catch { /* none */ }
        // the editor is open from the start: the page's words can be typed into, and the bar (or the panel) is there
        if (aside.hidden) open(true);
        return { render: () => { if (!aside.hidden) render(); }, touched, open };
    }

    // after the page changes the text itself (Slop.set, Slop.remove): refill the page, rebuild the editor and save
    let ed = null;
    function refresh() {
        fill();
        paintMeters();
        ed?.render();
        ed?.touched();
    }
    function remove(path) {
        const keys = keysOf(path);
        let node = text;
        keys.slice(0, -1).forEach((key) => { node = node?.[key]; });
        if (node) delete node[keys[keys.length - 1]];
    }

    // set things up once the page has filled in Slop.vars. Options: code (the class `code` renders with),
    // edit: 'local' (an editor anyone can use, saving in their browser; under `slop-editor edit` it saves into the file),
    // key (the name the browser editor saves under, for a host that gives each version of the page an address of its
    // own; the page's path otherwise)
    function start(options = {}) {
        Object.assign(config, options);
        fill();
        document.querySelectorAll('[data-slop-meter]').forEach((x) => { meters.push(buildMeter(x)); });
        new MutationObserver((changes) => changes.forEach((c) => c.addedNodes.forEach(added))).observe(document.body, { childList: true, subtree: true });
        theme(true);
        const watch = new MutationObserver(theme);
        [document.documentElement, document.body].forEach((x) => watch.observe(x, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] }));
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', theme);
        setMeter(store.get('slop-o-meter') !== 'off'); // on unless this reader turned it off
        // the browser editor: what this visitor changed last time. If the author has published a new version since,
        // their changes win and the visitor's stay everywhere else (a copy saved before 0.4 has no baseText, so it's dropped)
        const local = () => {
            if (options.edit !== 'local') return;
            const key = `slop-text:${pageKey()}`;
            try {
                const saved = JSON.parse(store.get(key));
                if (saved?.base === text.version) { text = saved.text; applyColors(); changed(); }
                else if (saved?.baseText && saved.text) {
                    text = rebase(saved.baseText, saved.text, text);
                    store.set(key, JSON.stringify({ base: text.version, baseText: JSON.parse(original), text }));
                    applyColors();
                    changed();
                }
            } catch { /* nothing saved */ }
            ed = editor('local');
        };
        // the file editor only on this machine, under `slop-editor edit` (a GET there answers "slop-editor")
        if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return local();
        fetch('/__slop').then((res) => (res.ok ? res.text() : '')).then((s) => { if (s === 'slop-editor') ed = editor('file'); else local(); }).catch(local);
    }

    return { ...core, get, set, remove, entries, categories, html, words, paragraphs, fill, refresh, onChange, reveal, meter, start, get text() { return text; } };
})();
