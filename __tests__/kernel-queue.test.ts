import { EventEmitter } from "events";
import type { ChildProcessWithoutNullStreams } from "child_process";
import {
  BaseKernel,
  KernelCancelledError,
  KernelTimeoutError,
} from "../src/kernels/BaseKernel";
import { ShellKernel } from "../src/kernels/ShellKernel";
import type { OutputChunk } from "../src/output/MimeRenderer";

/**
 * Regression tests for execution-queue poisoning: a single failed execution
 * (timeout, spawn error) must not cause subsequent executions to reject
 * with the stale error without running.
 */

describe("ShellKernel queue recovery", () => {
  it("runs cells in the configured working directory", async () => {
    const kernel = new ShellKernel("bash", process.cwd());
    const chunks: OutputChunk[] = [];

    await kernel.execute("pwd", (chunk) => chunks.push(chunk), 5000);

    const stdout = chunks
      .filter((chunk): chunk is Extract<OutputChunk, { type: "stream" }> => chunk.type === "stream")
      .map((chunk) => chunk.text)
      .join("")
      .trim();
    expect(stdout).toBe(process.cwd());
    kernel.stop();
  });

  it("runs the next cell normally after a timeout", async () => {
    const kernel = new ShellKernel("bash");

    await expect(
      kernel.execute("sleep 5", () => {}, 100)
    ).rejects.toThrow(/timed out/);

    const chunks: OutputChunk[] = [];
    await expect(
      kernel.execute("echo hello", (c) => chunks.push(c), 5000)
    ).resolves.toBeUndefined();

    const stdout = chunks
      .filter((c): c is Extract<OutputChunk, { type: "stream" }> => c.type === "stream")
      .map((c) => c.text)
      .join("");
    expect(stdout).toContain("hello");

    kernel.stop();
  });

  it("runs the next cell normally after a spawn failure", async () => {
    const kernel = new ShellKernel("/nonexistent/shell");

    await expect(
      kernel.execute("echo hi", () => {}, 5000)
    ).rejects.toThrow();

    // Point at a real shell the way a user would fix their settings —
    // the queue itself must not stay rejected.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (kernel as any).shellPath = "bash";

    const chunks: OutputChunk[] = [];
    await expect(
      kernel.execute("echo recovered", (c) => chunks.push(c), 5000)
    ).resolves.toBeUndefined();
    expect(chunks.some((c) => c.type === "stream" && c.text.includes("recovered"))).toBe(true);

    kernel.stop();
  });
});

/**
 * Minimal in-memory kernel: stdin.write echoes the finish sigil back on
 * stdout unless the code contains "HANG", which simulates a cell that
 * doesn't finish until it receives SIGINT (like an interrupted sleep) —
 * at which point it flushes pending output followed by its sigil.
 */
class FakeKernel extends BaseKernel {
  protected async start(): Promise<void> {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    let hungSigil: string | null = null;
    const fake = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: {
        write: (wrapped: string) => {
          const sigil = wrapped.match(/__NB_DONE_\S+__/)?.[0] ?? "";
          if (wrapped.includes("HANG")) {
            hungSigil = sigil;
            return true;
          }
          setImmediate(() => {
            stdout.emit("data", Buffer.from("ran\n" + sigil));
          });
          return true;
        },
      },
      kill: (signal?: string) => {
        if (signal === "SIGINT" && hungSigil) {
          const sigil = hungSigil;
          hungSigil = null;
          setImmediate(() => {
            stdout.emit("data", Buffer.from("STALE LATE OUTPUT\n" + sigil));
          });
        } else if (signal !== "SIGINT") {
          setImmediate(() => fake.emit("close"));
        }
        return true;
      },
    });
    this.process = fake as unknown as ChildProcessWithoutNullStreams;
  }

  protected wrapCode(code: string, finishSigil: string): string {
    return `${code}\n${finishSigil}`;
  }

  protected filterStderr(text: string): string {
    return text;
  }

  crash(): void {
    this.process?.emit("close", 1, null);
  }
}

