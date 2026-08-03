import { NB_OUTPUT_END_RE, NB_OUTPUT_RE, parseRunBlocks } from "./CellParser";

/**
 * Pure output-block logic shared by the Obsidian plugin and the CLI runner.
 * This module must not import "obsidian" — the vault-facing wrappers live in
 * OutputBlock.ts.
 */

export type OutputFormat = "html" | "image";
export type OutputStatus = "running" | "error" | "timeout";

/**
 * Identifies a cell by content rather than position. Line numbers captured at
 * click/render time go stale the moment an earlier cell's write inserts or
 * removes lines, so every write re-anchors by language + source at write time,
 * using the captured line only to disambiguate identical cells.
 */
export interface CellLocator {
  /** Canonical language of the cell (the fence itself may use an alias). */
  language: string;
  /** Exact source of the cell as passed to the code block processor. */
  source: string;
  /** Closing-fence line when the cell was last seen — duplicate tie-breaker. */
  hintLine: number;
}

export interface OutputBlock {
  id?: string;
  hash: string;
  content: string;
  format: OutputFormat;
  status?: OutputStatus;
  lineStart: number; // line index of <!-- nb-output ... -->
  lineEnd: number;   // line index of <!-- /nb-output -->
}

export const INTERRUPTED_HTML = `<div class="nb-status-error">Execution was interrupted</div>`;
export const ERROR_HTML = `<div class="nb-status-error">Execution failed</div>`;

export function timeoutHtml(timeoutMs: number): string {
  const secs = timeoutMs / 1000;
  return `<div class="nb-status-timeout">Execution timed out after ${secs}s</div>`;
}

/**
 * Split file content into lines, preserving knowledge of the line ending so
 * the file can be re-joined without converting CRLF files to LF (and so the
 * marker regexes, which anchor on `$`, aren't defeated by trailing `\r`).
 */
function splitFileLines(raw: string): { lines: string[]; eol: string } {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  return { lines: raw.split(/\r?\n/), eol };
}

/**
 * Find the closing-fence line index of the cell in the current file content.
 * Returns null if no fence matches the cell's language + source anymore
 * (the cell was edited or deleted while its execution was in flight).
 */
export function findCellFenceEnd(lines: string[], cell: CellLocator): number | null {
  const target = cell.source.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const matches = parseRunBlocks(lines.join("\n"))
    .filter((block) =>
      block.language === cell.language
      && block.source.replace(/\n$/, "") === target
    )
    .map((block) => block.lineEnd);
  if (matches.length === 0) return null;
  return matches.reduce((best, cur) =>
    Math.abs(cur - cell.hintLine) < Math.abs(best - cell.hintLine) ? cur : best
  );
}

/** Parse key="value" pairs out of the nb-output comment attributes. */
function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of attrStr.matchAll(/(\w+)="([^"]*)"/g)) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/** Serialise an attribute object back to a string, omitting undefined values. */
function serializeAttrs(attrs: Record<string, string | undefined>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
}

/**
 * Find the nb-output block immediately following codeFenceEndLine.
 * Allows one optional blank line between the fence and the marker.
 */
export function findOutputBlock(lines: string[], codeFenceEndLine: number): OutputBlock | null {
  const searchLimit = Math.min(codeFenceEndLine + 3, lines.length);

  for (let i = codeFenceEndLine + 1; i < searchLimit; i++) {
    const match = lines[i].match(NB_OUTPUT_RE);
    if (!match) {
      if (lines[i].trim() !== "") break;
      continue;
    }

    const attrs = parseAttrs(match[1]);
    if (!attrs.hash) continue;

    const lineStart = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (NB_OUTPUT_END_RE.test(lines[j])) {
        return {
          id: attrs.id,
          hash: attrs.hash,
          content: lines.slice(i + 1, j).join("\n"),
          format: (attrs.format as OutputFormat | undefined) ?? "html",
          status: (attrs.status as OutputStatus | undefined),
          lineStart,
          lineEnd: j,
        };
      }
    }
  }

  return null;
}

function makeMarker(id: string | undefined, hash: string, format: OutputFormat, status?: OutputStatus): string {
  const attrs = serializeAttrs({ id, hash, format, status });
  return `<!-- nb-output ${attrs} -->`;
}

