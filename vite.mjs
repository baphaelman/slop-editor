// slop-editor/vite: the slop editor in a Vite app. The words live in one JSON file (src/slopText.json). This puts them in
// the page as its text block, with slop.js and slop.css, which render them, and under `vite` (not a build) it answers
// the editor: its Edit text button appears on the page and saves back into the file. A built site has no editor.
//
//   import slopEditor from 'slop-editor/vite';
//   export default defineConfig({ plugins: [react(), slopEditor()] });   // or slopEditor({ text: 'content/words.json' })
//
// The file's `version` goes up with every save, so a page that loaded an older version can't save over what changed
// since. Edit the file directly (an agent, say) and the open page reloads. MIT license.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// where a project keeps its words unless it says: the file that's there, else src/slopText.json (or slopText.json in a
// project with no src). `slop-editor install` makes the same choice
export const textFileIn = (root) => ['src/slopText.json', 'slopText.json'].find((f) => existsSync(path.join(root, f)))
    ?? (existsSync(path.join(root, 'src')) ? 'src/slopText.json' : 'slopText.json');

export default function slopEditor({ text } = {}) {
    let file;
    let lastSaved = null; // the version this server wrote last, so its own saves don't reload the page
    const read = async () => {
        try {
            return await readFile(file, 'utf8');
        } catch {
            throw new Error(`slop-editor/vite: ${path.relative(process.cwd(), file)} not found. Run \`npx slop-editor install --auto <a .jsx or .tsx file>\` to make it, or write {"version": 1}`);
        }
    };
    return {
        name: 'slop-editor',
        configResolved(config) {
            file = path.resolve(config.root, text ?? textFileIn(config.root));
        },
        async transformIndexHtml() {
            const [words, js, css] = await Promise.all([read(), readFile(path.join(here, 'slop.js'), 'utf8'), readFile(path.join(here, 'slop.css'), 'utf8')]);
            // compact, and safe inside a script element
            const block = JSON.stringify(JSON.parse(words)).replace(/</g, '\\u003c');
            return [
                { tag: 'style', children: css, injectTo: 'head' },
                { tag: 'script', attrs: { type: 'application/json', id: 'slop-text' }, children: block, injectTo: 'body-prepend' },
                { tag: 'script', children: js.replace(/<\/script/gi, '<\\/script'), injectTo: 'body' },
            ];
        },
        configureServer(server) {
            server.watcher.add(file);
            server.watcher.on('change', async (changed) => {
                if (path.resolve(changed) !== file) return;
                try {
                    if (JSON.parse(await readFile(file, 'utf8')).version === lastSaved) return;
                } catch {
                    return; // halfway through being written
                }
                server.ws.send({ type: 'full-reload' });
            });
            // the editor's handshake: a GET answers "slop-editor", and a POST saves the whole text block
            server.middlewares.use('/__slop', (req, res) => {
                if (req.method !== 'POST') {
                    res.end('slop-editor');
                    return;
                }
                let body = '';
                req.on('data', (chunk) => { body += chunk; });
                req.on('end', async () => {
                    try {
                        const sent = JSON.parse(body);
                        if (!sent || typeof sent !== 'object' || Array.isArray(sent) || typeof sent.version !== 'number') throw new Error('expected an object with a numeric "version"');
                        const current = JSON.parse(await read());
                        if (sent.version !== current.version) {
                            res.statusCode = 409;
                            res.end('the file changed since this page loaded it. Reload the page (copy any unsaved edits first)');
                            return;
                        }
                        const saved = { ...sent, version: current.version + 1 };
                        lastSaved = saved.version;
                        await writeFile(`${file}.saving`, JSON.stringify(saved, null, 2) + '\n');
                        await rename(`${file}.saving`, file);
                        res.end(String(saved.version));
                    } catch (e) {
                        res.statusCode = 400;
                        res.end(e.message);
                    }
                });
            });
        },
    };
}
