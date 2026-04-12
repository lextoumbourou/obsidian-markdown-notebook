# Implementation Notes

Track implementation decisions, gotchas, and deviations from the plan as work progresses.

## Status: Pre-implementation (planning phase)

---

## Decisions Log

### 2026-04-12 — Initial planning

- Chose `<!-- nb-output hash="..." -->` HTML comment delimiters over fenced `\`\`\`nb-output\`` blocks
  - **Rationale:** HTML comments are invisible in Obsidian preview, Pelican, and standard HTML renderers. The output HTML renders correctly in all these contexts. Fenced blocks would show as ugly code blocks in non-Obsidian renderers.
  - **Confirmed:** Obsidian preserves HTML comments in preview mode, and they are accessible via the post-processor DOM API (requires `TreeWalker` with `NodeFilter.SHOW_COMMENT`).
  - **Target renderers:** Obsidian preview, PDF export (via Obsidian or Pandoc), Pelican static site generator. GitHub rendering is explicitly NOT a goal.
  - No fallback needed — HTML comment approach is confirmed viable.

- Chose SHA-256 via Web Crypto API (`crypto.subtle.digest`) rather than a bundled hash library
  - Web Crypto is available in Electron/Node environments
  - Returns ArrayBuffer; encode as hex string

- Phase 1 will use direct subprocess execution (no Jupyter dependency)
  - Keeps the plugin self-contained
  - Adds a Python shim to capture rich outputs via a sentinel JSON protocol on stderr

## Implementation Spikes Needed

### Spike 1: Python subprocess + sentinel protocol

Test the shim that intercepts `display()` and `plt.show()`. Emit:

```
__nb_output_start__
{"mime_type": "image/png", "data": "<base64>"}
__nb_output_end__
```

to stderr. The plugin separates stdout (stream output) from stderr (MIME output bundles).

### Spike 2: Editor position stability

When inserting/replacing an output block after a code fence, we need the editor position to be stable. Test with `editor.replaceRange()` vs `editor.transaction()` to determine which is less disruptive to the undo history.

## File Structure (Phase 1)

```
src/
├── main.ts
├── CodeFenceParser.ts
├── HashUtils.ts
├── OutputBlock.ts
├── RunButton.ts
├── ExecutionManager.ts
├── kernels/
│   └── SubprocessKernel.ts
├── output/
│   ├── MimeRenderer.ts
│   └── OutputRenderer.ts
└── settings/
    ├── Settings.ts
    └── SettingsTab.ts
```

## Key Implementation References

- **Run button injection pattern:** `reference/obsidian-execute-code/src/RunButton.ts:addToCodeBlock()`
- **Editor range finding:** `reference/obsidian-execute-code/src/output/FileAppender.ts:getRangeOfCodeBlock()`
- **Output block write/clear:** `reference/obsidian-execute-code/src/output/FileAppender.ts:addOutput()` and `clearOutput()`
- **Code block arg parsing:** `reference/obsidian-execute-code/src/CodeBlockArgs.ts` — we can reuse the JSON5 args-in-info-string approach
- **Subprocess execution:** `reference/obsidian-execute-code/src/executors/` — port the Python executor
