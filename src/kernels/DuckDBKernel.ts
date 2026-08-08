import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  KernelCancelledError,
  KernelExecutionError,
  KernelTimeoutError,
  kernelEnv,
  raceWithCancellation,
  stripAnsi,
} from "./BaseKernel";
import type { OutputChunk } from "../output/MimeRenderer";

const DRAIN_TIMEOUT_MS = 5000;
const STDERR_SETTLE_MS = 50;

/** Persistent DuckDB CLI kernel. Query output is requested as HTML rows and
 * wrapped as a rich table after the cell completion marker arrives. */
export class DuckDBKernel {
  private process: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private execQueue: Promise<void> = Promise.resolve();
  private pendingDrain: Promise<void> | null = null;
  private initFile: string | null = null;
  private intentionallyStopped = new WeakSet<ChildProcessWithoutNullStreams>();
  executionCount = 0;

  constructor(
    private readonly duckdbPath: string,
    private readonly cwd?: string,
  ) {}

  async ensureStarted(): Promise<void> {
    if (this.process) return;
    if (!this.starting) {
      this.starting = this.start().catch((error) => {
        this.stop();
        throw error;
      });
    }
    return this.starting;
  }

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
    this.execQueue = execution.then(() => undefined, () => undefined);
    return raceWithCancellation(execution, signal);
  }

  interrupt(): void {
    this.process?.kill("SIGINT");
  }

  stop(): void {
    if (this.process) {
      this.intentionallyStopped.add(this.process);
      this.process.kill();
      this.process = null;
    }
    this.starting = null;
    this.pendingDrain = null;
    this.executionCount = 0;
    if (this.initFile) {
      void fs.promises.rm(this.initFile, { force: true });
      this.initFile = null;
    }
  }

  private async start(): Promise<void> {
    const initFile = path.join(
      os.tmpdir(),
      `markdown-notebook-duckdb-${process.pid}-${Date.now()}.init`,
    );
    this.initFile = initFile;
    await fs.promises.writeFile(initFile, "", "utf8");
    const proc = spawn(
      this.duckdbPath,
      ["-batch", "-init", initFile, "-html", ":memory:"],
      { env: kernelEnv(), cwd: this.cwd },
    );
    this.process = proc;
    const cleanupInitFile = () => {
      if (this.initFile !== initFile) return;
      this.initFile = null;
      void fs.promises.rm(initFile, { force: true });
    };
    proc.on("close", () => {
      if (this.process === proc) this.process = null;
      this.starting = null;
      cleanupInitFile();
    });
    proc.on("error", (error) => {
      console.error("[MarkdownNotebook] DuckDB error:", error);
      if (this.process === proc) this.process = null;
      this.starting = null;
      cleanupInitFile();
    });
    proc.stdin.on("error", (error) => {
      console.error("[MarkdownNotebook] DuckDB stdin error:", error);
    });

    const marker = `__NB_DUCKDB_READY_${Date.now()}__`;
    await this.waitForMarker(proc, marker, () => {
      proc.stdin.write(`.print ${marker}\n`);
    });
  }

  private async doExecute(
    code: string,
    onChunk: (chunk: OutputChunk) => void,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.pendingDrain) await this.pendingDrain;
    if (signal?.aborted) throw new KernelCancelledError();
    await this.ensureStarted();
    if (signal?.aborted) throw new KernelCancelledError();
    const proc = this.process;
    if (!proc) throw new Error("DuckDB kernel not running");

    const marker = `__NB_DUCKDB_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const input = `${code.replace(/\r\n/g, "\n")}\n;\n.print ${marker}\n`;

    return new Promise<void>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let done = false;
      let markerTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (markerTimer) clearTimeout(markerTimer);
        proc.stdout.removeListener("data", onStdout);
        proc.stderr.removeListener("data", onStderr);
        proc.removeListener("close", onClose);
        proc.removeListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        this.executionCount += 1;
        const html = stdout.trim();
        if (html) {
          onChunk({
            type: "rich",
            mime: "text/html",
            data: `<table class="nb-table">${html}</table>`,
          });
        }
        const detail = stripAnsi(stderr).trim();
        if (detail) {
          const diagnostic = detail + "\n";
          onChunk({ type: "error", text: diagnostic });
          reject(new KernelExecutionError(detail.split("\n")[0], diagnostic));
        } else {
          resolve();
        }
      };
      const rejectTerminated = (error: Error) => {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      };
      const rejectInterrupted = (error: Error) => {
        if (done) return;
        done = true;
        cleanup();
        proc.kill("SIGINT");
        this.pendingDrain = this.drainStale(proc, marker).finally(() => {
          this.pendingDrain = null;
        });
        reject(error);
      };
      const onAbort = () => rejectInterrupted(new KernelCancelledError());
      const onClose = () => rejectTerminated(
        this.intentionallyStopped.has(proc)
          ? new KernelCancelledError()
          : new Error("DuckDB kernel exited during execution"),
      );
      const onError = (error: Error) => rejectTerminated(error);
      const onStdout = (data: Buffer) => {
        stdout += data.toString();
        const markerIndex = stdout.indexOf(marker);
        if (markerIndex >= 0) {
          stdout = stdout.slice(0, markerIndex);
          markerTimer = setTimeout(finish, STDERR_SETTLE_MS);
        }
      };
      const onStderr = (data: Buffer) => { stderr += data.toString(); };
      const timeoutTimer = setTimeout(
        () => rejectInterrupted(new KernelTimeoutError(timeoutMs)),
        timeoutMs,
      );

      proc.stdout.on("data", onStdout);
      proc.stderr.on("data", onStderr);
      proc.once("close", onClose);
      proc.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      proc.stdin.write(input, (error) => {
        if (error) onError(error);
      });
    });
  }

  private drainStale(
    proc: ChildProcessWithoutNullStreams,
    marker: string,
  ): Promise<void> {
    return new Promise((resolve) => {
      let stdout = "";
      const cleanup = (sawMarker: boolean) => {
        clearTimeout(timer);
        proc.stdout.removeListener("data", onStdout);
        proc.stderr.removeListener("data", onStderr);
        proc.removeListener("close", onClose);
        if (!sawMarker && this.process === proc) this.stop();
        resolve();
      };
      const onStdout = (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-marker.length * 2);
        if (stdout.includes(marker)) cleanup(true);
      };
      const onStderr = () => undefined;
      const onClose = () => cleanup(true);
      const timer = setTimeout(() => cleanup(false), DRAIN_TIMEOUT_MS);
      proc.stdout.on("data", onStdout);
      proc.stderr.on("data", onStderr);
      proc.once("close", onClose);
    });
  }

  private waitForMarker(
    proc: ChildProcessWithoutNullStreams,
    marker: string,
    start: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout.removeListener("data", onStdout);
        proc.stderr.removeListener("data", onStderr);
        proc.removeListener("close", onClose);
        proc.removeListener("error", onError);
      };
      const onStdout = (data: Buffer) => {
        stdout += data.toString();
        if (!stdout.includes(marker)) return;
        cleanup();
        resolve();
      };
      const onStderr = (data: Buffer) => { stderr += data.toString(); };
      const onClose = () => {
        cleanup();
        reject(new Error(stripAnsi(stderr).trim() || "DuckDB kernel exited during startup"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("DuckDB kernel startup timed out"));
      }, 15_000);
      proc.stdout.on("data", onStdout);
      proc.stderr.on("data", onStderr);
      proc.once("close", onClose);
      proc.once("error", onError);
      start();
    });
  }
}
