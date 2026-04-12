export interface PluginSettings {
  pythonPath: string;
  executionTimeout: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  pythonPath: "python3",
  executionTimeout: 30000,
};
