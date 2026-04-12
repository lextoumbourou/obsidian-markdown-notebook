import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseKernel, RICH_SIGIL, SETUP_DONE_SIGIL, stripAnsi, kernelEnv } from "./BaseKernel";

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
    print(repr(obj), flush=True)

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
    tree = __nb_ast__.parse(code_str, filename='<nb>', mode='exec')
    if not tree.body:
        return
    last = tree.body[-1]
    if isinstance(last, __nb_ast__.Expr):
        if len(tree.body) > 1:
            rest = __nb_ast__.Module(body=tree.body[:-1], type_ignores=[])
            exec(compile(rest, '<nb>', 'exec'), __nb_globals__)
        last_expr = __nb_ast__.Expression(body=last.value)
        result = eval(compile(last_expr, '<nb>', 'eval'), __nb_globals__)
        __nb_display__(result)
    else:
        exec(compile(tree, '<nb>', 'exec'), __nb_globals__)

print(${JSON.stringify(SETUP_DONE_SIGIL)}, flush=True)
`;

export class SubprocessKernel extends BaseKernel {
  private pythonPath: string;
  private setupFile: string | null = null;

  constructor(pythonPath: string) {
    super();
    this.pythonPath = pythonPath;
  }

  protected async start(): Promise<void> {
    this.setupFile = path.join(os.tmpdir(), `nb_setup_${Date.now()}.py`);
    await fs.promises.writeFile(this.setupFile, SETUP_SCRIPT, "utf8");

    this.process = spawn(this.pythonPath, ["-i", "-u", this.setupFile], {
      env: kernelEnv(),
    });
    this.process.on("close", () => { this.process = null; this.starting = null; });
    this.process.on("error", (err) => {
      console.error("[MarkdownNotebook] Python error:", err);
      this.process = null;
      this.starting = null;
    });

    await this.waitForSigil(SETUP_DONE_SIGIL);
  }

  protected wrapCode(code: string, finishSigil: string): string {
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

  protected filterStderr(text: string): string {
    return stripAnsi(text).replace(/^(>>>|\.\.\.) ?/gm, "").trimEnd();
  }

  stop(): void {
    super.stop();
    if (this.setupFile) {
      fs.promises.rm(this.setupFile).catch(() => {});
      this.setupFile = null;
    }
  }
}
