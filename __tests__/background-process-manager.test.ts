import { BackgroundProcessManager } from "../src/BackgroundProcessManager";
import type { OutputChunk } from "../src/output/MimeRenderer";

describe("BackgroundProcessManager", () => {
  const managers: BackgroundProcessManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  });

  it("starts, captures output from and stops a JavaScript process", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const chunks: OutputChunk[] = [];

    await manager.start({
      sourcePath: "note.md",
      name: "server",
      language: "javascript",
      source: 'console.log("ready"); setInterval(() => {}, 1000);',
      executable: process.execPath,
      cwd: process.cwd(),
    }, (chunk) => chunks.push(chunk));

    expect(manager.isRunning("note.md", "server")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "stream" && chunk.text.includes("ready")))
      .toBe(true);
    await expect(manager.stop("note.md", "server")).resolves.toBe(true);
    expect(manager.isRunning("note.md", "server")).toBe(false);
  });

  it("rejects duplicate names within one note", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const spec = {
      sourcePath: "note.md",
      name: "server",
      language: "javascript",
      source: "setInterval(() => {}, 1000);",
      executable: process.execPath,
      cwd: process.cwd(),
    };

    await manager.start(spec);
    await expect(manager.start(spec)).rejects.toThrow("already running");
  });

  it("reports a process that exits during startup", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);

    await expect(manager.start({
      sourcePath: "note.md",
      name: "broken",
      language: "javascript",
      source: 'console.error("startup failed"); process.exit(2);',
      executable: process.execPath,
      cwd: process.cwd(),
    })).rejects.toThrow("startup failed");
    expect(manager.isRunning("note.md", "broken")).toBe(false);
  });

  it("reports state changes when a process starts and exits", async () => {
    const states: boolean[] = [];
    const manager = new BackgroundProcessManager((_path, _name, running) => {
      states.push(running);
    });
    managers.push(manager);

    await manager.start({
      sourcePath: "note.md",
      name: "short-lived",
      language: "javascript",
      source: "setTimeout(() => process.exit(0), 550);",
      executable: process.execPath,
      cwd: process.cwd(),
    });

    expect(states).toEqual([true]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(states).toEqual([true, false]);
  });
});
