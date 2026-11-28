# Slop editor: how it's built

For contributors and their agents. [README.md](README.md) is the reference for people using it. This is how the code works and why it works that way.

## Files

| File | What |
|---|---|
| `slop.js` | Everything that runs in the page, as one global `Slop`: the format (pure functions, also used by Node), the Slop-o-meter, the editor. Outside a browser it returns only the format functions. |
| `slop.css` | The meter's and the editor's styles. Category colors aren't here: slop.js writes them into a `<style id="slop-colors">` at runtime. |
| `cli.mjs` | `slop-editor install / sync / edit / check / history / pending`. It uses only Node's built-ins, except `jsx.mjs`, which it loads for a React file. It loads the format functions from slop.js itself. `install` takes a page, a React file or a folder, and `--author ai|me` says whose words the moved text is (`me` wraps each text as `[{"me": …}]`). |
| `hooks/hooks.json` | The plugin's SessionStart hook: `cli.mjs pending --hook` tells each new Claude Code session about categories waiting for an agent. |
| `markup.mjs` | `install --auto`: finds a page's static prose (p, h1–h6, li, dd, dt, figcaption, blockquote with plain words, links, bold, italic, code) and returns the page with `data-slop` on each and the words for the block. It skips nav, forms, buttons, code, scripts and anything with other markup (spans, `<br>`, icons), and counts those it skipped. The rest is the agent's job. |
| `jsx.mjs` | `install --auto` for React: reads a `.jsx`/`.tsx` file with `@babel/parser` and edits the source by character range (so nothing else changes). Prose elements become `<SlopText path>` with the words in the block, `alt`/`title`/`placeholder`/`aria-label` become `slopAttrs` (with `useSlop()` in the component), and imports that lost their last use are dropped. It converts inline markup the same way `markup.mjs` does (it uses its `escape`, `slug` and `words`), follows JSX's own whitespace rules, and reports by line what it couldn't carry. Keys come from `have`, the texts already in the block, so a second run never reuses one. The CLI imports it only for a React file. |
| `vite.mjs` | `slop-editor/vite`: a Vite plugin with no imports from Vite. It puts the words file (`src/slopText.json`) in the page as the block, with `slop.js` and `slop.css`; under `vite` it answers the editor's handshake (`GET /__slop`) and saves (`POST`, version-checked, written to a `.saving` file and renamed), and reloads the page when the file changes some other way. A build has no endpoint, so no editor. |
| `react.mjs` | `slop-editor/react`: `SlopText`, `SlopMeter`, `slopAttrs` and `useSlop`, written with `createElement` so it needs no build. It reads the global `Slop`, so slop.js loads first. |
| `index.html` | The demo and landing page. It links `slop.js` and `slop.css` instead of inlining them. |
| `test.mjs` | Unit tests of the format. |
| `browser-test.mjs` | A smoke test of the editor in headless Chrome, on a fixture page of its own (not the demo). |
| `skills/slop-editor/SKILL.md`, `.claude-plugin/` | The Claude Code plugin: one skill, the plugin and marketplace manifests, and an icon. |

## Words

- **Block**: the `<script type="application/json" id="slop-text">` in the page that holds every text.
- **Text**: one thing the page shows, at a dotted path (`intro.p1`). In the block it's a string or a list of pieces.
- **Piece**: a stretch of a text by one author: a string (the AI's) or `{"<author>": "..."}`.
- **Group**: an object of texts, in reading order. The editor calls the top-level ones sections. Groups can nest.
- **Category** (or author): who wrote a piece. The built-ins are `ai`, `me`, `ok` and `data`, and a page can add its own.
- **Slop**: the AI's words that nobody approved (`ai`). Only ever that.
- **Approve / unslop**: `ai` → `ok`, with the words unchanged. **Reslop** takes it back: `ok` → `ai`.
- **Mine**: `me` plus `ok`, the share the editor calls yours. Data counts as neither.
- **Copy**: one of several texts with the same words (a repeat).

## The format

```json
{
  "version": 3,
  "_categories": { "bob": { "label": "Bob", "color": "#2b9fc0" }, "ai": { "color": "#d01f4a" } },
  "_show": "pie",
  "intro": {
    "title": "How it works",
    "p1": ["The agent wrote this. ", { "me": "I wrote this. " }, { "bob": "Bob added this." }]
  }
}
```

- **`version`** is a number. Every save through `slop-editor edit` bumps it, and a save whose `version` isn't the file's current one is refused (409). Anything that writes the block by hand must bump it too, so an open editor fails instead of overwriting newer words.
- **`version` and top-level keys starting with `_` aren't text.**
  - `_categories`: `{"<id>": {"label"?, "color"?, "about"?, "find"?, "found"?}}`, the page's own categories plus color overrides for the built-ins. `about` says whose words a category means; `find: true` asks an agent to find them; the agent then writes `found: {on, before: {path: old value}}` and drops `find`, and the editor offers Keep (drops `before`) and Undo (puts back each `before` whose words haven't changed).
  - `_show`: `"pie"` or `"colors"`. Absent means readers see nothing.