describe("BaseKernel queue recovery", () => {
  it("settles immediately when an active kernel is stopped", async () => {
    const kernel = new FakeKernel();
    const running = kernel.execute("HANG", () => {}, 10000);
    await new Promise((resolve) => setImmediate(resolve));

    kernel.stop();

    await expect(running).rejects.toBeInstanceOf(KernelCancelledError);
  });

  it("rejects promptly when a kernel process exits unexpectedly", async () => {
    const kernel = new FakeKernel();
    const running = kernel.execute("HANG", () => {}, 10000);
    await new Promise((resolve) => setImmediate(resolve));

    kernel.crash();

    await expect(running).rejects.toThrow("Kernel process exited during execution");
  });

  it("rejects a stopped queued cell without waiting for the active cell", async () => {
    const kernel = new FakeKernel();
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = kernel.execute("HANG", () => {}, 5000, activeController.signal);
    const activeResult = active.catch((error) => error);
    const queued = kernel.execute("ok", () => {}, 5000, queuedController.signal);

    queuedController.abort();
    await expect(queued).rejects.toBeInstanceOf(KernelCancelledError);

    activeController.abort();
    await expect(activeResult).resolves.toBeInstanceOf(KernelCancelledError);
  });

  it("stops the active cell and keeps the kernel usable", async () => {
    const kernel = new FakeKernel();
    const controller = new AbortController();
    const running = kernel.execute("HANG", () => {}, 5000, controller.signal);

    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(KernelCancelledError);

    const chunks: OutputChunk[] = [];
    await kernel.execute("ok", (chunk) => chunks.push(chunk), 5000);
    expect(chunks.some((chunk) => "text" in chunk && chunk.text.includes("ran"))).toBe(true);
  });

  it("runs the next cell normally after a timeout", async () => {
    const kernel = new FakeKernel();

    await expect(
      kernel.execute("HANG", () => {}, 50)
    ).rejects.toThrow(/timed out/);

    const chunks: OutputChunk[] = [];
    await expect(
      kernel.execute("ok", (c) => chunks.push(c), 5000)
    ).resolves.toBeUndefined();
    expect(chunks.some((c) => c.type === "stream" && c.text.includes("ran"))).toBe(true);
  });

  it("discards the timed-out cell's late output instead of leaking it into the next run", async () => {
    const kernel = new FakeKernel();

    await expect(
      kernel.execute("HANG", () => {}, 50)
    ).rejects.toThrow(/timed out/);

    const chunks: OutputChunk[] = [];
    await kernel.execute("ok", (c) => chunks.push(c), 5000);

    const allText = chunks.map((c) => ("text" in c ? c.text : "")).join("");
    expect(allText).toContain("ran");
    expect(allText).not.toContain("STALE LATE OUTPUT");
    expect(allText).not.toContain("__NB_DONE_");
  });
});

describe("timeout error type", () => {
  it("BaseKernel rejects with KernelTimeoutError on timeout", async () => {
    const kernel = new FakeKernel();
    const err = await kernel.execute("HANG", () => {}, 50).catch((e) => e);
    expect(err).toBeInstanceOf(KernelTimeoutError);
    expect((err as KernelTimeoutError).timeoutMs).toBe(50);
  });

  it("ShellKernel rejects with KernelTimeoutError on timeout", async () => {
    const kernel = new ShellKernel("bash");
    const err = await kernel.execute("sleep 5", () => {}, 100).catch((e) => e);
    expect(err).toBeInstanceOf(KernelTimeoutError);
    expect((err as KernelTimeoutError).timeoutMs).toBe(100);
    kernel.stop();
  });

  it("ShellKernel does not mark a spawn failure as a timeout", async () => {
    const kernel = new ShellKernel("/nonexistent/shell");
    const err = await kernel.execute("echo hi", () => {}, 5000).catch((e) => e);
    // Note: not asserting `instanceof Error` — Node-internal spawn errors are
    // created against the real global Error, not Jest's sandboxed one.
    expect(String(err)).toContain("ENOENT");
    expect(err).not.toBeInstanceOf(KernelTimeoutError);
  });

  it("ShellKernel rejects a stopped cell as cancellation", async () => {
    const kernel = new ShellKernel("bash");
    const controller = new AbortController();
    const running = kernel.execute("sleep 5", () => {}, 5000, controller.signal);
    setTimeout(() => controller.abort(), 25);

    await expect(running).rejects.toBeInstanceOf(KernelCancelledError);
    kernel.stop();
  });

  it("ShellKernel force-kills a signal-ignoring cell so the queue recovers", async () => {
    const kernel = new ShellKernel("bash");
    const controller = new AbortController();
    const running = kernel.execute(
      "trap '' INT TERM; while :; do :; done",
      () => {},
      10000,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 25);
    await expect(running).rejects.toBeInstanceOf(KernelCancelledError);

    const chunks: OutputChunk[] = [];
    await kernel.execute("echo recovered", (chunk) => chunks.push(chunk), 4000);
    expect(chunks.some((chunk) => "text" in chunk && chunk.text.includes("recovered"))).toBe(true);
    kernel.stop();
  });
});
