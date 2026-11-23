# Slop editor

It tracks who wrote every word on a page: the AI, you, or nobody (facts and quotes). Readers get a **Slop-o-meter** switch that colors the words by author. You get an editor where you read what your agent wrote, fix it, and sign off on what you agree with.

Every text starts as AI-generated: slop. What you type becomes yours. Switch a text's **slop** off and the AI's words are approved as they are, in a color of their own. Switch it back on to take that back. The point isn't detection. It's owning what you publish.

It's two files (`slop.js` and `slop.css`), has no dependencies and no build step, and works in any HTML page.

**[Try it on the demo page](https://baphaelman.github.io/slop-editor/)**, which is itself tracked by the slop editor.

## Install

**With Claude Code**, add the plugin, then ask for the slop editor on a page:

```
/plugin marketplace add baphaelman/slop-editor
/plugin install slop-editor@slop-editor
```

The agent moves the page's words into the text block for you. That's the tedious part.

**Without it**, use the command line (Node 18+):

```sh
npx slop-editor install page.html   # inline slop.css and slop.js, add the text block
npx slop-editor edit page.html      # open the page with the editor; it saves into the file
npx slop-editor check page.html     # how much is yours, repeated text, texts the block lacks
npx slop-editor sync page.html      # re-inline the current slop.css and slop.js
```

Or link the files instead of inlining them: `<link rel="stylesheet" href="slop.css">` and `<script src="slop.js"></script>`.

## The text block

The words live in the page, in `<script type="application/json" id="slop-text">`:

```json
{
  "version": 3,
  "intro": {
    "title": "How it works",
    "p1": ["The agent wrote this. ", { "me": "I wrote this. " }, "Then ", { "data": "\"a quote\"" }, "."]
  }
}
```

A **text** is a plain string (AI) or a list mixing strings (AI), `{"me": "..."}` (yours), `{"ok": "..."}` (the AI's, approved), `{"data": "..."}` (facts, or other people's words) and `{"<category>": "..."}` for a category of the page's own. Groups are objects, in reading order. Top-level keys starting with `_` aren't text.

**Categories.** Co-authors, editors and sources can have categories of their own, with a label and a color, in `_categories`. The same object holds colors picked for the built-in ones:

```json
"_categories": {
  "bob": { "label": "Bob", "color": "#2b9fc0" },
  "ai": { "color": "#d01f4a" }
}
```

Slop is only ever the AI's words. Other categories are other people's. Inline markup: `[label](url)`, `**bold**`, `*italic*`, `` `code` ``, `[[key]]` for a key cap, `{name}` for a value the page fills in, and `\` to escape.

In the page:

```html
<div data-slop-meter></div>          <!-- what readers see, if anything -->
<h2 data-slop="intro.title"></h2>    <!-- filled from the block -->
<p data-slop="intro.p1"></p>
<script>
  Slop.vars.count = 42;              // {count} in a text: a fact, shown as data
  Slop.onChange(() => relayout());   // after an edit: redo anything built from the text
  Slop.start();
</script>
```

Code can render texts itself with `Slop.html('intro.p1')` (HTML) or `Slop.words('intro.p1')` (plain text).

A text the page shows only some of the time (after a click, in another tab, once something's been pasted) is tagged **not on the page** in the editor. To let the editor show it while it's being edited, tell it how:

```js
Slop.reveal('intro.note', () => {
  showNote = true; render();                    // put the page in a state that shows it
  return () => { showNote = false; render(); }; // and undo that afterwards
});
```

A group's key (`'intro'`) covers all its texts. While shown, the page's own redraws must keep it shown (here, `render()` checks `showNote`).

## The editor

`slop-editor edit page.html` serves the page's folder on 127.0.0.1 and opens the page with an **Edit text** button. Published, the page shows no sign of the editor. `Slop.start({edit: 'local'})` gives every visitor an editor that saves in their browser instead (the demo page uses it).

- **All** shows every text, grouped by section. **Slop left** shows only the texts that aren't all yours yet; work through it until it's empty. **Repeats** shows the repeated text.
- Each text, section and the whole page has a pie of what it's made of and a **slop** switch. Off approves the AI's words; on takes that back. Your typed words are never touched. Every switch can be undone from the status line.
- At the top: how much of the page is slop, and every category with its share and a color picker. Rename a category by editing its name. **+ Category** adds one; × deletes it (its words become AI-generated).
- Focus a text and a row of categories appears under it: **Mark all as** (or **Mark selection as**, with words selected) gives the text, or just the selection, to a category.
- Click any text on the page to jump to it in the editor. Focus a text in the editor to find it on the page.
- Drag the header to move the editor anywhere, and drag any edge or corner to resize it. It stays where you leave it; double-click the header to put it back. On a phone it's a sheet along the bottom, and dragging changes its height.
- Nothing is written until you click **Save** (or press ⌘S). The button counts the texts changed since the last save. Each changed text has a **Revert** link that takes its words and authorship back to the last save. Saves are versioned: a tab whose copy of the file is out of date gets an error instead of overwriting newer edits, and leaving with unsaved changes asks first.
- ⌘Z in a text undoes typing and gives the restored words back to whoever wrote them. ⌘Z anywhere else undoes the last switch, mark or revert.

### Repeated text

Agents repeat things: a heading that's also in the nav, a tagline in the hero and the footer. When several texts have the same words, the editor treats them as copies of one text:

- Each copy keeps its own authorship. A copy is slop until it's approved, even if it repeats your words.
- Each copy has a **2×** badge. In **All**, a copy's switch changes that copy only, and says so: "Only this copy changed. 1 other copy didn't. Change it too".
- The **Repeats** tab has one card per repeated text. Its switch and its text change every copy, and it lists where each copy is.
- Edit one copy on its own and the editor offers to change the others too.

## Colors

Slop is purple, approved AI text is green, data is amber, and your words keep the page's own color, until you pick others in the editor (they're saved in `_categories`). The defaults follow the page's background (light or dark). A page can also set them in CSS with `--slop-ai`, `--slop-ok`, `--slop-data` and `--slop-me`, and the editor's fonts with `--slop-font` and `--slop-mono`.

## What readers see

It's the page's choice, made in the editor (**Readers see**) and saved in the block as `"_show"`:

- **Nothing** (the default): no sign of the slop editor. The safe choice for a page or project you don't know.
- **Pie chart**: a pie of who wrote what, and a legend: each category in its color, with its share of the page's text.
- **Colors**: the Slop-o-meter, the pie and legend plus a switch that colors every word by who wrote it.

It shows where the page puts `<div data-slop-meter></div>`. While the editor is open, you see the colors whatever readers get.

## Rules for agents

The full rules are in [skills/slop-editor/SKILL.md](skills/slop-editor/SKILL.md), which the Claude Code plugin loads. In short:

- Write everything as AI text to start. Only what the user dictates word for word goes in as `{"me": ...}`.
- Other people's words go in their category (`{"data": ...}` for quotes, or one of the page's own).
- Never reword the user's words without asking.
- Don't approve anything (`ok`) or take approval back unless asked.
- When editing the block by hand while the editor is open: read the file first, bump `version`, and keep every `"me"` and `"ok"` piece word for word.

## License

MIT
