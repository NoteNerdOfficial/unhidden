# Unhidden

An Obsidian plugin that reveals hidden dot-folders (`.claude`, `.github`, `.vscode`, and friends) inside your vault. Revealed folders show up in the file explorer, search, the metadata cache, and Bases, and stay live as files change on disk. Nothing on disk is ever modified: revealing and hiding only changes what Obsidian indexes.

## Features

- **Reveal any hidden folder or file**: toggle vault-root dot-entries from settings, reveal a nested hidden path like `projects/.notes`, or reveal a single dotfile like `.env`.
- **Eager indexing**: the full folder tree is registered the moment you reveal it, including deeply nested sub-folders.
- **Live updates**: a recursive watcher keeps revealed folders in sync as files are created, changed, or deleted.
- **New-path alerts**: a lightweight watcher on the vault root notices freshly created hidden folders/files and nudges you to reveal them.
- **File-type control**: index only an allowlist of extensions (the default), or flip to indexing every file type.
- **Exclusions**: folder names like `node_modules` are skipped wherever they appear, so revealing `.expo` or a project folder doesn't flood your index.
- **Command palette**: `Reveal a hidden folder`, `Hide a revealed folder` (both with fuzzy pickers), and `Rescan revealed folders`.

## How it works

Obsidian has no public API for indexing hidden paths, so the plugin calls (and patches) a small set of undocumented methods on the desktop `FileSystemAdapter` (`reconcileFolderCreation`, `reconcileFileInternal`, `reconcileDeletion`, and the `listRecursiveChild` / `reconcileFile` entry points). All patches are guarded, installed only while at least one folder is revealed, and fully restored on unload. This also means the plugin is **desktop only**.

## Development

```sh
npm install
npm run dev    # unminified build with inline sourcemaps
npm run build  # typecheck + minified production build
```

The build bundles `src/main.ts` into `main.js` with esbuild. Copy (or symlink) `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/unhidden/` and enable the plugin in **Settings → Community plugins**.

## Layout

| File | Role |
| --- | --- |
| `src/main.ts` | Plugin entry point: lifecycle, commands, settings persistence |
| `src/reveal-engine.ts` | Core: reveals/conceals folders, eager tree indexing, adapter patches |
| `src/vault-internals.ts` | Typed surface of the undocumented adapter methods |
| `src/settings.ts` | Settings shape, defaults, legacy-format migration, input parsing |
| `src/settings-tab.ts` | Settings UI |
| `src/folder-pick-modal.ts` | Fuzzy folder picker used by the commands |

## License

MIT — see [LICENSE](LICENSE).
