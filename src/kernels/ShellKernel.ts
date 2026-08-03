import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import {
  stripAnsi,
  kernelEnv,
  KernelCancelledError,
  KernelTimeoutError,
  raceWithCancellation,
} from "./BaseKernel";
import type { OutputChunk } from "../output/MimeRenderer";

/**
 * Shell kernel — spawns a fresh bash process per cell.
 *
 * No persistent state between cells (by design). This is the most reliable
 * approach: no heredoc escaping issues, no risk of a syntax error killing a
 * persistent shell, and shell cells are typically independent commands anyway.
 */
export class ShellKernel {
  private shellPath: string;
  private cwd?: string;
  private current: ChildProcessWithoutNullStreams | null = null;
  private execQueue: Promise<void> = Promise.resolve();
  private intentionallyStopped = new WeakSet<ChildProcessWithoutNullStreams>();
  executionCount = 0;

  constructor(shellPath: string, cwd?: string) {
    this.shellPath = shellPath;
    this.cwd = cwd;
  }

  async ensureStarted(): Promise<void> {} // no persistent process

  execute(
    code: string,
    onChunk: (chunk: OutputChunk) => void,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const execution = this.execQueue.then(() => {
      if (signal?.aborted) throw new KernelCancelledError();
      return this.doExecute(code, onChunk, timeoutMs, signal);
    });
    // The queue must survive a failed execution: keep chaining on a settled
    // promise while the caller still observes the rejection via `run`.
    this.execQueue = execution.then(
      () => undefined,
      () => undefined
    );
    return raceWithCancellation(execution, signal);
  }

  private doExecute(
    code: string,
    onChunk: (chunk: OutputChunk) => void,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KernelCancelledError());
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(this.shellPath, ["-c", code], { env: kernelEnv(), cwd: this.cwd });
      this.current = proc;
      let settled = false;
      let cancelled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        if (settled || cancelled) return;
        cancelled = true;
        clearTimeout(timer);
        proc.kill("SIGINT");
        forceKillTimer = setTimeout(() => proc.kill("SIGKILL"), 1000);
      };

      const timer = setTimeout(() => {
        settled = true;
        cleanup();
        proc.kill();
        reject(new KernelTimeoutError(timeoutMs));
      }, timeoutMs);

      proc.stdout.on("data", (data: Buffer) => {
        if (!settled) onChunk({ type: "stream", stream: "stdout", text: data.toString() });
      });

      proc.stderr.on("data", (data: Buffer) => {
        if (settled) return;
        const text = stripAnsi(data.toString()).trimEnd();
        if (text) onChunk({ type: "error", text: text + "\n" });
      });

      proc.on("close", () => {
        cleanup();
        this.current = null;
        if (settled) return;
        settled = true;
        if (cancelled || this.intentionallyStopped.has(proc)) {
          reject(new KernelCancelledError());
          return;
        }
        this.executionCount++;
        resolve();
      });

      proc.on("error", (err) => {
        cleanup();
        this.current = null;
        if (settled) return;
        settled = true;
        if (cancelled) {
          reject(new KernelCancelledError());
          return;
        }
        reject(err);
      });

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  interrupt(): void {
    this.current?.kill("SIGINT");
  }

  stop(): void {
    if (this.current) {
      this.intentionallyStopped.add(this.current);
      this.current.kill();
    }
    this.current = null;
    this.executionCount = 0;
  }
}
