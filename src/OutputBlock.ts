import { App, TFile } from "obsidian";

export type OutputFormat = "html" | "image";

export interface OutputBlock {
  id?: string;
  hash: string;
  content: string;
  format: OutputFormat;
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
          lineStart,
          lineEnd: j,
        };
      }
    }
  }

  return null;
}

function makeMarker(id: string | undefined, hash: string, format: OutputFormat): string {
  const attrs = serializeAttrs({ id, hash, format });
  return `<!-- nb-output ${attrs} -->`;
}

function replaceBlock(
  lines: string[],
  block: OutputBlock,
  id: string | undefined,
  hash: string,
  content: string,
  format: OutputFormat
): string[] {
  return [
    ...lines.slice(0, block.lineStart),
    makeMarker(id, hash, format),
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
  format: OutputFormat
): string[] {
  return [
    ...lines.slice(0, codeFenceEndLine + 1),
    makeMarker(id, hash, format),
    content,
    `<!-- /nb-output -->`,
    ...lines.slice(codeFenceEndLine + 1),
  ];
}

/**
 * Write (insert or replace) an nb-output block in the file on disk.
 * Uses vault.process for a safe transactional read-modify-write.
 */
export async function writeOutputBlock(
  app: App,
  file: TFile,
  codeFenceEndLine: number,
  hash: string,
  content: string,
  format: OutputFormat = "html",
  id?: string
): Promise<void> {
  await app.vault.process(file, (raw) => {
    const lines = raw.split("\n");
    const existing = findOutputBlock(lines, codeFenceEndLine);
    const updated = existing
      ? replaceBlock(lines, existing, id, hash, content, format)
      : insertBlock(lines, codeFenceEndLine, id, hash, content, format);
    return updated.join("\n");
  });
}

/**
 * Clear an nb-output block from the file on disk.
 */
export async function clearOutputBlock(
  app: App,
  file: TFile,
  codeFenceEndLine: number
): Promise<void> {
  await app.vault.process(file, (raw) => {
    const lines = raw.split("\n");
    const block = findOutputBlock(lines, codeFenceEndLine);
    if (!block) return raw;
    return [
      ...lines.slice(0, block.lineStart),
      ...lines.slice(block.lineEnd + 1),
    ].join("\n");
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
  const dir = (mediaPath.trim().replace(/\/+$/, "")) || noteFile.parent?.path || "";
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
  const noteDir = noteFile.parent?.path ?? "";
  return `![](${relativeVaultPath(noteDir, vaultPath)})`;
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
