import {
  App,
  MarkdownPostProcessorContext,
  Notice,
  TFile,
} from "obsidian";
import { hashCodeFence } from "./HashUtils";
import {
  writeOutputBlock,
  saveImageToVault,
  imageLink,
  OutputFormat,
  ERROR_HTML,
  INTERRUPTED_HTML,
  timeoutHtml,
} from "./OutputBlock";
import {
  appendChunkToElement,
  renderChunksToHtml,
  renderFailureToHtml,
  extractImageData,
  OutputChunk,
} from "./output/MimeRenderer";
import { renderHtmlToPng } from "./output/HtmlToImage";
import { OutputLimiter } from "./output/OutputLimiter";
import { KernelCancelledError, KernelExecutionError, KernelTimeoutError } from "./kernels/BaseKernel";
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";
import type { PluginSettings } from "./settings/Settings";
import { readNotebookFrontmatter, NotebookFrontmatter } from "./NotebookFrontmatter";
import { scheduleRunAllToolbarRender } from "./RunAllToolbar";
import type {
  BackgroundCellRequest,
  BackgroundExecutionContext,
} from "./BackgroundProcessManager";

type AnyKernel = BaseKernel | ShellKernel;

const RUNNING_HTML = `<div class="nb-status-running"><span class="nb-status-spinner"></span>Running...</div>`;

/** Cells currently executing, keyed by `${sourcePath}::${hash}`. Lets the
 * stale-block cleanup distinguish a live spinner from a crash leftover. */
const inFlight = new Set<string>();

type CellRunPhase = "running" | "stopping" | "finishing";

interface ActiveCellRun {
  controller: AbortController;
  phase: CellRunPhase;
  buttons: Set<HTMLButtonElement>;
}

const activeCellRuns = new Map<string, ActiveCellRun>();
const backgroundCellButtons = new Map<string, Set<HTMLButtonElement>>();

function backgroundKey(sourcePath: string, name: string): string {
  return `${sourcePath}::${name}`;
}

function registerBackgroundButton(
  sourcePath: string,
  name: string,
  button: HTMLButtonElement,
): void {
  const key = backgroundKey(sourcePath, name);
  let buttons = backgroundCellButtons.get(key);
  if (!buttons) {
    buttons = new Set();
    backgroundCellButtons.set(key, buttons);
  }
  buttons.add(button);
}

export function updateBackgroundButtons(
  sourcePath: string,
  name: string,
  phase: "running" | "stopping" | "idle",
): void {
  const key = backgroundKey(sourcePath, name);
  const buttons = backgroundCellButtons.get(key);
  if (!buttons) return;
  for (const button of buttons) {
    button.classList.toggle("nb-run-button--running", phase !== "idle");
    button.disabled = phase === "stopping";
    button.setText(
      phase === "running" ? "■ Stop" : phase === "stopping" ? "■ Stopping…" : "▶ Run",
    );
  }
  if (phase === "idle") backgroundCellButtons.delete(key);
}

function updateCellRunButtons(run: ActiveCellRun): void {
  for (const button of run.buttons) {
    button.classList.add("nb-run-button--running");
    button.disabled = run.phase !== "running";
    button.setText(
      run.phase === "running"
        ? "■ Stop"
        : run.phase === "stopping" ? "■ Stopping…" : "Finishing…"
    );
  }
}

function resetCellRunButtons(run: ActiveCellRun): void {
  for (const button of run.buttons) {
    button.classList.remove("nb-run-button--running");
    button.disabled = false;
    button.setText("▶ Run");
  }
}

export function isCellInFlight(sourcePath: string, hash: string): boolean {
  return inFlight.has(`${sourcePath}::${hash}`);
}

