export type OutputChunk =
  | { type: "stream"; stream: "stdout" | "stderr"; text: string }
  | { type: "rich"; mime: string; data: string }
  | { type: "error"; text: string };

/**
 * Convert a list of OutputChunks into a single HTML string for storage.
 */
export function renderChunksToHtml(chunks: OutputChunk[]): string {
  if (chunks.length === 0) return "";
  const parts = chunks.map(renderChunk);
  return `<div class="nb-output">\n${parts.join("\n")}\n</div>`;
}

function renderChunk(chunk: OutputChunk): string {
  switch (chunk.type) {
    case "stream":
      return chunk.stream === "stderr"
        ? `<pre class="nb-stream-stderr">${escapeHtml(chunk.text)}</pre>`
        : `<pre class="nb-stream-stdout">${escapeHtml(chunk.text)}</pre>`;
    case "error":
      return `<pre class="nb-stream-stderr">${escapeHtml(chunk.text)}</pre>`;
    case "rich":
      return renderRich(chunk.mime, chunk.data);
  }
}

function renderRich(mime: string, data: string): string {
  switch (mime) {
    case "text/html":
      return `<div class="nb-output-html">${data}</div>`;
    case "image/png":
      return `<img class="nb-output-image" src="data:image/png;base64,${data}" />`;
    case "image/svg+xml":
      return `<div class="nb-output-svg">${data}</div>`;
    case "text/markdown":
      // Store as-is; will be rendered by Obsidian's own Markdown renderer
      return `<div class="nb-output-markdown">${data}</div>`;
    case "text/plain":
    default:
      return `<pre class="nb-stream-stdout">${escapeHtml(data)}</pre>`;
  }
}

/**
 * Append a chunk to a live DOM element during execution.
 */
export function appendChunkToElement(el: HTMLElement, chunk: OutputChunk): void {
  switch (chunk.type) {
    case "stream": {
      // Coalesce consecutive text into the last <pre> if it's the same stream type
      const cls = chunk.stream === "stderr" ? "nb-stream-stderr" : "nb-stream-stdout";
      const last = el.lastElementChild;
      if (last instanceof HTMLPreElement && last.classList.contains(cls)) {
        last.textContent = (last.textContent ?? "") + chunk.text;
      } else {
        const pre = el.createEl("pre", { cls });
        pre.textContent = chunk.text;
      }
      break;
    }
    case "error": {
      const last = el.lastElementChild;
      if (last instanceof HTMLPreElement && last.classList.contains("nb-stream-stderr")) {
        last.textContent = (last.textContent ?? "") + chunk.text;
      } else {
        const pre = el.createEl("pre", { cls: "nb-stream-stderr" });
        pre.textContent = chunk.text;
      }
      break;
    }
    case "rich": {
      const wrapper = el.createDiv();
      wrapper.innerHTML = renderRich(chunk.mime, chunk.data);
      break;
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
