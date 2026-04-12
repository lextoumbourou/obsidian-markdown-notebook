import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { stripAnsi, kernelEnv } from "./BaseKernel";
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
  private current: ChildProcessWithoutNullStreams | null = null;
  private execQueue: Promise<void> = Promise.resolve();
  executionCount = 0;

  constructor(shellPath: string) {
    this.shellPath = shellPath;
  }

  async ensureStarted(): Promise<void> {} // no persistent process

  execute(
    code: string,
    onChunk: (chunk: OutputChunk) => void,
    timeoutMs: number
  ): Promise<void> {
    this.execQueue = this.execQueue.then(() =>
      this.doExecute(code, onChunk, timeoutMs)
    );
    return this.execQueue;
  }

  private doExecute(
    code: string,
    onChunk: (chunk: OutputChunk) => void,
    timeoutMs: number
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(this.shellPath, ["-c", code], { env: kernelEnv() });
      this.current = proc;

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on("data", (data: Buffer) => {
        onChunk({ type: "stream", stream: "stdout", text: data.toString() });
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = stripAnsi(data.toString()).trimEnd();
        if (text) onChunk({ type: "error", text: text + "\n" });
      });

      proc.on("close", () => {
        clearTimeout(timer);
        this.current = null;
        this.executionCount++;
        resolve();
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        this.current = null;
        reject(err);
      });
    });
  }

  interrupt(): void {
    this.current?.kill("SIGINT");
  }

  stop(): void {
    this.current?.kill();
    this.current = null;
    this.executionCount = 0;
  }
}
