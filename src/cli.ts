/**
 * nb-run — headless cell runner for Markdown Notebook files.
 *
 * Runs the same kernels and writes the same nb-output blocks as the Obsidian
 * plugin, without Obsidian. Built to cli.js by esbuild (npm run build).
 *
 *   node cli.js Note.md --list
 *   node cli.js Note.md --cell 3            # run cells 1..3 (shared kernel state)
 *   node cli.js Note.md --cell 3 --only     # run just cell 3 (fresh kernel)
 *   node cli.js Note.md --id revenue-chart
 *   node cli.js Note.md --write             # run all cells, update output blocks
 *
 * Differences from the plugin, by design:
 * - format=image only saves native images (matplotlib/R PNGs); the browser
 *   HTML-to-PNG fallback needs a DOM and degrades to format=html here.
 * - The media folder is resolved relative to the note's directory. A vault
 *   root is discovered or supplied only for cwd's vault-root special value.
 */
/* eslint-disable no-console -- stdout/stderr are the interface of a CLI */
import * as fs from "fs";
import * as path from "path";
import { webcrypto } from "crypto";
import { parseRunBlocks, RunBlock } from "./CellParser";
import { applyOutputBlock, OutputFormat, OutputStatus, ERROR_HTML, timeoutHtml } from "./OutputBlockCore";
import { KernelExecutionError, KernelTimeoutError } from "./kernels/BaseKernel";
import { hashCodeFence } from "./HashUtils";
import { renderChunksToHtml, renderFailureToHtml, extractImageData, OutputChunk } from "./output/MimeRenderer";
import { DEFAULT_OUTPUT_LIMIT_KB, OutputLimiter } from "./output/OutputLimiter";
import { SubprocessKernel } from "./kernels/SubprocessKernel";
import { NodeKernel } from "./kernels/NodeKernel";
import { ShellKernel } from "./kernels/ShellKernel";
import { RKernel } from "./kernels/RKernel";
import type { BaseKernel } from "./kernels/BaseKernel";
import { resolveExecutable } from "./NotebookKernelConfig";

// hashCodeFence uses the Web Crypto API; expose it on Node < 19
if (!globalThis.crypto) {
  (globalThis as { crypto?: unknown }).crypto = webcrypto;
}

type AnyKernel = BaseKernel | ShellKernel;

export interface CliOptions {
  file: string;
  list: boolean;
  cell?: number;
  id?: string;
  only: boolean;
  write: boolean;
  timeout?: number;
  outputLimit?: number;
  media?: string;
  vaultRoot?: string;
  paths: { python: string; node: string; shell: string; r: string };
  pathOverrides: Partial<CliOptions["paths"]>;
}

const USAGE = `Usage: nb-run <file.md> [options]

Options:
  --list             List the file's executable cells and exit
  --cell <n>         Target cell by 1-based index (default: last cell)
  --id <id>          Target cell by its id= arg
  --only             Run only the target cell (default: run every cell up to
                     and including it, so earlier cells' state is available)
  --write            Write nb-output blocks back into the file
                     (default: print output to stdout only)
  --timeout <ms>     Per-cell timeout (default: frontmatter notebook.timeout
                     or 30000)
  --output-limit <kb> Maximum rendered output stored per cell (default:
                     frontmatter notebook.outputLimit or 100)
  --media <dir>      Folder for format=image PNGs, relative to the note
                     (default: frontmatter notebook.media or next to the note)
  --vault-root <dir> Vault root for notebook.cwd: / or notebook.cwd: vault
                     (default: nearest parent containing .obsidian)
  --python <path>    Python executable (default: python3)
  --node <path>      Node executable (default: node)
  --shell <path>     Shell executable (default: bash)
  --r <path>         R executable (default: R)
  -h, --help         Show this help

Cell output streams to stdout/stderr as it runs; status lines go to stderr.
Exits 1 if any executed cell fails or times out.`;

