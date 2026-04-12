import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings/Settings";
import { SettingsTab } from "./settings/SettingsTab";
import { SubprocessKernel } from "./kernels/SubprocessKernel";
import { NodeKernel } from "./kernels/NodeKernel";
import { ShellKernel } from "./kernels/ShellKernel";
import { RKernel } from "./kernels/RKernel";
import { BaseKernel } from "./kernels/BaseKernel";
import { processCodeBlock, RunButtonContext } from "./RunButton";
import { runAll } from "./RunAll";

type AnyKernel = BaseKernel | ShellKernel;

// Canonical language names; fence aliases are normalised to these.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  sh: "bash",
  shell: "bash",
};

const SUPPORTED_LANGUAGES = ["python", "javascript", "bash", "r"];

export default class MarkdownNotebookPlugin extends Plugin {
  settings: PluginSettings;
  private kernels: Map<string, AnyKernel> = new Map();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    const context: RunButtonContext = {
      app: this.app,
      getSettings: () => this.settings,
      getKernel: (lang: string) => this.getKernel(lang),
    };

    // Register a processor for each language + its common aliases
    const registered = new Set<string>();
    for (const lang of [...SUPPORTED_LANGUAGES, ...Object.keys(LANG_ALIASES)]) {
      if (registered.has(lang)) continue;
      registered.add(lang);
      const canonical = LANG_ALIASES[lang] ?? lang;
      this.registerMarkdownCodeBlockProcessor(lang, (src, el, ctx) =>
        processCodeBlock(src, el, ctx, context, canonical)
      );
    }

    this.addCommand({
      id: "restart-kernel",
      name: "Restart all kernels",
      callback: () => this.restartKernel(),
    });

    this.addCommand({
      id: "interrupt-kernel",
      name: "Interrupt kernel",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        // Best-effort: interrupt the most recently active language kernel
        // (could be improved by tracking active cell language)
        for (const k of this.kernels.values()) k.interrupt();
        new Notice("Kernel interrupted");
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
        runAll(this.app, file, (lang) => this.getKernel(lang), this.settings);
      },
    });
  }

  onunload() {
    for (const k of this.kernels.values()) k.stop();
  }

  getKernel(lang: string): AnyKernel {
    const canonical = LANG_ALIASES[lang] ?? lang;
    if (!this.kernels.has(canonical)) {
      this.kernels.set(canonical, this.createKernel(canonical));
    }
    return this.kernels.get(canonical)!;
  }

  private createKernel(lang: string): AnyKernel {
    switch (lang) {
      case "python":     return new SubprocessKernel(this.settings.pythonPath);
      case "javascript": return new NodeKernel(this.settings.nodePath);
      case "bash":       return new ShellKernel(this.settings.shellPath);
      case "r":          return new RKernel(this.settings.rPath);
      default:           return new ShellKernel(this.settings.shellPath);
    }
  }

  /** Restart one kernel (by settings key) or all kernels. */
  restartKernel(key?: "pythonPath" | "nodePath" | "shellPath" | "rPath"): void {
    const langForKey: Record<string, string> = {
      pythonPath: "python", nodePath: "javascript",
      shellPath: "bash",    rPath: "r",
    };

    const langs = key ? [langForKey[key]] : [...this.kernels.keys()];
    for (const lang of langs) {
      this.kernels.get(lang)?.stop();
      this.kernels.delete(lang);
    }

    const label = key ? langForKey[key] : "all";
    new Notice(`${label.charAt(0).toUpperCase() + label.slice(1)} kernel${key ? "" : "s"} restarted`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
