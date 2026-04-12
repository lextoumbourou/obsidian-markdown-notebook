# Plan: Obsidian Markdown Notebook Plugin

## Overview

An Obsidian plugin that executes code fence blocks and stores outputs as HTML in the Markdown file. Outputs are identified by a hash of their source code, enabling staleness detection and content-addressable invalidation.

---

## Core Design Decisions

### 1. Output Storage Format

Outputs are stored as an HTML comment block immediately following the source code fence:

```markdown
```python
x = 1 + 1
print(x)
```

<!-- nb-output hash="a3f1b2c4" -->
<div class="nb-output">
<pre>2</pre>
</div>
<!-- /nb-output -->
```

**Rules:**
- The `<!-- nb-output hash="..." -->` marker must appear on the line immediately after the closing ` ``` ` of the source block
- The hash is SHA-256 of the source block content (language identifier + code body)
- If the hash doesn't match the current source block, the output is considered stale and displayed with a visual indicator
- The plugin manages these blocks entirely — users should not manually edit them

### 2. Code Fence Identification

Executable code blocks are identified by a `run-` prefix or by explicit annotation:

```markdown
```run-python
# This will be executed
```

```python {run}
# Alternative annotation style
```
```

Decision: start with `run-python`, `run-js` etc. (same as obsidian-execute-code) for familiarity. Add `{run}` annotation support later.

### 3. Kernel / Execution Backend

**Phase 1:** Direct subprocess execution (no Jupyter dependency)
- Spawn `python` subprocess, capture stdout/stderr as text
- Detect matplotlib/PIL output by monkey-patching `plt.show()` to save PNG → base64
- Each block runs in isolation (no shared state between cells) — documented limitation

**Phase 3:** Jupyter kernel mode (default once available, requires Jupyter installed)
- Use `jupyter_client` Python package to start/connect to kernels
- Communicate via ZMQ (Jupyter wire protocol)
- Get full MIME bundles: `text/html`, `image/png`, `application/json`, etc.
- Persistent kernel session: variables and imports shared across cells in document
- This is the target end state — the plugin is designed to lead toward a full Markdown-based Jupyter notebook

### 4. Output Rendering

Outputs are stored as raw HTML in the file. Obsidian renders them because it uses an Electron/Chromium renderer that processes inline HTML in preview mode.

For display, the plugin registers a Markdown post-processor that:
1. Finds `<!-- nb-output ... -->` comment blocks in the rendered DOM
2. Replaces them with the rendered HTML content
3. Adds staleness indicators when hash doesn't match

---

## Architecture

```
obsidian-markdown-notebook/
├── src/
│   ├── main.ts                  # Plugin entry, registers commands/processors
│   ├── CodeFenceParser.ts       # Parse code fences, extract language + content
│   ├── HashUtils.ts             # SHA-256 hash of code fence content
│   ├── OutputBlock.ts           # Read/write nb-output comment blocks in editor
│   ├── ExecutionManager.ts      # Manages kernel lifecycle and execution queue
│   ├── kernels/
│   │   ├── SubprocessKernel.ts  # Direct python/node subprocess execution
│   │   └── JupyterKernel.ts     # jupyter_client-based kernel (Phase 2)
│   ├── output/
│   │   ├── MimeRenderer.ts      # Convert MIME bundle → HTML string
│   │   ├── OutputRenderer.ts    # Obsidian post-processor for nb-output blocks
│   │   └── StaleIndicator.ts    # Visual indicator for stale outputs
│   └── settings/
│       ├── Settings.ts
│       └── SettingsTab.ts
├── styles.css
├── manifest.json
└── package.json
```

---

## Component Specifications

### `CodeFenceParser.ts`

```typescript
interface CodeFence {
  language: string;       // e.g. "python"
  source: string;         // raw code content
  hash: string;           // hex hash of language+source
  lineStart: number;      // line of opening ```
  lineEnd: number;        // line of closing ```
}

function parseCodeFences(content: string): CodeFence[]
function hashFence(language: string, source: string): string
```

### `OutputBlock.ts`

Manages reading and writing `nb-output` blocks in the editor.

```typescript
interface OutputBlock {
  hash: string;           // hash this output was generated from
  html: string;           // rendered HTML content
  lineStart: number;      // line of <!-- nb-output ... -->
  lineEnd: number;        // line of <!-- /nb-output -->
}

function findOutputBlock(editor: Editor, afterLine: number): OutputBlock | null
function writeOutputBlock(editor: Editor, afterLine: number, hash: string, html: string): void
function clearOutputBlock(editor: Editor, block: OutputBlock): void
function isStale(fence: CodeFence, block: OutputBlock): boolean
```

### `HashUtils.ts`

```typescript
// SHA-256, truncated to 8 bytes (16 hex chars)
function hashCodeFence(language: string, source: string): string
```

### `MimeRenderer.ts`

Converts a Jupyter MIME bundle (or plain text/stream output) to an HTML string for storage.

```typescript
interface MimeBundle {
  [mimeType: string]: string;  // e.g. "text/html": "<table>...</table>"
}

