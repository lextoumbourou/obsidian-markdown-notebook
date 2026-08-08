import type { RunBlock } from "./CellParser";

export type BackgroundContextMode = "above" | "none";

export interface BackgroundSourceMapEntry {
  generatedLineStart: number;
  generatedLineEnd: number;
  noteLineStart: number;
  role: "setup" | "background";
}

export interface BackgroundProgram {
  source: string;
  precedingCellCount: number;
  sourceMap: BackgroundSourceMapEntry[];
  context: BackgroundContextMode;
}

interface BackgroundTarget {
  language: string;
  source: string;
  lineEnd: number;
  context?: string;
}

function contextMode(value: string | undefined): BackgroundContextMode {
  if (value === undefined || value === "above") return "above";
  if (value === "none") return "none";
  throw new Error(`Unknown background context "${value}"; use "above" or "none"`);
}

function normaliseCellSource(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\n$/, "");
}

/** Tangle a deterministic program for a fresh background process. */
export function buildBackgroundProgram(
  blocks: RunBlock[],
  target: BackgroundTarget,
): BackgroundProgram {
  const mode = contextMode(target.context);
  const targetSource = normaliseCellSource(target.source);
  const candidates = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) =>
      block.language === target.language
      && normaliseCellSource(block.source) === targetSource
    );
  const targetIndex = candidates.length === 0
    ? -1
    : candidates.reduce((best, candidate) =>
      Math.abs(candidate.block.lineEnd - target.lineEnd)
        < Math.abs(best.block.lineEnd - target.lineEnd)
        ? candidate
        : best
    ).index;
  const targetBlock = targetIndex >= 0 ? blocks[targetIndex] : null;
  const setupBlocks = mode === "above" && targetIndex >= 0
    ? blocks.slice(0, targetIndex).filter((block) =>
      block.language === target.language && !block.background
    )
    : [];
  const cells = [
    ...setupBlocks.map((block) => ({ block, role: "setup" as const })),
    ...(targetBlock
      ? [{ block: targetBlock, role: "background" as const }]
      : []),
  ];
  if (cells.length === 0) {
    return {
      source: target.source,
      precedingCellCount: 0,
      sourceMap: [],
      context: mode,
    };
  }

  let generatedLine = 1;
  const sourceMap: BackgroundSourceMapEntry[] = [];
  for (const { block, role } of cells) {
    const lineCount = block.source.split("\n").length;
    sourceMap.push({
      generatedLineStart: generatedLine,
      generatedLineEnd: generatedLine + lineCount - 1,
      noteLineStart: block.lineStart + 2,
      role,
    });
    generatedLine += lineCount + 1;
  }
  return {
    source: cells.map(({ block }) => block.source).join("\n\n"),
    precedingCellCount: setupBlocks.length,
    sourceMap,
    context: mode,
  };
}

export function backgroundStartedMessage(
  backgroundName: string,
  language: string,
  program: BackgroundProgram,
): string {
  if (program.context === "none") {
    return `Background process "${backgroundName}" started in isolation (context=none).\n`;
  }
  return `Background process "${backgroundName}" started with ${
    program.precedingCellCount
  } preceding ${language} cell${program.precedingCellCount === 1 ? "" : "s"}.\n`;
}

function mapLine(
  generatedLine: number,
  sourceMap: BackgroundSourceMapEntry[],
): { noteLine: number; role: "setup" | "background" } | null {
  const entry = sourceMap.find((candidate) =>
    generatedLine >= candidate.generatedLineStart
    && generatedLine <= candidate.generatedLineEnd
  );
  if (!entry) return null;
  return {
    noteLine: entry.noteLineStart + generatedLine - entry.generatedLineStart,
    role: entry.role,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace temp-file locations in common runtime diagnostics with note lines. */
export function mapBackgroundDiagnostic(
  text: string,
  tempFile: string,
  sourcePath: string,
  backgroundName: string,
  sourceMap: BackgroundSourceMapEntry[],
): string {
  if (sourceMap.length === 0) return text;
  const escaped = escapeRegExp(tempFile);
  const describe = (line: number): string | null => {
    const mapped = mapLine(line, sourceMap);
    if (!mapped) return null;
    const role = mapped.role === "setup"
      ? `setup cell replayed for background '${backgroundName}'`
      : `background cell '${backgroundName}'`;
    return `${sourcePath}, line ${mapped.noteLine} (${role})`;
  };
  return text
    .replace(new RegExp(`File "${escaped}", line (\\d+)`, "g"), (match, line) => {
      const location = describe(Number(line));
      return location ? `File "${location}"` : match;
    })
    .replace(new RegExp(`${escaped}:(\\d+):(\\d+)`, "g"), (match, line, column) => {
      const location = describe(Number(line));
      return location ? `${location}:${column}` : match;
    })
    .replace(new RegExp(`${escaped}:(\\d+)(?!:)`, "g"), (match, line) => {
      const location = describe(Number(line));
      return location ?? match;
    })
    .replace(new RegExp(`${escaped}: line (\\d+)`, "g"), (match, line) => {
      const location = describe(Number(line));
      return location ?? match;
    });
}
