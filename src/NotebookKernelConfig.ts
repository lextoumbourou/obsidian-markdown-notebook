import type { App, TFile } from "obsidian";
import * as path from "path";
import type { NotebookFrontmatter } from "./NotebookFrontmatter";
import type { PluginSettings } from "./settings/Settings";

export interface NotebookKernelConfig {
  notePath: string;
  language: string;
  executable: string;
  cwd: string;
}

type ExecutableKey = "python" | "node" | "shell" | "r";

const EXECUTABLE_KEYS: Record<string, ExecutableKey> = {
  python: "python",
  javascript: "node",
  bash: "shell",
  r: "r",
};

const SETTING_KEYS: Record<ExecutableKey, keyof PluginSettings> = {
  python: "pythonPath",
  node: "nodePath",
  shell: "shellPath",
  r: "rPath",
};

function looksLikePath(value: string): boolean {
  return path.isAbsolute(value)
    || value.startsWith(".")
    || value.includes("/")
    || value.includes("\\");
}

export function resolveExecutable(value: string, noteDirectory: string): string {
  return looksLikePath(value) && !path.isAbsolute(value)
    ? path.resolve(noteDirectory, value)
    : value;
}

export function resolveWorkingDirectory(
  vaultRoot: string,
  noteFolder: string,
  override?: string,
): string {
  const noteDirectory = path.resolve(vaultRoot, noteFolder || ".");
  if (!override) return noteDirectory;
  const trimmed = override.trim();
  if (!trimmed) return noteDirectory;
  if (trimmed === "/" || trimmed.toLowerCase() === "vault") return vaultRoot;
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(noteDirectory, trimmed);
}

export function notebookKernelSessionKey(config: NotebookKernelConfig): string {
  return JSON.stringify([
    config.notePath,
    config.language,
    config.executable,
    config.cwd,
  ]);
}

export function resolveNotebookKernelConfig(
  app: App,
  file: TFile,
  language: string,
  settings: PluginSettings,
  frontmatter: NotebookFrontmatter,
): NotebookKernelConfig {
  const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
  if (typeof adapter.getBasePath !== "function") {
    throw new Error("Markdown Notebook requires a local filesystem vault");
  }
  const vaultRoot = path.resolve(adapter.getBasePath());
  const noteFolder = file.parent?.path ?? path.dirname(file.path);
  const relativeNoteFolder = noteFolder === "/" || noteFolder === "." ? "" : noteFolder;
  const noteDirectory = path.resolve(vaultRoot, relativeNoteFolder || ".");
  const cwd = resolveWorkingDirectory(vaultRoot, relativeNoteFolder, frontmatter.cwd);
  const executableKey = EXECUTABLE_KEYS[language] ?? "shell";
  const frontmatterExecutable = frontmatter[executableKey];
  const configured = frontmatterExecutable ?? settings[SETTING_KEYS[executableKey]];
  const executableBase = frontmatterExecutable !== undefined ? noteDirectory : vaultRoot;

  return {
    notePath: file.path,
    language,
    executable: resolveExecutable(configured as string, executableBase),
    cwd,
  };
}
