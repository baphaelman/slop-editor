// `slop-editor install --auto`: move a page's static prose into the slop text block (as AI text, or the author asked for).
// It takes paragraphs, headings, list items, captions and quotes whose content is plain words with links, bold,
// italic and code, and leaves everything else (labels, buttons, spans, text with other markup, text the code builds)
// to whoever ported the page. Returns the new html and what it did.

export const PROSE = 'p|h[1-6]|li|dd|dt|figcaption|blockquote';
const SKIP = 'script|style|svg|textarea|pre|select|button|template|noscript|head|code|kbd|nav|label|form|iframe|canvas|math';
const BLOCKS = /<(?:p|ul|ol|li|div|h[1-6]|section|article|aside|table|blockquote|details|figure|dl|dd|dt|header|footer|main|br|img|span|svg|input|button|select|textarea)\b/i;
// elements that hold other prose: look inside them instead of taking them whole
const CONTAINERS = /<(?:p|ul|ol|li|div|section|article|aside|table|blockquote|details|figure|dl|dd|dt|header|footer|main|h[1-6])\b/i;
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export const MIN_WORDS = 3;

const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (all, d, x, n) =>
    d ? String.fromCodePoint(+d) : x ? String.fromCodePoint(parseInt(x, 16)) : (ENTITIES[n] ?? all));
export const escape = (s) => s.replace(/([\\*\[\]{}`])/g, '\\$1');

// inner HTML -> the format's inline markup, or null if it holds anything the format can't say
function convert(inner) {
    if (BLOCKS.test(inner) || /\{\{|\$\{|<%|<\?/.test(inner)) return null;
    let out = '', open = [], last = 0, bad = false;
    const re = /<(\/?)(a|b|strong|i|em|code)\b([^>]*)>|<[^>]*>/gi;
    const text = (s) => { out += escape(decode(s)); };
    for (let m; (m = re.exec(inner)); last = re.lastIndex) {
        text(inner.slice(last, m.index));
        if (!m[2]) { bad = true; break; }
        const tag = m[2].toLowerCase();
        if (m[1]) {
            const top = open.pop();
            if (top?.tag !== tag) { bad = true; break; }
            out += top.close;
            continue;
        }
        if (tag === 'a') {
            const href = /\bhref="([^"]*)"/i.exec(m[3])?.[1];
            if (!href || /[()\s]/.test(href)) { bad = true; break; }
            open.push({ tag, close: `](${decode(href)})` });
            out += '[';
        } else {
            const mark = tag === 'b' || tag === 'strong' ? '**' : tag === 'code' ? '`' : '*';
            open.push({ tag, close: mark });
            out += mark;
        }
    }
    if (bad || open.length) return null;
    text(inner.slice(last));
    return out.replace(/\s+/g, ' ').trim();
}

export const words = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`\\]/g, '').split(/\s+/).filter((w) => /\w/.test(w)).length;
export const slug = (s) => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/&\w+;/g, ' ').match(/[a-z0-9]+/g)?.slice(0, 2).join('-') || '';

export function markup(html) {
    const body = /<body\b[^>]*>/i.exec(html);
    const from = body ? body.index + body[0].length : 0;
    const re = new RegExp(`<(${SKIP})\\b[\\s\\S]*?</\\1\\s*>|<!--[\\s\\S]*?-->|<(${PROSE})\\b([^>]*)>([\\s\\S]*?)</\\2\\s*>`, 'gi');
    const text = {};
    const used = new Set();
    let group = 'intro', n = 0, out = html.slice(0, from), last = from, skipped = 0;
    re.lastIndex = from;
    for (let m; (m = re.exec(html));) {
        const [all, skip, tag, attrs, inner] = m;
        if (skip || !tag) continue;
        const t = tag.toLowerCase();
        const heading = /^h[1-6]$/.test(t);
        if (!heading && CONTAINERS.test(inner)) { re.lastIndex = m.index + all.indexOf('>') + 1; continue; } // a container: look inside it
        if (/\bdata-slop\b/.test(attrs)) continue;
        const converted = convert(inner);
        if (converted === null) { if (decode(inner).replace(/<[^>]*>/g, '').trim()) skipped++; continue; }
        if (!/\w/.test(converted) || (!heading && words(converted) < MIN_WORDS)) continue;
        let key;
        if (heading) {
            let g = slug(inner) || 'text', i = 2;
            while (used.has(g)) g = `${slug(inner) || 'text'}-${i++}`;
            used.add(group = g);
            n = 0;
            key = `${group}.title`;
        } else {
            used.add(group);
            key = `${group}.${t}${++n}`;
        }
        text[key] = converted;
        out += html.slice(last, m.index) + `<${tag}${attrs} data-slop="${key}"></${tag}>`;
        last = m.index + all.length;
    }
    out += html.slice(last);
    const block = { version: 1 };
    for (const [k, v] of Object.entries(text)) {
        const dot = k.indexOf('.');
        (block[k.slice(0, dot)] ||= {})[k.slice(dot + 1)] = v;
    }
    return { html: out, block, texts: Object.keys(text), skipped };
}
