# Markdown Notebook — Example Vault

A manual smoke-test vault for the plugin. One note per language, plus notes for cross-cutting features. Each cell is annotated with its expected result.

## Setup

1. `npm run build` in the repo root (the plugin in this vault is symlinked to the repo's `main.js`, `manifest.json`, and `styles.css`)
2. Open this folder as a vault in Obsidian (**Open folder as vault**)
3. When prompted, trust the vault and enable community plugins
4. Requirements: `python3` (with `pandas` + `matplotlib`), `node`, `bash`, and `R` (with `knitr`, `jsonlite`, `base64enc`) on PATH

## Test notes

- [Python](Python.md) — plain output, expression display, state, DataFrame table, matplotlib, image format, stderr, errors
- [R](R.md) — plain output, state, kable table, plots, image format, messages, errors
- [Bash](Bash.md) — plain output, pipelines, stderr, fresh-process-per-cell semantics, aliases
- [JavaScript](JavaScript.md) — console output, object display, state, `js` alias, errors
- [Timeouts](Timeouts.md) — per-note timeout frontmatter, ⏱ timeout blocks, recovery after timeout
- [Frontmatter Defaults](Frontmatter%20Defaults.md) — note-level `notebook:` defaults (format, media folder, markdown links)

Run cells individually with **▶ Run**, and also test the **Run all cells** command on at least one note.

## Plugin settings are local

Settings changed in this vault (Settings → Markdown Notebook) are stored in `data.json`, which is gitignored — configure once and they survive resets. In particular, **set the Python path to an interpreter that has `pandas` and `matplotlib`** or the rich-output cells in [Python](Python.md) will fail with `ModuleNotFoundError`.

## Resetting after a run

Outputs are written into the `.md` files and images into the vault. Reset from a terminal in the repo root (note: every `bash` fence in this vault gets a ▶ Run button — which is why these instructions are in a plain `text` fence):

```text
git checkout -- example-vault
git clean -fd example-vault
```

Tip: before resetting, `git diff example-vault` shows exactly what this version wrote — useful for spotting output regressions between versions.
