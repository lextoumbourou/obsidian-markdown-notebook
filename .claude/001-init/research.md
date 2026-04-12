# Research: Obsidian Markdown Notebook

## Goal

Build an Obsidian plugin that executes code fence blocks and stores outputs as HTML directly in the Markdown file — like `obsidian-execute-code` but with Jupyter-quality rendering and persistent, content-addressed outputs.

---

## Prior Art

### obsidian-execute-code

**Source:** `reference/obsidian-execute-code/`

The closest existing implementation. Key observations:

- Uses `run-python`, `run-js`, etc. code fence language identifiers to flag executable blocks
- Injects a run button into the rendered HTML via `registerMarkdownCodeBlockProcessor` and `registerMarkdownPostProcessor`
- Executes code in a subprocess via `child_process`, streams stdout/stderr back to an `Outputter` object
- **Output persistence:** `FileAppender` writes a `\`\`\`output` block directly after the source fence in the editor using `editor.replaceRange()`
- Output blocks are identified by structural position (must immediately follow the code block), not by hash
- No Jupyter rendering — outputs are plain text in a fenced block
- No MIME type awareness — everything is streamed as text

**Key limitation:** Output identity is positional, not content-addressed. Moving cells or editing above them breaks association. No way to know if stored output is stale.

---

### jupytext

**Source:** `reference/jupytext/`

Python library for round-tripping `.ipynb` ↔ text formats (Markdown, percent scripts, MyST).

Key observations for our use case:

- Markdown format uses standard fenced code blocks; cell metadata goes in the info-string or as YAML within the block
- Outputs are deliberately excluded from the Markdown format — the companion `.ipynb` holds them
- `cell_reader.py` / `cell_to_text.py` handle parsing cells from text and serialising back
- `FileAppender`-equivalent logic would be in `cell_to_text.py`

