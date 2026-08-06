# Implementation Notes

## Managed background cells

### Goal

Allow a notebook cell to start a long-running process without blocking later
cells. The feature must work for Python, JavaScript, Bash and R, and the plugin
must remain responsible for stopping every process it starts.

### Cell syntax

````markdown
```python {background=calculator}
serve()
```
````

`background` is a note-scoped process name. Running the cell starts it. While
it is running, the cell's Run button becomes a Stop button. Run All starts the
process and immediately continues to the next cell.

### Design decisions

- Run background cells in fresh subprocesses, not persistent notebook kernels.
  A blocking server must not occupy the kernel or mix its output into later
  cell executions.
- Use the configured executable and working directory for each language.
- Write cell source to a temporary file. This avoids shell quoting and makes
  the same mechanism work across all supported languages.
- Keep processes attached to the plugin. Stop them when their cell is stopped,
  their note closes or is renamed or deleted, kernels are restarted, or the
  plugin unloads.
- Reset rendered Stop buttons when a process exits without a manual stop.
- Send `SIGINT` first, then escalate when a process does not exit.
- Keep the Markdown output finite. Persist the startup output, while draining
  later process output in memory so a noisy server cannot block.
- The headless CLI supports background cells during a multi-cell run and stops
  all of them before it exits.

### Verification

- [x] Parser tests cover named background cells in every supported language.
- [x] Process-manager tests cover start, duplicate names, output, state and stop.
- [x] Run-button tests cover start and Stop-button behaviour.
- [x] Run All tests prove that later cells execute while a background cell is
      still running.
- [x] Lint, unit tests and production build pass.
