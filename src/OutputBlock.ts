import { App, TFile } from "obsidian";

export interface OutputBlock {
  hash: string;
  html: string;
  lineStart: number; // line index of <!-- nb-output hash="..." -->
  lineEnd: number;   // line index of <!-- /nb-output -->
}

const NB_OUTPUT_START = /^<!-- nb-output hash="([0-9a-f]+)" -->$/;
const NB_OUTPUT_END = /^<!-- \/nb-output -->$/;

/**
 * Find the nb-output block immediately following codeFenceEndLine.
 * Allows one optional blank line between the fence and the marker.
 */
export function findOutputBlock(lines: string[], codeFenceEndLine: number): OutputBlock | null {
  const searchLimit = Math.min(codeFenceEndLine + 3, lines.length);

  for (let i = codeFenceEndLine + 1; i < searchLimit; i++) {
    const match = lines[i].match(NB_OUTPUT_START);
    if (!match) {
      if (lines[i].trim() !== "") break; // non-blank, non-marker line — stop
      continue;
    }

    const hash = match[1];
    const lineStart = i;

    for (let j = i + 1; j < lines.length; j++) {
      if (NB_OUTPUT_END.test(lines[j])) {
        return {
          hash,
          html: lines.slice(i + 1, j).join("\n"),
          lineStart,
          lineEnd: j,
        };
      }
    }
  }

  return null;
}

/**
 * Replace an existing nb-output block in-place.
 */
function replaceBlock(lines: string[], block: OutputBlock, hash: string, html: string): string[] {
  return [
    ...lines.slice(0, block.lineStart),
    `<!-- nb-output hash="${hash}" -->`,
    html,
    `<!-- /nb-output -->`,
    ...lines.slice(block.lineEnd + 1),
  ];
}

/**
 * Insert a new nb-output block after codeFenceEndLine.
 */
function insertBlock(lines: string[], codeFenceEndLine: number, hash: string, html: string): string[] {
  return [
    ...lines.slice(0, codeFenceEndLine + 1),
    `<!-- nb-output hash="${hash}" -->`,
    html,
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
  html: string
): Promise<void> {
  await app.vault.process(file, (content) => {
    const lines = content.split("\n");
    const existing = findOutputBlock(lines, codeFenceEndLine);
    const updated = existing
      ? replaceBlock(lines, existing, hash, html)
      : insertBlock(lines, codeFenceEndLine, hash, html);
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
  await app.vault.process(file, (content) => {
    const lines = content.split("\n");
    const block = findOutputBlock(lines, codeFenceEndLine);
    if (!block) return content;
    return [
      ...lines.slice(0, block.lineStart),
      ...lines.slice(block.lineEnd + 1),
    ].join("\n");
  });
}
