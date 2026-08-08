import { App, TFile } from "obsidian";

/** Document-level defaults from `notebook:` frontmatter key. */
export interface NotebookFrontmatter {
  format?: "html" | "image";
  media?: string;
  timeout?: number;
  readyTimeout?: number;
  outputLimit?: number;
  markdownLinks?: boolean;
  cwd?: string;
  python?: string;
  node?: string;
  shell?: string;
  r?: string;
  duckdb?: string;
}

export function readNotebookFrontmatter(app: App, file: TFile): NotebookFrontmatter {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter?.notebook;
  if (!fm || typeof fm !== "object") return {};
  return {
    format: fm.format === "html" || fm.format === "image" ? fm.format : undefined,
    media: typeof fm.media === "string" ? fm.media : undefined,
    timeout: typeof fm.timeout === "number" ? fm.timeout : undefined,
    readyTimeout: typeof fm.readyTimeout === "number" && fm.readyTimeout > 0
      ? fm.readyTimeout
      : undefined,
    outputLimit: typeof fm.outputLimit === "number" && fm.outputLimit > 0
      ? fm.outputLimit
      : undefined,
    markdownLinks: typeof fm.markdownLinks === "boolean" ? fm.markdownLinks : undefined,
    cwd: typeof fm.cwd === "string" ? fm.cwd : undefined,
    python: typeof fm.python === "string" ? fm.python : undefined,
    node: typeof fm.node === "string" ? fm.node : undefined,
    shell: typeof fm.shell === "string" ? fm.shell : undefined,
    r: typeof fm.r === "string" ? fm.r : undefined,
    duckdb: typeof fm.duckdb === "string" ? fm.duckdb : undefined,
  };
}
