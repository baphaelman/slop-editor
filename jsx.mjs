// `slop-editor install --auto Foo.jsx`: markup.mjs for React. It moves a component file's static prose into the text
// block and swaps each text for <SlopText path="…" />, and alt text and the like for slopAttrs. It reads the file with
// Babel but changes the source in place, so formatting, comments and everything else stay as they were. The cli loads
// this file only for a React file, so nothing else pays for the parser.
import { parse } from '@babel/parser';
import { PROSE, MIN_WORDS, escape, slug, words } from './markup.mjs';

const PROSE_TAG = new RegExp(`^(?:${PROSE})$`);
// elements that hold other prose: look inside them instead of taking them whole
const CONTAINER_TAG = /^(?:p|ul|ol|li|div|section|article|aside|table|blockquote|details|figure|dl|dd|dt|header|footer|main|h[1-6])$/;
const MARKS = { b: '**', strong: '**', i: '*', em: '*', code: '`' };
// a component that is a link: <ExternalLink href="https://…">words</ExternalLink>
const LINK_COMPONENT = /(?:Link|Anchor)$/;
// attributes whose words the editor lists under Hidden, and the group each goes in
const ATTRS = { alt: 'alt-text', title: 'tooltips', placeholder: 'placeholders', 'aria-label': 'labels' };
const MARKED = ['data-slop', 'data-slop-ref', 'data-slop-attr'];
const TAKEN_PROPS = ['as', 'path', 'vars'];

// JSX's own rule for the whitespace in a text: lines are trimmed, blank ones dropped, the rest joined with a space
function jsxText(value) {
    const lines = value.split(/\r\n|\n|\r/);
    let last = 0;
    lines.forEach((l, i) => { if (/[^ \t]/.test(l)) last = i; });
    let out = '';
    lines.forEach((line, i) => {
        let t = line.replace(/\t/g, ' ');
        if (i !== 0) t = t.replace(/^ +/, '');
        if (i !== lines.length - 1) t = t.replace(/ +$/, '');
        if (t) out += i === last ? t : `${t} `;
    });
    return out;
}

const tagOf = (el) => (el.openingElement.name.type === 'JSXIdentifier' ? el.openingElement.name.name : null);
const propOf = (el, name) => el.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name);
const stringOf = (attr) => {
    const v = attr?.value;
    if (v?.type === 'StringLiteral') return v.value;
    if (v?.type === 'JSXExpressionContainer') {
        if (v.expression.type === 'StringLiteral') return v.expression.value;
        if (v.expression.type === 'TemplateLiteral' && !v.expression.expressions.length) return v.expression.quasis[0].value.cooked;
    }
    return null;
};

// is there anything in it that reads as words, or that code builds? That's what's worth telling the user about
const hasWords = (el) => el.children.some((c) => (c.type === 'JSXText' && /\S/.test(c.value))
    || (c.type === 'JSXExpressionContainer' && c.expression.type !== 'JSXEmptyExpression') || (c.type === 'JSXElement' && hasWords(c)));

