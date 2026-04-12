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

    new Setting(containerEl)
      .setName("Python path")
      .setDesc("Path to the Python executable (e.g. python3 or /usr/bin/python3)")
      .addText((text) =>
        text
          .setPlaceholder("python3")
          .setValue(this.plugin.settings.pythonPath)
          .onChange(async (value) => {
            this.plugin.settings.pythonPath = value;
            await this.plugin.saveSettings();
            this.plugin.restartKernel();
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

    new Setting(containerEl)
      .setName("Media folder")
      .setDesc("Vault-relative folder for saved images (e.g. attachments). Leave empty to save next to each note.")
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

    new Setting(containerEl)
      .setName("Restart kernel")
      .setDesc("Kill and restart the Python kernel, clearing all variables")
      .addButton((btn) =>
        btn
          .setButtonText("Restart")
          .setWarning()
          .onClick(() => {
            this.plugin.restartKernel();
          })
      );
  }
}