export function parseArgs(argv: string[]): CliOptions | { error: string } | { help: true } {
  const opts: CliOptions = {
    file: "",
    list: false,
    only: false,
    write: false,
    paths: { python: "python3", node: "node", shell: "bash", r: "R" },
    pathOverrides: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | null => (i + 1 < argv.length ? argv[++i] : null);
    switch (a) {
      case "-h":
      case "--help":
        return { help: true };
      case "--list": opts.list = true; break;
      case "--only": opts.only = true; break;
      case "--write": opts.write = true; break;
      case "--cell": {
        const n = parseInt(next() ?? "", 10);
        if (isNaN(n)) return { error: "--cell requires a number" };
        opts.cell = n;
        break;
      }
      case "--id": {
        const v = next();
        if (v === null) return { error: "--id requires a value" };
        opts.id = v;
        break;
      }
      case "--timeout": {
        const n = parseInt(next() ?? "", 10);
        if (isNaN(n) || n <= 0) return { error: "--timeout requires a positive number" };
        opts.timeout = n;
        break;
      }
      case "--output-limit": {
        const n = parseInt(next() ?? "", 10);
        if (isNaN(n) || n <= 0) return { error: "--output-limit requires a positive number" };
        opts.outputLimit = n;
        break;
      }
      case "--media": {
        const v = next();
        if (v === null) return { error: "--media requires a value" };
        opts.media = v;
        break;
      }
      case "--vault-root": {
        const v = next();
        if (v === null) return { error: "--vault-root requires a value" };
        opts.vaultRoot = v;
        break;
      }
      case "--python": case "--node": case "--shell": case "--r": {
        const v = next();
        if (v === null) return { error: `${a} requires a value` };
        const key = a.slice(2) as keyof CliOptions["paths"];
        opts.paths[key] = v;
        opts.pathOverrides[key] = v;
        break;
      }
      default:
        if (a.startsWith("-")) return { error: `Unknown option: ${a}` };
        if (opts.file) return { error: `Unexpected argument: ${a}` };
        opts.file = a;
    }
  }
  if (!opts.file) return { error: "Missing <file.md> argument" };
  return opts;
}

export interface NotebookFm {
  format?: "html" | "image";
  media?: string;
  timeout?: number;
  outputLimit?: number;
  markdownLinks?: boolean;
  cwd?: string;
  python?: string;
  node?: string;
  shell?: string;
  r?: string;
}

/** Minimal parser for the `notebook:` frontmatter block (flat keys only). */
export function parseNotebookFrontmatter(content: string): NotebookFm {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end < 0) return {};

  const fm: NotebookFm = {};
  let inNotebook = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^notebook:\s*$/.test(line)) { inNotebook = true; continue; }
    if (!inNotebook) continue;
    if (!/^\s/.test(line)) { inNotebook = false; continue; }
    const m = line.match(/^\s+(\w+):\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^["']|["']$/g, "");
    if (key === "format" && (val === "html" || val === "image")) fm.format = val;
    else if (key === "media") fm.media = val;
    else if (key === "timeout" && !isNaN(Number(val))) fm.timeout = Number(val);
    else if (key === "outputLimit" && Number(val) > 0) fm.outputLimit = Number(val);
    else if (key === "markdownLinks") fm.markdownLinks = val === "true";
    else if (key === "cwd") fm.cwd = val;
    else if (key === "python" || key === "node" || key === "shell" || key === "r") fm[key] = val;
  }
  return fm;
}

/** Resolve which cell indices to execute (run-up-to semantics by default). */
export function selectCells(
  blocks: Array<{ id?: string }>,
  opts: { cell?: number; id?: string; only: boolean }
): number[] | { error: string } {
  let target = blocks.length - 1;
  if (opts.id !== undefined) {
    target = blocks.findIndex((b) => b.id === opts.id);
    if (target < 0) return { error: `No cell with id "${opts.id}"` };
  } else if (opts.cell !== undefined) {
    if (opts.cell < 1 || opts.cell > blocks.length) {
      return { error: `Cell ${opts.cell} out of range (file has ${blocks.length} cell${blocks.length === 1 ? "" : "s"})` };
    }
    target = opts.cell - 1;
  }
  return opts.only ? [target] : Array.from({ length: target + 1 }, (_, i) => i);
}

