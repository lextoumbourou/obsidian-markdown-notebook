import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  KernelCancelledError,
  KernelExecutionError,
  kernelEnv,
  stripAnsi,
} from "./kernels/BaseKernel";
import type { OutputChunk } from "./output/MimeRenderer";
import {
  mapBackgroundDiagnostic,
  type BackgroundSourceMapEntry,
} from "./BackgroundProgram";

const STARTUP_GRACE_MS = 400;
const STOP_GRACE_MS = 1000;
const FORCE_STOP_GRACE_MS = 1000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

export interface BackgroundCellRequest {
  sourcePath: string;
  name: string;
  language: string;
  source: string;
  precedingCellCount?: number;
  sourceMap?: BackgroundSourceMapEntry[];
}

export interface BackgroundProcessSpec extends BackgroundCellRequest {
  executable: string;
  cwd: string;
}

export interface BackgroundExecutionContext {
  start(
    request: BackgroundCellRequest,
    onChunk: (chunk: OutputChunk) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  stop(sourcePath: string, name: string): Promise<boolean>;
  isRunning(sourcePath: string, name: string): boolean;
}

interface ManagedProcess {
  spec: BackgroundProcessSpec;
  process: ChildProcessWithoutNullStreams;
  tempFile: string;
  closed: Promise<void>;
  capturedOutput: string;
  stopping: boolean;
}

function processKey(sourcePath: string, name: string): string {
  return JSON.stringify([sourcePath, name]);
}

function safeName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "Background names must contain only letters, numbers, dots, underscores or hyphens",
    );
  }
  return trimmed;
}

function languageLaunch(language: string, tempFile: string): string[] {
  switch (language) {
    case "python": return ["-u", tempFile];
    case "javascript": return [tempFile];
    case "bash": return [tempFile];
    case "r": return ["--vanilla", "--slave", "-f", tempFile];
    default: throw new Error(`Background cells do not support ${language}`);
  }
}

function languageExtension(language: string): string {
  switch (language) {
    case "python": return ".py";
    case "javascript": return ".js";
    case "bash": return ".sh";
    case "r": return ".R";
    default: return ".txt";
  }
}

export class BackgroundProcessManager {
  private processes = new Map<string, ManagedProcess>();

  constructor(
    private readonly onStateChange: (
      sourcePath: string,
      name: string,
      running: boolean,
    ) => void = () => undefined,
  ) {}

  isRunning(sourcePath: string, name: string): boolean {
    return this.processes.has(processKey(sourcePath, name));
  }

  sourcePaths(): string[] {
    return [...new Set(
      [...this.processes.values()].map((managed) => managed.spec.sourcePath),
    )];
  }

  async start(
    input: BackgroundProcessSpec,
    onChunk: (chunk: OutputChunk) => void = () => undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const name = safeName(input.name);
    const spec = { ...input, name };
    const key = processKey(spec.sourcePath, name);
    if (this.processes.has(key)) {
      throw new Error(`Background process "${name}" is already running`);
    }
    if (signal?.aborted) throw new Error("Background process start was cancelled");

    const tempFile = path.join(
      os.tmpdir(),
      `markdown-notebook-${process.pid}-${Date.now()}-${name}${languageExtension(spec.language)}`,
    );
    await fs.promises.writeFile(tempFile, spec.source + "\n", "utf8");

    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(spec.executable, languageLaunch(spec.language, tempFile), {
        cwd: spec.cwd,
        env: kernelEnv(),
        detached: process.platform !== "win32",
      });
    } catch (error) {
      await fs.promises.rm(tempFile, { force: true });
      throw error;
    }

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const managed: ManagedProcess = {
      spec,
      process: proc,
      tempFile,
      closed,
      capturedOutput: "",
      stopping: false,
    };
    this.processes.set(key, managed);

