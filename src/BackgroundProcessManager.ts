import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
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
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const PORT_POLL_INTERVAL_MS = 50;
const PORT_CONNECT_TIMEOUT_MS = 200;
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
  ready?: string;
  readyTimeoutMs?: number;
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

type Readiness =
  | { kind: "port"; port: number }
  | { kind: "output"; literal: string };

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

function parseReadiness(value: string | undefined): Readiness | undefined {
  if (value === undefined) return undefined;
  if (!value) throw new Error("ready must be port:<number> or a non-empty output literal");
  if (value.startsWith("port:")) {
    if (!/^port:\d+$/.test(value)) {
      throw new Error(`Invalid ready value "${value}": use port:<number> or an output literal`);
    }
    const port = Number(value.slice("port:".length));
    if (port < 1 || port > 65535) {
      throw new Error(`Invalid ready port ${port}: use a number from 1 to 65535`);
    }
    return { kind: "port", port };
  }
  return { kind: "output", literal: value };
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(PORT_CONNECT_TIMEOUT_MS, () => finish(false));
  });
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
  private starting = new Set<string>();

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
    const existing = this.processes.get(key);
    if (existing) {
      throw new Error(
        `Background process "${name}" is already ${existing.stopping ? "stopping" : "running"}`,
      );
    }
    if (this.starting.has(key)) {
      throw new Error(`Background process "${name}" is already starting`);
    }
    if (signal?.aborted) throw new Error("Background process start was cancelled");
    const readiness = parseReadiness(spec.ready);
    const readyTimeoutMs = spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
      throw new Error("Background readiness timeout must be greater than zero");
    }
    this.starting.add(key);
    const tempFile = path.join(
      os.tmpdir(),
      `markdown-notebook-${process.pid}-${Date.now()}-${name}${languageExtension(spec.language)}`,
    );
    let proc!: ChildProcessWithoutNullStreams;
    try {
      if (readiness?.kind === "port" && await isPortOpen(readiness.port)) {
        throw new Error(
          `Port ${readiness.port} was already in use on 127.0.0.1 before ` +
          `background process "${name}" started`,
        );
      }
      if (signal?.aborted) throw new KernelCancelledError();
      await fs.promises.writeFile(tempFile, spec.source + "\n", "utf8");
      proc = spawn(spec.executable, languageLaunch(spec.language, tempFile), {
        cwd: spec.cwd,
        env: spec.language === "python"
          ? { ...kernelEnv(), PYTHONUNBUFFERED: "1" }
          : kernelEnv(),
        detached: process.platform !== "win32",
      });
    } catch (error) {
      await fs.promises.rm(tempFile, { force: true });
      throw error;
    } finally {
      this.starting.delete(key);
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

    let startupSettled = false;
    let startupStopping = false;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let portPollTimer: ReturnType<typeof setInterval> | undefined;
    let resolveStartup!: () => void;
    let rejectStartup!: (error: Error) => void;
    const startup = new Promise<void>((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    const clearStartupTimers = () => {
      if (startupTimer) clearTimeout(startupTimer);
      if (portPollTimer) clearInterval(portPollTimer);
      startupTimer = undefined;
      portPollTimer = undefined;
    };
    const settleStartup = () => {
      if (startupSettled || startupStopping) return;
      startupSettled = true;
      clearStartupTimers();
      if (this.processes.get(key) === managed) {
        this.onStateChange(spec.sourcePath, name, true);
        resolveStartup();
      } else {
        rejectStartup(new Error(
          `Background process "${name}" lost ownership while starting`,
        ));
      }
    };
    const failStartup = (error: Error) => {
      if (startupSettled || startupStopping) return;
      startupSettled = true;
      clearStartupTimers();
      rejectStartup(error);
    };
    const failStartupAndStop = async (error: Error) => {
      if (startupSettled || startupStopping) return;
      startupStopping = true;
      clearStartupTimers();
      await this.stop(spec.sourcePath, name);
      startupSettled = true;
      startupStopping = false;
      rejectStartup(error);
    };

    const readinessTails = { stdout: "", stderr: "" };
    const inspectReadiness = (stream: keyof typeof readinessTails, text: string) => {
      if (readiness?.kind !== "output" || startupSettled || startupStopping) return;
      const candidate = readinessTails[stream] + text;
      if (candidate.includes(readiness.literal)) {
        settleStartup();
        return;
      }
      const retained = Math.max(0, readiness.literal.length - 1);
      readinessTails[stream] = retained === 0 ? "" : candidate.slice(-retained);
    };
    const capture = (text: string) => {
      managed.capturedOutput = (managed.capturedOutput + text).slice(-MAX_CAPTURED_OUTPUT);
    };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (text: string) => {
      if (managed.stopping) return;
      inspectReadiness("stdout", text);
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
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (raw: string) => {
      if (managed.stopping) return;
      const text = stripAnsi(raw);
      inspectReadiness("stderr", text);
      stderrBuffer += text;
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

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearStartupTimers();
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
      failStartup(error);
    });
    proc.once("close", (code, signalName) => {
      flushStderr();
      cleanup();
      if (!startupSettled && !startupStopping) {
        if (managed.stopping) {
          failStartup(new KernelCancelledError());
        } else {
          const detail = managed.capturedOutput.trim();
          const message = detail || `Background process "${name}" exited with ${
              code === null ? `signal ${signalName ?? "unknown"}` : `code ${code}`
            }`;
          failStartup(new KernelExecutionError(message, message));
        }
      }
    });

    if (!readiness) {
      startupTimer = setTimeout(settleStartup, STARTUP_GRACE_MS);
    } else {
      const description = readiness.kind === "port"
        ? `port ${readiness.port} on 127.0.0.1`
        : `output "${readiness.literal}"`;
      startupTimer = setTimeout(() => {
        const message = `Background process "${name}" was not ready after ` +
          `${readyTimeoutMs}ms while waiting for ${description}`;
        flushStderr();
        const captured = managed.capturedOutput.trim();
        void failStartupAndStop(new KernelExecutionError(
          message,
          captured ? `${message}\n${captured}` : message,
        ));
      }, readyTimeoutMs);
      if (readiness.kind === "port") {
        let checking = false;
        const checkPort = async () => {
          if (checking || startupSettled || startupStopping) return;
          checking = true;
          const open = await isPortOpen(readiness.port);
          checking = false;
          if (open) settleStartup();
        };
        portPollTimer = setInterval(() => { void checkPort(); }, PORT_POLL_INTERVAL_MS);
        void checkPort();
      }
    }

    const onAbort = () => { void this.stop(spec.sourcePath, name); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await startup;
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
