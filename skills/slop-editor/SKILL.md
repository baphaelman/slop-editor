---
name: slop-editor
description: The slop editor. It tracks who wrote every word on an HTML page (the AI, the user, AI text the user approved, facts and quotes, or categories of the page's own), with a Slop-o-meter switch for readers and a local editor where the user reads, fixes and approves the AI's text. Use when the user asks to add the slop editor or Slop-o-meter, to "track what's AI", or to "slopify" a page, or when writing or editing text in a page whose HTML contains id="slop-text".
---

# Slop editor

The slop editor's code and CLI are in this plugin: `${CLAUDE_PLUGIN_ROOT}`. The README there is the full reference.

## Setting it up in a page

1. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" install --auto <page.html>` (drop `--auto` to do the marking by hand). It moves the page's static prose (paragraphs, headings, list items) into the block as AI text, marks those elements and adds `Slop.start()`; do steps 2–6 only for what it reports it couldn't carry (spans, text the code builds, text shown only sometimes). Without `--auto` this inlines `slop.css` and `slop.js` and adds an empty `<script type="application/json" id="slop-text">` block. The page stays one file.
2. Move every word a reader sees into the block, **as AI text**. Mark each element with `data-slop="group.key"`. For text the page's code builds, use `Slop.html('group.key')` (HTML) or `Slop.words('group.key')` (plain), and put `data-slop-ref="group.key"` on the element so the editor can find it. Alt text, tooltips and aria-labels go in the block too, with `data-slop-attr="alt:group.key"`. In a React app, use `slop-editor/react` (`SlopText`, `SlopMeter`, `slopAttrs`). Obvious labels such as buttons, axis labels, table headers and pills can stay in the code. Where a group's paragraphs (`p1`, `p2`…) all sit in one element (an article's body, a card), mark that element `data-slop-list="group"` (or `data-slop-list-ref`, with `slopList` in React, when the code draws them), so the user can add and remove paragraphs in the editor. Its title, captions and other children can stay in it. Skip it where paragraphs are tied to code by position (scroll steps, animation beats).
3. Keep computed numbers computed. The text says `{name}` and the code sets `Slop.vars.name` (a string or number is a fact, shown as data).
4. Add `<div data-slop-meter></div>` at the top of the page. It shows readers nothing unless the user chooses otherwise: ask whether readers should see nothing, a pie chart, or the full colored text, and set `"_show": "pie"` or `"colors"` in the block if so (they can also pick it in the editor). Leave it out for nothing, the default.
5. Call `Slop.start()` once `Slop.vars` is set and before anything reads the text. Register `Slop.onChange(fn)` to redo anything built from the text (layout, titles, charts) after an edit.
6. For any text the page shows only some of the time (after an interaction, in a hidden tab or state), register `Slop.reveal('group.key', () => { /* show it */ return () => { /* undo */ }; })` so the editor can show it while it's edited. Keep it shown through the page's own redraws while revealed.
7. Run `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" check <page.html>`. It reports texts the page uses that the block lacks, repeated text, and how much is the user's.
8. Tell the user how to edit: `node "${CLAUDE_PLUGIN_ROOT}/cli.mjs" edit <page.html>` (or `npx slop-editor edit`). It opens the page with the editor, which saves into the file. Note it in the project's README.

**Converting a page that already has text:** everything that isn't obviously a label becomes AI text. If the user has already written or edited some of it, record their words as `{"me": ...}` pieces, with a word-level diff, and tell them what you attributed to them.

## Writing text in a page that has it

- A text is a plain string (AI) or a list mixing strings (AI), `{"me": "..."}` (the user's), `{"ok": "..."}` (AI words the user approved), `{"data": "..."}` (facts, or other people's words quoted) and `{"<id>": "..."}` for the page's own categories. A list is one text, never a list of paragraphs: put a blank line in a text to split it into paragraphs on the page, or give each paragraph its own key (`p1`, `p2`…). Inline markup: `[label](url)`, `**bold**`, `*italic*`, `` `code` ``, `[[key]]`, `{name}`, and `\` to escape.
- Write as AI text. Only what the user dictates word for word goes in as `{"me": ...}`.
- **Categories:** when the user wants someone else's words tracked (a co-author, an editor, a source), add `"_categories": {"<id>": {"label": "...", "color": "#rrggbb"}}` at the top level of the block, and mark their words `{"<id>": "..."}`. When they ask you to mark text as a category, change only who wrote it, never the words. Slop is only ever the AI's words.
- **Repeated text** (a heading that's also in the nav, a tagline in the hero and the footer): give each copy the same words, so the editor recognizes the copies and can unslopify them together. A copy you place is AI text, even when it repeats the user's words. It stays slop until they approve it.
- Never reword the user's words without asking. Point out typos instead of fixing them.
- AI text is terse: about half the words you'd naturally use.
- Don't approve AI text (`ok`) or take approval back unless the user asks. The editor's slop switches do both.
- If you edit the block by hand while the user might have the editor open: read the file right before each edit, bump `version`, and check that every `"me"` and `"ok"` piece survives word for word (compare the lists of their strings before and after).
