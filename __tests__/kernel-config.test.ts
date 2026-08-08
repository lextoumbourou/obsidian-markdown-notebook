import * as path from "path";
import { TFile } from "obsidian";
import {
  notebookKernelSessionKey,
  resolveExecutable,
  resolveNotebookKernelConfig,
  resolveWorkingDirectory,
} from "../src/NotebookKernelConfig";
import { DEFAULT_SETTINGS } from "../src/settings/Settings";

describe("notebook kernel configuration", () => {
  it("defaults cwd to the note folder and resolves relative executables there", () => {
    const file = new TFile();
    file.path = "projects/demo/Notebook.md";
    Object.assign(file, { parent: { path: "projects/demo" } });
    const app = {
      vault: { adapter: { getBasePath: () => "/vault" } },
    };

    const config = resolveNotebookKernelConfig(
      app as never,
      file,
      "python",
      DEFAULT_SETTINGS,
      { python: ".venv/bin/python" },
    );

    expect(config.cwd).toBe(path.resolve("/vault/projects/demo"));
    expect(config.executable).toBe(path.resolve("/vault/projects/demo/.venv/bin/python"));
  });

  it("supports vault-root and note-relative cwd overrides", () => {
    expect(resolveWorkingDirectory("/vault", "notes/project", "/"))
      .toBe(path.resolve("/vault"));
    expect(resolveWorkingDirectory("/vault", "notes/project", "data"))
      .toBe(path.resolve("/vault/notes/project/data"));
  });

  it("leaves PATH executable names unchanged", () => {
    expect(resolveExecutable("python3", "/vault/project")).toBe("python3");
  });

  it("resolves relative global executable settings from the vault root", () => {
    const file = new TFile();
    file.path = "projects/demo/Notebook.md";
    Object.assign(file, { parent: { path: "projects/demo" } });
    const app = { vault: { adapter: { getBasePath: () => "/vault" } } };

    const config = resolveNotebookKernelConfig(
      app as never,
      file,
      "python",
      { ...DEFAULT_SETTINGS, pythonPath: "./tools/python" },
      {},
    );

    expect(config.executable).toBe(path.resolve("/vault/tools/python"));
  });

  it("resolves the DuckDB executable from note frontmatter", () => {
    const file = new TFile();
    file.path = "projects/demo/Notebook.md";
    Object.assign(file, { parent: { path: "projects/demo" } });
    const app = { vault: { adapter: { getBasePath: () => "/vault" } } };

    const config = resolveNotebookKernelConfig(
      app as never,
      file,
      "sql",
      DEFAULT_SETTINGS,
      { duckdb: "./bin/duckdb" },
    );

    expect(config.executable).toBe(path.resolve("/vault/projects/demo/bin/duckdb"));
  });

  it("includes the note and resolved configuration in the session key", () => {
    const base = { language: "python", executable: "python3", cwd: "/vault/a" };
    expect(notebookKernelSessionKey({ ...base, notePath: "a.md" }))
      .not.toBe(notebookKernelSessionKey({ ...base, notePath: "b.md" }));
    expect(notebookKernelSessionKey({ ...base, notePath: "a.md" }))
      .not.toBe(notebookKernelSessionKey({ ...base, notePath: "a.md", cwd: "/vault/b" }));
  });
});
