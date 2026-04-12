// Minimal Obsidian API mock for unit tests.
// Only the shapes used by the tested modules are implemented.

export class TFile {
  path = '';
  name = '';
  basename = '';
  parent: { path: string } | null = null;
}

export class TFolder {
  path = '';
  name = '';
}

export class App {}
export class Plugin {}
export class PluginSettingTab {}
export class Notice { constructor(_msg: string) {} }
export const Setting = jest.fn().mockImplementation(() => ({
  setName: jest.fn().mockReturnThis(),
  setDesc: jest.fn().mockReturnThis(),
  addText: jest.fn().mockReturnThis(),
  addToggle: jest.fn().mockReturnThis(),
  addButton: jest.fn().mockReturnThis(),
}));

export class Vault {
  process = jest.fn();
  read = jest.fn();
  modify = jest.fn();
  createBinary = jest.fn();
  modifyBinary = jest.fn();
  createFolder = jest.fn();
  getAbstractFileByPath = jest.fn();
}
