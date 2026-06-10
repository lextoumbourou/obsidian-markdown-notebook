import { canonicalLang } from "./languages";

export interface RunBlock {
  language: string;
  source: string;
  id: string | undefined;
  format: string | undefined;
  lineEnd: number;
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
    const fenceMatch = lines[i].match(/^```(\w+)(?:\s*\{([^}]*)\})?/);
    if (fenceMatch) {
      const lang = canonicalLang(fenceMatch[1]);
      if (lang) {
        const args = fenceMatch[2] ?? "";
        const id = args.match(/id=(\S+)/)?.[1];
        const format = args.match(/format=(\S+)/)?.[1];
        const sourceLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) {
          sourceLines.push(lines[i]);
          i++;
        }
        blocks.push({ language: lang, source: sourceLines.join("\n"), id, format, lineEnd: i });
      }
    }
    i++;
  }

  return blocks;
}
