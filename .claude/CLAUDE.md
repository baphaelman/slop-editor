# Slop editor

Read [ARCHITECTURE.md](../ARCHITECTURE.md) (how it's built, design principles) before changing code, and [README.md](../README.md) for what users see. If `HANDOFF.md` exists, it's the maintainer's note on the current state and open questions: read it too.

## Rules

- **Text in a slop-text block** follows the agent rules in [skills/slop-editor/SKILL.md](../skills/slop-editor/SKILL.md) ("Writing text in a page that has it"). That's the one copy of them. Most of all:
  - never reword the user's words (`me` pieces) without asking; point out typos instead;
  - don't approve or un-approve anything unless asked;
  - AI text is terse.
- **Editing a block by hand while `slop-editor edit` may be running on that page:**
  - read the file right before each edit;
  - bump `version`;
  - check that every `me` and `ok` piece survives word for word.

  The open tab will get a 409 on its next save; tell the user to reload it.
- **Edit servers:** find running ones with `ps aux | grep 'cli.mjs edit'` (or `lsof -iTCP -sTCP:LISTEN -P`). Never stop a process you didn't start.
- Keep the design principles in ARCHITECTURE.md unless the user changes them.
- After changing `slop.js` or `slop.css`, pages with inlined code need `node cli.mjs sync <page>`.
- Before reporting UI work: run `node --test test.mjs` and the browser test, and screenshot the demo in light, dark and at 390px.
- Commit, push or publish only when asked.

## Showing the maintainer a change

After any change the maintainer can see, update the lab page and send its link: https://claude.ai/artifact/8hVd5GZgtYBLoQPQYZ5JsX (private, "Slop Editor Lab"). Keep building on that page rather than making a new one.

1. Read it with the Artifact tool (`action: "read"`); the result names the saved file. Work on that file, or a copy in the session's scratchpad.
2. Add a section for the change, and keep what's there. The page is release notes you try on the page itself:
   - One section per release (`v030` in the block, an `<h2>` of the version and a status tag), newest first, each with its own section meter and its paragraphs in a `data-slop-list`.
   - Each time you report back is a part of the current release. A release with one part has no subtitle; when a second part comes, give the first one a subtitle too ("Part 1 · …", "Part 2 · …"), newest part first. Several npm releases can share a section, or one can span several.
   - Only what changed since the previous part. Each paragraph says where to look and what to do with the words in front of you ("point at the + under this paragraph").
   - Each change is one paragraph with a number for good, counted from 1 within its release, across its parts (`CHANGES` in the page's script): a new change takes its release's next number, and none is ever renumbered or reused. Small updates that aren't features (like adding the numbers) get no section or number.
   - Text is AI text, terse. Never write `me` pieces: that's the maintainer's own words.
   - Lab-only controls (like the + look picker) are plain HTML, not texts in the block.
3. Run `node cli.mjs sync <file>` to inline the current `slop.js` and `slop.css`. Keep the block's `version` as it is unless the update changes the demo's own text: a new version makes browsers drop the edits the maintainer saved there.
4. Publish it with `url` set to the link above.

Reply with the link and a short list of where to see each change for yourself, numbered with the same numbers the page gives them and grouped under the release, e.g. "0.3.0 · 17. Edit text → All → 0.3.0: point at the + under any paragraph".
