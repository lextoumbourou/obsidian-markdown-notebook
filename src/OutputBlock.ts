import { App, TFile } from "obsidian";
import { canonicalLang } from "./languages";

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
  const matches: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^```(\w+)/);
    if (m && canonicalLang(m[1]) === cell.language) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      if (body.join("\n").replace(/\n$/, "") === target) matches.push(i);
    }
    i++;
  }
  if (matches.length === 0) return null;
  return matches.reduce((best, cur) =>
    Math.abs(cur - cell.hintLine) < Math.abs(best - cell.hintLine) ? cur : best
  );
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

const NB_OUTPUT_RE = /^<!-- nb-output (.*?)-->$/;
const NB_OUTPUT_END = /^<!-- \/nb-output -->$/;

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
      if (NB_OUTPUT_END.test(lines[j])) {
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
 * Write (insert or replace) an nb-output block in the file on disk.
 * Uses vault.process for a safe transactional read-modify-write, and
 * re-locates the cell's fence at write time so concurrent cell runs can't
 * write into each other's regions. If the cell no longer exists in the file,
 * the write is dropped.
 */
export async function writeOutputBlock(
  app: App,
  file: TFile,
  cell: CellLocator,
  hash: string,
  content: string,
  format: OutputFormat = "html",
  id?: string,
  status?: OutputStatus
): Promise<void> {
  await app.vault.process(file, (raw) => {
    const { lines, eol } = splitFileLines(raw);
    const fenceEnd = findCellFenceEnd(lines, cell);
    if (fenceEnd === null) return raw;
    const existing = findOutputBlock(lines, fenceEnd);
    const updated = existing
      ? replaceBlock(lines, existing, id, hash, content, format, status)
      : insertBlock(lines, fenceEnd, id, hash, content, format, status);
    return updated.join(eol);
  });
}

/**
 * Clear an nb-output block from the file on disk.
 */
export async function clearOutputBlock(
  app: App,
  file: TFile,
  cell: CellLocator
): Promise<void> {
  await app.vault.process(file, (raw) => {
    const { lines, eol } = splitFileLines(raw);
    const fenceEnd = findCellFenceEnd(lines, cell);
    if (fenceEnd === null) return raw;
    const block = findOutputBlock(lines, fenceEnd);
    if (!block) return raw;
    return [
      ...lines.slice(0, block.lineStart),
      ...lines.slice(block.lineEnd + 1),
    ].join(eol);
  });
}

const INTERRUPTED_HTML = `<div class="nb-status-error">Execution was interrupted</div>`;

/**
 * Replace stale `status="running"` blocks with an interrupted-error state.
 * A spinner block survives in the file when Obsidian quits (or the plugin
 * reloads) mid-execution. Any running block whose cell is not currently
 * executing is stale by definition.
 */
export async function clearStaleRunningBlocks(
  app: App,
  file: TFile,
  isInFlight: (hash: string) => boolean
): Promise<void> {
  await app.vault.process(file, (raw) => {
    if (!raw.includes('status="running"')) return raw;
    const { lines, eol } = splitFileLines(raw);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(NB_OUTPUT_RE);
      const attrs = m ? parseAttrs(m[1]) : null;
      if (attrs?.hash && attrs.status === "running" && !isInFlight(attrs.hash)) {
        let j = i + 1;
        while (j < lines.length && !NB_OUTPUT_END.test(lines[j])) j++;
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
  });
}

/**
 * Save a base64-encoded PNG to the vault.
 * Returns { filename, vaultPath } — filename for wikilinks, vaultPath for computing relative paths.
 */
export async function saveImageToVault(
  app: App,
  noteFile: TFile,
  id: string | undefined,
  hash: string,
  base64: string,
  mediaPath: string
): Promise<{ filename: string; vaultPath: string }> {
  const filename = id ? `${id}.png` : `${hash}.png`;
  const dir = normalizeDir(
    (mediaPath.trim().replace(/\/+$/, "")) || noteFile.parent?.path || ""
  );
  const vaultPath = dir ? `${dir}/${filename}` : filename;

  const binaryStr = atob(base64);
  const ab = new ArrayBuffer(binaryStr.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < binaryStr.length; i++) view[i] = binaryStr.charCodeAt(i);

  if (dir && !(await app.vault.adapter.exists(dir))) {
    await app.vault.createFolder(dir);
  }

  const fileExists = await app.vault.adapter.exists(vaultPath);
  if (fileExists) {
    const f = app.vault.getAbstractFileByPath(vaultPath);
    if (f instanceof TFile) {
      await app.vault.modifyBinary(f, ab);
    } else {
      // Index is stale — write directly via adapter
      await app.vault.adapter.writeBinary(vaultPath, ab);
    }
  } else {
    await app.vault.createBinary(vaultPath, ab);
  }

  return { filename, vaultPath };
}

/**
 * Format a saved image as a link string.
 * - wikilink:  ![[filename.png]]
 * - markdown:  ![](relative/path/to/filename.png)
 */
export function imageLink(
  filename: string,
  vaultPath: string,
  noteFile: TFile,
  useMarkdown: boolean
): string {
  if (!useMarkdown) return `![[${filename}]]`;
  const noteDir = normalizeDir(noteFile.parent?.path ?? "");
  return `![](${relativeVaultPath(noteDir, vaultPath)})`;
}

/** Obsidian reports the vault root folder's path as "/" — treat it as "". */
function normalizeDir(dir: string): string {
  return dir === "/" ? "" : dir;
}

/** Compute a path to `targetVaultPath` relative to `fromDir` (both vault-relative). */
function relativeVaultPath(fromDir: string, targetVaultPath: string): string {
  const from = fromDir ? fromDir.split("/") : [];
  const to = targetVaultPath.split("/");
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) {
    common++;
  }
  const ups = from.length - common;
  return [...Array(ups).fill(".."), ...to.slice(common)].join("/");
}
