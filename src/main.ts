import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings/Settings";
import { SettingsTab } from "./settings/SettingsTab";
import { SubprocessKernel } from "./kernels/SubprocessKernel";
import { NodeKernel } from "./kernels/NodeKernel";
import { ShellKernel } from "./kernels/ShellKernel";
import { RKernel } from "./kernels/RKernel";
import { DuckDBKernel } from "./kernels/DuckDBKernel";
import { BaseKernel } from "./kernels/BaseKernel";
import {
  processCodeBlock,
  runOrStopCell,
  RunButtonContext,
  hasActiveCellRun,
  isCellInFlight,
  updateBackgroundButtons,
} from "./RunButton";
import { activateRunAll, disposeRunAll, isRunAllActive, runAll } from "./RunAll";
import { clearAllOutputBlocks, clearOutputBlock, clearStaleRunningBlocks } from "./OutputBlock";
import { findRunBlockAtLine, type RunBlock } from "./CellParser";
import { SUPPORTED_LANGUAGES, LANG_ALIASES } from "./languages";
import { readNotebookFrontmatter } from "./NotebookFrontmatter";
import {
  notebookKernelSessionKey,
  resolveNotebookKernelConfig,
  NotebookKernelConfig,
} from "./NotebookKernelConfig";
import {
  activateRunAllToolbar,
  disposeRunAllToolbar,
  renderRunAllToolbar,
  runAllToolbarHooks,
  setRunAllToolbarVisible,
} from "./RunAllToolbar";
import {
  BackgroundCellRequest,
  BackgroundExecutionContext,
  BackgroundProcessManager,
} from "./BackgroundProcessManager";
import type { OutputChunk } from "./output/MimeRenderer";

type AnyKernel = BaseKernel | ShellKernel | DuckDBKernel;

interface KernelSession {
  config: NotebookKernelConfig;
  kernel: AnyKernel;
}

export default class MarkdownNotebookPlugin extends Plugin {
  settings: PluginSettings;
  private kernels: Map<string, KernelSession> = new Map();
  private runButtonContext?: RunButtonContext;
  private backgrounds = new BackgroundProcessManager((sourcePath, name, running) => {
    updateBackgroundButtons(sourcePath, name, running ? "running" : "idle");
  });

