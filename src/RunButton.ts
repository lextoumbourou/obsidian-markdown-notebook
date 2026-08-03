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
  extractImageData,
  OutputChunk,
} from "./output/MimeRenderer";
import { renderHtmlToPng } from "./output/HtmlToImage";
import { KernelCancelledError, KernelTimeoutError } from "./kernels/BaseKernel";
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";
import type { PluginSettings } from "./settings/Settings";
import { readNotebookFrontmatter, NotebookFrontmatter } from "./NotebookFrontmatter";
import { scheduleRunAllToolbarRender } from "./RunAllToolbar";

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

export interface RunButtonContext {
  app: App;
  getSettings: () => PluginSettings;
  getKernel: (lang: string) => AnyKernel;
}

/** Args parsed from `{key=value}` pairs in the fence info string. */
export interface RunArgs {
  id?: string;
  format?: string;
  [key: string]: string | undefined;
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

  const settings = context.getSettings();
  const kernel = context.getKernel(language);
  const pre = renderPlainCodeBlock(src, el, language);
  const hash = await hashCodeFence(language, src);
  const flightKey = `${ctx.sourcePath}::${hash}`;

  const buttonWrap = pre.createDiv({ cls: "nb-run-button-wrap" });
  const countBadge = buttonWrap.createEl("span", {
    cls: "nb-exec-count",
    text: `[${kernel.executionCount}]`,
  });
  const button = buttonWrap.createEl("button", {
    cls: "nb-run-button",
    text: "▶ Run",
  });
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
    const controller = new AbortController();
    const run: ActiveCellRun = {
      controller,
      phase: "running",
      buttons: new Set([button]),
    };
    activeCellRuns.set(flightKey, run);
    updateCellRunButtons(run);

    inFlight.add(flightKey);
    try {
      // Re-read section info at click time so args are never stale.
      // getSectionInfo can return null during the initial render pass.
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

      const liveEl = el.createDiv({ cls: "nb-live-output" });
      const chunks: OutputChunk[] = [];

      const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
      const fm: NotebookFrontmatter = file instanceof TFile
        ? readNotebookFrontmatter(app, file)
        : {};
      const timeout = fm.timeout ?? settings.executionTimeout;

      const pendingFormat = (runArgs.format ?? fm.format ?? settings.defaultFormat) as OutputFormat;

      // Identify the cell by content, not position — line numbers go stale as
      // soon as any other cell's write inserts lines above this one.
      const cell = { language, source: src, hintLine: sectionInfo?.lineEnd ?? 0 };

      // Write a placeholder block immediately so the output anchor exists in the
      // file while execution is running. Prevents accidental edits into the gap.
      if (sectionInfo && file instanceof TFile) {
        try {
          await writeOutputBlock(app, file, cell, hash, RUNNING_HTML, pendingFormat, runArgs.id, "running");
        } catch (err) {
          console.error("[MarkdownNotebook] Failed to write placeholder block:", err);
        }
      }

      let failure: "error" | "timeout" | "cancelled" | null = null;
      try {
        await kernel.execute(src, (chunk) => {
          chunks.push(chunk);
          appendChunkToElement(liveEl, chunk);
        }, timeout, controller.signal);
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
          chunks.push({ type: "error", text: msg });
          appendChunkToElement(liveEl, { type: "error", text: msg });
          new Notice(`Notebook: ${msg}`);
        }
      }

      if (sectionInfo && file instanceof TFile) {
        if (failure) {
          const statusHtml = failure === "cancelled"
            ? INTERRUPTED_HTML
            : failure === "timeout" ? timeoutHtml(timeout) : ERROR_HTML;
          try {
            await writeOutputBlock(
              app, file, cell, hash, statusHtml, pendingFormat, runArgs.id,
              failure === "cancelled" ? "error" : failure,
            );
          } catch (err) {
            console.error("[MarkdownNotebook] Failed to write error block:", err);
          }
        } else {
          try {
            const { content, format } = await buildOutput(
              app, file, hash, chunks, runArgs, settings, fm,
              () => {
                if (controller.signal.aborted) throw new KernelCancelledError();
              },
            );
            await writeOutputBlock(
              app, file, cell, hash, content, format, runArgs.id, undefined,
              () => {
                if (controller.signal.aborted) throw new KernelCancelledError();
              },
            );
          } catch (err) {
            if (err instanceof KernelCancelledError) {
              try {
                await writeOutputBlock(
                  app, file, cell, hash, INTERRUPTED_HTML, pendingFormat,
                  runArgs.id, "error",
                );
              } catch {
                // file write is failing entirely; nothing more we can do
              }
              new Notice("Notebook: execution stopped.");
            } else {
              console.error("[MarkdownNotebook] Failed to write output block:", err);
              // Never leave the "running" placeholder behind — degrade to an
              // error block so the file doesn't show a spinner forever.
              try {
                await writeOutputBlock(app, file, cell, hash, ERROR_HTML, pendingFormat, runArgs.id, "error");
              } catch {
                // file write is failing entirely; nothing more we can do
              }
            }
          }
        }
      }

      liveEl.remove();
    } finally {
      inFlight.delete(flightKey);
      if (activeCellRuns.get(flightKey) === run) activeCellRuns.delete(flightKey);
      resetCellRunButtons(run);
      countBadge.textContent = `[${context.getKernel(language).executionCount}]`;
    }
  });
}

async function buildOutput(
  app: App,
  file: TFile,
  hash: string,
  chunks: OutputChunk[],
  runArgs: RunArgs,
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
    const imgData = extractImageData(chunks) ??
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