// JSX children -> the format's inline markup and the plain words, or null if they hold anything it can't say
function convert(children) {
    let md = '', plain = '';
    for (const c of children) {
        let text = null;
        if (c.type === 'JSXText') text = jsxText(c.value);
        else if (c.type === 'JSXExpressionContainer') {
            if (c.expression.type === 'JSXEmptyExpression') continue; // {/* a comment */}
            if (c.expression.type === 'StringLiteral') text = c.expression.value;
            else if (c.expression.type === 'TemplateLiteral' && !c.expression.expressions.length) text = c.expression.quasis[0].value.cooked;
            else return null;
        } else if (c.type === 'JSXElement') {
            const tag = tagOf(c);
            const attrs = c.openingElement.attributes;
            if (!tag || attrs.some((a) => a.type !== 'JSXAttribute' || typeof a.name.name !== 'string')) return null;
            let href = null, inner = c.children, mark;
            if (tag === 'a') {
                href = stringOf(propOf(c, 'href'));
                // an <a> keeps its href and may say where it opens; any other attribute would be lost
                if (!href || attrs.some((a) => !['href', 'target', 'rel'].includes(a.name.name))) return null;
            } else if (LINK_COMPONENT.test(tag)) {
                href = stringOf(propOf(c, 'href'));
                const kid = propOf(c, 'children');
                if (!/^https?:\/\//.test(href ?? '') || attrs.some((a) => !['href', 'children'].includes(a.name.name))) return null;
                if (kid) {
                    const label = stringOf(kid);
                    if (label === null || inner.length) return null;
                    inner = [{ type: 'JSXText', value: label }];
                }
            } else if (MARKS[tag] && !attrs.length) mark = MARKS[tag];
            else return null;
            if (href && /[()\s]/.test(href)) return null;
            const done = convert(inner);
            if (!done?.md) return null;
            md += href ? `[${done.md}](${href})` : `${mark}${done.md}${mark}`;
            plain += done.plain;
            continue;
        } else return null;
        md += escape(text);
        plain += text;
    }
    return { md: md.replace(/\s+/g, ' ').trim(), plain: plain.replace(/\s+/g, ' ').trim() };
}

// the component a node is in, for a hook: the nearest function named like one, with a block body
function componentOf(parents) {
    for (let i = parents.length - 1; i >= 0; i--) {
        const p = parents[i];
        if (!/^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(p.type)) continue;
        const name = p.id?.name ?? (parents[i - 1]?.type === 'VariableDeclarator' ? parents[i - 1].id.name : null);
        if (name && /^[A-Z]/.test(name)) return p.body.type === 'BlockStatement' ? p : null;
    }
    return null;
}

// source: the file's text. name: what its texts go under in the block (`articleOne`), and have: what's there already, so
// a second run never reuses a key. Returns the new source, the
// texts for the block ({group: {key: markup}}), and what it left alone: lines of prose it couldn't carry (`skipped`),
// of attributes it couldn't reach (`attrsLeft`) and of words in elements that aren't prose (`loose`)
export function moveJsx(source, { name, ts = false, have = {} }) {
    const ast = parse(source, { sourceType: 'module', plugins: ['jsx', ...(ts ? ['typescript'] : [])] });
    const found = [];
    const walk = (node, parents) => {
        if (node.type === 'JSXElement') found.push({ node, parents: [...parents] });
        parents.push(node);
        for (const key of Object.keys(node)) {
            if (key === 'loc' || key === 'extra') continue;
            const v = node[key];
            for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') walk(c, parents);
        }
        parents.pop();
    };
    walk(ast.program, []);
    found.sort((a, b) => a.node.start - b.node.start); // reading order, whichever way the tree was walked

    const edits = [], block = {}, skipped = [], taken = new Set();
    const used = new Set([...Object.values(ATTRS), ...Object.keys(have)]);
    const need = new Set(), hooks = new Map();
    const free = (group, key) => have[group]?.[key] === undefined && block[group]?.[key] === undefined;
    const unique = (group, key) => { let k = key, i = 2; while (!free(group, k)) k = `${key}-${i++}`; return k; };
    let group = 'intro', n = 0;

    for (const { node, parents } of found) {
        const tag = tagOf(node);
        if (!tag || !PROSE_TAG.test(tag) || parents.some((p) => taken.has(p))) continue;
        const attrs = node.openingElement.attributes;
        if (attrs.some((a) => a.type === 'JSXAttribute' && (MARKED.includes(a.name.name) || TAKEN_PROPS.includes(a.name.name)))) continue;
        const heading = /^h[1-6]$/.test(tag);
        if (!heading && node.children.some((c) => c.type === 'JSXElement' && CONTAINER_TAG.test(tagOf(c) ?? ''))) continue; // a container
        const done = convert(node.children);
        if (!done) { if (hasWords(node)) skipped.push(node.loc.start.line); continue; }
        if (!/\w/.test(done.md) || (!heading && words(done.md) < MIN_WORDS)) continue;
        let key;
        if (heading) {
            let g = slug(done.plain) || 'text', i = 2;
            while (used.has(g)) g = `${slug(done.plain) || 'text'}-${i++}`;
            used.add(group = g);
            n = 0;
            key = 'title';
        } else {
            used.add(group);
            key = `${tag}${++n}`;
            while (!free(group, key)) key = `${tag}${++n}`;
        }
        (block[group] ||= {})[key] = done.md;
        const rest = source.slice(node.openingElement.name.end, node.openingElement.end - (node.openingElement.selfClosing ? 2 : 1)).trim();
        edits.push({ start: node.start, end: node.end, text: `<SlopText path="${name}.${group}.${key}" as="${tag}"${rest ? ` ${rest}` : ''} />` });
        taken.add(node);
        need.add('SlopText');
    }

    // alt text, tooltips, placeholders and labels: slopAttrs, and useSlop() in the component so they follow edits
    const attrsLeft = [];
    let attrCount = 0;
    for (const { node, parents } of found) {
        const tag = tagOf(node);
        if (!tag || tag !== tag.toLowerCase() || taken.has(node) || parents.some((p) => taken.has(p))) continue;
        const attrs = node.openingElement.attributes;
        if (attrs.some((a) => a.type === 'JSXAttribute' && MARKED.includes(a.name.name))) continue;
        const hits = attrs.filter((a) => a.type === 'JSXAttribute' && ATTRS[a.name.name] && a.value?.type === 'StringLiteral' && /\w/.test(a.value.value));
        if (!hits.length) continue;
        const fn = componentOf(parents);
        if (!fn) { attrsLeft.push(node.loc.start.line); continue; }
        const pairs = hits.map((a) => {
            const g = ATTRS[a.name.name];
            const k = unique(g, slug(a.value.value) || 'text');
            (block[g] ||= {})[k] = a.value.value;
            return `${/^\w+$/.test(a.name.name) ? a.name.name : `'${a.name.name}'`}: '${name}.${g}.${k}'`;
        });
        attrCount += hits.length;
        edits.push({ start: hits[0].start, end: hits[0].end, text: `{...slopAttrs({ ${pairs.join(', ')} })}` });
        for (const a of hits.slice(1)) {
            let start = a.start;
            while (/\s/.test(source[start - 1])) start--;
            edits.push({ start, end: a.end, text: '' });
        }
        need.add('slopAttrs');
        hooks.set(fn, true);
    }
    for (const fn of hooks.keys()) {
        if (/\buseSlop\(/.test(source.slice(fn.body.start, fn.body.end))) continue;
        const first = fn.body.body[0];
        const line = first ? source.slice(source.lastIndexOf('\n', first.start - 1) + 1, first.start) : '';
        edits.push({ start: fn.body.start + 1, end: fn.body.start + 1, text: `\n${/^\s+$/.test(line) ? line : '    '}useSlop();` });
        need.add('useSlop');
    }

    // words sitting in an element that isn't prose (a span, an i, a div): not moved, but worth a line to the user
    const loose = found.filter(({ node, parents }) => {
        const tag = tagOf(node);
        return tag && tag === tag.toLowerCase() && !PROSE_TAG.test(tag) && !parents.some((p) => taken.has(p))
            && node.children.some((c) => c.type === 'JSXText' && words(jsxText(c.value)) >= MIN_WORDS);
    }).map(({ node }) => node.loc.start.line);

    // imports this left unused: a link component that's now a [label](url), say. Only names that were used before
    const imports = ast.program.body.filter((s) => s.type === 'ImportDeclaration');
    const apply = (list) => list.slice().sort((a, b) => b.start - a.start || b.end - a.end).reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), source);
    const bare = (text) => text.replace(/^import\b[\s\S]*?\bfrom\s*['"][^'"]+['"];?[ \t]*$/gm, '');
    const [was, now] = [bare(source), bare(apply(edits))];
    const uses = (text, name) => text.match(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))?.length ?? 0;
    const dropped = new Set();
    if (edits.length) {
        for (const decl of imports) {
            if (decl.source.value === 'slop-editor/react' || !decl.specifiers.length) continue;
            const gone = decl.specifiers.filter((sp) => uses(was, sp.local.name) && !uses(now, sp.local.name));
            if (gone.length === decl.specifiers.length) {
                const lead = source[decl.start - 1] === '\n' ? 1 : 0;
                edits.push({ start: decl.start - lead, end: decl.end, text: '' });
                dropped.add(decl);
            } else if (gone.length && gone.every((sp) => sp.type === 'ImportSpecifier')) {
                for (const sp of gone) {
                    const all = decl.specifiers.filter((x) => x.type === 'ImportSpecifier');
                    const i = all.indexOf(sp);
                    edits.push(i < all.length - 1 ? { start: sp.start, end: all[i + 1].start, text: '' } : { start: all[i - 1]?.end ?? sp.start, end: sp.end, text: '' });
                }
            }
        }
    }

    // the import
    const kept = imports.filter((d) => !dropped.has(d));
    const existing = imports.find((s) => s.source.value === 'slop-editor/react' && s.importKind !== 'type');
    const imported = new Set((existing?.specifiers ?? []).filter((s) => s.type === 'ImportSpecifier').map((s) => s.imported.name));
    const missing = [...need].filter((x) => !imported.has(x));
    if (missing.length && edits.length) {
        const named = existing?.specifiers.filter((s) => s.type === 'ImportSpecifier') ?? [];
        const plainDefault = existing?.specifiers.length && !existing.specifiers.some((s) => s.type === 'ImportNamespaceSpecifier');
        if (named.length) edits.push({ start: named.at(-1).end, end: named.at(-1).end, text: `, ${missing.join(', ')}` });
        else if (plainDefault) edits.push({ start: existing.specifiers.at(-1).end, end: existing.specifiers.at(-1).end, text: `, { ${missing.join(', ')} }` });
        else {
            const line = `import { ${missing.join(', ')} } from 'slop-editor/react';`;
            // after the last import, or after 'use client' and the like
            const after = kept.at(-1)?.end ?? ast.program.directives?.at(-1)?.end;
            edits.push(after === undefined ? { start: 0, end: 0, text: `${line}\n` } : { start: after, end: after, text: `\n${line}` });
        }
    }

    return { code: apply(edits), block, texts: edits.filter((e) => e.text.startsWith('<SlopText')).length, attrs: attrCount, skipped, attrsLeft, loose };
}
