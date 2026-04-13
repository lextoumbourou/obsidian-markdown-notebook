# Implementation Notes

Track implementation decisions, gotchas, and deviations from the plan as work progresses.

## Status: Phase 1 + Phase 2 complete

---

## What's Built

| Component | File | Notes |
|---|---|---|
| Plugin entry | `src/main.ts` | Registers processors for all languages + commands |
| Languages | `src/languages.ts` | `SUPPORTED_LANGUAGES`, `LANG_ALIASES`, `canonicalLang()` |
| Settings | `src/settings/Settings.ts`, `SettingsTab.ts` | Per-language paths, timeout, defaultFormat, media, markdownLinks |
| Frontmatter | `src/NotebookFrontmatter.ts` | Per-note defaults from `notebook:` YAML key |
| Hash utility | `src/HashUtils.ts` | SHA-256 via Web Crypto, truncated to 8 bytes |
| Output block I/O | `src/OutputBlock.ts` | find/write/clear `<!-- nb-output -->` blocks; image save |
| MIME rendering | `src/output/MimeRenderer.ts` | Chunks → HTML; live DOM appending |
| HTML→Image | `src/output/HtmlToImage.ts` | html-to-image (SVG foreignObject) fallback for non-native images |
| Python kernel | `src/kernels/SubprocessKernel.ts` | Persistent `python3 -i` REPL |
| Node kernel | `src/kernels/NodeKernel.ts` | Persistent Node.js via `vm.createContext` + stdin JSON protocol |
| Shell kernel | `src/kernels/ShellKernel.ts` | Per-execution `bash -c` |
| R kernel | `src/kernels/RKernel.ts` | Persistent `R --slave` REPL |
| Base kernel | `src/kernels/BaseKernel.ts` | Shared REPL infrastructure; `kernelEnv()`, `stripAnsi()` |
| Run button | `src/RunButton.ts` | Code block processor; all supported blocks get run button |
| Run All | `src/RunAll.ts` | Executes all supported cells in document order |

---

## Decisions Log

### 2026-04-12 — Output comment format

- Chose `<!-- nb-output hash="..." -->` HTML comment delimiters over fenced `` ```nb-output `` blocks
  - **Rationale:** HTML comments are invisible in Obsidian preview, Pelican, and standard HTML renderers. Fenced blocks would show as ugly code blocks in non-Obsidian renderers.
  - **Target renderers:** Obsidian preview, PDF export, Pelican. GitHub rendering is explicitly NOT a goal.

- Chose SHA-256 via Web Crypto API (`crypto.subtle.digest`) rather than a bundled hash library

### 2026-04-12 — No `{run}` gate

- All code blocks for supported languages get a run button — no `{run}` annotation needed
- Cell args use `{key=value}` syntax directly: `{format=image id=chart}`
- `getSectionInfo(el)` is called inside the click handler (not at render time) to avoid stale null returns during initial render

### 2026-04-12 — Output formats

- Two formats: `html` (default) and `image`
- `format=markdown` was considered and removed — too narrow (only useful for `df.to_markdown()`)
- `defaultFormat` plugin setting (`html` | `image`) sets the baseline; overridden by frontmatter then cell args
- Precedence: **plugin settings** → **frontmatter** → **cell args**
- `format=image` priority: native `image/png` chunk (matplotlib/R) → html-to-image fallback → save HTML

### 2026-04-12 — Image rendering fallback

- When `format=image` is set but code produces no native `image/png` chunk, html-to-image converts the HTML output to PNG
- Uses SVG `foreignObject` approach (html-to-image library) — browser handles CSS rendering including Obsidian CSS variables
- html2canvas was tried first but failed: it re-implements CSS in JS and can't resolve CSS variables, producing blank images
- Key gotcha: the container element passed to `toPng()` must NOT have `position:fixed` — the fixed positioning is cloned into the foreignObject and renders off-screen. Solution: wrap in a fixed off-screen parent, pass the inner container (no position style) to `toPng()`

### 2026-04-12 — Multi-language architecture

- `BaseKernel` abstract class handles the finish-sigil protocol, exec queue, stdout streaming, RICH_SIGIL parsing
- `ShellKernel` doesn't extend `BaseKernel` — per-execution `bash -c` doesn't fit the persistent REPL model
- `NodeKernel` uses `vm.createContext` + JSON stdin protocol instead of Node's interactive REPL (too unreliable for programmatic use)
- `kernelEnv()` prepends `/usr/local/bin`, `/opt/homebrew/bin` etc. to PATH — Obsidian launched from the Dock doesn't inherit shell PATH

### 2026-04-12 — Python REPL

- Multi-line try/finally blocks sent to `python -i` require a trailing blank line to signal end-of-block
- `__nb_run__` uses `ast.parse` to split code: execs all-but-last statement, evals last expression if `ast.Expr`, calls `__nb_display__` on result
- `__nb_display__` checks `_repr_html_`, `_repr_svg_`, `_repr_markdown_`, `_repr_png_` in priority order
- `plt.show` is monkey-patched to capture figure as base64 PNG via `\x00NB_RICH\x00` protocol

### 2026-04-12 — Image file writes

- `saveImageToVault` uses `vault.adapter.exists()` (filesystem check) rather than `getAbstractFileByPath` (index check) — vault index can be stale, causing "File already exists" errors on re-run
- Falls back to `vault.adapter.writeBinary()` if index is stale after exists check

### 2026-04-12 — Run All write order

- Execute all cells sequentially (collecting outputs), then write in **reverse document order** so each write only shifts line numbers of already-written blocks

### 2026-04-12 — Conflict detection

- `registerMarkdownCodeBlockProcessor` throws if another plugin has already claimed a language
- Wrapped in try/catch; conflicting languages collected and shown in a persistent Notice with instructions to disable the conflicting plugin

---

## Actual File Structure

```
src/
├── main.ts
├── languages.ts
├── HashUtils.ts
├── OutputBlock.ts
├── NotebookFrontmatter.ts
├── RunButton.ts
├── RunAll.ts
├── kernels/
│   ├── BaseKernel.ts
│   ├── SubprocessKernel.ts
│   ├── NodeKernel.ts
│   ├── ShellKernel.ts
│   └── RKernel.ts
├── output/
│   ├── MimeRenderer.ts
│   └── HtmlToImage.ts
└── settings/
    ├── Settings.ts
    └── SettingsTab.ts
```
