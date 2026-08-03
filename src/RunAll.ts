import { App, Notice, TFile } from "obsidian";
import { hashCodeFence } from "./HashUtils";
import { parseRunBlocks, RunBlock } from "./CellParser";
import {
  writeOutputBlock,
  outputCellExists,
  saveImageToVault,
  imageLink,
  OutputFormat,
  OutputStatus,
  ERROR_HTML,
  timeoutHtml,
} from "./OutputBlock";
import { KernelCancelledError, KernelTimeoutError } from "./kernels/BaseKernel";

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
  onCancel?: (state: { current: number; total: number }) => void;
}

interface OwnedProgress {
  owner: symbol;
  state: RunAllProgress;
}

type PendingResult = RunBlock & {
  cellIndex: number;
  hash: string;
  content: string;
  format: OutputFormat;
  status?: OutputStatus;
};

class RunAllCancelledError extends Error {}

const runAllInFlight = new Map<string, symbol>();
const runAllFilesInFlight = new Map<TFile, symbol>();
const runAllProgress = new Map<string, OwnedProgress>();
const activeNotices = new Map<symbol, Notice>();
const runAllControllers = new Map<symbol, AbortController>();
let runAllEnabled = true;
let runAllGeneration = 0;

export function activateRunAll(): void {
  runAllEnabled = true;
  runAllGeneration += 1;
}

export function disposeRunAll(): void {
  runAllEnabled = false;
  runAllGeneration += 1;
  for (const controller of runAllControllers.values()) controller.abort();
  runAllControllers.clear();
  for (const notice of activeNotices.values()) notice.hide();
  activeNotices.clear();
  runAllInFlight.clear();
  runAllFilesInFlight.clear();
  runAllProgress.clear();
}

/** Stop the run-all operation for one note, including its current cell. */
export function cancelRunAll(sourcePath: string): boolean {
  const owner = runAllInFlight.get(sourcePath);
  if (!owner) return false;
  const controller = runAllControllers.get(owner);
  if (!controller) return false;
  controller.abort();
  return true;
}

function throwIfRunCancelled(generation: number): void {
  if (isRunCancelled(generation)) {
    throw new RunAllCancelledError();
  }
}

function isRunCancelled(generation: number): boolean {
  return !runAllEnabled || generation !== runAllGeneration;
}

