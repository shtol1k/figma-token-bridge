# figma-token-bridge

A local Figma plugin + a tiny local bridge server that sync a Figma
Variables collection with a folder of [W3C Design Tokens (DTCG)](https://tr.designtokens.org/format/)
JSON files on your disk — one click to export, one click to import back.

Built because the [Variables REST API](https://www.figma.com/developers/api#variables)
is Enterprise-only, and native "Export variables" in Figma only goes one
direction and drops a zip in `~/Downloads` that then needs unzipping and
moving by hand. This tool uses the **Plugin API** instead (works on any
paid Figma plan) and writes/reads files directly where you tell it to.

## Not real synchronization

Both directions are explicit, one-shot operations triggered by a click —
there is no watching, no automatic merging, and no conflict detection.
Whichever side you click last wins. Treat it as a fast, format-compatible
replacement for the manual export/unzip/move dance, not as a live sync.

## How it works

```
Figma desktop app
 └─ Plugin (plugin/code.ts — Plugin API: reads/writes Variables)
      ↕ postMessage
    Plugin UI (plugin/ui.html — the only part with fetch/DOM)
      ↕ fetch → http://localhost:8934
    Bridge server (server/index.ts — plain Node, real filesystem/OS access)
      ↕ reads/writes
    <your chosen folder>/<collection-slug>/<mode-name>.tokens.json
```

The plugin's main thread has the Plugin API but no `fetch`/DOM. The
plugin's UI iframe has `fetch`/DOM but no Plugin API, and — this is the
part that isn't obvious — **no File System Access API either**, so it
can't open a native folder picker on its own. The bridge server is a
plain Node process outside Figma's sandbox entirely, so it can touch the
filesystem and pop a real macOS folder picker (`osascript`) on request.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full detail,
including every Figma manifest quirk this ran into.

## Requirements

- **macOS** — the native folder picker shells out to `osascript`
  (`choose folder`). Everything else is platform-agnostic, but this one
  feature ties the tool to macOS today.
- **Figma desktop app** — local/dev plugins ("Import plugin from
  manifest") aren't available in the browser version.
- **Figma plan with Variables** — Professional or higher. The Enterprise
  Variables REST API is never used, so no Enterprise plan is required.
- **Node.js 18+** and **pnpm**.

## Setup

```sh
git clone <this-repo-url> figma-token-bridge
cd figma-token-bridge
pnpm install
pnpm run build   # compiles server + plugin, builds Tailwind CSS, inlines it into plugin/dist/ui.html
```

## How to use

### 1. Start the bridge server

```sh
pnpm run start
```

Leave this running in a terminal tab for the whole session — every
Export/Import click needs it. It listens on `http://localhost:8934` and
does nothing until the plugin talks to it.

### 2. Load the plugin into Figma (once per machine)

1. Open the **Figma desktop app**.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Select `plugin/manifest.json` from this repo.
4. Open the Figma file whose Variables you want to sync, then run the
   plugin from **Plugins → Development → Figma Token Bridge (local)**.

### 3. Set the tokens folder (once per Figma file)

Click the folder icon at the left of the panel's top row. A native
folder picker opens (via the bridge server) — choose the folder where
token JSON should live, e.g. a `docs/tokens/` directory in your app's
repo. This is remembered per Figma file (keyed by `figma.fileKey` in the
plugin's `clientStorage`), so different design files can point at
different folders.

### 4. Pick a collection

The dropdown lists every local Variables collection, plus **All
Collections** at the top. Selecting a real collection immediately checks
that collection's subfolder and shows which `*.tokens.json` files are
already there (or "Files not found" if none yet) — no extra click needed
to see this.

### 5. Export (Figma → files)

Click **Export**. With a specific collection selected, it writes
`<folder>/<collection-name-lowercased>/<mode-lowercased>.tokens.json`
for every mode in that collection — e.g. a `theme` collection with
`Light`/`Dark` modes produces `<folder>/theme/light.tokens.json` and
`<folder>/theme/dark.tokens.json`. With **All Collections** selected, it
does this for every collection in one click.

Each file uses the same DTCG shape Figma's own native export produces
(`$type`, `$value`, `$description`, `$extensions["com.figma.*"]`),
including `com.figma.variableId` — the mechanism this tool uses to
survive renames on Import.

Before overwriting, Export reads whatever was already at that path and
diffs it against the fresh Figma state (matched by `com.figma.variableId`,
same as Import), so the result reads the same way an Import result
does — a token missing from Figma since the last Export shows up under
`Deleted` immediately, without having to notice it by hand:

```
Created: 1
Deleted: 0
Updated: 3
- Name: 0
- Value: 3
- Scope: 0
- Description: 0
- Code Syntax: 0
```

### 6. Import (files → Figma)

Click **Import**. With a specific collection selected, it imports every
`*.tokens.json` file already found in that collection's subfolder — all
modes, no per-file picking. With **All Collections** selected, it does
this for every collection at once. For every token in the imported
file(s):

- If it carries a `com.figma.variableId` that still resolves to a real
  variable, that variable is updated **by ID**, even if its name or
  position in the JSON changed — so a rename made on the code side (e.g.
  by a coding agent) can be pushed back into Figma cleanly instead of
  creating a duplicate.
- If the ID is missing or stale (target deleted since the last Export),
  it falls back to matching by name, and creates a brand-new Figma
  variable if nothing matches at all.
- `com.figma.codeSyntax` and alias bindings (`com.figma.aliasData`) are
  written back too, not just the raw value.

The panel reports a structured summary — `Created` and `Deleted` (the
stale-ID-fallback case) list the affected token names underneath;
`Updated` is broken down by which field actually changed (`Name` /
`Value` / `Scope` / `Description` / `Code Syntax`). Every count is
deduplicated by token name across all imported mode files, so a token
present in both `light.tokens.json` and `dark.tokens.json` isn't counted
twice just because it was processed twice — plus any notes (e.g. an
alias target that couldn't be resolved).

## Token file format

One JSON file per collection × mode, matching the
[W3C Design Tokens](https://tr.designtokens.org/format/) draft spec with
Figma's own `com.figma.*` extensions:

```json
{
  "content": {
    "surface": {
      "primary": {
        "$type": "color",
        "$value": { "colorSpace": "srgb", "components": [0.09, 0.09, 0.11], "alpha": 1, "hex": "#18181B" },
        "$description": "…",
        "$extensions": {
          "com.figma.variableId": "VariableID:25:382",
          "com.figma.scopes": ["SHAPE_FILL", "TEXT_FILL", "STROKE_COLOR"],
          "com.figma.codeSyntax": { "WEB": "var(--content-surface-primary)" },
          "com.figma.aliasData": {
            "targetVariableId": "VariableID:...",
            "targetVariableName": "zinc/900",
            "targetVariableSetId": "VariableCollectionId:...",
            "targetVariableSetName": "color"
          }
        }
      }
    }
  }
}
```

Nesting follows the variable's Figma name, split on `/` (`content/surface/primary`).

## Limitations

- macOS only (the folder picker).
- Only **local** variables in the current file are read/written — a
  variable bound from an external published library isn't editable via
  the Plugin API and won't round-trip correctly.
- No delete propagation from Figma to files: deleting a variable in
  Figma doesn't remove it from a previously-exported JSON file (the next
  Export naturally corrects this).
- Removing a token from a JSON file **does** delete the matching Figma
  variable on the next Import — but only after an explicit confirmation.
  Before importing, the plugin checks which variables in the collection
  aren't referenced by any of the files being imported and, if there are
  any, shows a dialog listing them and asking to confirm before deleting
  anything. Import proceeds normally (creates/updates, no deletions) if
  you cancel.
- This tool never touches anything outside the folder you point it at —
  it doesn't know about, and won't run, any downstream build step (e.g.
  a catalog-regeneration script in a consuming app repo). Re-run those
  yourself after an Export.

## Troubleshooting

These are real errors hit while building this tool — kept here because
none of them are obvious from Figma's own docs:

| Error | Fix |
| --- | --- |
| `Invalid value for allowedDomains. '...' must be a valid URL` | Figma's manifest validator rejects raw IP literals like `127.0.0.1`. Use `localhost`. |
| `If you want to allow localhost, please add a "reasoning" field... please add a "devAllowedDomains" field instead` | Put `localhost` under `networkAccess.devAllowedDomains`, not `allowedDomains`. If `allowedDomains` is otherwise unused, set it to `["none"]` — an empty array is rejected. |
| `Unable to load code: ... main file must be located in same directory, or a subdirectory, as manifest` | `manifest.json`'s `main` (and `ui`) can't point outside its own directory via `../`. Keep compiled output inside a subfolder of wherever `manifest.json` lives. |
| `Cannot access client storage without a plugin ID` | Add a top-level `"id"` field to `manifest.json`. Any string works for a local/unpublished dev plugin — it's just a storage namespace. |
| Linked `<link rel="stylesheet" href="ui.css">` silently does nothing, plugin renders unstyled | Figma loads the `ui` file as a single standalone document, not from a real static file server — relative `<link>`/`<script src>` to sibling files don't resolve. Inline all CSS/JS into the one `ui.html` file (see `scripts/build-ui.mjs`). |
