import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseKernel, ERROR_SIGIL, RICH_SIGIL, SETUP_DONE_SIGIL, stripAnsi, kernelEnv } from "./BaseKernel";

/**
 * R kernel using a persistent `R --slave --no-save --no-restore` process.
 *
 * Rich output (data frames as HTML, plots as PNG) is emitted via the
 * NB_RICH sentinel if the required packages are available:
 *   - knitr + jsonlite  → data frame HTML tables
 *   - grDevices + jsonlite + base64enc  → plot PNG capture
 *
 * Everything degrades gracefully to plain text if packages are absent.
 */
const SETUP_SCRIPT = `
.nb_rich <- ${JSON.stringify(RICH_SIGIL)}
.nb_error <- ${JSON.stringify(ERROR_SIGIL)}

# Proper JSON via jsonlite so quotes/newlines in data are escaped — the
# payload stays on one line and the TS side JSON.parses it back.
.nb_show_rich <- function(mime, data) {
  payload <- jsonlite::toJSON(list(mime = mime, data = data), auto_unbox = TRUE)
  cat(.nb_rich, payload, '\\n', sep = '')
}

.nb_display <- function(x) {
  if (is.null(x)) return(invisible(NULL))
  # Data frame / tibble: try HTML table (requires knitr + jsonlite)
  if (is.data.frame(x)) {
    ok <- tryCatch({
      html <- paste(knitr::kable(x, format = 'html', table.attr = 'class="nb-table"'), collapse = '\\n')
      .nb_show_rich('text/html', html)
      TRUE
    }, error = function(e) FALSE)
    if (ok) return(invisible(NULL))
  }
  print(x)
  invisible(NULL)
}

# Plot capture: in a headless session R opens the default device (Rplots.pdf)
# on first plot. Route it to a PNG tempfile instead via options(device);
# .nb_flush_plot() emits and closes it after each cell.
# (Requires base64enc + jsonlite — degrades to no plot output otherwise)
.nb_plot_file <- NULL
.nb_plot_dev <- NULL
options(device = function(...) {
  .nb_plot_file <<- tempfile(fileext = '.png')
  grDevices::png(.nb_plot_file, width = 800, height = 500, res = 96)
  .nb_plot_dev <<- grDevices::dev.cur()
})

.nb_flush_plot <- function() {
  tryCatch({
    if (!is.null(.nb_plot_dev) && .nb_plot_dev %in% grDevices::dev.list()) {
      grDevices::dev.off(.nb_plot_dev)
      if (file.exists(.nb_plot_file) && file.size(.nb_plot_file) > 0) {
        .nb_show_rich('image/png', base64enc::base64encode(.nb_plot_file))
      }
      file.remove(.nb_plot_file)
    }
  }, error = function(e) {})
  .nb_plot_file <<- NULL
  .nb_plot_dev <<- NULL
}

cat(${JSON.stringify(SETUP_DONE_SIGIL)}, '\\n', sep = '')
`;

export class RKernel extends BaseKernel {
  private rPath: string;
  private cwd?: string;
  private setupFile: string | null = null;

  constructor(rPath: string, cwd?: string) {
    super();
    this.rPath = rPath;
    this.cwd = cwd;
  }

  protected async start(): Promise<void> {
    this.setupFile = path.join(os.tmpdir(), `nb_r_${Date.now()}.R`);
    await fs.promises.writeFile(this.setupFile, SETUP_SCRIPT, "utf8");

    // --slave suppresses prompts; the setup file is sourced via stdin piping
    this.process = spawn(
      this.rPath,
      ["--slave", "--no-save", "--no-restore"],
      { env: kernelEnv(), cwd: this.cwd }
    );
    this.process.on("close", () => { this.process = null; this.starting = null; });
    this.process.on("error", (err) => {
      console.error("[MarkdownNotebook] R error:", err);
      this.process = null;
      this.starting = null;
    });

    // Pipe the setup script then wait for ready sigil
    const setupContent = await fs.promises.readFile(this.setupFile, "utf8");
    this.process.stdin.write(setupContent + "\n");
    await this.waitForSigil(SETUP_DONE_SIGIL);
  }

  protected wrapCode(code: string, finishSigil: string): string {
    // withVisible preserves auto-print behaviour for the last expression
    const escaped = code.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `
tryCatch(
  withCallingHandlers(
    {
      .nb_result <- withVisible(eval(parse(text = '${escaped}')))
      if (.nb_result$visible) .nb_display(.nb_result$value)
    },
    message = function(m) {
      cat(conditionMessage(m), file = stderr())
      invokeRestart("muffleMessage")
    }
  ),
  error = function(e) {
    detail <- paste0("Error: ", conditionMessage(e))
    cat(.nb_error, "url:", utils::URLencode(detail, reserved = TRUE), '\\n', sep = '')
  }
)
.nb_flush_plot()
cat(${JSON.stringify(finishSigil)}, sep='')
`;
  }

  protected filterStderr(text: string): string {
    return stripAnsi(text)
      // R startup messages when not fully suppressed
      .replace(/^(\s*>|\s*\+) ?/gm, "")
      .trimEnd();
  }

  stop(): void {
    super.stop();
    if (this.setupFile) {
      fs.promises.rm(this.setupFile).catch(() => {});
      this.setupFile = null;
    }
  }
}