function replaceBlock(
  lines: string[],
  block: OutputBlock,
  id: string | undefined,
  hash: string,
  content: string,
  format: OutputFormat,
  status?: OutputStatus
): string[] {
  return [
    ...lines.slice(0, block.lineStart),
    makeMarker(id, hash, format, status),
    content,
    `<!-- /nb-output -->`,
    ...lines.slice(block.lineEnd + 1),
  ];
}

function insertBlock(
  lines: string[],
  codeFenceEndLine: number,
  id: string | undefined,
  hash: string,
  content: string,
  format: OutputFormat,
  status?: OutputStatus
): string[] {
  return [
    ...lines.slice(0, codeFenceEndLine + 1),
    makeMarker(id, hash, format, status),
    content,
    `<!-- /nb-output -->`,
    ...lines.slice(codeFenceEndLine + 1),
  ];
}

/**
 * Insert or replace the cell's nb-output block in raw file content,
 * re-locating the cell's fence at apply time so concurrent cell runs can't
 * write into each other's regions. Returns the content unchanged if the cell
 * no longer exists in the file.
 */
export function applyOutputBlock(
  raw: string,
  cell: CellLocator,
  hash: string,
  content: string,
  format: OutputFormat = "html",
  id?: string,
  status?: OutputStatus
): string {
  const { lines, eol } = splitFileLines(raw);
  const fenceEnd = findCellFenceEnd(lines, cell);
  if (fenceEnd === null) return raw;
  const existing = findOutputBlock(lines, fenceEnd);
  const updated = existing
    ? replaceBlock(lines, existing, id, hash, content, format, status)
    : insertBlock(lines, fenceEnd, id, hash, content, format, status);
  return updated.join(eol);
}

/** Remove the cell's nb-output block from raw file content, if present. */
export function removeOutputBlock(raw: string, cell: CellLocator): string {
  const { lines, eol } = splitFileLines(raw);
  const fenceEnd = findCellFenceEnd(lines, cell);
  if (fenceEnd === null) return raw;
  const block = findOutputBlock(lines, fenceEnd);
  if (!block) return raw;
  return [
    ...lines.slice(0, block.lineStart),
    ...lines.slice(block.lineEnd + 1),
  ].join(eol);
}

/** Remove every complete nb-output block anchored directly after a supported
 * executable fence. Marker examples elsewhere in the note are left intact. */
export function removeAllOutputBlocks(raw: string): string {
  if (!raw.includes("<!-- nb-output ")) return raw;
  const { lines, eol } = splitFileLines(raw);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const cell of parseRunBlocks(raw)) {
    const output = findOutputBlock(lines, cell.lineEnd);
    if (output) ranges.push({ start: output.lineStart, end: output.lineEnd });
  }
  if (ranges.length === 0) return raw;

  ranges.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const out: string[] = [];
  let rangeIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const range = merged[rangeIndex];
    if (range && i === range.start) {
      i = range.end;
      rangeIndex++;
    } else {
      out.push(lines[i]);
    }
  }
  return out.join(eol);
}

/**
 * Replace stale `status="running"` blocks with an interrupted-error state.
 * A spinner block survives in the file when Obsidian quits (or the plugin
 * reloads) mid-execution. Any running block whose cell is not currently
 * executing is stale by definition.
 */
export function applyStaleRunningCleanup(
  raw: string,
  isInFlight: (hash: string) => boolean
): string {
  if (!raw.includes('status="running"')) return raw;
  const { lines, eol } = splitFileLines(raw);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(NB_OUTPUT_RE);
    const attrs = m ? parseAttrs(m[1]) : null;
    if (attrs?.hash && attrs.status === "running" && !isInFlight(attrs.hash)) {
      let j = i + 1;
      while (j < lines.length && !NB_OUTPUT_END_RE.test(lines[j])) j++;
      if (j < lines.length) {
        out.push(
          makeMarker(attrs.id, attrs.hash, (attrs.format as OutputFormat | undefined) ?? "html", "error"),
          INTERRUPTED_HTML,
          `<!-- /nb-output -->`
        );
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return out.join(eol);
}