export function hasActiveCellRun(sourcePath: string): boolean {
  const prefix = `${sourcePath}::`;
  for (const key of activeCellRuns.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export interface RunButtonContext {
  app: App;
  getSettings: () => PluginSettings;
  acquireKernel: (lang: string, sourcePath: string) => AnyKernel;
  peekExecutionCount: (lang: string, sourcePath: string) => number;
  background?: BackgroundExecutionContext;
}

/** Args parsed from `{key=value}` pairs in the fence info string. */
export interface RunArgs {
  id?: string;
  format?: string;
  [key: string]: string | undefined;
}

export interface RunnableCell {
  language: string;
  source: string;
  lineEnd: number;
  id?: string;
  format?: string;
  background?: string;
}

interface RunCellOptions {
  hash?: string;
  button?: HTMLButtonElement;
  liveEl?: HTMLElement;
  onExecutionCount?: (count: number) => void;
}

function parseRunArgs(openingLine: string): RunArgs {
  const match = openingLine.match(/\{([^}]*)\}/);
  const args: RunArgs = {};
  if (match) {
    for (const m of match[1].matchAll(/(\w+)=(\S+)/g)) {
      args[m[1]] = m[2];
    }
  }
  return args;
}

function renderPlainCodeBlock(src: string, el: HTMLElement, language: string): HTMLPreElement {
  const pre = el.createEl("pre");
  const code = pre.createEl("code", { cls: `language-${language}` });
  code.textContent = src;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).Prism?.highlightElement(code);
  return pre;
}

/** Execute one cell and persist its output. Shared by Reading View buttons and
 * the editor command so both paths have identical timeout, error, image, and
 * cancellation semantics. Returns false when the same cell is already active. */
export async function runCell(
  sourcePath: string,
  file: TFile | null,
  cell: RunnableCell,
  context: RunButtonContext,
  options: RunCellOptions = {},
): Promise<boolean> {
  const { app } = context;
  const settings = context.getSettings();
  const hash = options.hash ?? await hashCodeFence(cell.language, cell.source);
  const flightKey = `${sourcePath}::${hash}`;
  if (activeCellRuns.has(flightKey)) {
    new Notice("Notebook: this cell is already running.");
    return false;
  }

  const controller = new AbortController();
  const run: ActiveCellRun = {
    controller,
    phase: "running",
    buttons: new Set(options.button ? [options.button] : []),
  };
  activeCellRuns.set(flightKey, run);
  updateCellRunButtons(run);
  inFlight.add(flightKey);

  let executedKernel: AnyKernel | null = null;
  const fm: NotebookFrontmatter = file
    ? readNotebookFrontmatter(app, file)
    : {};
  const timeout = fm.timeout ?? settings.executionTimeout;
  const pendingFormat = (cell.format ?? fm.format ?? settings.defaultFormat) as OutputFormat;
  const output = new OutputLimiter(
    fm.outputLimit ?? settings.outputLimitKb,
    pendingFormat === "image",
  );
  const chunks = output.chunks;
  const locator = {
    language: cell.language,
    source: cell.source,
    hintLine: cell.lineEnd,
  };

  try {
    if (file) {
      try {
        await writeOutputBlock(
          app, file, locator, hash, RUNNING_HTML, pendingFormat, cell.id, "running",
        );
      } catch (err) {
        console.error("[MarkdownNotebook] Failed to write placeholder block:", err);
      }
    }

    let failure: "error" | "timeout" | "cancelled" | null = null;
    try {
      const onChunk = (chunk: OutputChunk) => {
        for (const accepted of output.add(chunk)) {
          if (options.liveEl) appendChunkToElement(options.liveEl, accepted);
        }
      };
      if (cell.background) {
        if (!context.background) {
          throw new Error("Background cells are unavailable in this runner");
        }
        const request: BackgroundCellRequest = {
          sourcePath,
          name: cell.background,
          language: cell.language,
          source: cell.source,
        };
        await context.background.start(request, onChunk, controller.signal);
        onChunk({
          type: "stream",
          stream: "stdout",
          text: `Background process "${cell.background}" started.\n`,
        });
      } else {
        executedKernel = context.acquireKernel(cell.language, sourcePath);
        await executedKernel.execute(cell.source, onChunk, timeout, controller.signal);
      }
      run.phase = "finishing";
      updateCellRunButtons(run);
    } catch (err) {
      failure = err instanceof KernelCancelledError
        ? "cancelled"
        : err instanceof KernelTimeoutError ? "timeout" : "error";
      if (failure === "cancelled") {
        new Notice("Notebook: execution stopped.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (!(err instanceof KernelExecutionError) && !(err instanceof KernelTimeoutError)) {
          const chunk = { type: "error" as const, text: msg };
          for (const accepted of output.add(chunk)) {
            if (options.liveEl) appendChunkToElement(options.liveEl, accepted);
          }
        }
        new Notice(`Notebook: ${msg}`);
      }
    }

    if (file) {
      if (failure) {
        const statusHtml = failure === "cancelled"
          ? INTERRUPTED_HTML
          : failure === "timeout" ? timeoutHtml(timeout) : ERROR_HTML;
        const failureHtml = renderFailureToHtml(statusHtml, chunks);
        try {
          await writeOutputBlock(
            app, file, locator, hash, failureHtml, "html", cell.id,
            failure === "cancelled" ? "error" : failure,
          );
        } catch (err) {
          console.error("[MarkdownNotebook] Failed to write error block:", err);
        }
      } else {
        try {
          const { content, format } = await buildOutput(
            app, file, hash, chunks, output.nativeImageData, cell, settings, fm,
            () => {
              if (controller.signal.aborted) throw new KernelCancelledError();
            },
          );
          await writeOutputBlock(
            app, file, locator, hash, content, format, cell.id, undefined,
            () => {
              if (controller.signal.aborted) throw new KernelCancelledError();
            },
          );
        } catch (err) {
          if (err instanceof KernelCancelledError) {
            try {
              await writeOutputBlock(
                app, file, locator, hash, INTERRUPTED_HTML, pendingFormat,
                cell.id, "error",
              );
            } catch {
              // file write is failing entirely; nothing more we can do
            }
            new Notice("Notebook: execution stopped.");
          } else {
            console.error("[MarkdownNotebook] Failed to write output block:", err);
            try {
              await writeOutputBlock(
                app, file, locator, hash, ERROR_HTML, pendingFormat, cell.id, "error",
              );
            } catch {
              // file write is failing entirely; nothing more we can do
            }
          }
        }
      }
    }
    return true;
  } finally {
    options.liveEl?.remove();
    inFlight.delete(flightKey);
    if (activeCellRuns.get(flightKey) === run) activeCellRuns.delete(flightKey);
    if (
      cell.background
      && context.background?.isRunning(sourcePath, cell.background)
    ) {
      if (options.button) registerBackgroundButton(sourcePath, cell.background, options.button);
      updateBackgroundButtons(sourcePath, cell.background, "running");
    } else {
      resetCellRunButtons(run);
    }
    options.onExecutionCount?.(
      executedKernel?.executionCount
      ?? context.peekExecutionCount(cell.language, sourcePath),
    );
  }
}

