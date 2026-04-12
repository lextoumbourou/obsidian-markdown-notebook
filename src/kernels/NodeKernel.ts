import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseKernel, RICH_SIGIL, SETUP_DONE_SIGIL, stripAnsi, kernelEnv } from "./BaseKernel";

// Delimiter marking the end of a job message sent over stdin.
const CMD_END = "\x00NB_CMD\x00";

/**
 * Persistent Node.js kernel using vm.createContext.
 *
 * Protocol: TypeScript writes JSON.stringify({code, sigil}) + CMD_END to stdin.
 * The setup script reads, executes in shared context, writes sigil to stdout.
 *
 * Note: only synchronous code is supported. Top-level await is not available
 * in vm.runInContext without additional setup.
 */
const SETUP_SCRIPT = `
const vm = require('vm');
const RICH_SIGIL = ${JSON.stringify(RICH_SIGIL)};
const CMD_END = ${JSON.stringify(CMD_END)};

const __nb_ctx__ = vm.createContext(Object.assign({}, global, {
  require,
  console,
  process,
  Buffer,
  setTimeout, setInterval, clearTimeout, clearInterval,
  Promise, JSON, Math, Date, Error, RegExp, Array, Object, Map, Set,
  __nb_display__: function(v) {
    if (v === undefined || v === null) return;
    const s = (typeof v === 'object') ? JSON.stringify(v, null, 2) : String(v);
    process.stdout.write(s + '\\n');
  },
}));

process.stdout.write(${JSON.stringify(SETUP_DONE_SIGIL)} + '\\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buf += data;
  let idx;
  while ((idx = buf.indexOf(CMD_END)) !== -1) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + CMD_END.length);
    let job;
    try { job = JSON.parse(raw); } catch { continue; }
    const { code, sigil } = job;
    try {
      const result = vm.runInContext(code, __nb_ctx__);
      if (result !== undefined) __nb_ctx__.__nb_display__(result);
    } catch (e) {
      process.stderr.write((e.stack || String(e)) + '\\n');
    }
    process.stdout.write(sigil);
  }
});
`;

export class NodeKernel extends BaseKernel {
  private nodePath: string;
  private setupFile: string | null = null;

  constructor(nodePath: string) {
    super();
    this.nodePath = nodePath;
  }

  protected async start(): Promise<void> {
    this.setupFile = path.join(os.tmpdir(), `nb_node_${Date.now()}.js`);
    await fs.promises.writeFile(this.setupFile, SETUP_SCRIPT, "utf8");

    this.process = spawn(this.nodePath, [this.setupFile], { env: kernelEnv() });
    this.process.on("close", () => { this.process = null; this.starting = null; });
    this.process.on("error", (err) => {
      console.error("[MarkdownNotebook] Node error:", err);
      this.process = null;
      this.starting = null;
    });

    await this.waitForSigil(SETUP_DONE_SIGIL);
  }

  protected wrapCode(code: string, finishSigil: string): string {
    return JSON.stringify({ code, sigil: finishSigil }) + CMD_END;
  }

  protected filterStderr(text: string): string {
    return stripAnsi(text).trimEnd();
  }

  stop(): void {
    super.stop();
    if (this.setupFile) {
      fs.promises.rm(this.setupFile).catch(() => {});
      this.setupFile = null;
    }
  }
}
