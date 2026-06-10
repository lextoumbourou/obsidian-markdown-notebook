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
} from "./OutputBlock";
import {
  appendChunkToElement,
  renderChunksToHtml,
  extractImageData,
  OutputChunk,
} from "./output/MimeRenderer";
import { renderHtmlToPng } from "./output/HtmlToImage";
import { KernelTimeoutError } from "./kernels/BaseKernel";
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";
import type { PluginSettings } from "./settings/Settings";
import { readNotebookFrontmatter, NotebookFrontmatter } from "./NotebookFrontmatter";

type AnyKernel = BaseKernel | ShellKernel;

const RUNNING_HTML = `<div class="nb-status-running"><span class="nb-status-spinner"></span>Running...</div>`;
const ERROR_HTML = `<div class="nb-status-error">Execution failed</div>`;

/** Cells currently executing, keyed by `${sourcePath}::${hash}`. Lets the
 * stale-block cleanup distinguish a live spinner from a crash leftover. */
const inFlight = new Set<string>();

export function isCellInFlight(sourcePath: string, hash: string): boolean {
  return inFlight.has(`${sourcePath}::${hash}`);
}

function timeoutHtml(timeoutMs: number): string {
  const secs = timeoutMs / 1000;
  return `<div class="nb-status-timeout">Execution timed out after ${secs}s</div>`;
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
  const { app } = context;

  const settings = context.getSettings();
  const kernel = context.getKernel(language);
  const pre = renderPlainCodeBlock(src, el, language);
  const hash = await hashCodeFence(language, src);

  const buttonWrap = pre.createDiv({ cls: "nb-run-button-wrap" });
  const countBadge = buttonWrap.createEl("span", {
    cls: "nb-exec-count",
    text: `[${kernel.executionCount}]`,
  });
  const button = buttonWrap.createEl("button", {
    cls: "nb-run-button",
    text: "▶ Run",
  });

  button.addEventListener("click", async () => {
    if (button.classList.contains("nb-run-button--running")) return;
    button.classList.add("nb-run-button--running");
    button.setText("● Running");

    const flightKey = `${ctx.sourcePath}::${hash}`;
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

      let failure: "error" | "timeout" | null = null;
      try {
        await kernel.execute(src, (chunk) => {
          chunks.push(chunk);
          appendChunkToElement(liveEl, chunk);
        }, timeout);
      } catch (err) {
        failure = err instanceof KernelTimeoutError ? "timeout" : "error";
        const msg = err instanceof Error ? err.message : String(err);
        chunks.push({ type: "error", text: msg });
        appendChunkToElement(liveEl, { type: "error", text: msg });
        new Notice(`Notebook: ${msg}`);
      }

      if (sectionInfo && file instanceof TFile) {
        if (failure) {
          const statusHtml = failure === "timeout" ? timeoutHtml(timeout) : ERROR_HTML;
          try {
            await writeOutputBlock(app, file, cell, hash, statusHtml, pendingFormat, runArgs.id, failure);
          } catch (err) {
            console.error("[MarkdownNotebook] Failed to write error block:", err);
          }
        } else {
          try {
            const { content, format } = await buildOutput(
              app, file, hash, chunks, runArgs, settings, fm
            );
            await writeOutputBlock(app, file, cell, hash, content, format, runArgs.id);
          } catch (err) {
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

      liveEl.remove();
    } finally {
      inFlight.delete(flightKey);
      button.classList.remove("nb-run-button--running");
      button.setText("▶ Run");
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
): Promise<{ content: string; format: OutputFormat }> {
  const outputFormat = runArgs.format ?? fm.format ?? settings.defaultFormat;
  const mediaPath = fm.media ?? settings.mediaPath;
  const markdownLinks = fm.markdownLinks ?? settings.markdownImageLinks;

  if (outputFormat === "image") {
    // Prefer native image data (matplotlib, R plots, etc.)
    const imgData = extractImageData(chunks) ??
      await renderHtmlToPng(renderChunksToHtml(chunks));
    if (imgData) {
      const { filename, vaultPath } = await saveImageToVault(
        app, file, runArgs.id, hash, imgData, mediaPath
      );
      return { content: imageLink(filename, vaultPath, file, markdownLinks), format: "image" };
    }
  }
  return { content: renderChunksToHtml(chunks), format: "html" };
}
