#!/usr/bin/env node
// The slop editor's command line. No dependencies.
//
//   slop-editor install <page.html>   add the text block and inline slop.css and slop.js into a page (it stays one file)
//              [--auto]               also move the page's static prose (paragraphs, headings, list items) into the block
//   slop-editor sync <page.html …>    re-inline the current slop.css and slop.js into pages that have them
//   slop-editor edit <page.html>      serve the page's folder on localhost with the editor, which saves into the file
//                                     (it re-inlines the current code first, and serves slop.js/slop.css to a page that links them)
//              [--port 5178] [--no-open]
//   slop-editor check <page.html>     what the text is made of, the repeated text, and texts the page uses but the block lacks
//   slop-editor history <page.html>   what each git commit did to who wrote what (a page, or a block kept as .json)
import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { markup } from './markup.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STYLE = /(<style id="slop-css">)[\s\S]*?(<\/style>)/;
const SCRIPT = /(<script id="slop-js">)[\s\S]*?(<\/script>)/;
const BLOCK = /(<script type="application\/json" id="slop-text">)([\s\S]*?)(<\/script>)/;

// the format's functions, from slop.js itself (it returns only those outside a browser)
const Slop = new Function(`${await readFile(path.join(here, 'slop.js'), 'utf8')}\nreturn Slop;`)();