**Relevant issue [#220](https://github.com/mwouts/jupytext/issues/220):** Adding outputs to Markdown was explored and abandoned due to:
1. No standard way to embed HTML that renders on GitHub
2. Inline outputs make diffs noisy and files large
3. Two-way sync becomes fragile when outputs are inline

**Key design note from @mwouts:** HTML outputs can be embedded inline and will work in VS Code/Obsidian but NOT on GitHub (GitHub sanitises `<iframe>`, `<object>`, `<script>`). Plain HTML injected directly into the file does work in Obsidian's preview mode.

---

### jupymd (obsidian plugin)

**Source:** `reference/jupymd/`

Bridges Obsidian ↔ Jupyter via jupytext. Key observations:

- Requires Python + Jupyter + jupytext installed (heavy prerequisites)
- Uses a paired `.ipynb` file as the output store — not inline in Markdown
- Outputs rendered by fetching the `.ipynb` and extracting cell outputs
- Bidirectional sync is the main value prop

**Our differentiation:** We want outputs stored inline in the `.md` file, no `.ipynb` dependency, uses Jupyter's rendering engine for MIME types (HTML/images/tables/plots) but does not require the full Jupyter stack.

---

### JEP #103 — Markdown-based Notebooks

**URL:** https://github.com/jupyter/enhancement-proposals/pull/103  
**Status:** Open draft, never merged (as of 2025-11)

Proposes `.nb.md` format using fenced directives:

```
```{jupyter.code-cell execution_count=42}
print('hi')
```
```{jupyter.output output_type=stream}
---
name: stdout
---
hi
```
```

Key decisions/tensions from the discussion:

- **Syntax wars:** `{jupyter.code-cell}` incompatible with Pandoc attribute syntax; `{.jupyter-code}` or `{.jupyter .code-cell}` are alternatives
- **Outputs inline vs companion file:** @echarles and @mwouts both argue companion file is cleaner for VCS; inline outputs make diffs noisy
- **GitHub renderability:** Neither the proposed output blocks nor embedded HTML renders on GitHub
- **No consensus** on whether to extend an existing format (MyST/Quarto) or define a new one
- The JEP was **stalled** — no implementation, no merge

**Takeaway:** The ecosystem has not solved this. We are free to make pragmatic choices for Obsidian specifically (GitHub renderability is not a goal; Obsidian renderability is).

---

### LitREPL / knitr / Codebraid (adjacent tools)

- **LitREPL** (Vim plugin): stores result in a `result` fenced block directly after the code block — simple, positional
- **knitr** intermediate Markdown: outputs follow code blocks with `## ` prefix, HTML tables as inline HTML, widgets as `` ```{=html} `` blocks
- **Codebraid**: converts Markdown code blocks to notebook-style execution with output sections

**Pattern:** The simplest and most common approach across all tools is a fenced output block immediately following the source block, with some convention for marking it as machine-generated.

---

## Key Technical Insights

### Output Storage Strategy Options

| Approach | Pros | Cons |
|---|---|---|
| Fenced `output` block (positional) | Simple, used by obsidian-execute-code, LitREPL | Breaks on cell moves; no staleness detection |
| HTML comment with cell hash | Content-addressed; staleness detection; Obsidian renders inline HTML | HTML comments stripped in some renderers; larger diffs |
| Companion file (`.outputs.json`) | Clean diffs; easy to regenerate | Not self-contained; requires file sync |
| YAML front matter store | Self-contained; diffs cleanly | Not human-readable; all outputs at top of file |

**Our chosen approach:** HTML comment block immediately after the code fence, containing the rendered output HTML, with the hash of the code fence content embedded in the comment. This gives us:
- Content-addressed staleness detection (hash mismatch → needs rerun)
- Block identity (hash → which code block this output belongs to)
- Obsidian-renderable output (raw HTML in the file)
- Self-contained file (no companion files)

### Hashing Strategy

Hash the **raw content** of the code fence (language + code body), not including the output block itself. Use SHA-256 truncated to 8 bytes (16 hex chars) — short enough to be readable, collision-resistant enough for a single file.

### Output Format (proposed)

```markdown
```python
import pandas as pd
df = pd.DataFrame({'a': [1, 2, 3]})
df
```

<!-- nb-output hash="a3f1b2c4d5e6f7a8" -->
<div class="nb-output">
  <table>...</table>
</div>
<!-- /nb-output -->
```

The HTML comment markers serve as:
1. Machine-readable delimiters (easy to find/replace with regex)
2. Hash storage (staleness check)
3. Invisible in rendered Markdown (Obsidian renders them as whitespace)

### Jupyter Rendering Engine

We can reuse Jupyter's output rendering for MIME types without requiring the full Jupyter server. The `@jupyterlab/rendermime` package (or its subset) provides renderers for:

- `text/plain` → `<pre>`
- `text/html` → direct injection
- `image/png`, `image/svg+xml` → `<img>`
- `application/vnd.jupyter.widget-view+json` → widget placeholder
- `application/json` → formatted JSON

This can be bundled into the Obsidian plugin via esbuild (same pattern as obsidian-execute-code uses).

---

## Rendering Constraints

**Target environment:** Obsidian preview mode (Electron/Chromium renderer)

| Output type | Approach | Works in Obsidian? |
|---|---|---|
| Text/stdout | `<pre>` block | Yes |
| HTML tables | Inline `<div>` | Yes |
| matplotlib PNG | Base64 `<img src="data:...">` | Yes |
| Plotly/Bokeh (HTML+JS) | Inline `<script>` + HTML | Yes (Electron) |
| SVG | Inline `<svg>` | Yes |
| Markdown | Render via Obsidian's MarkdownRenderer | Yes |
| LaTeX/MathJax | Via Obsidian's existing math renderer | Yes |

**GitHub/standard Markdown renderers:** Most outputs won't render (sanitised). This is accepted — the target is Obsidian, not GitHub.

---

## Execution Architecture

obsidian-execute-code's approach works well:
- Spawn a persistent kernel process (Python via `jupyter_client` or direct `python` subprocess)
- Stream outputs back via stdout/stderr
- For rich MIME outputs (plots, tables), have the kernel send a special JSON envelope over stdout

Two options:
1. **Lightweight:** Run Python directly, capture text output — no Jupyter dependency
2. **Full Jupyter kernel:** Use `jupyter_client` to connect to a kernel, get full MIME output bundles

Option 2 is preferred for rich outputs (DataFrames, plots) but requires Jupyter installed. Option 1 is simpler for text-only workflows.

**Decision:** Support both. Default to lightweight mode; detect if Jupyter is available and offer kernel mode.
