# Changelog

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