function readBlock(html, name) {
    if (name.endsWith('.json')) return JSON.parse(html); // a block kept in a file of its own
    const m = BLOCK.exec(html);
    if (!m) throw new Error(`${name} has no <script type="application/json" id="slop-text"> block (run install first)`);
    return JSON.parse(m[2]);
}
// JSON inside a <script>: "</" would end the element early
const serialize = (text) => '\n' + JSON.stringify(text, null, 2).replace(/<\//g, '<\\/') + '\n';
const inline = (s) => s.trimEnd().replace(/<\/(script|style)/gi, '<\\/$1');

/* ---------- install and sync ---------- */

async function sync(file) {
    const css = inline(await readFile(path.join(here, 'slop.css'), 'utf8'));
    const js = inline(await readFile(path.join(here, 'slop.js'), 'utf8'));
    const html = await readFile(file, 'utf8');
    if (!STYLE.test(html) || !SCRIPT.test(html)) throw new Error(`${file}: no slop-css or slop-js markers (run install first)`);
    const next = html.replace(STYLE, (_, a, b) => `${a}\n${css}\n${b}`).replace(SCRIPT, (_, a, b) => `${a}\n${js}\n${b}`);
    if (next !== html) await writeFile(file, next);
    console.log(`${next === html ? 'up to date' : 'synced'}: ${path.relative(process.cwd(), file)}`);
}

// the styles go at the end of <head>; the block and the code just before the page's first inline script (so that
// script can use Slop), or at the end of <body> with a Slop.start() of their own
function install(html) {
    let out = html;
    if (!STYLE.test(out)) {
        const tag = '<style id="slop-css"></style>\n';
        out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${tag}</head>`) : tag + out;
    }
    if (BLOCK.test(out) && SCRIPT.test(out)) return out;
    const parts = [];
    if (!BLOCK.test(out)) parts.push('<script type="application/json" id="slop-text">\n{\n  "version": 1\n}\n</script>');
    if (!SCRIPT.test(out)) parts.push('<script id="slop-js"></script>');
    const tag = parts.join('\n') + '\n';
    const first = /<script(?![^>]*\bsrc=)(?![^>]*\bid="slop-)(?![^>]*type="application\/(?:ld\+)?json")[^>]*>/i.exec(out);
    if (first) return out.slice(0, first.index) + tag + out.slice(first.index);
    if (/<\/body>/i.test(out)) return out.replace(/<\/body>/i, `${tag}<script>Slop.start();</script>\n</body>`);
    return `${out}\n${tag}<script>Slop.start();</script>\n`;
}

// --auto: the page's prose goes into the block as AI text, and Slop.start() runs once the marked elements exist
function auto(html) {
    const found = markup(html);
    const block = readBlock(html, 'the page');
    const { version, ...have } = block;
    const added = [];
    for (const [group, texts] of Object.entries(found.block)) {
        if (group === 'version') continue;
        for (const [key, value] of Object.entries(texts)) {
            if (have[group]?.[key] !== undefined) continue;
            (have[group] ||= {})[key] = value;
            added.push(`${group}.${key}`);
        }
    }
    let out = found.html.replace(BLOCK, (_, a, __, b) => a + serialize({ version, ...have }) + b);
    if (!/Slop\.start\(/.test(out)) {
        const script = /<script id="slop-js">[\s\S]*?<\/script>/.exec(out);
        const end = script.index + script[0].length;
        const direct = out.lastIndexOf('data-slop="') < script.index; // every marked element is above the script
        const call = direct ? '<script>Slop.start();</script>'
            : '<script>document.readyState === \'loading\' ? document.addEventListener(\'DOMContentLoaded\', () => Slop.start()) : Slop.start();</script>';
        out = out.slice(0, end) + '\n' + call + out.slice(end);
    }
    return { html: out, texts: found.texts.length, skipped: found.skipped };
}

/* ---------- check ---------- */

// every text in a block: [[path, value]]
function textsOf(text) {
    const entries = [];
    const walk = (node, at) => Object.entries(node).forEach(([k, v]) => {
        if (!at.length && (k === 'version' || k.startsWith('_'))) return; // not text
        if (typeof v === 'string' || Array.isArray(v)) entries.push([[...at, k].join('.'), v]);
        else if (v && typeof v === 'object') walk(v, [...at, k]);
    });
    walk(text, []);
    return entries;
}
const labelIn = (text) => (id) => text._categories?.[id]?.label || Slop.BUILTIN[id]?.label || id;

async function check(file) {
    const html = await readFile(file, 'utf8');
    const text = readBlock(html, file);
    const entries = textsOf(text);
    const paths = new Set(entries.map(([p]) => p));
    const m = Slop.makeup(entries.map(([, v]) => v));
    const label = labelIn(text);
    console.log(`${path.relative(process.cwd(), file)} (version ${text.version})`);
    console.log(`  ${m.allWords.toLocaleString()} words in ${entries.length} texts`);
    console.log(`  ${Object.entries(m.counts).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${label(id)} ${Slop.percent(n / m.letters)}`).join(' · ')}`);
    const left = entries.filter(([, v]) => Slop.makeup([v]).counts.ai);
    console.log(`  ${left.length} ${left.length === 1 ? 'text has' : 'texts have'} slop left`);
    const sets = Slop.repeats(entries);
    if (sets.length) console.log(`  repeated text:\n${sets.map((r) => `    "${r.words.slice(0, 60)}${r.words.length > 60 ? '…' : ''}": ${r.paths.join(', ')}`).join('\n')}`);
    // texts the page asks for: data-slop="…" (or data-slop-ref, data-slop-attr) in a tag, Slop.html('…') and Slop.words('…') in its code. Only a whole
    // string counts: Slop.html('caption' + n) builds its path, so its start isn't a text
    const page = html.replace(SCRIPT, '').replace(STYLE, '').replace(BLOCK, ''); // the page's own markup and code
    const used = new Set([...page.matchAll(/<[a-z][^>]*?\bdata-slop(?:-ref)?="([^"]+)"/gi), ...page.matchAll(/Slop\.(?:html|words|get)\(\s*(['"`])([\w.-]+)\1\s*[,)]/g)].map((m) => m[2] ?? m[1]));
    // and data-slop-attr="alt:hero.photo title:hero.tip"
    [...page.matchAll(/<[a-z][^>]*?\bdata-slop-attr="([^"]+)"/gi)].forEach((m) => m[1].split(/\s+/).forEach((pair) => { const at = pair.slice(pair.indexOf(':') + 1); if (pair.includes(':') && at) used.add(at); }));
    const missing = [...used].filter((p) => !paths.has(p));
    if (missing.length) console.log(`  missing from the block: ${missing.join(', ')}`);
    return missing.length ? 1 : 0;
}

/* ---------- edit ---------- */

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
};

// POST /__slop takes the whole text block. Its `version` must be the file's current one (otherwise 409: the file
// changed since the page loaded it), and every save bumps it. A GET answers "slop-editor": that's how the page knows
async function edit(file, { port, fixed, open }) {
    const root = path.dirname(file);
    const name = path.basename(file);
    const html = await readFile(file, 'utf8');
    readBlock(html, name); // fail now, not on the first save
    // a page that inlines the code gets this version's, so a page on its own stays current
    if (!name.endsWith('.json') && STYLE.test(html) && SCRIPT.test(html)) await sync(file);
    let queue = Promise.resolve(); // one save at a time
    const save = (body) => {
        const run = queue.then(async () => {
            const text = JSON.parse(body);
            if (!text || typeof text !== 'object' || Array.isArray(text) || typeof text.version !== 'number') {
                return [400, 'expected an object with a numeric "version"'];
            }
            const html = await readFile(file, 'utf8');
            const current = readBlock(html, name);
            if (text.version !== current.version) return [409, 'the file changed since this page loaded it. Reload the page (copy any unsaved edits first)'];
            const saved = { ...text, version: current.version + 1 };
            const tmp = `${file}.saving`;
            await writeFile(tmp, html.replace(BLOCK, (_, a, __, b) => a + serialize(saved) + b));
            await rename(tmp, file);
            return [200, String(saved.version)];
        });
        queue = run.catch(() => {});
        return run;
    };
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const send = (status, body, type = 'text/plain; charset=utf-8') => {
            res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
            res.end(body);
        };
        if (url.pathname === '/__slop') {
            // only the page being edited: another page in its folder would save its own block into this file
            let from = '/';
            try { from = decodeURIComponent(new URL(req.headers.referer).pathname); } catch { /* no referer: curl, say */ }
            if (from !== '/' && from !== `/${name}`) return req.method === 'POST' ? send(403, `this server edits ${name}`) : send(200, 'another page');
            if (req.method !== 'POST') return send(200, 'slop-editor');
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                try {
                    const [status, out] = await save(body);
                    if (status === 200) console.log(`saved version ${out}`);
                    send(status, out);
                } catch (e) {
                    send(400, e.message);
                }
            });
            return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, '');
        const target = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? `/${name}` : url.pathname));
        if (!target.startsWith(root + path.sep)) return send(403, 'outside the page\'s folder');
        try {
            if (!(await stat(target)).isFile()) return send(404, 'not found');
            send(200, await readFile(target), TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
        } catch {
            // a page that links slop.js and slop.css from elsewhere (a site's build serves them) gets this version's
            const own = path.basename(url.pathname);
            if (own === 'slop.js' || own === 'slop.css') return send(200, await readFile(path.join(here, own)), TYPES[path.extname(own)]);
            send(404, 'not found');
        }
    });
    // a port that's taken: the next one, unless the port was asked for. Taken means anything answers there, on
    // 127.0.0.1 or ::1: `localhost` can be either, and another dev server (Vite, say) may listen on ::1 only, where
    // binding 127.0.0.1 wouldn't notice it
    const answers = (host) => new Promise((resolve) => {
        const socket = net.connect({ port, host });
        const done = (yes) => { socket.destroy(); resolve(yes); };
        socket.once('connect', () => done(true)).once('error', () => done(false)).setTimeout(500, () => done(false));
    });
    const first = port;
    const taken = async () => (await answers('127.0.0.1')) || (await answers('::1'));
    const next = async () => {
        while (await taken()) {
            if (fixed || port >= first + 20) {
                console.error(`port ${port} is taken: try --port ${port + 1}`);
                process.exit(1);
            }
            port++;
        }
        server.listen(port, '127.0.0.1');
    };
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE' && !fixed && port < first + 20) { port++; next(); return; }
        console.error(e.code === 'EADDRINUSE' ? `port ${port} is taken: try --port ${port + 1}` : e.message);
        process.exit(1);
    });
    server.on('listening', () => {
        if (port !== first) console.log(`(port ${first} is taken)`);
        const link = `http://127.0.0.1:${port}/${encodeURIComponent(name)}`;
        console.log(`Editing ${name}: ${link}\nThe editor saves into the file. Ctrl+C to stop.`);
        if (!open) return;
        const [cmd, ...rest] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
        spawn(cmd, [...rest, link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    });
    await next();
}

/* ---------- history ---------- */

// what each commit did to who wrote what, from git's copies of the file: letters gained or lost by each category, and
// the share of slop after it. It's the author's own account, commit by commit, not proof of who wrote what
async function history(file) {
    const git = (...a) => new Promise((resolve, reject) => execFile('git', a, { cwd: path.dirname(file), maxBuffer: 1 << 28 }, (e, out) => (e ? reject(e) : resolve(out))));
    const name = `./${path.basename(file)}`;
    let log;
    try {
        log = await git('log', '--reverse', '--format=%h%x09%ad%x09%s', '--date=short', '--', name);
    } catch {
        throw new Error(`${file} isn't in a git repository`);
    }
    const versions = log.split('\n').filter(Boolean).map((line) => { const [sha, date, subject] = line.split('\t'); return { sha, date, subject }; });
    versions.push({ sha: null, date: 'now', subject: '(not committed)' });
    console.log(path.relative(process.cwd(), file));
    let before = null;
    let shown = 0;
    for (const v of versions) {
        let text;
        try {
            text = readBlock(v.sha ? await git('show', `${v.sha}:${name}`) : await readFile(file, 'utf8'), file);
        } catch { continue; } // no block in that version yet
        const entries = textsOf(text);
        const key = JSON.stringify(entries);
        if (before?.key === key) continue; // the commit didn't change the text
        const m = Slop.makeup(entries.map(([, val]) => val));
        const label = labelIn(text);
        // in the editor's order: mine, approved, the page's own, data, slop
        const rank = (id) => ({ me: 0, ok: 1, data: 3, ai: 4 })[id] ?? 2;
        const ids = [...new Set([...Object.keys(before?.m.counts ?? {}), ...Object.keys(m.counts)])].sort((a, b) => rank(a) - rank(b));
        const change = ids.map((id) => [id, (m.counts[id] ?? 0) - (before?.m.counts[id] ?? 0)]).filter(([, n]) => n)
            .map(([id, n]) => `${label(id)} ${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString()}`).join(' · ');
        const slop = Slop.percent(m.letters ? (m.counts.ai ?? 0) / m.letters : 0);
        console.log(`  ${v.date.padEnd(10)} ${(v.sha ?? '').padEnd(9)} slop ${slop.padStart(4)}  ${change || 'only moved or reworded'}  ${v.subject}`);
        before = { key, m };
        shown++;
    }
    if (!shown) console.log('  no versions with a text block');
    else console.log('\nLetters gained or lost by each category, per commit. It\'s what the author recorded, not proof of who wrote what.');
}

/* ---------- main ---------- */

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const portFlag = flag('--port') ?? process.env.PORT;
const port = Number(portFlag ?? 5178);
const autoFlag = args.includes('--auto') && args.splice(args.indexOf('--auto'), 1);
const noOpen = args.includes('--no-open') && args.splice(args.indexOf('--no-open'), 1);
const [cmd, ...rest] = args;
const files = rest.map((f) => path.resolve(f));
const usage = 'usage: slop-editor install <page.html> [--auto] | sync <page.html …> | edit <page.html> [--port N] [--no-open] | check <page.html …> | history <page.html>';

if (cmd !== 'help' && cmd && !files.length) {
    console.error(usage);
    process.exit(1);
}
try {
    if (cmd === 'install') {
        for (const file of files) {
            let html = install(await readFile(file, 'utf8'));
            if (autoFlag) {
                const done = auto(html);
                html = done.html;
                console.log(`${path.relative(process.cwd(), file)}: moved ${done.texts} texts into the block`
                    + (done.skipped ? `; ${done.skipped} more have markup it can't carry (spans, line breaks, icons): do those by hand` : ''));
            }
            await writeFile(file, html);
            await sync(file);
        }
        if (autoFlag) {
            console.log('\nStatic prose is done. Still yours to check: text the page\'s code builds (Slop.html / Slop.words), text shown only\n'
                + 'sometimes (Slop.reveal), and anything that reads an element\'s text before Slop.start() or after an edit (Slop.onChange).\n'
                + 'Then: slop-editor check <page.html>, and slop-editor edit <page.html>');
        } else console.log('\nNext: mark text elements with data-slop="group.key" and put their words in the slop-text block\n'
            + '(as AI text to start). Add <div data-slop-meter></div> at the top (readers see\n'
            + 'nothing there unless you pick a pie chart or colors in the editor). Call Slop.start() once Slop.vars is\n'
            + 'set and before anything reads the text. Then: slop-editor edit <page.html>');
    } else if (cmd === 'sync') {
        for (const file of files) await sync(file);
    } else if (cmd === 'edit') {
        await edit(files[0], { port, fixed: portFlag != null, open: !noOpen });
    } else if (cmd === 'check') {
        let status = 0;
        for (const file of files) status |= await check(file);
        process.exitCode = status;
    } else if (cmd === 'history') {
        for (const file of files) await history(file);
    } else {
        console.log(usage);
    }
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