/** Run an idle cell, or stop it when the same cell is already executing. */
export async function runOrStopCell(
  sourcePath: string,
  file: TFile,
  cell: RunnableCell,
  context: RunButtonContext,
): Promise<"started" | "stopped" | "finishing"> {
  const hash = await hashCodeFence(cell.language, cell.source);
  if (
    cell.background
    && context.background?.isRunning(sourcePath, cell.background)
  ) {
    await stopBackgroundCell(sourcePath, file, cell, context, hash);
    return "stopped";
  }
  const activeRun = activeCellRuns.get(`${sourcePath}::${hash}`);
  if (activeRun) {
    if (activeRun.phase === "running") {
      activeRun.phase = "stopping";
      activeRun.controller.abort();
      updateCellRunButtons(activeRun);
      return "stopped";
    }
    return "finishing";
  }

  await runCell(sourcePath, file, cell, context, { hash });
  return "started";
}

async function stopBackgroundCell(
  sourcePath: string,
  file: TFile,
  cell: RunnableCell,
  context: RunButtonContext,
  hash: string,
): Promise<boolean> {
  const name = cell.background;
  if (!name || !context.background) return false;
  updateBackgroundButtons(sourcePath, name, "stopping");
  const stopped = await context.background.stop(sourcePath, name);
  updateBackgroundButtons(sourcePath, name, "idle");
  if (stopped) {
    await writeOutputBlock(
      context.app,
      file,
      { language: cell.language, source: cell.source, hintLine: cell.lineEnd },
      hash,
      renderChunksToHtml([{
        type: "stream",
        stream: "stdout",
        text: `Background process "${name}" stopped.\n`,
      }]),
      "html",
      cell.id,
    );
  }
  return stopped;
}

/**
 * Registered via plugin.registerMarkdownCodeBlockProcessor(language, ...).
 * All blocks for supported languages get a run button — no {run} marker needed.
 */