- **A piece object's first key is its author.** Other keys are ignored. An author missing from `_categories` still works: it's labeled with its id and colored from the palette.
- **Authorship is per character.** Every operation turns the value into one author per character (`authorsByChar`), works on that, and rebuilds the pieces with `fromChars`. That merges neighbours by the same author and returns a plain string when it's all AI. Hand-written values don't need to be tidy; the editor's output always is.
- **Markup is parsed over the whole text, not per piece**, so `**` opened in one piece can close in another. Markup characters, spaces and filled-in values don't count toward shares. The markup: `[label](url)`, `**bold**`, `*italic*`, `` `code` ``, `[[key]]`, `{name}`, and `\` to escape.
- **Code is a fact.** `runs` gives every character inside backticks to `data`, whoever wrote it, so a command or file name is shown and counted as data, like a `{name}`. The pieces keep their real author; only how it reads changes. Agents use backticks only for literal things, so prose can't hide in them.
- **A blank line** (`\n`, optional spaces, `\n`) splits a text into paragraphs (`paragraphsOf`), each keeping its authors. Further blank lines join the gap; spaces a paragraph starts with stay in it, so one typed there on the page stays. In a `<p>`, `<li>` or `<dd>`, `fillOne` shows the first and `spill` keeps a copy of the element after it for each of the others, marked `data-slop-more`. Elsewhere `render` turns every `\n` into `<br>`.
- **A list** is a group's paragraphs (keys `p<n>`) in an element the page marks with `data-slop-list` (slop.js draws them: `fillList` copies the first paragraph for a new one, puts it after the paragraph before it, and leaves every other child alone) or `data-slop-list-ref` (the page draws them). Unmarked, it's found by `listsIn` (called by `findLists` on each fill that may have new `data-slop` elements): two or more of a group's paragraphs in `data-slop` elements with one parent, the same tag and the same other attributes (slop.js's own `slop-*` classes aside), none shown any other way (`data-slop-ref`, `data-slop-attr`, `Slop.html`, a `reveal` hook) and no marked list for the group. Attributes that differ mean the page tells them apart (scroll steps, `data-b`), so they aren't a list. `data-slop-list="off"` on the parent opts out. A found list is kept in `autos` (parent → group) while the parent is in the document, so adding or removing paragraphs doesn't undo it; `fillList` and `listed()` treat it like a marked one. One paragraph on its own isn't found: mark it. Only there can the editor add and remove paragraphs; the group's other texts stay fixed. New keys come from `freshKey`: the next `p<n>` after any the group had in the file, the last save or now, so a key is never reused for other words. Order is the object's key order, so a new text is put in by rebuilding the group object (`insert`).
- **`{name}`** is filled from `Slop.vars`. A string or number is a fact, shown as data. `{html, data}` gives HTML, and it's shown as data only when `data` is true; otherwise it takes the color of whoever wrote the `{name}`.
- **Repeats** are texts whose words match once whitespace is collapsed (`wordsOf`). A text with fewer than 3 word characters, or made only of data, doesn't count.
- **Percentages** are rounded one by one, so they can add up to 99 or 101.

## slop.js, top to bottom

It's one IIFE that returns `Slop`. The sections are marked with `/* ---------- … ---------- */` comments.

