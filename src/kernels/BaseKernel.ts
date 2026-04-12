import { ChildProcessWithoutNullStreams } from "child_process";
import type { OutputChunk } from "../output/MimeRenderer";

export const RICH_SIGIL = "\x00NB_RICH\x00";
export const SETUP_DONE_SIGIL = "__NB_SETUP_DONE__";

/**
 * Return a process env with common binary directories prepended to PATH.
 * Obsidian launched from the Dock doesn't inherit the user's shell PATH,
 * so executables in /usr/local/bin or /opt/homebrew/bin are otherwise invisible.
 */
export function kernelEnv(): Record<string, string | undefined> {
  const extra = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/bin",
    "/bin",
  ];
  const current = process.env.PATH ?? "";
  const parts = current.split(":").filter(Boolean);
  const merged = [...extra.filter((p) => !parts.includes(p)), ...parts].join(":");
  return { ...process.env, PATH: merged };
}

/**
 * Shared infrastructure for persistent-REPL kernels.
 *
 * Subclasses implement:
 *   start()        — spawn the process, wait for it to be ready, set this.process
 *   wrapCode()     — wrap user code with a finish sigil
 *   filterStderr() — clean stderr (strip prompts, ANSI codes, etc.)
 *
 * Subclasses may override stop() for additional cleanup (temp files, etc.),
 * but must call super.stop().
 */
export abstract class BaseKernel {
  protected process: ChildProcessWithoutNullStreams | null = null;
  protected starting: Promise<void> | null = null;
  private execQueue: Promise<void> = Promise.resolve();
  executionCount = 0;

  protected abstract start(): Promise<void>;
  protected abstract wrapCode(code: string, finishSigil: string): string;
  protected abstract filterStderr(text: string): string;

  async ensureStarted(): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    return this.starting;
  }

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

  private async doExecute(
    code: string,
    onChunk: (chunk: OutputChunk) => void,
    timeoutMs: number
  ): Promise<void> {
    await this.ensureStarted();
    if (!this.process) throw new Error("Kernel not running");

    const finishSigil = `__NB_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const wrapped = this.wrapCode(code, finishSigil);

    return new Promise<void>((resolve, reject) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.process?.stdout.removeListener("data", onStdout);
        this.process?.stderr.removeListener("data", onStderr);
        this.executionCount++;
        resolve();
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.process?.stdout.removeListener("data", onStdout);
        this.process?.stderr.removeListener("data", onStderr);
        reject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onStdout = (data: Buffer) => {
        stdoutBuf += data.toString();
        const sigilIdx = stdoutBuf.indexOf(finishSigil);
        if (sigilIdx >= 0) {
          const before = stdoutBuf.substring(0, sigilIdx);
          if (before) emitText(before);
          finish();
          return;
        }
        const lastNl = stdoutBuf.lastIndexOf("\n");
        if (lastNl >= 0) {
          const complete = stdoutBuf.substring(0, lastNl + 1);
          stdoutBuf = stdoutBuf.substring(lastNl + 1);
          emitText(complete);
        }
      };

      const onStderr = (data: Buffer) => {
        stderrBuf += data.toString();
        const lastNl = stderrBuf.lastIndexOf("\n");
        if (lastNl >= 0) {
          const complete = stderrBuf.substring(0, lastNl + 1);
          stderrBuf = stderrBuf.substring(lastNl + 1);
          const filtered = this.filterStderr(complete);
          if (filtered) onChunk({ type: "error", text: filtered + "\n" });
        }
      };

      const emitText = (text: string) => {
        const lines = text.split("\n");
        let plainBuf = "";
        for (const line of lines) {
          if (line.startsWith(RICH_SIGIL)) {
            if (plainBuf) {
              onChunk({ type: "stream", stream: "stdout", text: plainBuf });
              plainBuf = "";
            }
            try {
              const parsed = JSON.parse(line.slice(RICH_SIGIL.length));
              onChunk({ type: "rich", mime: parsed.mime, data: parsed.data });
            } catch {
              onChunk({ type: "stream", stream: "stdout", text: line + "\n" });
            }
          } else {
            plainBuf += line + "\n";
          }
        }
        if (plainBuf.trim()) {
          onChunk({ type: "stream", stream: "stdout", text: plainBuf });
        }
      };

      this.process!.stdout.on("data", onStdout);
      this.process!.stderr.on("data", onStderr);
      this.process!.stdin.write(wrapped);
    });
  }

  interrupt(): void {
    this.process?.kill("SIGINT");
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.starting = null;
    }
    this.executionCount = 0;
  }

  /** Helper: wait for a sigil string to appear on the process stdout. */
  protected waitForSigil(sigil: string, timeoutMs = 15000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let buf = "";
      const onData = (data: Buffer) => {
        buf += data.toString();
        if (buf.includes(sigil)) {
          this.process?.stdout.removeListener("data", onData);
          resolve();
        }
      };
      this.process!.stdout.on("data", onData);
      this.process!.once("error", reject);
      setTimeout(() => reject(new Error("Kernel startup timed out")), timeoutMs);
    });
  }
}

/** Strip ANSI escape codes. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
