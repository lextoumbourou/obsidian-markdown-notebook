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
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";
import type { PluginSettings } from "./settings/Settings";
import { readNotebookFrontmatter, NotebookFrontmatter } from "./NotebookFrontmatter";

type AnyKernel = BaseKernel | ShellKernel;

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

    try {
      await kernel.execute(src, (chunk) => {
        chunks.push(chunk);
        appendChunkToElement(liveEl, chunk);
      }, timeout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push({ type: "error", text: msg });
      appendChunkToElement(liveEl, { type: "error", text: msg });
      new Notice(`Notebook: ${msg}`);
    }

    if (sectionInfo && file instanceof TFile) {
      try {
        const { content, format } = await buildOutput(
          app, file, hash, chunks, runArgs, settings, fm
        );
        await writeOutputBlock(app, file, sectionInfo.lineEnd, hash, content, format, runArgs.id);
      } catch (err) {
        console.error("[MarkdownNotebook] Failed to write output block:", err);
      }
    }

    liveEl.remove();
    button.classList.remove("nb-run-button--running");
    button.setText("▶ Run");
    countBadge.textContent = `[${context.getKernel(language).executionCount}]`;
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
