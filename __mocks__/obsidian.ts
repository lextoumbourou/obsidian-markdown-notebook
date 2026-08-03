// Minimal Obsidian API mock for unit tests.
// Only the shapes used by the tested modules are implemented.

export class TFile {
  path = '';
  name = '';
  basename = '';
  parent: TFolder | null = null;
}

export class TFolder {
  path = '';
  name = '';
  parent: TFolder | null = null;
  vault: unknown = null;
  children: unknown[] = [];
  isRoot() { return false; }
}

export class App {
  metadataCache = {
    getFileCache: jest.fn(() => null),
  };
  vault = new Vault();
  workspace = {
    on: jest.fn(() => ({ off: jest.fn() })),
    getLeavesOfType: jest.fn(() => []),
    getActiveViewOfType: jest.fn(() => null),
  };
}
export class Plugin {
  app = new App();
  addSettingTab = jest.fn();
  registerMarkdownCodeBlockProcessor = jest.fn();
  registerMarkdownPostProcessor = jest.fn();
  registerEvent = jest.fn();
  addCommand = jest.fn();
  register = jest.fn();
  loadData = jest.fn(async () => null);
  saveData = jest.fn(async () => undefined);
}
export class PluginSettingTab {}
export class Notice {
  static messages: string[] = [];
  message: string;
  hidden = false;

  constructor(message: string, _timeout?: number) {
    this.message = message;
    Notice.messages.push(message);
  }

  setMessage(message: string) {
    this.message = message;
    Notice.messages.push(message);
  }

  hide() {
    this.hidden = true;
  }
}
export const Setting = jest.fn().mockImplementation(() => ({
  setName: jest.fn().mockReturnThis(),
  setDesc: jest.fn().mockReturnThis(),
  addText: jest.fn().mockReturnThis(),
  addToggle: jest.fn().mockReturnThis(),
  addButton: jest.fn().mockReturnThis(),
}));

export class Vault {
  on = jest.fn(() => ({ off: jest.fn() }));
  process = jest.fn();
  read = jest.fn();
  modify = jest.fn();
  createBinary = jest.fn();
  modifyBinary = jest.fn();
  createFolder = jest.fn();
  getAbstractFileByPath = jest.fn();
}