export function findVaultRoot(
  startDirectory: string,
  hasObsidianDirectory: (directory: string) => boolean = (directory) =>
    fs.existsSync(path.join(directory, ".obsidian")),
): string | null {
  let current = path.resolve(startDirectory);
  while (true) {
    if (hasObsidianDirectory(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveCliWorkingDirectory(
  noteDirectory: string,
  override?: string,
  explicitVaultRoot?: string,
  discoverVaultRoot: (directory: string) => string | null = findVaultRoot,
): string {
  if (!override?.trim()) return noteDirectory;
  const value = override.trim();
  if (value === "/" || value.toLowerCase() === "vault") {
    const vaultRoot = explicitVaultRoot
      ? path.resolve(explicitVaultRoot)
      : discoverVaultRoot(noteDirectory);
    if (!vaultRoot) {
      throw new Error(
        `notebook.cwd is "${value}", but no parent .obsidian directory was found; ` +
        `pass --vault-root <dir>`
      );
    }
    return vaultRoot;
  }
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(noteDirectory, value);
}

function createKernel(lang: string, paths: CliOptions["paths"], cwd: string): AnyKernel {
  switch (lang) {
    case "python":     return new SubprocessKernel(paths.python, cwd);
    case "javascript": return new NodeKernel(paths.node, cwd);
    case "r":          return new RKernel(paths.r, cwd);
    default:           return new ShellKernel(paths.shell, cwd);
  }
}

export function printChunk(chunk: OutputChunk, willWrite: boolean): void {
  switch (chunk.type) {
    case "stream":
      process.stdout.write(chunk.text);
      break;
    case "error":
      process.stderr.write(chunk.text);
      break;
    case "rich": {
      const size = chunk.mime === "image/png"
        ? `${Math.round(chunk.data.length * 0.75 / 1024)} KB`
        : `${chunk.data.length} chars`;
      const hint = willWrite ? "" : " — use --write to store";
      process.stderr.write(`[${chunk.mime} output, ${size}${hint}]\n`);
      break;
    }
    case "truncated":
      process.stderr.write(`[Output truncated after ${chunk.limitBytes / 1024} KB]\n`);
      break;
  }
}

function buildCellOutput(
  filePath: string,
  block: RunBlock,
  hash: string,
  chunks: OutputChunk[],
  nativeImageData: string | null,
  opts: CliOptions,
  fm: NotebookFm
): { content: string; format: OutputFormat } {
  const format = block.format ?? fm.format ?? "html";
  if (format === "image") {
    // Native image data only — the plugin's HTML-to-PNG fallback needs a DOM
    const img = nativeImageData ?? extractImageData(chunks);
    if (img) {
      const noteDir = path.dirname(filePath);
      const mediaRel = (opts.media ?? fm.media ?? "").trim().replace(/\/+$/, "");
      const dirAbs = mediaRel ? path.join(noteDir, mediaRel) : noteDir;
      fs.mkdirSync(dirAbs, { recursive: true });
      const filename = block.id ? `${block.id}.png` : `${hash}.png`;
      fs.writeFileSync(path.join(dirAbs, filename), Buffer.from(img, "base64"));
      const link = fm.markdownLinks
        ? `![](${mediaRel ? `${mediaRel}/` : ""}${filename})`
        : `![[${filename}]]`;
      return { content: link, format: "image" };
    }
  }
  return { content: renderChunksToHtml(chunks), format: "html" };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log(USAGE);
    return;
  }
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const opts = parsed;

  const filePath = path.resolve(opts.file);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    console.error(`Error: cannot read ${filePath}`);
    process.exitCode = 2;
    return;
  }

  const blocks = parseRunBlocks(content);
  if (opts.list) {
    if (blocks.length === 0) {
      console.log("No executable cells.");
      return;
    }
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const firstLine = (b.source.split("\n")[0] ?? "").slice(0, 60);
      console.log(
        `${String(i + 1).padStart(3)}  ${b.language.padEnd(10)}  ${(b.id ?? "-").padEnd(14)}  ${firstLine}`
      );
    }
    return;
  }
  if (blocks.length === 0) {
    console.error("No executable cells found.");
    process.exitCode = 1;
    return;
  }

  const selection = selectCells(blocks, opts);
  if (!Array.isArray(selection)) {
    console.error(`Error: ${selection.error}`);
    process.exitCode = 2;
    return;
  }

  const fm = parseNotebookFrontmatter(content);
  const timeout = opts.timeout ?? fm.timeout ?? 30000;
  const outputLimit = opts.outputLimit ?? fm.outputLimit ?? DEFAULT_OUTPUT_LIMIT_KB;
  const noteDirectory = path.dirname(filePath);
  let cwd: string;
  try {
    cwd = resolveCliWorkingDirectory(noteDirectory, fm.cwd, opts.vaultRoot);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  const cliExecutable = (key: keyof CliOptions["paths"], fallback: string): string => {
    const explicit = opts.pathOverrides[key];
    if (explicit !== undefined) return resolveExecutable(explicit, process.cwd());
    const noteOverride = fm[key];
    return resolveExecutable(noteOverride ?? fallback, noteOverride !== undefined ? noteDirectory : process.cwd());
  };
  const paths = {
    python: cliExecutable("python", opts.paths.python),
    node: cliExecutable("node", opts.paths.node),
    shell: cliExecutable("shell", opts.paths.shell),
    r: cliExecutable("r", opts.paths.r),
  };

  const kernels = new Map<string, AnyKernel>();
  const getKernel = (lang: string): AnyKernel => {
    let k = kernels.get(lang);
    if (!k) {
      k = createKernel(lang, paths, cwd);
      kernels.set(lang, k);
    }
    return k;
  };

  let failed = false;
  const results: Array<{
    block: RunBlock;
    chunks: OutputChunk[];
    nativeImageData: string | null;
    failure: OutputStatus | null;
  }> = [];
  for (const index of selection) {
    const block = blocks[index];
    process.stderr.write(
      `── cell ${index + 1}/${blocks.length} [${block.language}]${block.id ? ` id=${block.id}` : ""}\n`
    );
    const format = block.format ?? fm.format ?? "html";
    const output = new OutputLimiter(outputLimit, format === "image");
    const chunks = output.chunks;
    let failure: OutputStatus | null = null;
    try {
      await getKernel(block.language).execute(
        block.source,
        (chunk) => {
          const accepted = output.add(chunk);
          printChunk(chunk, opts.write);
          if (opts.write) {
            for (const item of accepted) {
              if (item.type === "truncated") printChunk(item, true);
            }
          }
        },
        timeout
      );
    } catch (err) {
      failed = true;
      failure = err instanceof KernelTimeoutError ? "timeout" : "error";
      const msg = err instanceof Error ? err.message : String(err);
      if (!(err instanceof KernelExecutionError) && !(err instanceof KernelTimeoutError)) {
        const chunk = { type: "error" as const, text: msg };
        const accepted = output.add(chunk);
        printChunk(chunk, opts.write);
        if (opts.write) {
          for (const item of accepted) {
            if (item.type === "truncated") printChunk(item, true);
          }
        }
      }
    }
    results.push({ block, chunks, nativeImageData: output.nativeImageData, failure });
  }
  for (const k of kernels.values()) k.stop();

  if (opts.write) {
    let updated = content;
    for (const { block, chunks, nativeImageData, failure } of results) {
      const hash = await hashCodeFence(block.language, block.source);
      // Failed cells get the same status blocks the plugin writes
      const { content: outContent, format, status } = failure
        ? {
            content: renderFailureToHtml(
              failure === "timeout" ? timeoutHtml(timeout) : ERROR_HTML,
              chunks,
            ),
            format: "html" as OutputFormat,
            status: failure,
          }
        : {
            ...buildCellOutput(
              filePath, block, hash, chunks, nativeImageData, opts, fm,
            ),
            status: undefined,
          };
      updated = applyOutputBlock(
        updated,
        { language: block.language, source: block.source, hintLine: block.lineEnd },
        hash, outContent, format, block.id, status
      );
    }
    fs.writeFileSync(filePath, updated, "utf8");
    process.stderr.write(`Wrote ${results.length} output block(s) to ${path.basename(filePath)}\n`);
  }

  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
