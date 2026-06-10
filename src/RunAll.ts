import { App, Notice, TFile } from "obsidian";
import { hashCodeFence } from "./HashUtils";
import { parseRunBlocks, RunBlock } from "./CellParser";
import { writeOutputBlock, saveImageToVault, imageLink, OutputFormat } from "./OutputBlock";

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

export async function runAll(
  app: App,
  file: TFile,
  getKernel: (lang: string) => AnyKernel,
  settings: PluginSettings
): Promise<void> {
  const content = await app.vault.read(file);
  const blocks = parseRunBlocks(content);
  const fm = readNotebookFrontmatter(app, file);

  if (blocks.length === 0) {
    new Notice("No executable cells found.");
    return;
  }

  const notice = new Notice(`Running cell 1 / ${blocks.length}…`, 0);
  const results: Array<RunBlock & { hash: string; content: string; format: OutputFormat }> = [];

  for (let i = 0; i < blocks.length; i++) {
    notice.setMessage(`Running cell ${i + 1} / ${blocks.length}…`);
    const block = blocks[i];
    const hash = await hashCodeFence(block.language, block.source);
    const chunks: OutputChunk[] = [];
    const timeout = fm.timeout ?? settings.executionTimeout;

    try {
      await getKernel(block.language).execute(
        block.source,
        (chunk) => chunks.push(chunk),
        timeout
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push({ type: "error", text: msg });
    }

    const { content: outContent, format } = await resolveOutput(
      app, file, hash, chunks, block.id, block.format, settings, fm
    );
    results.push({ ...block, hash, content: outContent, format });
  }

  // Writes re-anchor each cell by content; lineEnd is only the duplicate
  // tie-breaker hint. Reverse order keeps the hints closest to accurate.
  for (const result of [...results].reverse()) {
    await writeOutputBlock(
      app, file,
      { language: result.language, source: result.source, hintLine: result.lineEnd },
      result.hash, result.content, result.format, result.id
    );
  }

  notice.hide();
  new Notice(`Ran ${blocks.length} cell${blocks.length !== 1 ? "s" : ""}.`);
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
