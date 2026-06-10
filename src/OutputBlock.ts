import { App, TFile } from "obsidian";
import {
  applyOutputBlock,
  removeOutputBlock,
  applyStaleRunningCleanup,
  CellLocator,
  OutputFormat,
  OutputStatus,
} from "./OutputBlockCore";

// The pure block logic (parsing, fence re-anchoring, marker serialization)
// lives in OutputBlockCore.ts so the CLI runner can use it without Obsidian.
export * from "./OutputBlockCore";

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
  await app.vault.process(file, (raw) =>
    applyOutputBlock(raw, cell, hash, content, format, id, status)
  );
}

/**
 * Clear an nb-output block from the file on disk.
 */
export async function clearOutputBlock(
  app: App,
  file: TFile,
  cell: CellLocator
): Promise<void> {
  await app.vault.process(file, (raw) => removeOutputBlock(raw, cell));
}

/**
 * Replace stale `status="running"` blocks with an interrupted-error state.
 * See applyStaleRunningCleanup for semantics.
 */
export async function clearStaleRunningBlocks(
  app: App,
  file: TFile,
  isInFlight: (hash: string) => boolean
): Promise<void> {
  await app.vault.process(file, (raw) => applyStaleRunningCleanup(raw, isInFlight));
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
