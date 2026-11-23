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
