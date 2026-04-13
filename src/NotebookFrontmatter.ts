import { App, TFile } from "obsidian";

/** Document-level defaults from `notebook:` frontmatter key. */
export interface NotebookFrontmatter {
  format?: string;
  media?: string;
  timeout?: number;
  markdownLinks?: boolean;
}

export function readNotebookFrontmatter(app: App, file: TFile): NotebookFrontmatter {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter?.notebook;
  if (!fm || typeof fm !== "object") return {};
  return {
    format: typeof fm.format === "string" ? fm.format : undefined,
    media: typeof fm.media === "string" ? fm.media : undefined,
    timeout: typeof fm.timeout === "number" ? fm.timeout : undefined,
    markdownLinks: typeof fm.markdownLinks === "boolean" ? fm.markdownLinks : undefined,
  };
}
