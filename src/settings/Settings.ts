import { DEFAULT_OUTPUT_LIMIT_KB } from "../output/OutputLimiter";

export interface PluginSettings {
  pythonPath: string;
  nodePath: string;
  shellPath: string;
  rPath: string;
  executionTimeout: number;
  outputLimitKb: number;
  stopOnFirstError: boolean;
  showRunAllToolbar: boolean;
  defaultFormat: "html" | "image";
  mediaPath: string;
  markdownImageLinks: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  pythonPath: "python3",
  nodePath: "node",
  shellPath: "bash",
  rPath: "R",
  executionTimeout: 30000,
  outputLimitKb: DEFAULT_OUTPUT_LIMIT_KB,
  stopOnFirstError: true,
  showRunAllToolbar: true,
  defaultFormat: "html",
  mediaPath: "",
  markdownImageLinks: false,
};
