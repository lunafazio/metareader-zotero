# MetaReader for Zotero

> **PLEASE NOTE:** This is a vibecoded prototype. Use under your own risk, etc.

A Zotero 7–10 plugin to read a paper's PDF next to its structured full text
(TEI / JATS / Docling) with sentence-level PDF highlighting, and build a
computational-reproducibility package.

## In Zotero

- **Right-click an item → Open in MetaReader** opens the item in a MetaReader
  tab.
- The item's own **PDF attachments** are used directly. A PDF that MetaReader
  downloads or you upload becomes a normal PDF attachment of the item.
- Everything MetaReader generates (OpenAlex metadata, GROBID/JATS/Docling/Claude
  TEI, the `repro/` package, the ZIP) goes into one **MetaReader Package**
  attachment per item, so the item tree gets only one extra row.
  - Its main file `metareader-package.html` is an overview of the folder.
    Because it is a `text/html` attachment, Zotero file sync uploads the
    whole folder (as a zip).
  - Zotero doesn't allow child items under attachments, so the package contents
    (the "second level") are shown in the **MetaReader Package section of
    the item pane** as a folder tree. Click a file to open it, or Shift-click
    to show it in the file manager. The section header has Open in MetaReader
    and Show folder buttons.
  - Double-clicking the package opens MetaReader instead of the overview.
- Settings (OpenAlex key, GROBID URL, docling / claude commands) are in the
  ⚙ dialog and stored as Zotero prefs `extensions.metareader.*`.
- MetaReader tabs are not restored after a restart (Zotero can't restore
  tab types it doesn't know). The last reference text, PDF and wizard step
  are remembered per item.

## Reproducibility wizard

Seven steps, state saved per item in the package
(`repro/.metareader/state.json`):

1. **Inputs**: a table of input files under `repro/inputs/`. The role (data
   / code / other) is guessed from the extension and can be changed, and
   each file can have a note. Zip files are unpacked and listed under the
   archive row: removing the archive deletes all of its files, while removing
   a member only marks it as unused.
2. **Targets** and 3. **Analysis plan**: tables. "+ Add …" opens a form where
   article content can be marked as the reference. "Generate with LLM…" shows
   the content to scan, the model, the exact command and the prompt before
   sending. Each call's extractions are grouped under it; changes are stored
   on top of the LLM's version (↺ Restore), rows can be unticked, and a whole
   call can be discarded after a confirmation.
4. **Master script**: creating the package writes the files and commits them
   to a git repository in `repro/`.
5. **Code generation**: on the left, the package folder opened in your code
   editor plus a suggested prompt to copy, then the headless LLM agent (with
   a confirmation that shows the model call) and its activity log. On the
   right, the package files, refreshed every few seconds while the step is
   open (also picks up edits made in the editor). A headless run that changes
   files is committed.
6. **Run & compare** and 7. **Report & package**.

## Layout

```
ui/        unprivileged UI (vite) → loaded from resource://metareader/ui/
           in a content <browser> inside the tab
plugin/    privileged plugin code (esbuild → content/plugin.js)
  bridge.ts    UI ↔ plugin: DOM events, only methods of the tab's api
               object can be called
  backend.ts   api for one item (files, OpenAlex/Europe PMC, GROBID,
               docling, claude, repro runs, ZIP)
  package.ts   MetaReader Package attachment (create, list, overview)
  itempane.ts  item pane section with the package tree
  tabs.ts      Zotero tab, session filtering
  processes.ts child processes in their own process group (setsid) so
               Stop kills the whole tree
static/    manifest.json, bootstrap.js (loads plugin.js), locale/, icons
test/      dev-only helpers (never in the .xpi)
```

## Build / develop

```
npm install
npm run build  # → build/metareader.xpi
               # (Zotero: Tools → Plugins → gear → Install Plugin From File)
npm run dev    # Zotero with an isolated profile + data dir in dev-profile/,
               # loading build/addon/
```

`npm run dev` goes through `scripts/run-clean-env.sh`, which is needed when
starting from the VS Code snap terminal. Zotero is expected at
`~/.local/share/zotero/zotero` (override with `ZOTERO_BIN`).

Testing: the dev profile also loads `test/devbridge/`, a localhost eval endpoint
(dev profile only). `test/zeval.sh script.js` runs an async JS body inside
the dev Zotero (`Zotero` and `win` in scope), `test/restart.sh` restarts
it after a build, and `test/bridge-call.js` is a prefix that gives scripts
`call(method, ...args)` through the real UI → plugin bridge of an open
MetaReader tab.

## Security note

The UI and pdf.js run without privileges. The plugin still exposes running
shell commands and Claude with write access to the package folder, because
the reproducibility wizard needs them. Code that broke out of pdf.js could
reach those calls.
