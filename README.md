# Slop editor

It tracks who wrote every word on a page: the AI, you, or nobody (facts and quotes). Readers get a **Slop-o-meter** switch that colors the words by author. You get an editor where you read what your agent wrote, fix it, and sign off on what you agree with.

Every text starts as AI-generated: slop. What you type becomes yours. Switch a text's **slop** off and the AI's words are approved as they are, in a color of their own. Switch it back on to take that back. The point isn't detection. It's owning what you publish.

It's honest, not proven. The record is the author's own account, like a byline: nothing can tell AI text someone retyped from words they wrote. What the slop editor makes easy is telling the truth about it, and `slop-editor history` shows the account commit by commit.

It's two files (`slop.js` and `slop.css`) with no dependencies and no build step in the page, and works in any HTML page.

**[Try it on the demo page](https://baphaelman.github.io/slop-editor/)**, which is itself tracked by the slop editor.

## Install

**With Claude Code**, add the plugin, then ask for the slop editor on a page:

```
/plugin marketplace add baphaelman/slop-editor
/plugin install slop-editor@slop-editor
```

The agent moves the page's words into the text block for you. That's the tedious part. The CLI does the bulk of it too, with `--auto` below.

**Without it**, use the command line (Node 18+):

```sh
npx slop-editor install page.html  # inline slop.css and slop.js, add the text block
npx slop-editor install --auto page.html  # the same, and move the page's paragraphs, headings and list items into the block
npx slop-editor install --auto --author me page.html  # the same, with the moved text marked as yours (the default is the AI's)
npx slop-editor install --auto src          # a React app on Vite: the plugin, Slop.start(), and each component's text (see below)
npx slop-editor edit page.html     # open the page with the editor; it saves into the file (and re-inlines the current code)
npx slop-editor check page.html    # how much is yours, repeated text, texts the block lacks
npx slop-editor history page.html  # what each git commit did to who wrote what (a page, or a block kept as .json)
npx slop-editor sync page.html     # re-inline the current slop.css and slop.js
npx slop-editor pending            # categories you asked an agent to find, in the pages under this folder
```

Or link the files instead of inlining them: `<link rel="stylesheet" href="slop.css">` and `<script src="slop.js"></script>`. A site that installs `slop-editor` from npm can serve `node_modules/slop-editor/slop.js` and `slop.css` itself, so `npm update slop-editor` updates every page. Under `slop-editor edit`, a page that links a `slop.js` or `slop.css` its folder doesn't have gets the CLI's own.

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

Slop is only ever the AI's words. Other categories are other people's.

**Categories an agent finds.** A category can say whose words it means (`"about"`), and ask an agent to find them in the page's existing text (`"find": true`). In the editor, a new category asks **Whose words are …?**, with **Ask an agent to find them**; select any category to edit its description. Built-ins have one too, and an agent can be asked to find facts and quotes (`data`), never your words or what you approved. The next agent that works on the project is told at the start of its session (with the Claude Code plugin; `npx slop-editor pending` lists them too, and **Copy a prompt** hands one to any agent now). It marks the words (never changing them), records what it changed in `"found": {"on": "2026-11-25", "before": {"<path>": <old value>}}`, and removes `"find"`. The editor then shows **An agent marked 12 texts as Bob · Keep · Undo**. An agent never puts a category on its own words: only on words that came from that person or source (a quote, a paste, a dictation), as `about` describes.

```json
"bob": { "label": "Bob", "about": "My co-author: the methods section, and quotes from his thesis", "find": true }
```

Inline markup: `[label](url)`, `**bold**`, `*italic*`, `` `code` `` (a fact: shown and counted as data, whoever wrote it), `[[key]]` for a key cap, `{name}` for a value the page fills in, and `\` to escape.

**Paragraphs.** A blank line in a text shown in a `<p>`, `<li>` or `<dd>` starts a paragraph of its own: the element shows the first, and a copy of it after it shows each of the others (`data-slop-more` instead of `data-slop`). Markup doesn't carry across a blank line. Anywhere else a line break is a `<br>`. An element whose text is empty is hidden (`.slop-empty`), except while the editor is open.

In the page:

```html
<div data-slop-meter></div>          <!-- what readers see, if anything -->
<h2 data-slop="intro.title"></h2>    <!-- filled from the block -->
<p data-slop="intro.p1"></p>
<script>
  Slop.vars.count = 42;              // {count} in a text: a fact, shown as data
  Slop.onChange(() => relayout());   // after an edit: redo anything built from the text (returns an unsubscribe)
  Slop.start();
</script>
```

Code can render texts itself with `Slop.html('intro.p1')` (HTML), `Slop.paragraphs('intro.p1')` (HTML, one string per paragraph) or `Slop.words('intro.p1')` (plain text). Put `data-slop-ref="intro.p1"` on the element that shows them (a button or link the page builds) and the editor can still find, highlight and scroll to it. Unlike `data-slop`, nothing fills it.

**Lists.** Where the page shows a group's paragraphs (`p1`, `p2`, …) in one element, the editor can add and remove paragraphs there. That's found without marking when two or more of them are `data-slop` elements with the same parent, the same tag and the same other attributes (so `<p data-b="0">`, `<p data-b="1">` scroll steps aren't a list). Put `data-slop-list="off"` on the parent to opt out. Or say so:

```html
<div data-slop-list="intro">            <!-- a copy of the first paragraph for each p<n> in "intro", in order -->
  <h2 data-slop="intro.title"></h2>     <!-- the group's other texts and other children stay where they are -->
  <p data-slop="intro.p1"></p>
  <p data-slop="intro.p2"></p>
</div>
```

All of the group's paragraphs have to be in that element; the ones the page has no element for are drawn after the others. A new one goes after the paragraph before it. A page that draws them itself (React and the like) puts `data-slop-list-ref="intro"` on the element around them instead, draws one per paragraph key, in order, and redraws after an edit.

**Words the page doesn't show as words** (alt text for an image that doesn't load, a tooltip, a label for screen readers, a placeholder) go in attributes: `<img data-slop-attr="alt:hero.photo">`, or several at once, `data-slop-attr="alt:hero.photo title:hero.tip"`. They're filled as plain text. The editor gives them a tab of their own, **Hidden**, since readers' colors can't show them.

`[data-slop]` elements and meters the page adds after `Slop.start()` (a single-page app's) are filled and built as they appear. `Slop.meter(el)` builds a meter by hand.

For code that draws its own view of who wrote what: `Slop.entries()` lists every `[path, value]`; `Slop.makeup(values)` counts their letters and words by category (`{counts, letters, words, allWords}`); `Slop.categories()` gives each category's `id`, `label` and `color`, in the order the meter shows them; `Slop.percent(fraction)` rounds a share the way the meter does.

A text the page shows only some of the time (after a click, in another tab, once something's been pasted) is tagged **not on the page** in the editor. To let the editor show it while it's being edited, tell it how:

```js
Slop.reveal('intro.note', () => {
  showNote = true; render();                    // put the page in a state that shows it
  return () => { showNote = false; render(); }; // and undo that afterwards
});
```

A group's key (`'intro'`) covers all its texts. While shown, the page's own redraws must keep it shown (here, `render()` checks `showNote`).

### In a React app

**On Vite, one command does it** (`npm i slop-editor` first):

```sh
npx slop-editor install --auto src/components/Article.jsx   # a file, or a folder of .jsx and .tsx files
npx slop-editor install --auto --dry-run src                # what it would do, without doing it
```

It reads each file with Babel and edits its source in place, so formatting and comments stay. It moves the prose (`p`, `h1`–`h6`, `li`, `dd`, `dt`, `figcaption`, `blockquote` holding plain words, links, bold, italic and code) into `src/slopText.json` (`--text words.json` to put it elsewhere) under the file's name (`ArticleOne.jsx` is `articleOne`), and swaps each text for `<SlopText path="…" />`. A link component (`<ExternalLink href="https://…">`) becomes `[label](url)`, and `alt`, `title`, `placeholder` and `aria-label` become `slopAttrs`, with `useSlop()` added to the component. Imports it leaves unused are dropped. It also adds the `slopEditor()` plugin to `vite.config` and `Slop.start()` to the file `index.html` loads, unless they're there. What it can't carry (words with a `<span>` or `<br>` in them, text built from variables, words in an element that isn't prose) it lists by line, for you or an agent to do by hand. As with a page, the moved text is AI text unless you say `--author me`. Running it again moves nothing twice.

The plugin, `slop-editor/vite`, is what runs the editor:

```js
import slopEditor from 'slop-editor/vite';
export default defineConfig({ plugins: [react(), slopEditor()] });  // slopEditor({ text: 'content/words.json' }) to move the file
```

It puts the words in the page as its text block, with `slop.js` and `slop.css`. Under `vite` the page gets an **Edit text** button, and saves go into the words file, version-checked: the file changes under an open page and the page reloads. A build has no editor. Other build tools aren't set up for you yet: put the block, `slop.js` and `slop.css` in the page yourself.

By hand, `slop-editor/react` wraps it, with no JSX and no build. slop.js still goes in the page first, as a plain `<script>`.

```jsx
import Slop, { SlopText, SlopMeter, slopAttrs, slopList, useSlop } from 'slop-editor/react';

<SlopMeter path="games.othello" />            // a meter (no path: the page's)
<SlopText path="intro.p1" as="p" />           // a text, redrawn after each edit; as a p, li or dd, one per paragraph
<img src="hero.png" {...slopAttrs({ alt: 'hero.photo' })} />
<div {...slopList('intro')}>                  // a list: the editor can add and remove texts in it
  {Object.keys(Slop.text.intro).map((k) => <SlopText key={k} path={`intro.${k}`} as="p" />)}
</div>
```

`useSlop()` makes any component render again after an edit; `SlopText` already does. Call it in a component that uses `slopAttrs` or `Slop.words`.

## The editor

`slop-editor edit page.html` serves the page's folder on 127.0.0.1 and opens the page with an **Edit text** button. Published, the page shows no sign of the editor. `Slop.start({edit: 'local'})` gives every visitor an editor that saves in their browser instead (the demo page uses it). When the page's author publishes a new version, a visitor's saved edits carry over: the author's changes win, text by text, and the visitor's stay everywhere else. They're kept under the page's path; on a host that gives each version an address of its own, name the page instead: `Slop.start({edit: 'local', key: 'my-page'})`.

- **All** shows every text, grouped by section. An open section's name stays at the top while you scroll its texts, so you can close it from anywhere in it. **Slop left** shows only the texts that aren't all yours yet; work through it until it's empty. **Repeats** shows the repeated text. **Hidden** (on pages that have some) shows alt text, tooltips and labels.
- Each text box shows its words in their authors' colors, as readers see them with the Slop-o-meter on.
- Each text and section has a pie of what it's made of, by its name, and a **slop** switch at the right. Off approves the AI's words; on takes that back. Your typed words are never touched. Every switch can be undone from the status line.
- At the top: every category with its share of the page, the biggest first (as in the meters' legends). Click a category's dot for its color picker, laid out like the browser's (a rectangle of shades; the eyedropper, the color and a hue bar; RGB, HEX or HSL numbers). Its eyedropper, or dragging the dot onto any color on the page, takes a color from the page: the point is a ring, and a magnifier beside it (not over it, so you can see where you are) shows the page around the point three times bigger, rimmed in the color, joined to the ring by a line (Escape drops it). **Revert colors** puts every category back to its default. Rename a category by editing its name. **+ Category** adds one; × deletes it (its words become AI-generated).
- Focus a text and a row of categories appears under it: **Mark all as** (or **Mark selection as**, as soon as you start selecting) gives the text, or just the selection, to a category.
- Words copied (or cut) from a text keep their authors when pasted into a text, here or in another page's editor: AI words stay AI, approved stay approved. Words pasted from anywhere else are yours, as if typed.
- In a list, a **+** under the text you're on adds an empty paragraph after it; pointing at the + draws a line on the page where it would go. The trash can before its slop switch outlines the text on the page in dashed red; a text with words takes a second click (it asks **Remove?**), and stays red until then. A removed text stays in **All** as a row with **Restore** until the next save. New texts get new keys (`p7` between `p2` and `p3` is still called Paragraph 3 in the editor), so a key never moves to other words.
- Click any text on the page to jump to it in the editor. Focus a text in the editor to find it on the page.
- Drag the header to move the editor anywhere, and drag any edge or corner to resize it. It stays where you leave it; double-click the header to put it back. On a phone it's a sheet along the bottom, and dragging changes its height.
- Nothing is written until you click **Save** (or press ⌘S). The button counts the texts changed since the last save. Each changed text has a **Revert** link that takes its words and authorship back to the last save. Saves are versioned: a tab whose copy of the file is out of date gets an error instead of overwriting newer edits. Leaving with unsaved changes asks first, and a reload keeps them in that tab, still unsaved, with **Discard** (a page in a frame can't ask).
- What you type is yours, every letter, even one typed over a selection that starts with the same letter. ⌘Z in a text undoes typing and gives the restored words back to whoever wrote them. ⌘Z anywhere else undoes the last switch, mark, revert, added or removed text.

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

It shows where the page puts `<div data-slop-meter></div>`. While the editor is open, you see the colors whatever readers get; its **Colors** switch (or the page's Slop-o-meter) turns them off to compare.

A meter can cover one part of the page: `<div data-slop-meter="games.othello"></div>` measures only the texts under `games.othello`, and its switch colors only its section, the closest `[data-slop-section]` or else its parent. A section's switch starts the way the page's is and is its own once flipped. Only the page's is remembered.

Pointing at a category in a legend dims everyone else's words, in the meter's section or the whole page.

The colors apply inside `.slop-on` (on `<html>` while the page's switch is on, or a section switched on) and not inside `.slop-off` (a section switched off). Pointing at a category sets `data-slop-only="<id>"` on the section.

## Rules for agents

The full rules are in [skills/slop-editor/SKILL.md](skills/slop-editor/SKILL.md), which the Claude Code plugin loads. In short:

- Write everything as AI text to start. Only what the user dictates word for word goes in as `{"me": ...}`.
- Other people's words go in their category (`{"data": ...}` for quotes, or one of the page's own).
- Never reword the user's words without asking.
- Don't approve anything (`ok`) or take approval back unless asked.
- When editing the block by hand while the editor is open: read the file first, bump `version`, and keep every `"me"` and `"ok"` piece word for word.

## License

MIT