export function getRunAllProgress(sourcePath: string): RunAllProgress | undefined {
  return runAllProgress.get(sourcePath)?.state;
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
  const activeOwner = runAllFilesInFlight.get(file) ?? runAllInFlight.get(sourcePath);
  if (activeOwner) {
    const activeState = [...runAllProgress.values()]
      .find((progress) => progress.owner === activeOwner)?.state;
    new Notice("Notebook: this file is already running.");
    return {
      total: activeState?.total ?? 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
    };
  }

  if (!runAllEnabled) {
    return { total: 0, succeeded: 0, failed: 0, skipped: true };
  }

  const owner = Symbol(sourcePath);
  const controller = new AbortController();
  const generation = runAllGeneration;
  runAllInFlight.set(sourcePath, owner);
  runAllFilesInFlight.set(file, owner);
  runAllControllers.set(owner, controller);
  let total = 0;
  let notice: Notice | null = null;
  const failedCells = new Set<number>();
  const results: PendingResult[] = [];
  let completedCells = 0;
  let stoppedAt: number | null = null;
  let phase: "running" | "writing" | "done" = "running";

  const saveResults = async (assertActive: () => void): Promise<void> => {
    // Writes re-anchor each cell by content; lineEnd is only the duplicate
    // tie-breaker hint. Reverse order keeps the hints closest to accurate.
    for (const result of [...results].reverse()) {
      assertActive();
      try {
        const saved = await writeOutputBlock(
          app, file,
          { language: result.language, source: result.source, hintLine: result.lineEnd },
          result.hash, result.content, result.format, result.id, result.status,
          assertActive,
        );
        assertActive();
        if (!saved) {
          failedCells.add(result.cellIndex);
          const cellNumber = result.cellIndex + 1;
          new Notice(
            `Notebook: cell ${cellNumber} changed before its output could be saved.`
          );
        }
      } catch (err) {
        if (err instanceof KernelCancelledError || err instanceof RunAllCancelledError) throw err;
        if (isRunCancelled(generation)) throw new RunAllCancelledError();
        failedCells.add(result.cellIndex);
        const cellNumber = result.cellIndex + 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MarkdownNotebook] Cell ${cellNumber} output write failed:`, err);
        new Notice(`Notebook: cell ${cellNumber} output could not be saved: ${msg}`);
      }
    }
  };

  try {
    throwIfRunCancelled(generation);
    const content = await app.vault.read(file);
    throwIfRunCancelled(generation);
    const blocks = parseRunBlocks(content);
    const fm = readNotebookFrontmatter(app, file);
    total = blocks.length;

    if (total === 0) {
      new Notice("No executable cells found.");
      const emptySummary = { total: 0, succeeded: 0, failed: 0, skipped: false };
      callHook(hooks, "onComplete", emptySummary);
      return emptySummary;
    }

    runAllProgress.set(sourcePath, {
      owner,
      state: { running: true, current: 0, total },
    });
    callHook(hooks, "onStart", { total });
    throwIfRunCancelled(generation);
    notice = new Notice(`Running cell 1 / ${total}…`, 0);
    activeNotices.set(owner, notice);
    for (let i = 0; i < total; i++) {
      throwIfRunCancelled(generation);
      const current = i + 1;
      runAllProgress.set(sourcePath, {
        owner,
        state: { running: true, current, total },
      });
      callHook(hooks, "onProgress", { current, total });
      throwIfRunCancelled(generation);
      notice.setMessage(`Running cell ${current} / ${total}…`);
      const block = blocks[i];
      let hash: string;
      try {
        hash = await hashCodeFence(block.language, block.source);
        throwIfRunCancelled(generation);
      } catch (err) {
        if (isRunCancelled(generation)) throw new RunAllCancelledError();
        if (err instanceof RunAllCancelledError) throw err;
        failedCells.add(i);
        completedCells += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[MarkdownNotebook] Cell ${current} hashing failed:`, err);
        new Notice(`Notebook: cell ${current} could not be prepared: ${msg}`);
        continue;
      }
      const chunks: OutputChunk[] = [];
      const timeout = fm.timeout ?? settings.executionTimeout;

      let failure: OutputStatus | null = null;
      try {
        await getKernel(block.language).execute(
          block.source,
          (chunk) => chunks.push(chunk),
          timeout,
          controller.signal,
        );
        if (controller.signal.aborted) throw new KernelCancelledError();
        throwIfRunCancelled(generation);
      } catch (err) {
        if (controller.signal.aborted || err instanceof KernelCancelledError) {
          throw new KernelCancelledError();
        }
        if (isRunCancelled(generation)) throw new RunAllCancelledError();
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
        if (settings.stopOnFirstError) {
          stoppedAt = current;
          break;
        }
        continue;
      }

      try {
        const cellStillExists = await outputCellExists(
          app,
          file,
          { language: block.language, source: block.source, hintLine: block.lineEnd },
          () => throwIfRunCancelled(generation),
        );
        if (!cellStillExists) {
          failedCells.add(i);
          completedCells += 1;
          new Notice(
            `Notebook: cell ${current} changed before its output could be prepared.`
          );
          continue;
        }
        const { content: outContent, format } = await resolveOutput(
          app, file, hash, chunks, block.id, block.format, settings, fm,
          () => throwIfRunCancelled(generation)
        );
        throwIfRunCancelled(generation);
        results.push({ ...block, cellIndex: i, hash, content: outContent, format });
      } catch (err) {
        if (isRunCancelled(generation)) throw new RunAllCancelledError();
        if (err instanceof RunAllCancelledError) throw err;
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

    phase = "writing";
    await saveResults(() => {
      throwIfRunCancelled(generation);
      if (controller.signal.aborted) throw new KernelCancelledError();
    });
    phase = "done";

    throwIfRunCancelled(generation);
    const summary = {
      total,
      succeeded: Math.max(0, completedCells - failedCells.size),
      failed: failedCells.size,
      skipped: false,
    };
    notice.hide();
    activeNotices.delete(owner);
    notice = null;
    if (stoppedAt !== null) {
      const notRun = Math.max(0, total - completedCells);
      new Notice(
        `Stopped at cell ${stoppedAt} after an error: ` +
        `${summary.succeeded} succeeded, ${summary.failed} failed` +
        `${notRun > 0 ? `, ${notRun} not run` : ""}.`
      );
    } else {
      new Notice(
        `Ran ${total} cell${total === 1 ? "" : "s"}: ` +
        `${summary.succeeded} succeeded, ${summary.failed} failed.`
      );
    }
    callHook(hooks, "onComplete", summary);
    return summary;
  } catch (err) {
    if (
      controller.signal.aborted
      || isRunCancelled(generation)
      || err instanceof RunAllCancelledError
      || err instanceof KernelCancelledError
    ) {
      const current = runAllProgress.get(sourcePath)?.state.current ?? completedCells;
      const manuallyCancelled = controller.signal.aborted && !isRunCancelled(generation);
      // A stop during execution preserves outputs from cells that already
      // completed. A stop during the write phase stops further writes instead.
      if (manuallyCancelled && phase === "running" && results.length > 0) {
        notice?.setMessage("Saving completed cell outputs…");
        try {
          await saveResults(() => throwIfRunCancelled(generation));
        } catch (saveErr) {
          if (!isRunCancelled(generation)) throw saveErr;
        }
      }
      const succeeded = Math.max(0, completedCells - failedCells.size);
      const summary = {
        total,
        succeeded,
        failed: manuallyCancelled
          ? failedCells.size
          : Math.max(failedCells.size, total - succeeded),
        skipped: true,
      };
      if (manuallyCancelled) {
        new Notice(
          `Stopped at cell ${current} of ${total}: ` +
          `${succeeded} succeeded, ${failedCells.size} failed.`
        );
        callHook(hooks, "onCancel", { current, total });
      }
      return summary;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[MarkdownNotebook] Run all failed:", err);
    new Notice(`Notebook: run all failed: ${msg}`);
    const succeeded = Math.max(0, completedCells - failedCells.size);
    const summary = {
      total,
      succeeded,
      failed: Math.max(failedCells.size, total - succeeded),
      skipped: false,
    };
    callHook(hooks, "onComplete", summary);
    return summary;
  } finally {
    notice?.hide();
    activeNotices.delete(owner);
    runAllControllers.delete(owner);
    if (runAllInFlight.get(sourcePath) === owner) runAllInFlight.delete(sourcePath);
    if (runAllFilesInFlight.get(file) === owner) runAllFilesInFlight.delete(file);
    if (runAllProgress.get(sourcePath)?.owner === owner) runAllProgress.delete(sourcePath);
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
  assertActive: () => void,
): Promise<{ content: string; format: OutputFormat }> {
  assertActive();
  const outputFormat = formatArg ?? fm.format ?? settings.defaultFormat;
  const mediaPath = fm.media ?? settings.mediaPath;
  const markdownLinks = fm.markdownLinks ?? settings.markdownImageLinks;

  if (outputFormat === "image") {
    // Prefer native image data (matplotlib, R plots, etc.)
    let imgData = extractImageData(chunks);
    if (!imgData) {
      assertActive();
      imgData = await renderHtmlToPng(renderChunksToHtml(chunks));
      assertActive();
    }
    if (imgData) {
      const { filename, vaultPath } = await saveImageToVault(
        app, file, id, hash, imgData, mediaPath, assertActive
      );
      assertActive();
      return { content: imageLink(filename, vaultPath, file, markdownLinks), format: "image" };
    }
  }
  assertActive();
  return { content: renderChunksToHtml(chunks), format: "html" };
}
