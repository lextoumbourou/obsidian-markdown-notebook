import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, PluginSettings } from "./settings/Settings";
import { SettingsTab } from "./settings/SettingsTab";
import { SubprocessKernel } from "./kernels/SubprocessKernel";
import { processCodeBlock, RunButtonContext } from "./RunButton";

export default class MarkdownNotebookPlugin extends Plugin {
  settings: PluginSettings;
  kernel: SubprocessKernel;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.kernel = new SubprocessKernel(this.settings.pythonPath);

    const context: RunButtonContext = {
      app: this.app,
      getSettings: () => this.settings,
      getKernel: () => this.kernel,
    };

    // Handle python code blocks — processCodeBlock checks for {run} and
    // falls through to normal rendering for plain python blocks.
    this.registerMarkdownCodeBlockProcessor("python", (src, el, ctx) =>
      processCodeBlock(src, el, ctx, context)
    );

    // Commands
    this.addCommand({
      id: "restart-kernel",
      name: "Restart Python kernel",
      callback: () => this.restartKernel(),
    });

    this.addCommand({
      id: "interrupt-kernel",
      name: "Interrupt Python kernel",
      callback: () => {
        this.kernel.interrupt();
        new Notice("Kernel interrupted");
      },
    });
  }

  onunload() {
    this.kernel.stop();
  }

  restartKernel() {
    this.kernel.stop();
    this.kernel = new SubprocessKernel(this.settings.pythonPath);
    // context.getKernel() always reads this.kernel, so no further update needed.
    new Notice("Python kernel restarted");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
