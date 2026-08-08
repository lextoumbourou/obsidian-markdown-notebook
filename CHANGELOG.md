# Changelog

## Unreleased

### Added
- Code languages such as `format=json` now store plain text output as syntax-highlighted Markdown fences. The default remains `format=html`

### Changed
- Background cells now tangle preceding, non-background cells of the same language into their fresh process by default. Use `{context=none}` for an isolated process
- Background startup output reports how many preceding cells were included, and common temporary-file diagnostics point back to the relevant note line

### Fixed
- Reading View now matches Obsidian's trailing-newline and CRLF-normalised cell source when locating a background cell, so preceding context is not silently omitted
- Carriage-return progress output from background processes is streamed, and unterminated stderr is force-flushed before its buffer can grow without bound
- Bare Node traceback locations are mapped from temporary scripts back to their source note lines
- `nb-run --write` snapshots background startup output instead of allowing later process logs to leak into the persisted block

## [0.5.0] - 2026-08-06

### Added
- Managed background cells for Python, JavaScript, Bash, and R via `{background=<name>}`. Background cells run in fresh processes, let Run All continue immediately, and expose a Stop button in the note
- Automatic cleanup of notebook-managed background processes when a cell is stopped, its note closes or is renamed or deleted, kernels restart, the plugin unloads, or a headless CLI run ends
- Background-process coverage in the example vault and implementation notes for the lifecycle design

### Changed
- Background-cell startup output is persisted, while later output is drained into a bounded in-memory buffer so long-running processes cannot grow the note without limit

## [0.4.0] - 2026-08-04

### Added
- **Run all cells above cursor** and **Run cell and all cells below cursor** editor commands for rebuilding or continuing shared notebook state without running the entire note
- Configurable per-cell output-size cap, defaulting to 100 KB, with a visible truncation marker; `notebook.outputLimit` and the CLI's `--output-limit` override the limit in KB
- **Run cell under cursor** command for executing and persisting the current cell directly from Live Preview or Source mode; the command can be assigned a hotkey in Obsidian
- Active **Run** and **Run all cells** buttons now become red **Stop** buttons, allowing the current cell or notebook-wide run to be interrupted without executing queued cells
- Notebook-scoped kernel sessions: persistent Python, Node.js, and R state is shared within a note but isolated between notes, along with execution counts and runtime configuration
- Kernels now use the note's folder as their working directory, making relative file access predictable; `notebook.cwd` can select a note-relative directory, an absolute path, or the vault root with `/`/`vault`
- Per-note `notebook.python`, `notebook.node`, `notebook.shell`, and `notebook.r` executable overrides, with relative executable paths resolved from the note's folder
- Persistent failure diagnostics: Python, Node.js, and R exceptions and non-zero shell exits now store the failure marker together with preceding output and an escaped traceback/stderr
- **Clear current cell output** and **Clear all outputs in active note** commands; clearing removes persisted `nb-output` blocks while retaining image attachments and is blocked during active execution

### Changed
- **Run cell under cursor** now acts as a Run/Stop toggle, so pressing its hotkey again interrupts the active cell and persists the interrupted state
- **Interrupt kernel** now targets kernels belonging to the active note; **Restart all kernels** and plugin unload clean up every notebook-scoped session
- The `nb-run` CLI now starts kernels in the note's folder and respects the new working-directory and executable frontmatter fields
- Notebook sessions are shut down when their last Markdown leaf closes and when their note is renamed or deleted, bounding the number of persistent subprocesses
- Relative executable paths in global plugin settings resolve from the vault root; relative frontmatter executable paths remain note-relative

