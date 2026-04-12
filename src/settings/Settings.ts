export interface PluginSettings {
  pythonPath: string;
  nodePath: string;
  shellPath: string;
  rPath: string;
  executionTimeout: number;
  mediaPath: string;
  markdownImageLinks: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  pythonPath: "python3",
  nodePath: "node",
  shellPath: "bash",
  rPath: "R",
  executionTimeout: 30000,
  mediaPath: "",
  markdownImageLinks: false,
};
