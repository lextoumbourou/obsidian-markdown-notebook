# Plan: Loading state for output blocks

## Problem

When a code cell takes a while to run, the user can scroll and accidentally edit the output HTML before execution completes. The output block only appears once execution finishes, leaving nothing to anchor the cursor away from.

## Goal

Insert a placeholder output block into the file immediately when Run is clicked, before execution starts. Replace it with the real output when execution completes (or an error state if it fails).

## Proposed output block states

Three states, all using the existing `<!-- nb-output -->` comment format:

```
<!-- nb-output hash="abc123" format="html" status="running" -->
<!-- /nb-output -->
```

```
<!-- nb-output hash="abc123" format="html" -->
<div class="nb-output-html">...</div>
<!-- /nb-output -->
```

```
<!-- nb-output hash="abc123" format="html" status="error" -->
<!-- /nb-output -->
```

The `status` attribute is omitted on success (backwards compatible with existing output blocks).

## Implementation steps

1. **Write placeholder on click** -- in `RunButton.ts`, at the start of the click handler (before kernel execution), call `writeOutputBlock` with empty content and `status="running"`. This requires adding an optional `status` param to `writeOutputBlock` and the marker serialisation in `OutputBlock.ts`.

2. **Render loading state** -- in `MimeRenderer.ts` or a new `OutputBlockRenderer.ts`, detect `status="running"` in the rendered output block and show a spinner or "Running..." message inside the output element in the Obsidian UI. This is a live preview concern only -- the file just has an empty block.

3. **Replace on completion** -- existing `writeOutputBlock` call at the end of execution already overwrites the block. Remove `status` on success (omit the attribute).

4. **Write error state on failure** -- in the `catch` block in `RunButton.ts`, call `writeOutputBlock` with empty content and `status="error"` so the block stays anchored but signals failure.

5. **Update `findOutputBlock`** -- ensure the parser reads and preserves the `status` attribute.

6. **CSS** -- add a `.nb-output-running` style with a simple animation (e.g. pulsing border or spinner) and `.nb-output-error` with a warning colour.

## Files affected

- `src/OutputBlock.ts` -- add `status` to `OutputBlock` type, `makeMarker`, `findOutputBlock`, `writeOutputBlock`
- `src/RunButton.ts` -- write placeholder before execution, write error state on failure
- `src/MimeRenderer.ts` -- render loading/error states in the live preview
- `src/styles.css` -- add loading and error state styles

## Out of scope

- Run All (`RunAll.ts`) -- can follow the same pattern in a separate pass once the single-cell flow is stable
- Cancellation -- not planned yet
