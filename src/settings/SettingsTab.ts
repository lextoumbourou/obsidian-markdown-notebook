import { App, PluginSettingTab, Setting } from "obsidian";
import type MarkdownNotebookPlugin from "../main";

export class SettingsTab extends PluginSettingTab {
  plugin: MarkdownNotebookPlugin;

  constructor(app: App, plugin: MarkdownNotebookPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Interface ────────────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Interface" });

    new Setting(containerEl)
      .setName("Show Run all toolbar")
      .setDesc("Show notebook-wide execution controls at the top of Reading View")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showRunAllToolbar)
          .onChange(async (value) => {
            this.plugin.settings.showRunAllToolbar = value;
            await this.plugin.saveSettings();
            await this.plugin.updateRunAllToolbarVisibility(value);
          })
      );

    // ── Execution ────────────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Execution" });

    new Setting(containerEl)
      .setName("Stop on first error")
      .setDesc("Stop Run all after the first failed or timed-out cell, like Jupyter")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.stopOnFirstError)
          .onChange(async (value) => {
            this.plugin.settings.stopOnFirstError = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Execution timeout (ms)")
      .setDesc("Maximum time to wait for a cell to finish executing")
      .addText((text) =>
        text
          .setPlaceholder("30000")
          .setValue(String(this.plugin.settings.executionTimeout))
          .onChange(async (value) => {
            const n = parseInt(value);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.executionTimeout = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // ── Language paths ───────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Language paths" });

    this.addPathSetting(containerEl, "Python", "python3", "pythonPath", true);
    this.addPathSetting(containerEl, "Node.js", "node", "nodePath", false);
    this.addPathSetting(containerEl, "Shell", "bash", "shellPath", false);
    this.addPathSetting(containerEl, "R", "R", "rPath", false);

    // ── Output ───────────────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Output" });

    new Setting(containerEl)
      .setName("Maximum output size (KB)")
      .setDesc("Maximum rendered output stored per cell; excess output is replaced by a truncation marker")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.outputLimitKb))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.outputLimitKb = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Default output format")
      .setDesc("Format used when no format= arg is specified on a cell")
      .addDropdown((drop) =>
        drop
          .addOption("html", "HTML")
          .addOption("image", "Image")
          .setValue(this.plugin.settings.defaultFormat)
          .onChange(async (value) => {
            this.plugin.settings.defaultFormat = value as "html" | "image";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Media folder")
      .setDesc("Vault-relative folder for saved images (e.g. attachments). Empty = save next to the note.")
      .addText((text) =>
        text
          .setPlaceholder("attachments")
          .setValue(this.plugin.settings.mediaPath)
          .onChange(async (value) => {
            this.plugin.settings.mediaPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Markdown image links")
      .setDesc("Use standard Markdown links ![](path) instead of Obsidian wikilinks ![[file]] for saved images")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.markdownImageLinks)
          .onChange(async (value) => {
            this.plugin.settings.markdownImageLinks = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Kernel ───────────────────────────────────────────────────────────────

    containerEl.createEl("h3", { text: "Kernel" });

    new Setting(containerEl)
      .setName("Restart all kernels")
      .setDesc("Kill and restart every language kernel, clearing all variables")
      .addButton((btn) =>
        btn
          .setButtonText("Restart all")
          .setWarning()
          .onClick(() => this.plugin.restartKernel())
      );
  }

  private addPathSetting(
    containerEl: HTMLElement,
    label: string,
    placeholder: string,
    key: "pythonPath" | "nodePath" | "shellPath" | "rPath",
    restartOnChange: boolean
  ): void {
    new Setting(containerEl)
      .setName(`${label} path`)
      .setDesc(`Path to the ${label} executable`)
      .addText((text) =>
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveSettings();
            if (restartOnChange) this.plugin.restartKernel(key);
          })
      );
  }
}
