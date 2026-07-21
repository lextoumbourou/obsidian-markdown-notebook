import { App, Notice, TFile } from "obsidian";
import { hashCodeFence } from "./HashUtils";
import { parseRunBlocks, RunBlock } from "./CellParser";
import {
  writeOutputBlock,
  saveImageToVault,
  imageLink,
  OutputFormat,
  OutputStatus,
  ERROR_HTML,
  timeoutHtml,
} from "./OutputBlock";
import { KernelTimeoutError } from "./kernels/BaseKernel";

export { parseRunBlocks } from "./CellParser";
import {
  renderChunksToHtml,
  extractImageData,
  OutputChunk,
} from "./output/MimeRenderer";
import { renderHtmlToPng } from "./output/HtmlToImage";
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";
import type { PluginSettings } from "./settings/Settings";
import { readNotebookFrontmatter, NotebookFrontmatter } from "./NotebookFrontmatter";

type AnyKernel = BaseKernel | ShellKernel;

export interface RunAllSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
}

export interface RunAllProgress {
  running: boolean;
  current: number;
  total: number;
}

export interface RunAllHooks {
  onStart?: (state: { total: number }) => void;
  onProgress?: (state: { current: number; total: number }) => void;
  onComplete?: (summary: RunAllSummary) => void;
}

const runAllInFlight = new Set<string>();
const runAllProgress = new Map<string, RunAllProgress>();

export function getRunAllProgress(sourcePath: string): RunAllProgress | undefined {
  return runAllProgress.get(sourcePath);
}

function callHook<K extends keyof RunAllHooks>(
  hooks: RunAllHooks,
  name: K,
  payload: Parameters<NonNullable<RunAllHooks[K]>>[0]
): void {
  try {
    const hook = hooks[name];
    if (hook) hook(payload as never);
  } catch (err) {
    console.error(`[MarkdownNotebook] ${name} hook failed:`, err);
  }
}

export async function runAll(
  app: App,
  file: TFile,
  getKernel: (lang: string) => AnyKernel,
  settings: PluginSettings,
  hooks: RunAllHooks = {}
): Promise<RunAllSummary> {
  const sourcePath = file.path;
  const activeState = runAllProgress.get(sourcePath);
  if (runAllInFlight.has(sourcePath)) {
    new Notice("Notebook: this file is already running.");
    return {
      total: activeState?.total ?? 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
    };
  }

  runAllInFlight.add(sourcePath);
  let total = 0;
  let notice: Notice | null = null;
  const failedCells = new Set<number>();
  let completedCells = 0;

  try {
    const content = await app.vault.read(file);
    const blocks = parseRunBlocks(content);
    const fm = readNotebookFrontmatter(app, file);
    total = blocks.length;

    if (total === 0) {
      new Notice("No executable cells found.");
      const emptySummary = { total: 0, succeeded: 0, failed: 0, skipped: false };
      callHook(hooks, "onComplete", emptySummary);
      return emptySummary;
    }

    runAllProgress.set(sourcePath, { running: true, current: 0, total });
    callHook(hooks, "onStart", { total });
    notice = new Notice(`Running cell 1 / ${total}…`, 0);
    const results: Array<RunBlock & {
      cellIndex: number;
      hash: string;
      content: string;
      format: OutputFormat;
      status?: OutputStatus;
    }> = [];

    for (let i = 0; i < total; i++) {
      const current = i + 1;
      runAllProgress.set(sourcePath, { running: true, current, total });
      callHook(hooks, "onProgress", { current, total });
      notice.setMessage(`Running cell ${current} / ${total}…`);
      const block = blocks[i];
      const hash = await hashCodeFence(block.language, block.source);
      const chunks: OutputChunk[] = [];
      const timeout = fm.timeout ?? settings.executionTimeout;

      let failure: OutputStatus | null = null;
      try {
        await getKernel(block.language).execute(
          block.source,
          (chunk) => chunks.push(chunk),
          timeout
        );
      } catch (err) {
        failure = err instanceof KernelTimeoutError ? "timeout" : "error";
        failedCells.add(i);
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Notebook: cell ${current}: ${msg}`);
      }

      if (failure) {
        const statusHtml = failure === "timeout" ? timeoutHtml(timeout) : ERROR_HTML;
        results.push({
          ...block,
          cellIndex: i,
          hash,
          content: statusHtml,
          format: "html",
          status: failure,
        });
        completedCells += 1;
        continue;
      }

      try {
        const { content: outContent, format } = await resolveOutput(
          app, file, hash, chunks, block.id, block.format, settings, fm
        );
        results.push({ ...block, cellIndex: i, hash, content: outContent, format });
      } catch (err) {
        failedCells.add(i);
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MarkdownNotebook] Cell ${current} output rendering failed:`, err);
        new Notice(`Notebook: cell ${current} output failed: ${msg}`);
        results.push({
          ...block,
          cellIndex: i,
          hash,
          content: ERROR_HTML,
          format: "html",
          status: "error",
        });
      }
      completedCells += 1;
    }

    // Writes re-anchor each cell by content; lineEnd is only the duplicate
    // tie-breaker hint. Reverse order keeps the hints closest to accurate.
    for (const result of [...results].reverse()) {
      try {
        await writeOutputBlock(
          app, file,
          { language: result.language, source: result.source, hintLine: result.lineEnd },
          result.hash, result.content, result.format, result.id, result.status
        );
      } catch (err) {
        failedCells.add(result.cellIndex);
        const cellNumber = result.cellIndex + 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MarkdownNotebook] Cell ${cellNumber} output write failed:`, err);
        new Notice(`Notebook: cell ${cellNumber} output could not be saved: ${msg}`);
      }
    }

    const summary = {
      total,
      succeeded: total - failedCells.size,
      failed: failedCells.size,
      skipped: false,
    };
    notice.hide();
    notice = null;
    new Notice(
      `Ran ${total} cell${total === 1 ? "" : "s"}: ` +
      `${summary.succeeded} succeeded, ${summary.failed} failed.`
    );
    callHook(hooks, "onComplete", summary);
    return summary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[MarkdownNotebook] Run all failed:", err);
    new Notice(`Notebook: run all failed: ${msg}`);
    const summary = {
      total,
      succeeded: Math.max(0, completedCells - failedCells.size),
      failed: failedCells.size + (completedCells < total ? 1 : 0),
      skipped: false,
    };
    callHook(hooks, "onComplete", summary);
    return summary;
  } finally {
    notice?.hide();
    runAllInFlight.delete(sourcePath);
    runAllProgress.delete(sourcePath);
  }
}

async function resolveOutput(
  app: App,
  file: TFile,
  hash: string,
  chunks: OutputChunk[],
  id: string | undefined,
  formatArg: string | undefined,
  settings: PluginSettings,
  fm: NotebookFrontmatter,
): Promise<{ content: string; format: OutputFormat }> {
  const outputFormat = formatArg ?? fm.format ?? settings.defaultFormat;
  const mediaPath = fm.media ?? settings.mediaPath;
  const markdownLinks = fm.markdownLinks ?? settings.markdownImageLinks;

  if (outputFormat === "image") {
    // Prefer native image data (matplotlib, R plots, etc.)
    const imgData = extractImageData(chunks) ??
      await renderHtmlToPng(renderChunksToHtml(chunks));
    if (imgData) {
      const { filename, vaultPath } = await saveImageToVault(app, file, id, hash, imgData, mediaPath);
      return { content: imageLink(filename, vaultPath, file, markdownLinks), format: "image" };
    }
  }
  return { content: renderChunksToHtml(chunks), format: "html" };
}
