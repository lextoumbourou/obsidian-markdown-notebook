import { App, Notice, TFile } from "obsidian";
import { hashCodeFence } from "./HashUtils";
import { writeOutputBlock, saveImageToVault, imageLink, OutputFormat } from "./OutputBlock";
import {
  renderChunksToHtml,
  renderChunksToMarkdown,
  extractImageData,
  OutputChunk,
} from "./output/MimeRenderer";
import type { SubprocessKernel } from "./kernels/SubprocessKernel";
import type { PluginSettings } from "./settings/Settings";

interface RunBlock {
  source: string;
  id: string | undefined;
  output: string | undefined; // value of the `output` run arg, if any
  lineEnd: number; // line index of the closing ```
}

/**
 * Parse all `python {run}` blocks from raw file content, in document order.
 */
function parseRunBlocks(content: string): RunBlock[] {
  const lines = content.split("\n");
  const blocks: RunBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const fenceMatch = lines[i].match(/^```python\s*\{run([^}]*)\}/);
    if (fenceMatch) {
      const args = fenceMatch[1];
      const idMatch = args.match(/id=(\S+)/);
      const outputMatch = args.match(/output=(\S+)/);
      const id = idMatch ? idMatch[1] : undefined;
      const output = outputMatch ? outputMatch[1] : undefined;
      const sourceLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        sourceLines.push(lines[i]);
        i++;
      }
      // i is now on the closing ```
      blocks.push({ source: sourceLines.join("\n"), id, output, lineEnd: i });
    }
    i++;
  }

  return blocks;
}

/**
 * Execute every `python {run}` block in the active file, top to bottom.
 * Outputs are written to the file in reverse order so earlier line numbers
 * remain valid while writing later blocks first.
 */
export async function runAll(
  app: App,
  file: TFile,
  kernel: SubprocessKernel,
  settings: PluginSettings
): Promise<void> {
  const content = await app.vault.read(file);
  const blocks = parseRunBlocks(content);

  if (blocks.length === 0) {
    new Notice("No executable cells found.");
    return;
  }

  const notice = new Notice(`Running cell 1 / ${blocks.length}…`, 0);

  const results: Array<RunBlock & { hash: string; content: string; format: OutputFormat }> = [];

  for (let i = 0; i < blocks.length; i++) {
    notice.setMessage(`Running cell ${i + 1} / ${blocks.length}…`);
    const block = blocks[i];
    const hash = await hashCodeFence("python", block.source);
    const chunks: OutputChunk[] = [];

    try {
      await kernel.execute(
        block.source,
        (chunk) => chunks.push(chunk),
        settings.executionTimeout
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push({ type: "error", text: msg });
    }

    const { content, format } = await resolveOutput(app, file, hash, chunks, block.id, block.output, settings.mediaPath, settings.markdownImageLinks);
    results.push({ ...block, hash, content, format });
  }

  // Write outputs in reverse order so earlier blocks' line numbers stay valid
  for (const result of [...results].reverse()) {
    await writeOutputBlock(app, file, result.lineEnd, result.hash, result.content, result.format, result.id);
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
  outputArg: string | undefined,
  mediaPath: string,
  markdownImageLinks: boolean
): Promise<{ content: string; format: OutputFormat }> {
  if (outputArg === "markdown") {
    return { content: renderChunksToMarkdown(chunks), format: "markdown" };
  }
  if (outputArg === "image") {
    const imgData = extractImageData(chunks);
    if (imgData) {
      const { filename, vaultPath } = await saveImageToVault(app, file, id, hash, imgData, mediaPath);
      return { content: imageLink(filename, vaultPath, file, markdownImageLinks), format: "image" };
    }
  }
  return { content: renderChunksToHtml(chunks), format: "html" };
}
