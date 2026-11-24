/* Slop editor: who wrote every word on a page. MIT license.

   The words live in the page's text block, a JSON script element with the id "slop-text": an object with a
   top-level "version" and groups (objects) of texts in reading order. A text is a plain string (the AI's words) or a
   list of pieces: a string (the AI's), {"me": "..."} (mine: typed in the editor, or dictated word for word),
   {"ok": "..."} (the AI's words, approved as they are), {"data": "..."} (a fact, or someone else's words quoted), or
   {"<category>": "..."} for a category the page defines. A list is always one text.
   Top-level keys that start with "_" aren't text: "_categories" holds the page's own categories and colors,
   {"<id>": {"label": "...", "color": "#rrggbb"}}, for built-in ones too, and "_show" what readers see: "nothing" (the
   default), "pie" (a pie of who wrote what, with a legend) or "colors" (the Slop-o-meter switch, which colors the words).
   Inside any text: [label](url) is a link, **bold**, *italic*, `code`, [[key]] a key cap, {name} a value the page
   fills in (Slop.vars), and \ makes the next character literal.

   A blank line starts a new paragraph in a <p>, <li> or <dd>.

   Elements with data-slop="group.key" are filled from the block. Code renders the rest with Slop.html(path). An
   element with data-slop-list="group" shows each text in that group in a copy of its first child, and the editor can
   add and remove texts there (data-slop-list-ref: the page draws them itself).
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

    const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/y;
    const VAR = /\{(\w+)\}/y;
    const same = (a, b) => a.by === b.by && a.link === b.link && a.b === b.b && a.i === b.i && a.code === b.code && a.key === b.key;

    // the text as it reads: runs of one author's words (`by`: the category) with their formatting (b, i, code, key)
    // and the link they sit in, if any. A {name} is a run of its own with `v` set
    function runs(value) {
        const text = plain(value);
        const authors = authorsByChar(value);
        const out = [];
        const st = { b: false, i: false, code: false, key: false, link: null };
        let linkEnd = -1;
        let linkTail = 0;
        const push = (s, by, v) => {
            const run = { text: s, by, link: st.link, b: st.b, i: st.i, code: st.code, key: st.key, v };
            const last = out[out.length - 1];
            if (last && !last.v && !v && same(last, run)) last.text += s;
            else out.push(run);
        };
        for (let i = 0; i < text.length;) {
            const c = text[i];
            if (i === linkEnd) { st.link = null; i += linkTail; linkEnd = -1; continue; }
            if (c === '\\' && i + 1 < text.length) { push(text[i + 1], authors[i + 1]); i += 2; continue; }
            if (c === '[' && text[i + 1] === '[' && !st.key) { st.key = true; i += 2; continue; }
            if (c === ']' && text[i + 1] === ']' && st.key) { st.key = false; i += 2; continue; }
            if (c === '[' && !st.link) {
                LINK.lastIndex = i;
                const m = LINK.exec(text);
                if (m) { st.link = { href: m[2] }; linkEnd = i + 1 + m[1].length; linkTail = m[0].length - m[1].length - 1; i++; continue; }
            }
            if (c === '`') { st.code = !st.code; i++; continue; }
            if (c === '*' && !st.code) {
                if (text[i + 1] === '*') { st.b = !st.b; i += 2; } else { st.i = !st.i; i++; }
                continue;
            }
            if (c === '{') {
                VAR.lastIndex = i;
                const m = VAR.exec(text);
                if (m) { push('', authors[i], m[1]); i += m[0].length; continue; }
            }
            push(c, authors[i]);
            i++;
        }
        return out;
    }

    // a text in paragraphs: split at blank lines, each keeping its authors. Without a blank line it's one paragraph
    function paragraphsOf(value) {
        const text = plain(value);
        const authors = authorsByChar(value);
        const spans = [];
        const gap = /\n[ \t]*\n\s*/g;
        let at = 0;
        for (let m; (m = gap.exec(text));) { spans.push([at, m.index]); at = m.index + m[0].length; }
        if (!spans.length) return [value];
        spans.push([at, text.length]);
        const parts = spans.map(([s, e]) => fromChars(text.slice(s, e), authors.slice(s, e))).filter((p) => plain(p).trim());
        return parts.length ? parts : [value];
    }

    // values the page fills in: {html, data} (data: a fact, shown in the data color; otherwise it takes the color of
    // whoever wrote the {name}), or a plain string or number (a fact)
    const vars = {};
    const config = { code: 'code' };
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
        const one = (run) => {
            let h;
            let by = run.by;
            if (run.v) {
                const v = lookup(run.v, local);
                h = v.html;
                if (v.data) by = 'data';
            } else h = esc(run.text).replace(/\n/g, '<br>');
            h = `<span class="${cls(by)}">${h}</span>`;
            if (run.key) h = `<kbd>${h}</kbd>`;
            if (run.code) h = `<span class="${config.code}">${h}</span>`;
            if (run.i) h = `<em>${h}</em>`;
            if (run.b) h = `<strong>${h}</strong>`;
            return h;
        };
        const parts = [];
        runs(value).forEach((run) => {
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

    const core = { BUILTIN, plain, applyEdit, reslop, unslop, assign, reattribute, runs, readable, render, makeup, share, percent, repeats, rebase, wordsOf, paragraphsOf, vars };
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
    function fillOne(el) {
        const local = el.dataset.slopVars ? JSON.parse(el.dataset.slopVars) : undefined;
        if (el.dataset.slop) {
            const value = get(el.dataset.slop);
            const parts = SPLITS.test(el.tagName) ? paragraphsOf(value) : [value];
            const h = render(parts[0], local);
            if (el.innerHTML !== h) el.innerHTML = h;
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
                ['id', 'data-slop', 'data-slop-attr'].forEach((a) => c.removeAttribute(a));
                c.classList.remove('slop-focus', 'slop-copy', 'slop-empty');
                ownerOf.set(c, el);
                copies.push(c);
            }
            c.dataset.slopMore = el.dataset.slop;
            if (c.innerHTML !== h) c.innerHTML = h;
            const before = i ? copies[i - 1] : el;
            if (before.nextElementSibling !== c) before.after(c);
        });
        if (copies.length) spills.set(el, copies); else spills.delete(el);
    }
    // a list: an element with data-slop-list="group" shows the group's paragraphs (p1, p2, …), in order, each in a copy
    // of the first. The group's other texts (a title, a caption) and the element's other children stay where they
    // are. (With data-slop-list-ref, the page draws them itself.) Either way, the editor can add and remove paragraphs
    const isParagraph = (key) => /^p\d+$/.test(key);
    const templates = new WeakMap(); // list → the element its paragraphs are copies of
    function fillList(box) {
        const at = box.dataset.slopList;
        const ours = (x) => x.dataset.slop?.startsWith(`${at}.`) && isParagraph(x.dataset.slop.slice(at.length + 1));
        if (!templates.has(box)) {
            const first = [...box.children].find(ours);
            if (!first) return;
            const t = first.cloneNode(false);
            ['id', 'data-slop'].forEach((a) => t.removeAttribute(a));
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
        root.querySelectorAll('[data-slop-list]').forEach(fillList);
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
        if (n.nodeType !== 1 || n.closest('.slop-panel')) return;
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
    // author sees the colors whatever readers get
    const SHOW = ['nothing', 'pie', 'colors'];
    const shows = () => (SHOW.includes(text._show) ? text._show : 'nothing');
    const meters = [];
    const built = new WeakMap(); // element → its meter
    let meterOn = false;
    let editing = false;
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
        document.documentElement.classList.toggle('slop-on', editing || (mode === 'colors' && meterOn));
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
            m.btn.setAttribute('aria-pressed', String(m.own ?? meterOn));
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
            legend.innerHTML = cats.filter((c) => m.counts[c.id])
                .map((c) => `<span class="slop-key" tabindex="0" data-id="${esc(c.id)}" style="color:${swatch(c)}"><i style="background:${swatch(c)}"></i>${esc(c.label)}<b class="slop-pct">${percent(m.counts[c.id] / m.letters)}</b></span>`).join('');
        });
    }
    function buildMeter(el) {
        el.classList.add('slop-meter');
        el.innerHTML = '<button type="button" class="slop-meter-btn" aria-pressed="false"><span class="slop-switch" aria-hidden="true"></span>Slop-o-meter</button>'
            + '<span class="slop-meter-key"><span class="slop-pie" role="img"></span><span class="slop-legend"></span></span>';
        const m = { el, at: el.dataset.slopMeter || '', own: null, section: null, btn: el.querySelector('button'), pie: el.querySelector('.slop-pie'), legend: el.querySelector('.slop-legend') };
        m.btn.addEventListener('click', () => {
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
    const listed = () => new Set([...document.querySelectorAll('[data-slop-list], [data-slop-list-ref]')].map((x) => x.dataset.slopList || x.dataset.slopListRef));
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
        const LOCAL = `slop-text:${location.pathname}`;
        // open: the first section, and any the page adds later (pasted text, say)
        // it opens on Repeats, or on Slop left when nothing is repeated
        const state = { tab: startTab(), open: new Set(groupKeys().slice(0, 1)), known: new Set(groupKeys()), focus: null };
        let sets = repeats(entries());
        let controls = []; // [{el, paths}] in the current view, repainted by numbers()
        let undo = null;

        const btn = el('button', 'slop-edit-btn', 'Edit text');
        btn.type = 'button';
        const aside = el('aside', 'slop-panel', `
          <header class="sp-head" title="Drag to move, or drag an edge to resize. Double-click to put it back">
            <span class="sp-grip" aria-hidden="true"></span>
            <div><h2>Edit text</h2><p class="sp-status" role="status" aria-live="polite"></p></div>
            <button type="button" class="sp-save" title="Save (⌘S)" disabled>Saved</button>
            <button type="button" class="sp-close" aria-label="Close the editor">×</button>
          </header>
          <div class="sp-cover">
            <div class="sp-cover-row"><p class="sp-big"><b></b> slop</p><p class="sp-words"></p></div>
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
        document.body.append(btn, aside);
        const $ = (sel) => aside.querySelector(sel);
        const body = $('.sp-body');
        const statusEl = $('.sp-status');
        const pageControl = control(() => entries().map(([p]) => p), 'the whole page');
        $('.sp-cover-row').append(pageControl);

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

        // any change to who wrote what (the slop switch, marking text, deleting a category) can be undone
        function withUndo(what, change) {
            const before = JSON.stringify(text);
            change();
            if (JSON.stringify(text) === before) return false;
            touched();
            if (state.tab === 'slop') render(); else numbers();
            undo = before;
            status(what, '', {
                label: 'Undo',
                run: () => {
                    if (!undo) return;
                    const version = text.version;
                    text = JSON.parse(undo);
                    text.version = version;
                    undo = null;
                    applyColors();
                    touched();
                    render();
                },
            });
            return true;
        }

        /* the slop switch, next to a pie of what the texts are made of. A text's or section's row takes the pie out, to
           sit by its name, and puts the switch at the end (c.pie, c.toggle) */
        function control(paths, what, after) {
            const c = el('span', 'sp-ctl', '<span class="sp-pie" role="img"></span>'
                + '<button type="button" class="sp-toggle" role="switch"><span class="sp-switch" aria-hidden="true"></span>slop</button>');
            const toggle = c.querySelector('.sp-toggle');
            toggle.addEventListener('click', (e) => {
                e.preventDefault(); // in a section's summary, don't open or close it
                const on = toggle.getAttribute('aria-checked') === 'true';
                const done = withUndo(on ? `Approved ${what}` : `Back to slop: ${what}`, () => paths().forEach((p) => set(p, on ? unslop(get(p)) : reslop(get(p)))));
                if (done) after?.(on);
            });
            c.pie = c.querySelector('.sp-pie');
            c.toggle = toggle;
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
            toggle.title = on ? 'Slop. Switch it off to approve the AI\'s words as they are'
                : m.counts.ok ? 'Approved. Switch it on to make it slop again' : 'No AI-generated words here';
        }

        /* categories: a color picker and a name for each, and how much of the page is theirs */
        const own = (id) => { text._categories ??= {}; return (text._categories[id] ??= {}); };
        const slug = (label) => {
            const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
            let id = base;
            for (let n = 2; id in BUILTIN || text._categories?.[id] || categories().some((c) => c.id === id); n++) id = `${base}-${n}`;
            return id;
        };
        function renderCats() {
            const box = $('.sp-cats');
            box.innerHTML = '';
            categories().forEach((cat) => {
                const row = el('span', 'sp-cat', `<label class="sp-swatch" title="Pick a color for ${esc(cat.label)}"><input type="color"></label>`
                    + `<input class="sp-cat-name" aria-label="Category name" spellcheck="false"><b class="sp-cat-pct"></b>`
                    + (cat.builtin ? '' : `<button type="button" class="sp-cat-x" title="Delete ${esc(cat.label)}: its words become AI-generated">×</button>`));
                row.dataset.id = cat.id;
                const picker = row.querySelector('input[type="color"]');
                picker.value = hex(swatch(cat));
                row.querySelector('.sp-swatch').style.background = swatch(cat);
                picker.addEventListener('input', () => {
                    own(cat.id).color = picker.value;
                    row.querySelector('.sp-swatch').style.background = picker.value;
                    applyColors();
                    touched();
                });
                const name = row.querySelector('.sp-cat-name');
                name.value = cat.label;
                name.size = Math.max(3, cat.label.length);
                name.addEventListener('input', () => {
                    name.size = Math.max(3, name.value.length);
                    own(cat.id).label = name.value.trim();
                    touched();
                });
                name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
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
                const done = (keep) => {
                    if (finished) return;
                    finished = true;
                    const label = input.value.trim();
                    if (keep && label) {
                        const id = slug(label);
                        const color = PALETTE[categories().filter((c) => !c.builtin).length % PALETTE.length];
                        Object.assign(own(id), { label, color });
                        applyColors();
                        touched();
                    }
                    render();
                };
                input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
                input.addEventListener('blur', () => done(true), { once: true });
            });
            box.append(add);
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
                    let [s, e] = [input.selectionStart, input.selectionEnd];
                    const whole = s === e;
                    if (whole) [s, e] = [0, input.value.length];
                    withUndo(`Marked ${whole ? 'the text' : 'the selection'} as ${cat.label}`, () => paths.forEach((p) => set(p, assign(get(p), s, e, cat.id))));
                });
                assignEl.append(b);
            });
            assignLabel(input);
            if (wrap.insert) wrap.insert.before(assignEl); else wrap.append(assignEl); // the + stays last
        }
        const assignLabel = (input) => {
            if (assignEl.firstChild) assignEl.firstChild.textContent = input.selectionStart === input.selectionEnd ? 'Mark all as' : 'Mark selection as';
        };

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
            const ctl = control(paths, all ? count(all.paths.length, 'copy', 'copies') : `"${where(path)}"`, all ? null : (approved) => {
                const others = (setOf(path)?.paths ?? []).filter((p) => p !== path);
                if (!others.length) return;
                const how = approved ? unslop : reslop;
                hint(wrap, `Only this copy changed. ${count(others.length, 'other copy', 'other copies')} didn't.`, {
                    label: others.length === 1 ? 'Change it too' : 'Change them too',
                    run: () => withUndo(`${approved ? 'Approved' : 'Back to slop:'} ${count(others.length + 1, 'copy', 'copies')}`, () => others.forEach((p) => set(p, how(get(p))))),
                });
            });
            row.before(ctl.pie);
            if (listItem) row.append(removeButton(path, wrap));
            row.append(ctl);
            // the stretch a keystroke or a paste replaces: the selection, or nothing at the caret
            input.addEventListener('beforeinput', () => { input.at = [input.selectionStart, input.selectionEnd]; });
            input.addEventListener('input', (e) => {
                const restoring = /^history(Undo|Redo)$/.test(e.inputType);
                edit(paths(), input, restoring, restoring || e.isComposing || /Composition/.test(e.inputType) ? undefined : input.at);
                input.at = undefined;
            });
            ['select', 'keyup', 'pointerup'].forEach((t) => input.addEventListener(t, () => assignLabel(input)));
            input.addEventListener('focus', () => { focus(path, all, input, wrap); showAssign(wrap, input, paths()); });
            input.addEventListener('blur', () => {
                mark(false);
                // after the click that moved the focus lands: removing these first would move what's being clicked
                afterClick(() => {
                    if (document.activeElement === input) return;
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
            const ctl = control(all, `"${groupTitle(key)}"`);
            det.querySelector('.sp-gname').after(ctl.pie);
            det.querySelector('summary').append(ctl);
            det.addEventListener('toggle', () => {
                if (det.open) { state.open.add(key); det.querySelectorAll('textarea').forEach(grow); } else state.open.delete(key);
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
            controls = [controls.find((c) => c.el === pageControl)];
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
            $('.sp-big b').textContent = percent(page.letters ? (page.counts.ai ?? 0) / page.letters : 0);
            $('.sp-words').textContent = count(page.allWords, 'word');
            aside.querySelectorAll('.sp-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.show === shows())));
            aside.querySelectorAll('.sp-cat').forEach((row) => {
                row.querySelector('.sp-cat-pct').textContent = percent(page.letters ? (page.counts[row.dataset.id] ?? 0) / page.letters : 0);
            });
            controls.forEach((c) => paintControl(c, cats));
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
        reseen = () => { if (!aside.hidden) body.querySelectorAll('.sp-field').forEach(paintSeen); };
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

        const grow = (x) => { x.style.height = 'auto'; x.style.height = `${x.scrollHeight + 2}px`; };

        // typing: what you type is yours, the rest keeps its author
        // ⌘Z in a text: the words come back with whoever wrote them, from each text's recent versions
        const past = new Map(); // path → [value, …], oldest first
        function remember(p) {
            const list = past.get(p) ?? [];
            const v = get(p);
            if (JSON.stringify(list.at(-1)) !== JSON.stringify(v)) list.push(v);
            past.set(p, list.slice(-200));
        }
        const recall = (p, words) => past.get(p)?.findLast((v) => plain(v) === words);
        function edit(paths, input, restoring, at) {
            undo = null;
            const f = state.focus;
            [...paths, ...(f?.linked ?? [])].forEach((p) => {
                remember(p);
                set(p, applyEdit(get(p), input.value, restoring ? recall(p, input.value) : undefined, at));
                remember(p);
            });
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
                undo = null;
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
                undo = null;
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
            if (!stale && !undo) status(unsaved() ? 'Not saved yet' : 'No changes since the last save', unsaved() ? 'dirty' : '');
        }
        function reset() {
            store.drop(LOCAL);
            session.drop(DRAFT);
            text = JSON.parse(original);
            saved = JSON.parse(original);
            undo = null;
            applyColors();
            changed();
            render();
            savedStatus();
        }
        addEventListener('beforeunload', (e) => { if (busy || unsaved()) { e.preventDefault(); e.returnValue = ''; } });
        // a reload keeps what isn't saved, in this tab, still unsaved: a page in a frame (or a browser that skips the
        // prompt) can't ask before it goes. Kept only while the page's version is the one it was based on
        const DRAFT = `slop-draft:${location.pathname}`;
        const keepDraft = () => {
            if (unsaved() && !stale) session.set(DRAFT, JSON.stringify({ base: saved.version, text }));
            else session.drop(DRAFT);
        };
        addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's' && !aside.hidden) { e.preventDefault(); save(); }
            // ⌘Z outside a text undoes the last switch or mark (a text's own ⌘Z undoes its typing)
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'z' && undo && !aside.hidden && !e.target.closest?.('textarea, input')) {
                e.preventDefault();
                statusEl.querySelector('.sp-link')?.click();
            }
        });
        body.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.sp-hint')) return;
            const at = performance.now(); // a hint this click makes stays
            afterClick(() => body.querySelectorAll('.sp-hint').forEach((h) => { if (!(h.dataset.at > at)) h.hidden = true; }));
        });

        // while the editor is open, a click on a text opens it in the editor
        document.addEventListener('click', (e) => {
            if (aside.hidden || aside.contains(e.target) || btn.contains(e.target)) return;
            const target = e.target.closest('[data-slop], [data-slop-ref], [data-slop-more], [data-slop-attr]');
            if (!target) return;
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
        head.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) drag(e, 'move'); });
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
            btn.hidden = on;
            document.documentElement.classList.toggle('slop-editing', on);
            editing = on;
            paintShow();
            if (!on) { mark(false); unreveal(); return; }
            place();
            render();
        };
        btn.addEventListener('click', () => open(true));
        $('.sp-close').addEventListener('click', () => open(false));
        aside.querySelectorAll('.sp-seg button').forEach((b) => b.addEventListener('click', () => {
            if (b.dataset.show === shows()) return;
            withUndo(`Readers see: ${b.textContent.toLowerCase()}`, () => {
                if (b.dataset.show === 'nothing') delete text._show; // the default, so the block needn't say it
                else text._show = b.dataset.show;
            });
        }));
        aside.querySelectorAll('.sp-tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
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
                    run: () => { text = JSON.parse(JSON.stringify(saved)); session.drop(DRAFT); applyColors(); changed(); render(); savedStatus(); },
                });
            }
        } catch { /* none */ }
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
    // edit: 'local' (an editor anyone can use, saving in their browser; under `slop-editor edit` it saves into the file)
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
            const key = `slop-text:${location.pathname}`;
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
