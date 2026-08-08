import { BackgroundProcessManager } from "../src/BackgroundProcessManager";
import type { OutputChunk } from "../src/output/MimeRenderer";
import { mapBackgroundDiagnostic } from "../src/BackgroundProgram";
import * as net from "net";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("background diagnostic mapping", () => {
  const sourceMap = [
    {
      generatedLineStart: 1,
      generatedLineEnd: 3,
      noteLineStart: 40,
      role: "setup" as const,
    },
    {
      generatedLineStart: 5,
      generatedLineEnd: 7,
      noteLineStart: 60,
      role: "background" as const,
    },
  ];

  it("maps Python temp-file locations back to setup cells", () => {
    const diagnostic = '  File "/tmp/generated.py", line 2, in <module>\nNameError';
    expect(mapBackgroundDiagnostic(
      diagnostic, "/tmp/generated.py", "article.md", "server", sourceMap,
    )).toContain(
      'File "article.md, line 41 (setup cell replayed for background \'server\')"',
    );
  });

  it("maps Node and shell locations back to the background cell", () => {
    expect(mapBackgroundDiagnostic(
      "/tmp/generated.js:6:4", "/tmp/generated.js", "article.md", "server", sourceMap,
    )).toBe("article.md, line 61 (background cell 'server'):4");
    expect(mapBackgroundDiagnostic(
      "/tmp/generated.sh: line 7", "/tmp/generated.sh", "article.md", "server", sourceMap,
    )).toBe("article.md, line 62 (background cell 'server')");
  });

  it("maps a bare Node traceback header", () => {
    expect(mapBackgroundDiagnostic(
      "/tmp/generated.js:6\nthrow new Error()",
      "/tmp/generated.js", "article.md", "server", sourceMap,
    )).toBe("article.md, line 61 (background cell 'server')\nthrow new Error()");
  });
});

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

  it("reserves a name while an asynchronous readiness preflight is running", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const port = await freePort();
    const spec = {
      sourcePath: "note.md",
      name: "server",
      language: "javascript",
      source: [
        'const net = require("net");',
        `setTimeout(() => net.createServer(() => {}).listen(${port}, "127.0.0.1"), 50);`,
      ].join("\n"),
      executable: process.execPath,
      cwd: process.cwd(),
      ready: `port:${port}`,
      readyTimeoutMs: 1000,
    };

    const first = manager.start(spec);
    await expect(manager.start(spec)).rejects.toThrow("already starting");
    await expect(first).resolves.toBeUndefined();
    expect(manager.isRunning("note.md", "server")).toBe(true);
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
    let resolveStopped!: () => void;
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
    const manager = new BackgroundProcessManager((_path, _name, running) => {
      states.push(running);
      if (!running) resolveStopped();
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
    await Promise.race([
      stopped,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("background process did not exit")), 1500,
      )),
    ]);
    expect(states).toEqual([true, false]);
  });

  it("streams carriage-return terminated stderr", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const chunks: OutputChunk[] = [];

    await manager.start({
      sourcePath: "note.md",
      name: "progress",
      language: "javascript",
      source: 'process.stderr.write("working\\r"); setInterval(() => {}, 1000);',
      executable: process.execPath,
      cwd: process.cwd(),
    }, (chunk) => chunks.push(chunk));

    expect(chunks.some((chunk) => chunk.type === "error" && chunk.text === "working\r"))
      .toBe(true);
  });

  it("force-flushes unterminated stderr before its buffer can grow unbounded", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const chunks: OutputChunk[] = [];

    await manager.start({
      sourcePath: "note.md",
      name: "large-stderr",
      language: "javascript",
      source: 'process.stderr.write("x".repeat(70 * 1024)); setInterval(() => {}, 1000);',
      executable: process.execPath,
      cwd: process.cwd(),
    }, (chunk) => chunks.push(chunk));

    expect(chunks.some((chunk) => chunk.type === "error" && chunk.text.length >= 64 * 1024))
      .toBe(true);
  });

  it("waits until a TCP port is accepting connections", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const port = await freePort();
    const startedAt = Date.now();

    await manager.start({
      sourcePath: "note.md",
      name: "delayed-server",
      language: "javascript",
      source: [
        'const net = require("net");',
        `setTimeout(() => net.createServer(() => {}).listen(${port}, "127.0.0.1"), 250);`,
      ].join("\n"),
      executable: process.execPath,
      cwd: process.cwd(),
      ready: `port:${port}`,
      readyTimeoutMs: 2000,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
    expect(manager.isRunning("note.md", "delayed-server")).toBe(true);
  });

  it("matches output readiness across chunks without mixing streams", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);

    await manager.start({
      sourcePath: "note.md",
      name: "output-server",
      language: "javascript",
      source: [
        'process.stdout.write("Serv");',
        'process.stderr.write("unrelated\\n");',
        'setTimeout(() => process.stdout.write("ing on"), 50);',
        'setInterval(() => {}, 1000);',
      ].join("\n"),
      executable: process.execPath,
      cwd: process.cwd(),
      ready: "Serving on",
      readyTimeoutMs: 1000,
    });

    expect(manager.isRunning("note.md", "output-server")).toBe(true);
  });

  it("matches stderr readiness after removing ANSI colour codes", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);

    await manager.start({
      sourcePath: "note.md",
      name: "coloured-server",
      language: "javascript",
      source: [
        'process.stderr.write("\\u001b[32mServing\\u001b[0m on\\n");',
        'setInterval(() => {}, 1000);',
      ].join("\n"),
      executable: process.execPath,
      cwd: process.cwd(),
      ready: "Serving on",
      readyTimeoutMs: 1000,
    });

    expect(manager.isRunning("note.md", "coloured-server")).toBe(true);
  });

  it("rejects an occupied readiness port before spawning", async () => {
    const port = await freePort();
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    try {
      await expect(manager.start({
        sourcePath: "note.md",
        name: "occupied",
        language: "javascript",
        source: "setInterval(() => {}, 1000);",
        executable: process.execPath,
        cwd: process.cwd(),
        ready: `port:${port}`,
      })).rejects.toThrow(`Port ${port} was already in use on 127.0.0.1`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports process stderr when it exits while waiting for readiness", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const port = await freePort();

    await expect(manager.start({
      sourcePath: "note.md",
      name: "bind-failure",
      language: "javascript",
      source: 'console.error("EADDRINUSE: address already in use"); process.exit(1);',
      executable: process.execPath,
      cwd: process.cwd(),
      ready: `port:${port}`,
      readyTimeoutMs: 1000,
    })).rejects.toThrow("EADDRINUSE");
  });

  it("times out, reports captured output and stops the process", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    let error: unknown;
    try {
      await manager.start({
        sourcePath: "note.md",
        name: "never-ready",
        language: "javascript",
        source: 'process.stderr.write("still starting"); setInterval(() => {}, 1000);',
        executable: process.execPath,
        cwd: process.cwd(),
        ready: "ready now",
        readyTimeoutMs: 100,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      message: expect.stringContaining("was not ready after 100ms"),
      detail: expect.stringContaining("still starting"),
    });
    expect(manager.isRunning("note.md", "never-ready")).toBe(false);
  });

  it("rejects malformed readiness values clearly", async () => {
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

    await expect(manager.start({ ...spec, ready: "port:nope" }))
      .rejects.toThrow("use port:<number> or an output literal");
    await expect(manager.start({ ...spec, ready: "port:70000" }))
      .rejects.toThrow("use a number from 1 to 65535");
  });

  it("can reuse a readiness port after a stopped process fully closes", async () => {
    const manager = new BackgroundProcessManager();
    managers.push(manager);
    const port = await freePort();
    const spec = {
      sourcePath: "note.md",
      name: "server",
      language: "javascript",
      source: `require("net").createServer(() => {}).listen(${port}, "127.0.0.1");`,
      executable: process.execPath,
      cwd: process.cwd(),
      ready: `port:${port}`,
      readyTimeoutMs: 1000,
    };

    await manager.start(spec);
    await manager.stop("note.md", "server");
    await expect(manager.start(spec)).resolves.toBeUndefined();
  });
});
