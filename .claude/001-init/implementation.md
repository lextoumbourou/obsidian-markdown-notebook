# Implementation Notes

Track implementation decisions, gotchas, and deviations from the plan as work progresses.

## Status: Phase 1 + Phase 2 (partial) complete

---

## What's Built

### Phase 1 — complete

| Component | File | Notes |
|---|---|---|
| Plugin entry | `src/main.ts` | Registers processors and commands |
| Settings | `src/settings/Settings.ts`, `SettingsTab.ts` | pythonPath, executionTimeout |
| Hash utility | `src/HashUtils.ts` | SHA-256 via Web Crypto, truncated to 8 bytes |
| Output block I/O | `src/OutputBlock.ts` | find/write/clear `<!-- nb-output -->` blocks in raw file text |
| MIME rendering | `src/output/MimeRenderer.ts` | Chunks → HTML; live DOM appending |
| Python kernel | `src/kernels/SubprocessKernel.ts` | Persistent `python3 -i` REPL |
| Run button | `src/RunButton.ts` | Code block processor, staleness check, execution flow |
| Run All | `src/RunAll.ts` | Executes all `{run}` cells in document order |

### Phase 2 — complete

- **Pandas DataFrames** — `ast.parse`-based eval-last-expression, `_repr_html_()` dispatch
- **Matplotlib plots** — `plt.show()` override, base64 PNG via `\x00NB_RICH\x00` sentinel
- **Error tracebacks** — ANSI escape code stripping, red left-border styling
- **Run All command** — sequential execution, reverse-order file writes
- **Execution count** — `[N]` badge on run buttons; increments per execution, resets on kernel restart
- **Output format option** — `{run output=html|markdown|image}` controls storage format

---

## Decisions Log

### 2026-04-12 — Initial planning

- Chose `<!-- nb-output hash="..." -->` HTML comment delimiters over fenced `` ```nb-output `` blocks
  - **Rationale:** HTML comments are invisible in Obsidian preview, Pelican, and standard HTML renderers. The output HTML renders correctly in all these contexts. Fenced blocks would show as ugly code blocks in non-Obsidian renderers.
  - **Confirmed:** Obsidian preserves HTML comments in preview mode and they are accessible via the post-processor DOM API (requires `TreeWalker` with `NodeFilter.SHOW_COMMENT`).
  - **Target renderers:** Obsidian preview, PDF export (via Obsidian or Pandoc), Pelican static site generator. GitHub rendering is explicitly NOT a goal.

- Chose SHA-256 via Web Crypto API (`crypto.subtle.digest`) rather than a bundled hash library

- Phase 1 uses direct subprocess execution (no Jupyter dependency). Rich outputs via `\x00NB_RICH\x00{json}` sentinel on stdout.

### 2026-04-12 — Code fence syntax

- Changed from `run-python` to `python {run}` info-string annotation
  - **Rationale:** `run-python` is not a recognised language in Obsidian's editor — no syntax highlighting in Live Preview. With `python {run}`, the language identifier is `python`, so Obsidian applies full Python highlighting.
  - **Implementation:** `registerMarkdownCodeBlockProcessor('python', ...)` intercepts ALL python blocks; we check for `{run}` in the fence info string via `getSectionInfo` and fall through to Prism rendering for plain blocks.
  - **Gotcha:** `getSectionInfo(el).lineStart` doesn't always point to the opening fence — Obsidian sometimes groups a preceding HTML block (nb-output) with the code block into one section. Fixed by scanning from `lineStart` to `lineEnd` for the first `` ```python `` line rather than assuming `lineStart` IS the fence.

### 2026-04-12 — Python REPL blank line terminator

- Multi-line try/finally blocks sent to `python -i` via stdin require a trailing blank line to signal end-of-block to the REPL. Without it the REPL waits for more input and the execution times out.
- Fixed by adding `\n` after the closing line of `wrapCode`, making it `\n\n` total.

### 2026-04-12 — Multi-line cell eval

- Initial `eval()` → `exec()` fallback approach discards the return value of the last expression in multi-line cells (e.g., `import pandas as pd\ndf\n`).
- Fixed using `ast.parse` in the `__nb_run__` setup function: splits the code into statements, execs all-but-last, then evals the final statement if it's an `ast.Expr` node and calls `__nb_display__` on the result.

### 2026-04-12 — Error styling

- `var(--background-modifier-error)` in Obsidian is a solid red fill — too heavy for inline error output, text becomes invisible.
- Used transparent background with a red left border and `var(--text-error)` colour instead.

### 2026-04-13 — Output format option

- `{run output=html}` (default): HTML stored in `<!-- nb-output -->` block
- `{run output=markdown}`: raw markdown stored; Obsidian renders natively (good for `df.to_markdown()` tables)
- `{run output=image}`: PNG saved as `NOTENAME-nb-HASH.png` alongside the note; `![[filename]]` stored in block; falls back to HTML if no image was produced
- `format="..."` attribute added to `<!-- nb-output -->` marker; absent format treated as `"html"` for backwards compatibility
- `saveImageToVault` uses `atob` + `Uint8Array` (not Node `Buffer`) for ArrayBuffer conversion — works in Electron renderer context

### 2026-04-13 — Execution count indicators

- `SubprocessKernel.executionCount` public field, incremented in `finish()` after each successful execution, reset to `0` in `stop()`
- `[N]` badge rendered as `<span class="nb-exec-count">` inside a flex `nb-run-button-wrap` div
- Badge initialised from `kernel.executionCount` at render time, updated after each click

### 2026-04-12 — Run All write order

- Writing output blocks modifies the file and shifts line numbers for subsequent blocks.
- Solution: execute all cells sequentially (collecting outputs), then write outputs in **reverse document order** so each write only shifts line numbers of blocks that have already been written.

---

## Resolved Spikes

### Spike 1: Python subprocess + sentinel protocol ✅

- Rich outputs emitted as `\x00NB_RICH\x00{"mime": "...", "data": "..."}` on stdout
- `\x00` prefix ensures the marker won't appear in normal text output
- JSON-encoding handles all escaping including embedded newlines in HTML

### Spike 2: Editor position stability ✅

- Using `app.vault.process(file, fn)` (Obsidian v1.4+ transactional API) instead of `editor.replaceRange()`
- Operates on raw file text, not the editor DOM — no undo history disruption, works even when the file isn't open in an editor

---

## Actual File Structure

```
src/
├── main.ts
├── HashUtils.ts
├── OutputBlock.ts
├── RunButton.ts
├── RunAll.ts
├── kernels/
│   └── SubprocessKernel.ts
├── output/
│   └── MimeRenderer.ts
└── settings/
    ├── Settings.ts
    └── SettingsTab.ts
```

Note: `CodeFenceParser.ts`, `ExecutionManager.ts`, and `OutputRenderer.ts` from the original plan were not needed — their roles were absorbed by `RunButton.ts`, `SubprocessKernel.ts`, and Obsidian's native HTML pass-through respectively.
