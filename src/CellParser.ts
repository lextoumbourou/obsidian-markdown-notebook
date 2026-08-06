import { canonicalLang } from "./languages";

export const NB_OUTPUT_RE = /^<!-- nb-output (.*?)-->$/;
export const NB_OUTPUT_END_RE = /^<!-- \/nb-output -->$/;

export interface RunBlock {
  language: string;
  source: string;
  id: string | undefined;
  format: string | undefined;
  background: string | undefined;
  lineStart: number;
  lineEnd: number;
}

/** Return the closing marker for a complete persisted output block. */
function findOutputEnd(lines: string[], start: number): number | null {
  if (!NB_OUTPUT_RE.test(lines[start])) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (NB_OUTPUT_RE.test(lines[i])) return null;
    if (NB_OUTPUT_END_RE.test(lines[i])) return i;
  }
  return null;
}

/**
 * Parse all executable code blocks from raw file content.
 * All fences for supported languages are included — no {run} marker needed.
 */
export function parseRunBlocks(content: string): RunBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: RunBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    // Persisted output is opaque. Its escaped HTML may legitimately contain a
    // line beginning with ```python (or another supported fence), which must
    // not be interpreted as a notebook cell.
    const outputEnd = findOutputEnd(lines, i);
    if (outputEnd !== null) {
      i = outputEnd + 1;
      continue;
    }

    const fenceMatch = lines[i].match(/^```(\w+)(?:\s*\{([^}]*)\})?/);
    if (fenceMatch) {
      const lang = canonicalLang(fenceMatch[1]);
      if (lang) {
        const lineStart = i;
        const args = fenceMatch[2] ?? "";
        const id = args.match(/id=(\S+)/)?.[1];
        const format = args.match(/format=(\S+)/)?.[1];
        const background = args.match(/background=(\S+)/)?.[1];
        const sourceLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) {
          sourceLines.push(lines[i]);
          i++;
        }
        blocks.push({
          language: lang,
          source: sourceLines.join("\n"),
          id,
          format,
          background,
          lineStart,
          lineEnd: i,
        });
      }
    }
    i++;
  }

  return blocks;
}

/** Return the executable cell or its attached output at a zero-based editor line. */
export function findRunBlockAtLine(content: string, line: number): RunBlock | null {
  const lines = content.split(/\r?\n/);
  for (const block of parseRunBlocks(content)) {
    if (line >= block.lineStart && line <= block.lineEnd) return block;

    // Match findOutputBlock's anchoring rule: the marker may immediately
    // follow the fence or have one blank line before it.
    const searchLimit = Math.min(block.lineEnd + 3, lines.length);
    for (let i = block.lineEnd + 1; i < searchLimit; i++) {
      if (lines[i].trim() === "") continue;
      const outputEnd = findOutputEnd(lines, i);
      if (outputEnd !== null && line >= i && line <= outputEnd) return block;
      break;
    }
  }
  return null;
}
