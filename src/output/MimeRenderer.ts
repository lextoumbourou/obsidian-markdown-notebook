export type OutputChunk =
  | { type: "stream"; stream: "stdout" | "stderr"; text: string }
  | { type: "rich"; mime: string; data: string }
  | { type: "error"; text: string }
  | { type: "truncated"; limitBytes: number };

/**
 * Convert a list of OutputChunks into a single HTML string for storage.
 */
export function renderChunksToHtml(chunks: OutputChunk[], format = "html"): string {
  if (chunks.length === 0) return "";
  const outputFormat = normaliseOutputFormat(format);
  const parts = chunks.map((chunk) => renderChunkToHtml(chunk, outputFormat));
  if (outputFormat !== "html" && outputFormat !== "image") return parts.join("\n\n");
  return `<div class="nb-output">\n${parts.join("\n")}\n</div>`;
}

/** Render a failed cell's status together with all output collected before
 * the failure. Text and traceback chunks are escaped by renderChunksToHtml. */
export function renderFailureToHtml(statusHtml: string, chunks: OutputChunk[]): string {
  const output = renderChunksToHtml(chunks);
  return output ? `${statusHtml}\n${output}` : statusHtml;
}

export function renderChunkToHtml(chunk: OutputChunk, format = "html"): string {
  switch (chunk.type) {
    case "stream":
      return chunk.stream === "stderr"
        ? `<pre class="nb-stream-stderr">${escapeHtml(chunk.text)}</pre>`
        : renderFormattedOutput(chunk.text, format);
    case "error":
      return `<pre class="nb-stream-stderr">${escapeHtml(chunk.text)}</pre>`;
    case "rich":
      return renderRich(chunk.mime, chunk.data, format);
    case "truncated":
      return `<div class="nb-output-truncated">Output truncated after ${formatBytes(chunk.limitBytes)}</div>`;
  }
}

function renderRich(mime: string, data: string, format = "html"): string {
  switch (mime) {
    case "text/html":
      return `<div class="nb-output-html">${collapseStyleTags(data)}</div>`;
    case "image/png":
      return `<img class="nb-output-image" src="data:image/png;base64,${data}" />`;
    case "image/svg+xml":
      return `<div class="nb-output-svg">${data}</div>`;
    case "text/markdown":
      // Store as-is; will be rendered by Obsidian's own Markdown renderer
      return `<div class="nb-output-markdown">${data}</div>`;
    case "text/plain":
    default:
      return renderFormattedOutput(data, format);
  }
}

function renderFormattedOutput(text: string, format: string): string {
  const language = normaliseOutputFormat(format);
  if (language === "html" || language === "image") {
    return `<pre class="nb-stream-stdout">${escapeHtml(text)}</pre>`;
  }
  const longestFence = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  const newline = text.endsWith("\n") ? "" : "\n";
  return `${fence}${language}\n${text}${newline}${fence}`;
}

export function normaliseOutputFormat(format: string): string {
  return /^[A-Za-z0-9_-]+$/.test(format) ? format : "html";
}

/**
 * Return the base64-encoded PNG data from the first image/png chunk, or null.
 */
export function extractImageData(chunks: OutputChunk[]): string | null {
  for (const chunk of chunks) {
    if (chunk.type === "rich" && chunk.mime === "image/png") return chunk.data;
  }
  return null;
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
    case "truncated":
      el.createDiv({
        cls: "nb-output-truncated",
        text: `Output truncated after ${formatBytes(chunk.limitBytes)}`,
      });
      break;
  }
}

function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`;
}

function collapseStyleTags(html: string): string {
  return html.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_, content) => `<style>${content.replace(/\s+/g, " ").trim()}</style>`
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
