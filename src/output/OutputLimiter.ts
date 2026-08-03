import { OutputChunk, renderChunkToHtml } from "./MimeRenderer";

export const DEFAULT_OUTPUT_LIMIT_KB = 100;

const encoder = new TextEncoder();
const OUTPUT_WRAPPER_BYTES = byteLength('<div class="nb-output">\n\n</div>');

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function withText(chunk: OutputChunk, text: string): OutputChunk | null {
  switch (chunk.type) {
    case "stream": return text ? { ...chunk, text } : null;
    case "error": return text ? { ...chunk, text } : null;
    case "rich":
      return chunk.mime === "text/plain" && text
        ? { ...chunk, data: text }
        : null;
    case "truncated": return null;
  }
}

function truncateTextChunk(chunk: OutputChunk, availableBytes: number): OutputChunk | null {
  const text = chunk.type === "stream" || chunk.type === "error"
    ? chunk.text
    : chunk.type === "rich" && chunk.mime === "text/plain" ? chunk.data : "";
  if (!text || availableBytes <= 0) return null;

  let low = 0;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const end = mid > 0 && /[\uD800-\uDBFF]/.test(text[mid - 1]) ? mid - 1 : mid;
    const candidate = withText(chunk, text.slice(0, end));
    const size = candidate ? byteLength(renderChunkToHtml(candidate)) : 0;
    if (size <= availableBytes) {
      best = Math.max(best, end);
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return withText(chunk, text.slice(0, best));
}

function truncateTextChunkFromEnd(
  chunk: OutputChunk,
  availableBytes: number,
): OutputChunk | null {
  const text = chunk.type === "error" ? chunk.text : "";
  if (!text || availableBytes <= 0) return null;

  let low = 0;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    let start = text.length - length;
    if (start < text.length && /[\uDC00-\uDFFF]/.test(text[start])) start++;
    const candidate = withText(chunk, text.slice(start));
    const size = candidate ? byteLength(renderChunkToHtml(candidate)) : 0;
    if (size <= availableBytes) {
      best = Math.max(best, text.length - start);
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  let start = text.length - best;
  if (start < text.length && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  return withText(chunk, text.slice(start));
}

/** Collect chunks while keeping their final rendered HTML within a byte cap. */
export class OutputLimiter {
  readonly chunks: OutputChunk[] = [];
  readonly limitBytes: number;
  nativeImageData: string | null = null;
  truncated = false;
  private usedBytes = 0;
  private readonly contentBudget: number;
  private readonly preserveImageData: boolean;

  constructor(limitKb: number, preserveImageData = false) {
    this.limitBytes = Math.max(1, Math.floor(limitKb * 1024));
    this.preserveImageData = preserveImageData;
    const marker = this.marker();
    const markerBytes = byteLength(renderChunkToHtml(marker));
    // Reserve the outer wrapper, marker, and one separator so a truncated
    // rendered block stays within the configured limit.
    this.contentBudget = Math.max(
      0,
      this.limitBytes - OUTPUT_WRAPPER_BYTES - markerBytes - 1,
    );
  }

  /** Add a kernel chunk and return only the chunks callers should render live. */
  add(chunk: OutputChunk): OutputChunk[] {
    if (
      this.preserveImageData
      && chunk.type === "rich"
      && chunk.mime === "image/png"
    ) {
      this.nativeImageData ??= chunk.data;
      return [chunk];
    }
    if (chunk.type === "error" && this.truncated) {
      return this.prioritizeError(chunk);
    }
    if (this.truncated) return [];

    const separatorBytes = this.chunks.length > 0 ? 1 : 0;
    const renderedBytes = byteLength(renderChunkToHtml(chunk));
    if (this.usedBytes + separatorBytes + renderedBytes <= this.contentBudget) {
      this.chunks.push(chunk);
      this.usedBytes += separatorBytes + renderedBytes;
      return [chunk];
    }

    if (chunk.type === "error") return this.prioritizeError(chunk);

    const emitted: OutputChunk[] = [];
    const remaining = this.contentBudget - this.usedBytes - separatorBytes;
    const partial = truncateTextChunk(chunk, remaining);
    if (partial) {
      this.chunks.push(partial);
      this.usedBytes += separatorBytes + byteLength(renderChunkToHtml(partial));
      emitted.push(partial);
    }
    const marker = this.marker();
    this.chunks.push(marker);
    this.truncated = true;
    emitted.push(marker);
    return emitted;
  }

  private marker(): OutputChunk {
    return { type: "truncated", limitBytes: this.limitBytes };
  }

  /** Reclaim ordinary-output space for the tail of late diagnostics. */
  private prioritizeError(chunk: Extract<OutputChunk, { type: "error" }>): OutputChunk[] {
    const wasTruncated = this.truncated;
    const marker = this.marker();
    const markerBytes = byteLength(renderChunkToHtml(marker));
    const availableContent = Math.max(
      0,
      this.limitBytes - OUTPUT_WRAPPER_BYTES - markerBytes - 1,
    );
    const diagnosticBudget = Math.min(16 * 1024, Math.floor(availableContent / 2));
    const existingDiagnostics = this.chunks.filter(
      (item): item is Extract<OutputChunk, { type: "error" }> => item.type === "error",
    );
    const diagnosticCandidates = [...existingDiagnostics, chunk];
    const diagnosticsReversed: OutputChunk[] = [];
    let diagnosticBytes = 0;
    for (let i = diagnosticCandidates.length - 1; i >= 0; i--) {
      const candidate = diagnosticCandidates[i];
      const separator = diagnosticsReversed.length > 0 ? 1 : 0;
      const rendered = byteLength(renderChunkToHtml(candidate));
      if (diagnosticBytes + separator + rendered <= diagnosticBudget) {
        diagnosticsReversed.push(candidate);
        diagnosticBytes += separator + rendered;
        continue;
      }
      const partial = truncateTextChunkFromEnd(
        candidate,
        diagnosticBudget - diagnosticBytes - separator,
      );
      if (partial) diagnosticsReversed.push(partial);
      break;
    }
    const diagnostics = diagnosticsReversed.reverse();

    const ordinary = this.chunks.filter(
      (item) => item.type !== "error" && item.type !== "truncated",
    );
    const baseBytes = OUTPUT_WRAPPER_BYTES
      + markerBytes
      + diagnostics.reduce(
        (total, item) => total + 1 + byteLength(renderChunkToHtml(item)),
        0,
      );
    let remaining = Math.max(0, this.limitBytes - baseBytes);
    const keptOrdinary: OutputChunk[] = [];
    for (const candidate of ordinary) {
      const rendered = byteLength(renderChunkToHtml(candidate));
      if (rendered + 1 <= remaining) {
        keptOrdinary.push(candidate);
        remaining -= rendered + 1;
        continue;
      }
      const partial = truncateTextChunk(candidate, remaining - 1);
      if (partial) keptOrdinary.push(partial);
      break;
    }

    this.chunks.splice(0, this.chunks.length, ...keptOrdinary, marker, ...diagnostics);
    this.truncated = true;
    const emitted: OutputChunk[] = [];
    if (!wasTruncated) emitted.push(marker);
    const finalDiagnostic = diagnostics[diagnostics.length - 1];
    if (finalDiagnostic) emitted.push(finalDiagnostic);
    return emitted;
  }
}