| Section | What's in it |
|---|---|
| the format | The pure functions, up to `const core`: `plain`, `applyEdit`, `reattribute`, `unslop`/`reslop`, `assign`, `overlay`, `runs`, `render`, `readable`, `makeup`, `share`, `percent`, `repeats`, `rebase`. Outside a browser, `Slop` is only these. The CLI and `test.mjs` load slop.js with `new Function`. |
| the block | Parsing the block, `get`/`set`/`entries`, `html`/`paragraphs`/`words` (which also record that a text is on the page), `fill` (with `fillOne`, `spill` and `fillList`), `added` (what a single-page app draws after `start`), `reveal`, `onChange`. |
| categories and their colors | `colorOf`, `categories`, the generated stylesheet, the pies. |
| colors follow the page | Reads the page's actual background and sets `.slop-dark` on `<html>`. |
| Slop-o-meter | The readers' switch, pie and legend, and `_show`. A meter with a path measures that group and switches its section: `slop-on`/`slop-off` on the section, which the generated stylesheet reads. |
| the editor | `editor(mode)`, with mode `'file'` or `'local'`. Inside it: the history (`track` records a step, `withUndo` one made with a button, `step` undoes or redoes one and `putBack` returns the focus), `control` (a slop switch, and `approvals`, what each one approved), `field` (one text), `paintInk` (the colored words behind each text box), the categories (`renderCats`, biggest share first) and their colors (`picker`, laid out like the browser's color picker but the editor's own, so its eyedropper (`eyedrop`) can show the magnifier beside the pointer: a browser's own eyedropper can't be moved; `dragColor` on a drag onto the page; `sampler` and `colorAt` for both, whose magnifier is a copy of the page's body scaled up around the point (`place` puts what's fixed or sticky where it is on screen, scrolls panels as they are and copies canvases); `setColor(id, null)` is the default), `about` (whose words, Ask an agent to find them), the list's + and Remove (`plusRow`, `removeButton`, which mark the page with `flag`) and removed rows (`listRows`), `render` (the tabs), `edit` (typing goes through `applyEdit`; a paste of words copied from a text keeps their authors with `overlay`, from the `application/x-slop-editor` clipboard data or the last copy in memory), the save and Revert state, and `place`/`drag` (moving and resizing the panel). |
| the end | `refresh`, `remove`, `start`, and the public object. |

`applyEdit` takes the stretch the edit replaced when the editor knows it (`at`, the selection from `beforeinput`), so a letter typed over a selection that starts with that letter is still mine; when that stretch doesn't fit the change, it compares the two versions. An undo (`was`) also takes back my letters at the edges of the stretch that the earlier version doesn't have as mine.

Read `applyEdit` and `runs` first. Everything else builds on them.