    const capture = (text: string) => {
      managed.capturedOutput = (managed.capturedOutput + text).slice(-MAX_CAPTURED_OUTPUT);
    };
    proc.stdout.on("data", (data: Buffer) => {
      if (managed.stopping) return;
      const text = data.toString();
      capture(text);
      onChunk({ type: "stream", stream: "stdout", text });
    });
    let stderrBuffer = "";
    const emitStderr = (raw: string) => {
      const text = mapBackgroundDiagnostic(
        raw,
        tempFile,
        spec.sourcePath,
        name,
        spec.sourceMap ?? [],
      );
      capture(text);
      if (text) onChunk({ type: "error", text });
    };
    const flushStderr = () => {
      if (!stderrBuffer) return;
      if (managed.stopping) {
        stderrBuffer = "";
        return;
      }
      emitStderr(stderrBuffer);
      stderrBuffer = "";
    };
    proc.stderr.on("data", (data: Buffer) => {
      if (managed.stopping) return;
      stderrBuffer += stripAnsi(data.toString());
      const completeThrough = Math.max(
        stderrBuffer.lastIndexOf("\n"),
        stderrBuffer.lastIndexOf("\r"),
      );
      if (completeThrough >= 0) {
        const complete = stderrBuffer.slice(0, completeThrough + 1);
        stderrBuffer = stderrBuffer.slice(completeThrough + 1);
        emitStderr(complete);
      }
      if (stderrBuffer.length >= MAX_CAPTURED_OUTPUT) flushStderr();
    });

    let startupSettled = false;
    let rejectStartup: ((error: Error) => void) | null = null;
    const cleanup = () => {
      if (this.processes.get(key) === managed) {
        this.processes.delete(key);
        this.onStateChange(spec.sourcePath, name, false);
      }
      void fs.promises.rm(tempFile, { force: true });
      resolveClosed();
    };
    proc.once("error", (error) => {
      flushStderr();
      cleanup();
      if (!startupSettled) rejectStartup?.(error);
    });
    proc.once("close", (code, signalName) => {
      flushStderr();
      cleanup();
      if (!startupSettled) {
        if (managed.stopping) {
          rejectStartup?.(new KernelCancelledError());
        } else {
          const detail = managed.capturedOutput.trim();
          const message = detail || `Background process "${name}" exited with ${
              code === null ? `signal ${signalName ?? "unknown"}` : `code ${code}`
            }`;
          rejectStartup?.(new KernelExecutionError(message, message));
        }
      }
    });

    const onAbort = () => { void this.stop(spec.sourcePath, name); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        rejectStartup = reject;
        setTimeout(() => {
          startupSettled = true;
          rejectStartup = null;
          if (this.processes.get(key) === managed) {
            this.onStateChange(spec.sourcePath, name, true);
            resolve();
          }
        }, STARTUP_GRACE_MS);
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async stop(sourcePath: string, name: string): Promise<boolean> {
    const key = processKey(sourcePath, name);
    const managed = this.processes.get(key);
    if (!managed) return false;
    managed.stopping = true;

    this.signal(managed, "SIGINT");
    if (await this.waitForClose(managed, STOP_GRACE_MS)) return true;
    this.signal(managed, "SIGTERM");
    if (await this.waitForClose(managed, FORCE_STOP_GRACE_MS)) return true;
    this.signal(managed, "SIGKILL");
    await managed.closed;
    return true;
  }

  async stopForNote(sourcePath: string, language?: string): Promise<void> {
    const targets = [...this.processes.values()].filter((managed) =>
      managed.spec.sourcePath === sourcePath
      && (!language || managed.spec.language === language)
    );
    await Promise.all(targets.map((managed) =>
      this.stop(managed.spec.sourcePath, managed.spec.name)
    ));
  }

  async stopLanguage(language: string): Promise<void> {
    const targets = [...this.processes.values()].filter((managed) =>
      managed.spec.language === language
    );
    await Promise.all(targets.map((managed) =>
      this.stop(managed.spec.sourcePath, managed.spec.name)
    ));
  }

  async stopAll(): Promise<void> {
    const targets = [...this.processes.values()];
    await Promise.all(targets.map((managed) =>
      this.stop(managed.spec.sourcePath, managed.spec.name)
    ));
  }

  private signal(
    managed: ManagedProcess,
    signal: "SIGINT" | "SIGTERM" | "SIGKILL",
  ): void {
    try {
      if (process.platform !== "win32" && managed.process.pid) {
        process.kill(-managed.process.pid, signal);
      } else {
        managed.process.kill(signal);
      }
    } catch {
      // The process can exit between the running check and the signal.
    }
  }

  private async waitForClose(managed: ManagedProcess, timeoutMs: number): Promise<boolean> {
    return Promise.race([
      managed.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }
}