  async onload() {
    activateRunAll();
    activateRunAllToolbar();
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    const background: BackgroundExecutionContext = {
      start: (request, onChunk, signal) =>
        this.startBackground(request, onChunk, signal),
      stop: (sourcePath, name) => this.backgrounds.stop(sourcePath, name),
      isRunning: (sourcePath, name) => this.backgrounds.isRunning(sourcePath, name),
    };
    const context: RunButtonContext = {
      app: this.app,
      getSettings: () => this.settings,
      acquireKernel: (lang: string, sourcePath: string) => this.acquireKernel(lang, sourcePath),
      peekExecutionCount: (lang: string, sourcePath: string) =>
        this.peekExecutionCount(lang, sourcePath),
      background,
    };
    this.runButtonContext = context;
    void setRunAllToolbarVisible(this.settings.showRunAllToolbar, context);

    // Register a processor for each language + its common aliases
    const registered = new Set<string>();
    const conflicts: string[] = [];
    for (const lang of [...SUPPORTED_LANGUAGES, ...Object.keys(LANG_ALIASES)]) {
      if (registered.has(lang)) continue;
      registered.add(lang);
      const canonical = LANG_ALIASES[lang] ?? lang;
      try {
        this.registerMarkdownCodeBlockProcessor(lang, (src, el, ctx) =>
          processCodeBlock(src, el, ctx, context, canonical)
        );
      } catch {
        conflicts.push(lang);
      }
    }
    if (conflicts.length > 0) {
      new Notice(
        `Markdown Notebook: another plugin has already claimed the ` +
        `"${conflicts.join('", "')}" code block processor(s). ` +
        `Please disable any other code-execution plugins (e.g. Execute Code, Code Emitter) ` +
        `and reload Obsidian.`,
        0  // persist until dismissed
      );
    }

    this.registerMarkdownPostProcessor((el, ctx) => {
      void renderRunAllToolbar(el, ctx, context);
    });

    // A `status="running"` spinner block survives in the file if Obsidian
    // quit (or the plugin reloaded) mid-execution — repair it on file open.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          clearStaleRunningBlocks(this.app, file, (hash) =>
            isCellInFlight(file.path, hash)
          ).catch((err) =>
            console.error("[MarkdownNotebook] Stale block cleanup failed:", err)
          );
        }
        this.reapClosedNotebookSessions();
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (_file, oldPath) => {
        this.stopSessionsForNote(oldPath);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) this.stopSessionsForNote(file.path);
      })
    );

    // Persistent sessions live only while at least one Markdown leaf has the
    // note open. This bounds subprocess growth without discarding state merely
    // because focus moved to another still-open tab or split.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.reapClosedNotebookSessions())
    );

    this.addCommand({
      id: "restart-kernel",
      name: "Restart all kernels",
      callback: () => this.restartKernel(),
    });

    this.addCommand({
      id: "interrupt-kernel",
      name: "Interrupt kernel",
      callback: () => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!(file instanceof TFile)) {
          new Notice("No active Markdown file.");
          return;
        }
        for (const session of this.kernels.values()) {
          if (session.config.notePath === file.path) session.kernel.interrupt();
        }
        new Notice("Notebook kernels interrupted");
      },
    });

    this.addCommand({
      id: "run-all-cells",
      name: "Run all cells",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file;
        if (!(file instanceof TFile)) {
          new Notice("No active Markdown file.");
          return;
        }
        void runAll(
          this.app,
          file,
          (lang) => this.acquireKernel(lang, file.path),
          this.settings,
          runAllToolbarHooks(file.path),
          undefined,
          background,
        );
      },
    });

    this.addCommand({
      id: "run-cell-under-cursor",
      name: "Run cell under cursor",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!(file instanceof TFile)) return false;
        const block = findRunBlockAtLine(editor.getValue(), editor.getCursor().line);
        if (!block) return false;
        if (!checking) void this.runEditorCell(file, block, context);
        return true;
      },
    });

    this.addCommand({
      id: "run-all-cells-above-cursor",
      name: "Run all cells above cursor",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!(file instanceof TFile)) return false;
        const block = findRunBlockAtLine(editor.getValue(), editor.getCursor().line);
        if (!block) return false;
        if (!checking) this.runRelativeCells(file, block, "above");
        return true;
      },
    });

    this.addCommand({
      id: "run-cell-and-all-below-cursor",
      name: "Run cell and all cells below cursor",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!(file instanceof TFile)) return false;
        const block = findRunBlockAtLine(editor.getValue(), editor.getCursor().line);
        if (!block) return false;
        if (!checking) this.runRelativeCells(file, block, "below");
        return true;
      },
    });

    this.addCommand({
      id: "clear-cell-output",
      name: "Clear current cell output",
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!(file instanceof TFile)) return false;
        const block = findRunBlockAtLine(editor.getValue(), editor.getCursor().line);
        if (!block) return false;
        if (!checking) void this.clearCellOutput(file, block);
        return true;
      },
    });

    this.addCommand({
      id: "clear-all-outputs",
      name: "Clear all outputs in active note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!(file instanceof TFile)) return false;
        if (!checking) void this.clearAllOutputs(file);
        return true;
      },
    });
  }

  onunload() {
    disposeRunAll();
    disposeRunAllToolbar();
    for (const session of this.kernels.values()) session.kernel.stop();
    this.kernels.clear();
    void this.backgrounds.stopAll();
  }

  peekExecutionCount(lang: string, sourcePath: string): number {
    const canonical = LANG_ALIASES[lang] ?? lang;
    for (const session of this.kernels.values()) {
      if (
        session.config.notePath === sourcePath
        && session.config.language === canonical
      ) return session.kernel.executionCount;
    }
    return 0;
  }

  acquireKernel(lang: string, sourcePath: string): AnyKernel {
    const canonical = LANG_ALIASES[lang] ?? lang;
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
      throw new Error(`Cannot create a kernel: ${sourcePath} is not a Markdown file`);
    }
    const config = resolveNotebookKernelConfig(
      this.app,
      file,
      canonical,
      this.settings,
      readNotebookFrontmatter(this.app, file),
    );
    const key = notebookKernelSessionKey(config);
    let session = this.kernels.get(key);
    if (!session) {
      // A frontmatter or settings change replaces the old session instead of
      // leaving an unreachable subprocess alive until plugin unload.
      for (const [existingKey, existing] of this.kernels) {
        if (
          existing.config.notePath === config.notePath
          && existing.config.language === config.language
        ) {
          existing.kernel.stop();
          this.kernels.delete(existingKey);
        }
      }
      session = { config, kernel: this.createKernel(config) };
      this.kernels.set(key, session);
    }
    return session.kernel;
  }

  private stopSessionsForNote(notePath: string): void {
    for (const [sessionKey, session] of this.kernels) {
      if (session.config.notePath !== notePath) continue;
      session.kernel.stop();
      this.kernels.delete(sessionKey);
    }
    void this.backgrounds.stopForNote(notePath);
  }

  private reapClosedNotebookSessions(): void {
    const openPaths = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as unknown as { file?: TFile | null };
      if (view.file instanceof TFile) openPaths.add(view.file.path);
    }
    for (const session of this.kernels.values()) {
      if (!openPaths.has(session.config.notePath)) {
        this.stopSessionsForNote(session.config.notePath);
      }
    }
    for (const sourcePath of this.backgrounds.sourcePaths()) {
      if (!openPaths.has(sourcePath)) void this.backgrounds.stopForNote(sourcePath);
    }
  }

  private canClearOutputs(file: TFile): boolean {
    if (hasActiveCellRun(file.path) || isRunAllActive(file.path)) {
      new Notice("Notebook: stop execution before clearing outputs.");
      return false;
    }
    return true;
  }

  private async runEditorCell(
    file: TFile,
    block: RunBlock,
    context: RunButtonContext,
  ): Promise<void> {
    if (isRunAllActive(file.path)) {
      new Notice("Notebook: this file is already running.");
      return;
    }
    try {
      await runOrStopCell(file.path, file, block, context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MarkdownNotebook] Failed to run editor cell:", err);
      new Notice(`Notebook: cell could not be run: ${msg}`);
    }
  }

  private runRelativeCells(
    file: TFile,
    block: RunBlock,
    mode: "above" | "below",
  ): void {
    void runAll(
      this.app,
      file,
      (lang) => this.acquireKernel(lang, file.path),
      this.settings,
      runAllToolbarHooks(file.path, true),
      { mode, target: block },
      this.runButtonContext?.background,
    );
  }

  private async clearCellOutput(file: TFile, block: RunBlock): Promise<void> {
    if (!this.canClearOutputs(file)) return;
    try {
      const removed = await clearOutputBlock(this.app, file, {
        language: block.language,
        source: block.source,
        hintLine: block.lineEnd,
      });
      new Notice(removed ? "Cell output cleared." : "This cell has no output.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MarkdownNotebook] Failed to clear cell output:", err);
      new Notice(`Notebook: output could not be cleared: ${msg}`);
    }
  }

  private async clearAllOutputs(file: TFile): Promise<void> {
    if (!this.canClearOutputs(file)) return;
    try {
      const removed = await clearAllOutputBlocks(this.app, file);
      new Notice(removed ? "All outputs cleared." : "This note has no outputs.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[MarkdownNotebook] Failed to clear note outputs:", err);
      new Notice(`Notebook: outputs could not be cleared: ${msg}`);
    }
  }

  private createKernel(config: NotebookKernelConfig): AnyKernel {
    switch (config.language) {
      case "python":     return new SubprocessKernel(config.executable, config.cwd);
      case "javascript": return new NodeKernel(config.executable, config.cwd);
      case "bash":       return new ShellKernel(config.executable, config.cwd);
      case "r":          return new RKernel(config.executable, config.cwd);
      case "sql":        return new DuckDBKernel(config.executable, config.cwd);
      default:            return new ShellKernel(config.executable, config.cwd);
    }
  }

  /** Restart one kernel (by settings key) or all kernels. */
  restartKernel(
    key?: "pythonPath" | "nodePath" | "shellPath" | "rPath" | "duckdbPath",
  ): void {
    const langForKey: Record<string, string> = {
      pythonPath: "python", nodePath: "javascript",
      shellPath: "bash",    rPath: "r",
      duckdbPath: "sql",
    };

    const targetLanguage = key ? langForKey[key] : undefined;
    if (targetLanguage) {
      void this.backgrounds.stopLanguage(targetLanguage);
    } else {
      void this.backgrounds.stopAll();
    }
    for (const [sessionKey, session] of this.kernels) {
      if (targetLanguage && session.config.language !== targetLanguage) continue;
      session.kernel.stop();
      this.kernels.delete(sessionKey);
    }

    const label = key ? langForKey[key] : "all";
    new Notice(`${label.charAt(0).toUpperCase() + label.slice(1)} kernel${key ? "" : "s"} restarted`);
  }

  private async startBackground(
    request: BackgroundCellRequest,
    onChunk: (chunk: OutputChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(request.sourcePath);
    if (!(file instanceof TFile)) {
      throw new Error(`Cannot start a background cell: ${request.sourcePath} is not a Markdown file`);
    }
    const config = resolveNotebookKernelConfig(
      this.app,
      file,
      request.language,
      this.settings,
      readNotebookFrontmatter(this.app, file),
    );
    await this.backgrounds.start({
      ...request,
      executable: config.executable,
      cwd: config.cwd,
    }, onChunk, signal);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async updateRunAllToolbarVisibility(visible: boolean): Promise<void> {
    if (this.runButtonContext) {
      await setRunAllToolbarVisible(visible, this.runButtonContext);
    }
  }
}