interface StreamOutput {
  name: "stdout" | "stderr";
  text: string;
}

function renderMimeBundle(bundle: MimeBundle): string
function renderStream(output: StreamOutput): string
function renderError(ename: string, evalue: string, traceback: string[]): string
```

Priority order for MIME types (highest wins):
1. `text/html`
2. `image/svg+xml`
3. `image/png` → wrap in `<img src="data:image/png;base64,..."/>`
4. `application/json`
5. `text/markdown` → convert to HTML
6. `text/plain` → wrap in `<pre>`

### `OutputRenderer.ts`

Obsidian `MarkdownPostProcessor` that finds and renders `nb-output` blocks.

```typescript
// Registered via plugin.registerMarkdownPostProcessor(...)
async function processOutputBlocks(element: HTMLElement, context: MarkdownPostProcessorContext): void
```

Strategy:
- Parse rendered DOM for HTML comments (note: Obsidian's renderer may strip comments)
- If comments are stripped: use a custom code block processor for a sentinel marker instead
- Alternative: store outputs in a `\`\`\`nb-output\`` fenced block (guaranteed preserved)

> **Issue to validate early:** Does Obsidian's Markdown renderer preserve HTML comments in preview mode? If not, we need to use a fenced block (`\`\`\`nb-output`) as the container instead of HTML comments. The hash can still be in the info-string: `` ```nb-output hash="a3f1b2c4" ``.

### `SubprocessKernel.ts`

Phase 1 execution backend.

```typescript
class SubprocessKernel {
  execute(language: string, code: string): AsyncIterator<KernelOutput>
  interrupt(): void
  restart(): void
}

interface KernelOutput {
  type: "stream" | "display_data" | "execute_result" | "error";
  data: MimeBundle | StreamOutput | ErrorOutput;
}
```

Implementation for Python:
1. Write code to temp file
2. Spawn `python -c "import sys; exec(open(sys.argv[1]).read())" <tmpfile>`
3. Capture stdout/stderr
4. For rich outputs: inject a small shim that overrides `plt.show()`, `display()`, etc. to emit base64-encoded MIME bundles on a special JSON channel (e.g., print to stderr with a sentinel prefix `__nb_output__:{json}`)

---

## Implementation Phases

### Phase 1: Minimal Viable Plugin

**Goal:** Run Python code blocks, store text output in `<!-- nb-output -->` blocks, show stale indicator when source changes.

Tasks:
1. Scaffold plugin from obsidian-sample-plugin template
2. Implement `CodeFenceParser` — find `run-python` blocks, extract content, compute hash
3. Implement `HashUtils` — SHA-256 via Web Crypto API
4. Implement `SubprocessKernel` (text output only, via Node `child_process`)
5. Implement `OutputBlock` — write/read/clear `<!-- nb-output -->` comment blocks
6. Implement run button injection (port from obsidian-execute-code's `RunButton.ts`)
7. Implement `OutputRenderer` — post-processor to render stored HTML in preview
8. Implement stale output detection and visual indicator
9. Settings: Python path, timeout

### Phase 2: Rich Outputs

**Goal:** DataFrames, matplotlib plots, other rich MIME outputs.

Tasks:
1. Inject Python shim for `display()`, `plt.show()`, `IPython.display.*`
2. Implement `MimeRenderer` with full MIME priority chain
3. Handle base64 PNG outputs
4. Handle HTML table outputs (pandas DataFrames)
5. Handle SVG outputs

### Phase 3: Jupyter Kernel Mode

**Goal:** Full Jupyter wire protocol for maximum compatibility.

Tasks:
1. Implement `JupyterKernel` using `jupyter_client` via a local Python bridge
2. Persistent kernel sessions (variables shared across cells)
3. Interrupt/restart support
4. Support for IPython magics (`%timeit`, `%%bash`, etc.)
5. Kernel manager UI (similar to obsidian-execute-code's `ExecutorManagerView`)

### Phase 4: Multi-language Support

Support for JavaScript (Node), R, Julia, Shell — same architecture, different kernels.

---

## Open Questions

1. **HTML comment preservation in Obsidian:** Does the Markdown renderer preserve `<!-- -->` comments in preview? If not, we use `` ```nb-output `` fenced blocks instead.

2. **Execution order / kernel state:** ✅ Resolved. Kernel mode is the default (Phase 3+). Execution order matches Jupyter: on-demand per-cell, not forced top-to-bottom. Phase 1 isolation is a documented temporary limitation.

3. **Image storage:** ✅ Resolved. Inline base64 for now. Future: code fence config `{output=image}` to opt into external file storage. The info-string arg system (borrowed from obsidian-execute-code's `CodeBlockArgs.ts`) will handle this naturally when we get there.

4. **Output HTML escaping:** We're storing raw HTML in the file. This is intentional for rich rendering, but it means the `.md` file contains arbitrary HTML — a potential concern for users who share files publicly.

5. **Live update vs. replace-on-complete:** ✅ Resolved. Stream to DOM during execution (temporary in-memory element), write to file atomically on completion. On interrupt, write whatever output arrived up to that point.
