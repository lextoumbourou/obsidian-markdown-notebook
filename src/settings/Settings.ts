export interface PluginSettings {
  pythonPath: string;
  executionTimeout: number;
  mediaPath: string; // vault-relative folder for saved images; empty = same folder as note
  markdownImageLinks: boolean; // use ![](path) instead of ![[filename]]
}

export const DEFAULT_SETTINGS: PluginSettings = {
  pythonPath: "python3",
  executionTimeout: 30000,
  mediaPath: "",
  markdownImageLinks: false,
};
