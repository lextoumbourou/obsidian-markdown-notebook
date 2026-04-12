import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseKernel, RICH_SIGIL, SETUP_DONE_SIGIL, stripAnsi, kernelEnv } from "./BaseKernel";

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

.nb_show_rich <- function(mime, data) {
  cat(.nb_rich, '{"mime":', paste0('"', mime, '"'), ',"data":', paste0('"', data, '"'), '}\\n', sep='')
}

.nb_display <- function(x) {
  if (is.null(x) || identical(x, invisible(NULL))) return(invisible(NULL))
  # Data frame / tibble: try HTML table
  if (is.data.frame(x)) {
    tryCatch({
      html <- paste(knitr::kable(x, format='html', table.attr='class="nb-table"'), collapse='\\n')
      .nb_show_rich('text/html', jsonlite::base64_enc(chartr('\\n', ' ', html)))
      return(invisible(NULL))
    }, error = function(e) {})
  }
  print(x)
  invisible(NULL)
}

# Capture plots: override the default display device after each cell
# (Requires grDevices, base64enc, jsonlite — silently skipped otherwise)
.nb_capture_plot <- function() {
  tryCatch({
    tmp <- tempfile(fileext = '.png')
    dev.copy(png, filename = tmp, width = 800, height = 500)
    dev.off()
    data <- base64enc::base64encode(tmp)
    file.remove(tmp)
    .nb_show_rich('image/png', data)
  }, error = function(e) {})
}

cat(${JSON.stringify(SETUP_DONE_SIGIL)}, '\\n', sep='')
`;

export class RKernel extends BaseKernel {
  private rPath: string;
  private setupFile: string | null = null;

  constructor(rPath: string) {
    super();
    this.rPath = rPath;
  }

  protected async start(): Promise<void> {
    this.setupFile = path.join(os.tmpdir(), `nb_r_${Date.now()}.R`);
    await fs.promises.writeFile(this.setupFile, SETUP_SCRIPT, "utf8");

    // --slave suppresses prompts; the setup file is sourced via stdin piping
    this.process = spawn(
      this.rPath,
      ["--slave", "--no-save", "--no-restore"],
      { env: kernelEnv() }
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
  error = function(e) cat(paste0("Error: ", conditionMessage(e), "\\n"), file = stderr())
)
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
