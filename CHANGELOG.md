# Changelog

## [Unreleased]

### Added
- Distinct timeout state for cells: a timed-out cell now writes a `status="timeout"` output block with an "Execution timed out after Ns" message, styled separately from execution errors
- Example vault (`example-vault/`) for manual smoke testing: openable directly in Obsidian with the plugin symlinked to the repo build output, one annotated test note per language plus notes for timeouts and frontmatter defaults; reset between runs with `git checkout -- example-vault && git clean -fd example-vault`

### Fixed
- A single failed execution (timeout or bad interpreter path) no longer permanently poisons a kernel's execution queue — previously every subsequent run of that language failed instantly with the stale error until kernels were restarted
- Timed-out cells are now interrupted (SIGINT) instead of left running, and their late output is discarded rather than leaking into the next execution's output; a kernel that ignores the interrupt for 5s is killed and restarted automatically on the next run
- R kernel could never start: the rich-output sentinel contained a nul byte, which R string literals reject (`nul character not allowed`) — the sentinel is now `\x01`-based across all kernels
- R data frames now render as HTML tables: rich payloads are serialized with `jsonlite::toJSON` instead of hand-rolled JSON, removing the base64 encoding that the renderer never decoded
- R plots now work headless: new plots are routed to a PNG temp file via `options(device)` and emitted after each cell — previously the capture helper was never invoked and base R `plot()` silently wrote `Rplots.pdf` into Obsidian's working directory
- Running multiple cells concurrently no longer corrupts the note: output writes re-anchor to the cell's fence by language + source at write time, instead of trusting line numbers captured at click time (which go stale as soon as an earlier cell inserts its output, splicing blocks into other cells' fences and replacing the wrong outputs)
- Python stderr output is no longer prefixed with runs of `>>> `/`... ` interactive-prompt echoes
- Removed the stray blank line appended to every stdout output block
- Markdown image links from notes at the vault root no longer get a spurious `../../` prefix (Obsidian reports the root folder's path as `/`)

## [0.1.6] - 2026-04-21

### Added
- Loading state placeholder: a spinner block (`status="running"`) is written to the file while a cell is executing

## [0.1.5] - 2026-04-21

### Changed
- Default image filenames now use just `{hash}.png` instead of `{notename}-nb-{hash}.png` when no `id=` arg is set

## [0.1.4] - 2026-04-21

### Fixed
- Strip trailing slashes from the media folder path setting to prevent malformed image vault paths

## [0.1.3] - 2026-04-21

### Changed
- README rewrite: title image, clearer How It Works section, updated settings table, document-level defaults docs
- `notebook.format` frontmatter field now strictly validated to `html` | `image` only

## [0.1.2] - 2026-04-21

### Added
- `format=image` now works for any output, not just matplotlib — HTML output is automatically rendered to PNG via the browser's layout engine (SVG foreignObject) when no native image is produced
- `defaultFormat` plugin setting (`html` | `image`) sets the baseline output format for all cells

### Changed
- Removed `format=markdown` — use `format=html` (default) or `format=image`

### Fixed
- "File already exists" error when re-running image cells — now uses `vault.adapter.exists()` (filesystem check) instead of the stale vault index
- Pandas `<style scoped>` CSS no longer leaks as visible text in Obsidian reading mode — style tag content is collapsed to a single line before storage
- `format=image` args were silently ignored when `getSectionInfo` returned null during initial render — args are now read at click time instead of render time

## [0.1.1] - 2026-04-21

### Added
- All supported language code blocks get a **▶ Run** button automatically — no `{run}` annotation required
- Document-level defaults via `notebook:` frontmatter key (`format`, `media`, `timeout`, `markdownLinks`)
- Conflict detection: shows a persistent notice if another plugin has claimed a language's code block processor
- `src/languages.ts` — single source of truth for supported languages and aliases

### Changed
- Cell args renamed from `output=` to `format=` (e.g. `{format=image}`)
- Precedence order: plugin settings → frontmatter → cell args

### Fixed
- ESLint 10 flat config (`eslint.config.mjs`) — CI was failing due to removal of `.eslintrc.*` support

## [0.1.0] - 2026-04-13

Initial release.

### Features
- Execute Python, JavaScript (Node.js), Bash, and R code blocks directly in Obsidian notes
- Persistent kernel state — variables defined in one cell are available in subsequent cells
- Outputs stored inline in the `.md` file as `<!-- nb-output -->` comment blocks
- HTML output: DataFrames, rich objects via `_repr_html_()`
- Image output: matplotlib plots saved as PNG to vault; `![[wikilink]]` or `![](markdown)` link stored in file
- `[N]` execution count badge on each run button, resets on kernel restart
- Run All Cells command — executes every supported block in document order
- `id=` arg for stable image filenames across re-runs
- Settings: per-language executable paths, execution timeout, media folder, markdown image links
- GitHub Actions CI (lint + test + build) and tag-triggered release workflow
- BRAT installation support