### Fixed
- Cursor-relative range runs restore the Reading View toolbar's full-note cell count after completion or cancellation instead of leaving the subset count behind
- Tracebacks emitted after the output cap is reached now reclaim space from ordinary output and retain their diagnostic tail within the same configured limit
- Oversized Markdown rich output is dropped atomically instead of being truncated inside raw HTML, and `nb-run --write` now reports persisted-output truncation on stderr
- Persisted output containing a line that looks like an executable code fence no longer creates phantom cells or hides later cells from Run All, toolbar counts, output writes, or Clear All
- **Clear current cell output** is now available when the editor cursor is inside the cell's attached output block, not only inside its code fence
- `nb-run` now gives `notebook.cwd: /` and `notebook.cwd: vault` the same vault-root meaning as the plugin, discovering the nearest `.obsidian` directory or requiring `--vault-root` instead of silently running from the filesystem root or a nonexistent `vault` subfolder
- Rendering a code block or execution-count badge no longer creates, replaces, or throws from kernel acquisition, so Canvas, exports, and third-party Markdown rendering can display cells without a resolvable source file
- Replacing or shutting down an active Python, Node.js, R, or shell kernel now settles the cell immediately as cancelled instead of leaving it stuck until its execution timeout
- Run All snapshots one kernel per language before execution, so frontmatter edits cannot replace a session and discard state midway through the run
- Python, Node.js, and R exceptions now reject the cell execution instead of being treated as successful stderr output; persistent kernels remain usable by subsequent cells
- Non-zero shell exit codes now fail the cell, making **Stop on first error** reliable for shell notebooks
- Single-cell, Run All, timeout, and `nb-run --write` failure blocks now retain collected diagnostics instead of replacing them with only a generic “Execution failed” marker
- Timeout output blocks no longer repeat the timeout message as both a status and a diagnostic chunk

## [0.3.0] - 2026-07-28

### Added
- Reading View toolbar for running every executable cell in a note, with cell count, live progress, and support for multiple panes and popout windows
- **Show Run all toolbar** setting, enabled by default, for hiding the Reading View toolbar while keeping the command-palette action available
- **Stop on first error** setting, enabled by default: Run all now stops after the first error or timeout like Jupyter, while preserving outputs from earlier cells and the failed cell; disable it to continue through independent cells

### Fixed
- Run all no longer saves or overwrites an image attachment when its source cell was edited or deleted during execution

## [0.2.0] - 2026-06-10

### Added
- Distinct timeout state for cells: a timed-out cell now writes a `status="timeout"` output block with an "Execution timed out after Ns" message, styled separately from execution errors
- Example vault (`example-vault/`) for manual smoke testing: openable directly in Obsidian with the plugin symlinked to the repo build output, one annotated test note per language plus notes for timeouts and frontmatter defaults; reset between runs with `git checkout -- example-vault && git clean -fd example-vault`
- `nb-run` CLI (`cli.js`, built alongside `main.js`): headless cell runner using the same kernels and output-block format as the plugin. Supports `--list`, `--cell N`/`--id X` targeting with run-up-to semantics (`--only` for a single cell on a fresh kernel), `--write` to update blocks in place, frontmatter defaults, and per-interpreter path flags. Native images only for `format=image` (no DOM for the HTML-to-PNG fallback); media folder is note-relative

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
- Stale "Running..." spinner blocks are repaired: if the post-run write fails the block degrades to an error state instead of spinning forever, and blocks left behind by a crash or plugin reload mid-execution are converted to "Execution was interrupted" when the note is next opened
- CRLF files no longer accumulate duplicate output blocks: line splitting handles `\r\n`, writes preserve the file's existing line endings, and content hashes are line-ending-normalized
- Kernel startup failures are recoverable: a failed start tears down the half-started process and retries on the next run instead of caching the rejection; startup listeners and timers no longer leak
- Output callbacks no longer fire after a shell cell has timed out
- "Run all cells" and the `nb-run` CLI now write the same ⏱ timeout / error status blocks as the per-cell Run button — previously the raw failure text was stored as plain output with no status attribute

### Changed
- README: corrected the documented default image filename (`<hash>.png` since 0.1.5), documented the `status` output attribute, and noted that image filenames are not namespaced per note

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
