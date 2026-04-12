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
import type { SubprocessKernel } from "./kernels/SubprocessKernel";

export interface RunButtonContext {
  app: App;
  getSettings: () => import("./settings/Settings").PluginSettings;
  getKernel: () => SubprocessKernel;
}

/** Args parsed from the `{run key=value}` info-string annotation. */
export interface RunArgs {
  output?: string;  // e.g. "image"
  [key: string]: string | undefined;
}

/**
 * Parse run args from the opening fence line, e.g. "python {run output=image}".
 * Returns null if `{run}` is not present.
 */
function parseRunArgs(openingLine: string): RunArgs | null {
  const match = openingLine.match(/\{run([^}]*)\}/);
  if (!match) return null;
  const args: RunArgs = {};
  for (const m of match[1].matchAll(/(\w+)=(\S+)/g)) {
    args[m[1]] = m[2];
  }
  return args;
}

/**
 * Render a plain Python block using Prism.js (bundled with Obsidian).
 * Used for non-run blocks and as the base for run blocks.
 */
function renderPlainCodeBlock(src: string, el: HTMLElement): HTMLPreElement {
  const pre = el.createEl("pre");
  const code = pre.createEl("code", { cls: "language-python" });
  code.textContent = src;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).Prism?.highlightElement(code);
  return pre;
}

/**
 * Registered via plugin.registerMarkdownCodeBlockProcessor('python', ...).
 *
 * - Blocks with `{run}` in the info string: render with run button + handle execution
 * - Plain `python` blocks: render as normal syntax-highlighted code (fall-through)
 */
export async function processCodeBlock(
  src: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  context: RunButtonContext
): Promise<void> {
  const { app } = context;

  // Check if this is a run block by finding the opening fence line.
  // We search from lineStart→lineEnd rather than assuming lineStart IS the fence,
  // because Obsidian sometimes groups a preceding HTML block (nb-output) with the
  // code block into one section, making lineStart point at the HTML line.
  const sectionInfo = ctx.getSectionInfo(el);
  let runArgs: RunArgs | null = null;

  if (sectionInfo) {
    const lines = sectionInfo.text.split("\n");
    for (let i = sectionInfo.lineStart; i <= sectionInfo.lineEnd; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("```python")) {
        runArgs = parseRunArgs(line);
        break;
      }
    }
  }

  // Plain python block — render normally and exit
  if (!runArgs) {
    renderPlainCodeBlock(src, el);
    return;
  }

  const settings = context.getSettings();
  const kernel = context.getKernel();
  const pre = renderPlainCodeBlock(src, el);
  const hash = await hashCodeFence("python", src);

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

    // Write final output atomically to the file
    if (sectionInfo) {
      const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (file instanceof TFile) {
        try {
          const { content, format } = await buildOutput(app, file, hash, chunks, runArgs, settings.mediaPath, settings.markdownImageLinks);
          await writeOutputBlock(app, file, sectionInfo.lineEnd, hash, content, format, runArgs.id);
        } catch (err) {
          console.error("[MarkdownNotebook] Failed to write output block:", err);
        }
      }
    }

    liveEl.remove();
    button.classList.remove("nb-run-button--running", "nb-run-button--stale");
    button.setText("▶ Run");
    countBadge.textContent = `[${context.getKernel().executionCount}]`;
  });
}

/**
 * Convert execution chunks to the storable content string + format,
 * based on the `output` run arg. Falls back to html if the requested
 * format can't be satisfied (e.g. no image was generated).
 */
async function buildOutput(
  app: App,
  file: TFile,
  hash: string,
  chunks: OutputChunk[],
  runArgs: RunArgs,
  mediaPath: string,
  markdownImageLinks: boolean
): Promise<{ content: string; format: OutputFormat }> {
  const req = runArgs.output;

  if (req === "markdown") {
    return { content: renderChunksToMarkdown(chunks), format: "markdown" };
  }

  if (req === "image") {
    const imgData = extractImageData(chunks);
    if (imgData) {
      const { filename, vaultPath } = await saveImageToVault(app, file, runArgs.id, hash, imgData, mediaPath);
      return { content: imageLink(filename, vaultPath, file, markdownImageLinks), format: "image" };
    }
    // No image produced — fall through to HTML
  }

  return { content: renderChunksToHtml(chunks), format: "html" };
}