**Editing on the page** (the editor is open from the start, as the bar unless the panel was open last time; `inPlace` only shrinks the panel to its header) uses `parse` (what `runs` is built on), which also gives each character's place in the plain text and the markup's characters, paired. `readOf` is a text's words as they read (a `{name}` is one character, `OBJ`), `readSpan` maps a stretch of those back to the plain text, and `editRead` replaces a stretch of them: typed letters are escaped and mine, markup in and around the stretch stays, and a pair of marks left holding nothing goes. In the editor, `liven` sets `contenteditable` on every `[data-slop]` and `[data-slop-more]` element (not inside a button or label, not `data-slop-ref`), `live.on` makes `render` draw each `{name}` as a block that can't be typed into, with spaces at the ends kept as `&nbsp;` so the caret can sit after them. The browser changes the words; `reconcile` reads them back (`domWords`), finds what changed (the selection from `beforeinput`, as `applyEdit`'s `at`), and `commit` sets the text, refills the page, updates the text's box in the panel and puts the caret back. New paragraphs, line breaks, joins, paste and ⌘Z (`step`) are done by the editor, not the browser, and so are ⌘B, ⌘I, ⌘E and ⌘K: `restyle` reads the text as styled letters, changes the selection's style, and writes the markup again with as few marks as it takes, each letter keeping its author. While editing on the page, a paragraph left empty still has an element (`paragraphSpans(value, true)`), so a new one can be typed into.

## How the editor gets the words back into the file

- `start()` picks the editor:
  - On `localhost`, `127.0.0.1` or `[::1]`, it sends `GET /__slop`. The answer `slop-editor` means the page is served by `slop-editor edit`, so the editor saves into the file.
  - Otherwise, with `edit: 'local'`, it saves in `localStorage`, keyed by the page's path (or `Slop.start({key})`, for a host that serves each version at its own address), as `{base, baseText, text}`: the page's `version` and block as published, and the saved block. When the page's `version` has changed since, `rebase` merges the three text by text: the saved value stays where the page's still matches `baseText`, the page's wins where the author changed, added or removed it (groups and `_categories` key by key). A copy without `baseText` (saved before 0.4) is dropped. A save the browser refuses says "Couldn't save in this browser".
  - Otherwise there's no editor.
- `slop-editor edit` serves only the page's folder, on 127.0.0.1. `POST /__slop` takes the whole block. Only the page being edited (by its `Referer`) gets the handshake and can save: another page in the folder would write its own block into this file. Saves run one at a time and are written to a `.saving` file that's then renamed over the page.
- In a Vite app, `slop-editor/vite` plays the part of `slop-editor edit`: it serves the same handshake and save from the dev server, into the words file, with the same version check. The page is the whole app, so any page in it may save. The words are one JSON file, not a page's block, which is why `slop-editor check` and `history` also take a `.json` file.
- `slop-editor edit` starts at port 5178 and moves on from any port where something already answers, on 127.0.0.1 or on ::1. Checking both matters because `localhost` can mean either, and dev servers such as Vite often listen on ::1 only.
- `install` adds `<style id="slop-css">`, `<script id="slop-js">` and the block. `sync` rewrites what's between the first two markers. `edit` runs `sync` on a page that has them before it serves it, so a page that inlines the code is current whenever it's edited.
- A page can link the files instead. `edit` serves a requested `slop.js` or `slop.css` that isn't in the folder from the CLI's own copy (by file name, at any path), so a site's page that links `/slop/slop.js` works under `edit` too.

## Design principles

Keep these unless the maintainer changes them.

1. **Slop is only ever the AI's words.** Extra categories are for other people (a co-author, an editor, a source), never kinds of slop. The tool is about who owns the words, not how good they are, and one meaning for "slop" keeps the number readers see honest.
2. **The slop switch changes only approval.** Off approves the AI's words (`ai` → `ok`); on takes that back: what that switch approved, where the words are still as it left them (`approvals`), or else every approved word (`ok` → `ai`). It never touches what someone typed, so flipping it can't lose anyone's writing. Approved text has its own color (green). A heading's switch on the page covers its section (`sectionUnder`).
3. **Each copy of a repeated text keeps its own authorship.** Approving words in one place shouldn't approve them where nobody read them. In the **All** tab a copy's switch changes that copy only, and says so ("Only this copy changed… Change it too"). In the **Repeats** tab a card's switch and text change every copy, on purpose.
4. **Readers see nothing unless the page chooses otherwise.** Agents install this on pages whose owners may not want it shown. The other choices are a pie chart, or colors (the pie plus a switch that colors the words). When a page shows colors, the switch starts on unless the reader turned it off. While the editor is open, the author sees colors, until they switch them off with its **Colors** switch to compare (`editColors`; the page's own meter flips the same switch then). The text boxes keep theirs: the panel is a `.slop-on` of its own.
5. **Saving is deliberate.** A Save button with a count (and ⌘S), Revert on each changed text, a prompt before leaving with unsaved changes, and no autosave. A reload keeps unsaved changes in `sessionStorage` for that tab, still unsaved, because a page in a frame can't prompt. A save rewrites an HTML file that may be open elsewhere, so each write should be one someone chose, and Revert always has a fixed point to go back to.
6. **Undo restores authorship too.** There's one history, the editor's own: ⌘Z undoes the last change wherever the focus is (typing on the page or in a box, a switch, a mark, a revert, a category deleted), and ⌘⇧Z redoes it. A step puts back the words with their authors, so undoing a deletion can't make the AI's words yours. Where the browser's own undo can't be stopped, the restored words get back their earlier authors (`applyEdit`'s `was`).
7. **Where words appear isn't who wrote them.** Alt text, tooltips and labels are texts like any other, by whoever wrote them, with a tab of their own (**Hidden**) because colors can't show them. Never a category.
8. **It's honest, not proven.** The block is the author's account. Don't present anything to readers as verification.
9. **The editor opens where the work is**: on Repeats if a repeated text still has slop, else on Slop left if any text has slop, else on All. The tabs are ordered the same way.
10. **Marking changes who wrote words, never the words.** Focus a text and a row of categories offers "Mark all as" or "Mark selection as". Deleting a category gives its words back to the AI.
11. **No dependencies in the page, and no build.** `slop.js` and `slop.css` work in any page with nothing else, and the CLI uses Node's built-ins. The one dependency is `@babel/parser`, which `jsx.mjs` uses to read a React file for `install --auto`, and nothing loads it otherwise. (The user lifted "no dependencies" on 2026-11-24 so the React and Vite support could ship in this one package rather than a second.) Babel 7, not 8: 8 needs Node 22, and this package supports 18.
12. **The demo page has exceptions that stay in `index.html`:**
    - the Slop-o-meter has its own band at the top, with a 56px pie;
    - the "Try it" note colors each category's share in that category's color (so those labels are in code), with a 44px pie beside it.

    Don't move them into the library.
13. **An agent never puts a category on its own words.** A category goes only on words that came from that person or source (a quote, a paste, a dictation), as its `about` says. Whether agents may use a category going forward is read from its `about`, never a switch: a switch would let AI text count as someone's, and the meter would lie.

## Where this could go (not built)

The slop editor is one preset of something more general: **a color-coder for a website's text, where every rule can be changed.** Words belong to categories, readers see colors and shares, an editor reassigns words, and agents follow the page's rules. In the slop-editor preset the rules are the ones above: agent text only ever goes to one category (AI, purple) by default, "slop" means only that, approval moves words from AI to approved, and the built-ins are fixed. A general version would let a page define its own:

- the categories and which one new agent text lands in (or none);
- what the switch does (here: approve), and what the meter measures (here: share of slop);
- the rules agents follow for each category (here: never mark your own words as anyone's), written in the block as `about`.

The format already allows most of it (`_categories`, `_show`); the rules that would change are principles 1, 2 and 13 and the skill's. Keep the slop editor's defaults as the preset when this happens.

## Gotchas

- **Anything that disappears on blur has to wait for the click.** When the "Mark as" row and hints were removed on blur, the layout shifted under the pointer and clicks missed. They're now removed after the click lands (`afterClick`). Use that pattern for anything new that disappears on blur.
- **Switches would slide on every redraw.** `render()` adds `.sp-still` for two frames to turn transitions off.
- **The history lives in the open editor**, one for the page and every box, and is gone on reload. A step keeps only the top-level keys it changed, before and after, so undoing it leaves the rest as it is now. A change the history doesn't record, under a key a step did change, goes with it: undo a deleted category and colors picked since go back too (both are in `_categories`).
- **Once picked, a category has one color for both themes.** The defaults follow the page's background.
- **A section switched off sits inside `html.slop-on`.** That's why the generated rules are `:where(.slop-on) .slop-<id>:not(:where(.slop-off) .slop-<id>)` and not a nearest-ancestor rule. `:where` keeps them about as easy to override as the old `html.slop-on .slop-<id>`.
- **Meters can leave and come back.** A single-page app moves a meter's element or redraws it. `paintMeters` drops meters that aren't in the document, and the MutationObserver in `start` (or `Slop.meter`) takes them back.
- **A text box's colors are a copy behind it.** The textarea's letters are transparent and `.sp-mirror`, under it, draws the same text in spans by author. The two must wrap identically: they share one CSS rule for font, padding, border and wrapping, so change them together. `numbers()` repaints the copies after every change.
- **"Not on the page" waits for the page.** A text just added, restored or undone has no element until the next fill (and a single-page app draws later still), so `seenSoon` checks the tags again after each fill and whenever the page adds elements.
- **A removed text can still be painted once.** `withUndo` repaints (`numbers()`) before the view is redrawn, so anything painting a field reads its value with `valueAt`, not `get`, which would warn about the missing text.
- **Pages with inlined code need `slop-editor sync page.html`** after any change to `slop.js` or `slop.css` (or `slop-editor edit`, which syncs first). `index.html` links the files, so it doesn't.

- **On the page, the element must render exactly as `fillOne` would.** Every fill compares `innerHTML` and rewrites what differs, and a rewrite loses the caret. It compares with the HTML as the browser gives it back (`asSet`), since `esc` writes `"` as `&quot;` and `innerHTML` returns a bare `"`: compared with `render`'s own string, any text with a quote in it was rewritten on every keystroke. That's why `render` itself draws the live-only parts (`live.on`), not something after it.
- **On the page, spaces the page would collapse are drawn as `&nbsp;` while editing** (`render`, `live.on`): at either end of a line (the text's ends, or next to a line break) and after another space. Collapsed, the browser drops one when you type next to it, and the text would lose it too. The caret is set to my color on focus (`caretColor`), since `caret-color: currentColor` would take each span's color. `domWords` reads every `&nbsp;` as a space, and `reconcile` compares with the words read the same way, so a non-breaking space in the text (pasted from an email) isn't taken for an edit.
- **The magnifier is a copy of the page.** While a dot is dragged, `.slop-sampler` holds a clone of `<body>`, so ids are doubled and the page's selectors match it too. Everything in it ignores the pointer, and `added` skips it. Anything that queries the document during the drag can find the copies.

## Running and testing

```sh
node cli.mjs edit index.html     # the demo, with the editor saving into index.html
node --test test.mjs             # unit tests of the format
npm i && npx playwright install chromium-headless-shell
npm run test:browser             # the editor in headless Chrome
```

To use a playwright-core and a Chrome you already have, set `PLAYWRIGHT_CORE` (the playwright-core folder) and `CHROME` (a chrome or chrome-headless-shell binary) and run `node browser-test.mjs`.

Opening `index.html` straight from disk gives the browser editor, which saves in `localStorage`.

For anything visual, also screenshot the demo in light and dark, and at 390px wide. There should be no horizontal scroll.
