# Implementation: Loading state for output blocks

## What was done

### `src/OutputBlock.ts`
- Added `OutputStatus = "running" | "error"` type
- Added optional `status?: OutputStatus` field to `OutputBlock` interface
- Updated `findOutputBlock` to read and return the `status` attribute
- Updated `makeMarker`, `replaceBlock`, `insertBlock`, and `writeOutputBlock` to accept and serialise an optional `status` parameter
- Status is omitted from the marker when undefined, keeping existing output blocks backwards compatible

### `src/RunButton.ts`
- Added `RUNNING_HTML` and `ERROR_HTML` constants -- simple HTML snippets using `.nb-status-running` and `.nb-status-error` CSS classes
- At the start of the click handler, before kernel execution, writes a placeholder block with `status="running"` and `RUNNING_HTML` content into the file
- On execution error, overwrites the block with `status="error"` and `ERROR_HTML` content
- On success, overwrites the block with the real output and no `status` attribute (existing path, unchanged)

### `styles.css`
- Added `.nb-status-running` -- flex container with spinner and "Running..." label
- Added `.nb-status-spinner` -- CSS-only spinning circle using `border-top-color` and `@keyframes nb-spin`
- Added `.nb-status-error` -- error text in `var(--text-error)` with a `✕` prefix

### `__tests__/output-block.test.ts`
- Added test: `findOutputBlock` parses `status="running"` attribute
- Added test: `findOutputBlock` leaves `status` undefined when attribute is absent
- Added test: `writeOutputBlock` includes `status` attribute in marker when provided
- Added test: `writeOutputBlock` omits `status` attribute when not provided

## Result

When Run is clicked, a placeholder with a spinner immediately appears in the document. The gap that previously existed between click and output (where accidental edits could land) is now anchored by the placeholder block. On completion the placeholder is replaced with real output; on failure it shows an error state.