export async function processCodeBlock(
  src: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  context: RunButtonContext,
  language: string
): Promise<void> {
  scheduleRunAllToolbarRender(ctx, context);
  const { app } = context;

  const pre = renderPlainCodeBlock(src, el, language);
  const hash = await hashCodeFence(language, src);
  const flightKey = `${ctx.sourcePath}::${hash}`;

  const buttonWrap = pre.createDiv({ cls: "nb-run-button-wrap" });
  const countBadge = buttonWrap.createEl("span", {
    cls: "nb-exec-count",
    text: `[${context.peekExecutionCount(language, ctx.sourcePath)}]`,
  });
  const button = buttonWrap.createEl("button", {
    cls: "nb-run-button",
    text: "▶ Run",
  });
  const initialSectionInfo = ctx.getSectionInfo(el);
  let initialArgs: RunArgs = {};
  if (initialSectionInfo) {
    const lines = initialSectionInfo.text.split("\n");
    for (let i = initialSectionInfo.lineStart; i <= initialSectionInfo.lineEnd; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("```")) {
        initialArgs = parseRunArgs(line);
        break;
      }
    }
  }
  if (initialArgs.background) {
    registerBackgroundButton(ctx.sourcePath, initialArgs.background, button);
    if (context.background?.isRunning(ctx.sourcePath, initialArgs.background)) {
      updateBackgroundButtons(ctx.sourcePath, initialArgs.background, "running");
    }
  }
  const existingRun = activeCellRuns.get(flightKey);
  if (existingRun) {
    existingRun.buttons.add(button);
    updateCellRunButtons(existingRun);
  }

  button.addEventListener("click", async () => {
    const activeRun = activeCellRuns.get(flightKey);
    if (activeRun) {
      if (activeRun.phase === "running") {
        activeRun.phase = "stopping";
        activeRun.controller.abort();
        updateCellRunButtons(activeRun);
      }
      return;
    }
    // Re-read section info at click time so args are never stale.
    const sectionInfo = ctx.getSectionInfo(el);
    let runArgs: RunArgs = {};
    if (sectionInfo) {
      const lines = sectionInfo.text.split("\n");
      for (let i = sectionInfo.lineStart; i <= sectionInfo.lineEnd; i++) {
        const line = lines[i] ?? "";
        if (line.startsWith("```")) {
          runArgs = parseRunArgs(line);
          break;
        }
      }
    }

    if (
      runArgs.background
      && context.background?.isRunning(ctx.sourcePath, runArgs.background)
    ) {
      const candidate = app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (candidate instanceof TFile) {
        await stopBackgroundCell(
          ctx.sourcePath,
          candidate,
          {
            id: runArgs.id,
            format: runArgs.format,
            background: runArgs.background,
            language,
            source: src,
            lineEnd: sectionInfo?.lineEnd ?? 0,
          },
          context,
          hash,
        );
      }
      return;
    }

    const liveEl = el.createDiv({ cls: "nb-live-output" });
    const candidate = app.vault.getAbstractFileByPath(ctx.sourcePath);
    const started = await runCell(
      ctx.sourcePath,
      candidate instanceof TFile ? candidate : null,
      {
        id: runArgs.id,
        format: runArgs.format,
        background: runArgs.background,
        language,
        source: src,
        lineEnd: sectionInfo?.lineEnd ?? 0,
      },
      context,
      {
        hash,
        button,
        liveEl,
        onExecutionCount: (count) => { countBadge.textContent = `[${count}]`; },
      },
    );
    if (!started) liveEl.remove();
  });
}

async function buildOutput(
  app: App,
  file: TFile,
  hash: string,
  chunks: OutputChunk[],
  nativeImageData: string | null,
  runArgs: Pick<RunArgs, "id" | "format">,
  settings: PluginSettings,
  fm: NotebookFrontmatter,
  assertActive: () => void,
): Promise<{ content: string; format: OutputFormat }> {
  assertActive();
  const outputFormat = runArgs.format ?? fm.format ?? settings.defaultFormat;
  const mediaPath = fm.media ?? settings.mediaPath;
  const markdownLinks = fm.markdownLinks ?? settings.markdownImageLinks;

  if (outputFormat === "image") {
    // Prefer native image data (matplotlib, R plots, etc.)
    const imgData = nativeImageData ?? extractImageData(chunks) ??
      await renderHtmlToPng(renderChunksToHtml(chunks));
    assertActive();
    if (imgData) {
      const { filename, vaultPath } = await saveImageToVault(
        app, file, runArgs.id, hash, imgData, mediaPath, assertActive,
      );
      assertActive();
      return { content: imageLink(filename, vaultPath, file, markdownLinks), format: "image" };
    }
  }
  assertActive();
  return { content: renderChunksToHtml(chunks), format: "html" };
}
