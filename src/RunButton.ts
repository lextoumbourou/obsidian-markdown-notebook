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
  renderChunksToMarkdown,
  extractImageData,
  OutputChunk,
} from "./output/MimeRenderer";
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";

type AnyKernel = BaseKernel | ShellKernel;

export interface RunButtonContext {
  app: App;
  getSettings: () => import("./settings/Settings").PluginSettings;
  getKernel: (lang: string) => AnyKernel;
}

/** Args parsed from the `{run key=value}` info-string annotation. */
export interface RunArgs {
  id?: string;
  output?: string;
  [key: string]: string | undefined;
}

function parseRunArgs(openingLine: string): RunArgs | null {
  const match = openingLine.match(/\{run([^}]*)\}/);
  if (!match) return null;
  const args: RunArgs = {};
  for (const m of match[1].matchAll(/(\w+)=(\S+)/g)) {
    args[m[1]] = m[2];
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
 * language is the canonical name (python, javascript, bash, r).
 */
export async function processCodeBlock(
  src: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  context: RunButtonContext,
  language: string
): Promise<void> {
  const { app } = context;

  const sectionInfo = ctx.getSectionInfo(el);
  let runArgs: RunArgs | null = null;

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

  // Plain block — render with syntax highlighting and exit
  if (!runArgs) {
    renderPlainCodeBlock(src, el, language);
    return;
  }

  const settings = context.getSettings();
  const kernel = context.getKernel(language);
  const pre = renderPlainCodeBlock(src, el, language);
  const hash = await hashCodeFence(language, src);

  // Run button + execution count badge
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

    const liveEl = el.createDiv({ cls: "nb-live-output" });
    const chunks: OutputChunk[] = [];

    try {
      await kernel.execute(
        src,
        (chunk) => {
          chunks.push(chunk);
          appendChunkToElement(liveEl, chunk);
        },
        settings.executionTimeout
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push({ type: "error", text: msg });
      appendChunkToElement(liveEl, { type: "error", text: msg });
      new Notice(`Notebook: ${msg}`);
    }

    if (sectionInfo) {
      const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (file instanceof TFile) {
        try {
          const { content, format } = await buildOutput(
            app, file, hash, chunks, runArgs!, settings.mediaPath, settings.markdownImageLinks
          );
          await writeOutputBlock(app, file, sectionInfo.lineEnd, hash, content, format, runArgs!.id);
        } catch (err) {
          console.error("[MarkdownNotebook] Failed to write output block:", err);
        }
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
  mediaPath: string,
  markdownImageLinks: boolean
): Promise<{ content: string; format: OutputFormat }> {
  if (runArgs.output === "markdown") {
    return { content: renderChunksToMarkdown(chunks), format: "markdown" };
  }
  if (runArgs.output === "image") {
    const imgData = extractImageData(chunks);
    if (imgData) {
      const { filename, vaultPath } = await saveImageToVault(
        app, file, runArgs.id, hash, imgData, mediaPath
      );
      return { content: imageLink(filename, vaultPath, file, markdownImageLinks), format: "image" };
    }
  }
  return { content: renderChunksToHtml(chunks), format: "html" };
}
