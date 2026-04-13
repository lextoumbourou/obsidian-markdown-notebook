import { App, Notice, TFile } from "obsidian";
import { hashCodeFence } from "./HashUtils";
import { writeOutputBlock, saveImageToVault, imageLink, OutputFormat } from "./OutputBlock";
import {
  renderChunksToHtml,
  extractImageData,
  OutputChunk,
} from "./output/MimeRenderer";
import { renderHtmlToPng } from "./output/HtmlToImage";
import type { BaseKernel } from "./kernels/BaseKernel";
import type { ShellKernel } from "./kernels/ShellKernel";
import type { PluginSettings } from "./settings/Settings";
import { canonicalLang } from "./languages";
import { readNotebookFrontmatter, NotebookFrontmatter } from "./NotebookFrontmatter";

type AnyKernel = BaseKernel | ShellKernel;

interface RunBlock {
  language: string;
  source: string;
  id: string | undefined;
  format: string | undefined;
  lineEnd: number;
}

/**
 * Parse all executable code blocks from raw file content.
 * All fences for supported languages are included — no {run} marker needed.
 */
export function parseRunBlocks(content: string): RunBlock[] {
  const lines = content.split("\n");
  const blocks: RunBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```(\w+)(?:\s*\{([^}]*)\})?/);
    if (fenceMatch) {
      const lang = canonicalLang(fenceMatch[1]);
      if (lang) {
        const args = fenceMatch[2] ?? "";
        const id = args.match(/id=(\S+)/)?.[1];
        const format = args.match(/format=(\S+)/)?.[1];
        const sourceLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) {
          sourceLines.push(lines[i]);
          i++;
        }
        blocks.push({ language: lang, source: sourceLines.join("\n"), id, format, lineEnd: i });
      }
    }
    i++;
  }

  return blocks;
}

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

  // Write outputs in reverse order so earlier blocks' line numbers stay valid
  for (const result of [...results].reverse()) {
    await writeOutputBlock(
      app, file, result.lineEnd, result.hash, result.content, result.format, result.id
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
