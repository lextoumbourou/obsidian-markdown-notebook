import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { OutputChunk } from "../output/MimeRenderer";

// Sentinel printed as the very first char of each rich output line.
// \x00 won't appear in normal text output.
const RICH_SIGIL = "\x00NB_RICH\x00";
const SETUP_DONE_SIGIL = "__NB_SETUP_DONE__";

/**
 * Python setup script injected at kernel startup.
 * Runs before the REPL enters interactive mode (via python3 -i setup.py).
 *
 * Provides:
 *   __nb_globals__  — persistent namespace shared across all cells
 *   __nb_display__  — rich repr dispatcher
 *   plt.show        — overridden to emit base64 PNG
 */
const SETUP_SCRIPT = `
import sys as __nb_sys__
import json as __nb_json__
import base64 as __nb_base64__

__nb_globals__ = {**globals()}
__NB_RICH__ = ${JSON.stringify(RICH_SIGIL)}

def __nb_show_rich__(mime, data):
    print(__NB_RICH__ + __nb_json__.dumps({'mime': mime, 'data': data}), flush=True)

def __nb_display__(obj):
    if obj is None:
        return
    for attr, mime in [
        ('_repr_html_',    'text/html'),
        ('_repr_svg_',     'image/svg+xml'),
        ('_repr_markdown_','text/markdown'),
    ]:
        try:
            result = getattr(obj, attr)()
            if result:
                __nb_show_rich__(mime, result)
                return
        except Exception:
            pass
    try:
        png = obj._repr_png_()
        if png:
            __nb_show_rich__('image/png', __nb_base64__.b64encode(png).decode())
            return
    except Exception:
        pass
    # Fall back to plain text repr
    print(repr(obj), flush=True)

# Override plt.show() to capture plots as base64 PNG
try:
    import matplotlib as __nb_mpl__
    __nb_mpl__.use('agg')
    import matplotlib.pyplot as __nb_plt__
    import io as __nb_io__
    def __nb_plt_show__(*args, **kwargs):
        buf = __nb_io__.BytesIO()
        __nb_plt__.savefig(buf, format='png', bbox_inches='tight')
        buf.seek(0)
        __nb_show_rich__('image/png', __nb_base64__.b64encode(buf.read()).decode())
        buf.close()
        __nb_plt__.clf()
    __nb_plt__.show = __nb_plt_show__
    __nb_globals__['plt'] = __nb_plt__
except Exception:
    pass

import ast as __nb_ast__

def __nb_run__(code_str):
    """
    Execute a cell, displaying the result of the last expression if any.
    Uses ast.parse to split statements so that multi-line cells like:
        import pandas as pd
        df = pd.DataFrame(...)
        df          <- this last expression is eval'd and displayed
    work correctly.
    """
    tree = __nb_ast__.parse(code_str, filename='<nb>', mode='exec')
    if not tree.body:
        return
    last = tree.body[-1]
    if isinstance(last, __nb_ast__.Expr):
        # Execute all statements before the last one
        if len(tree.body) > 1:
            rest = __nb_ast__.Module(body=tree.body[:-1], type_ignores=[])
            exec(compile(rest, '<nb>', 'exec'), __nb_globals__)
        # Eval the last expression and display it
        last_expr = __nb_ast__.Expression(body=last.value)
        result = eval(compile(last_expr, '<nb>', 'eval'), __nb_globals__)
        __nb_display__(result)
    else:
        exec(compile(tree, '<nb>', 'exec'), __nb_globals__)

print(${JSON.stringify(SETUP_DONE_SIGIL)}, flush=True)
`;

/**
 * Wrap user code for execution in the persistent REPL.
 * Delegates to __nb_run__ (defined in setup) which handles the
 * eval-last-expression logic via ast.parse.
 */
function wrapCode(code: string, finishSigil: string): string {
  const escaped = JSON.stringify(code.replace(/\r\n/g, "\n") + "\n");
  return `
try:
    __nb_run__(${escaped})
except BaseException as __nb_e__:
    import traceback as __nb_tb__
    print(__nb_tb__.format_exc(), file=__nb_sys__.stderr, flush=True)
finally:
    print(${JSON.stringify(finishSigil)}, end='', flush=True)

`;
}

export class SubprocessKernel {
  private process: ChildProcessWithoutNullStreams | null = null;
  private pythonPath: string;
  private setupFile: string | null = null;
  private starting: Promise<void> | null = null;
  private execQueue: Promise<void> = Promise.resolve();
  executionCount = 0;

  constructor(pythonPath: string) {
    this.pythonPath = pythonPath;
  }

  /**
   * Ensure the kernel is started. Idempotent — safe to call multiple times.
   */
  async ensureStarted(): Promise<void> {
    if (this.process) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    return this.starting;
  }

  private async start(): Promise<void> {
    // Write the setup script to a temp file so python3 -i can exec it at startup
    this.setupFile = path.join(os.tmpdir(), `nb_setup_${Date.now()}.py`);
    await fs.promises.writeFile(this.setupFile, SETUP_SCRIPT, "utf8");

    this.process = spawn(this.pythonPath, ["-i", "-u", this.setupFile], {
      env: process.env,
    });

    this.process.on("close", () => {
      this.process = null;
      this.starting = null;
    });

    this.process.on("error", (err) => {
      console.error("[MarkdownNotebook] Python process error:", err);
      this.process = null;
      this.starting = null;
    });

    // Wait for the setup done sigil on stdout
    await new Promise<void>((resolve, reject) => {
      let buf = "";
      const onData = (data: Buffer) => {
        buf += data.toString();
        if (buf.includes(SETUP_DONE_SIGIL)) {
          this.process?.stdout.removeListener("data", onData);
          resolve();
        }
      };
      this.process!.stdout.on("data", onData);
      this.process!.once("error", reject);

      // Timeout safety
      setTimeout(() => reject(new Error("Kernel startup timed out")), 15000);
    });
  }

  /**
   * Execute a code block. Chunks are emitted via onChunk as they arrive.
   * Resolves when execution is complete (finish sigil received).
   * Rejects on timeout or process death.
   *
   * Executions are serialised — concurrent calls queue up.
   */
  execute(code: string, onChunk: (chunk: OutputChunk) => void, timeoutMs: number): Promise<void> {
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
    if (!this.process) throw new Error("Python kernel not running");

    const finishSigil = `__NB_DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const wrapped = wrapCode(code, finishSigil);

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
          // Emit everything before the sigil
          const before = stdoutBuf.substring(0, sigilIdx);
          if (before) emitText(before);
          finish();
          return;
        }

        // Emit complete lines immediately for live streaming; hold last partial line
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
          // Strip ANSI escape codes (Python 3.11+ emits coloured tracebacks)
          const noAnsi = complete.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
          // Filter out the Python REPL prompts (>>> and ...)
          const filtered = noAnsi.replace(/^(>>>|\.\.\.) ?/gm, "").trimEnd();
          if (filtered) onChunk({ type: "error", text: filtered + "\n" });
        }
      };

      const emitText = (text: string) => {
        // Split on RICH_SIGIL lines
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
    if (this.setupFile) {
      fs.promises.rm(this.setupFile).catch(() => {});
      this.setupFile = null;
    }
  }
}
