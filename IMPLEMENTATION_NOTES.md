# Implementation Notes

## Managed background cells

### Goal

Allow a notebook cell to start a long-running process without blocking later
cells. The feature must work for Python, JavaScript, Bash and R, and the plugin
must remain responsible for stopping every process it starts.

### Cell syntax

````markdown
```python {background=calculator ready=port:8000}
serve()
```
````

`background` is a note-scoped process name. Running the cell starts it. While
it is running, the cell's Run button becomes a Stop button. With `ready`, Run
All waits for a TCP port or literal output before it continues. Without
`ready`, it retains the original 400 ms startup grace.

### Design decisions

- Run background cells in fresh subprocesses, not persistent notebook kernels.
  A blocking server must not occupy the kernel or mix its output into later
  cell executions.
- Tangle preceding, non-background cells of the same language before the
  background cell. The fresh process therefore follows document order and has
  the imports and definitions available at that point in the notebook.
- Let `{context=none}` opt out of tangling for a self-contained background
  process. `context=above` is the default.
- Use the configured executable and working directory for each language.
- Support `ready=port:<number>` on `127.0.0.1` and literal output readiness,
  including double-quoted values with spaces. Readiness belongs to the process
  manager, independently of source tangling.
- Keep separate, bounded raw stdout and stderr readiness tails so interleaved
  streams and display buffering cannot break a match across chunks.
- Reject a port that is already open before launch as a helpful diagnostic,
  while process exit and the readiness timeout remain authoritative.
- Use `notebook.readyTimeout`, defaulting to 15 seconds, and stop a process
  that never becomes ready.
- Keep Python background output unbuffered with `-u` and
  `PYTHONUNBUFFERED=1`.
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
- `nb-run --only` limits which cell emits output, not which cells are tangled
  into a selected background program.
- Map common Python, Node and shell temporary-file diagnostics back to note
  lines and identify replayed setup cells.
- Reading View uses Obsidian's cached vault content when tangling. An edit that
  has not reached the vault cache can still be absent from a background run;
  save the note before starting when exact edit timing matters.

### Verification

- [x] Parser tests cover named background cells in every supported language.
- [x] Process-manager tests cover start, duplicate names, output, state and stop.
- [x] Readiness tests cover delayed TCP binding, occupied ports, literal output
      split across chunks, stream interleaving, timeout diagnostics and port
      reuse after a complete stop.
- [x] Run-button tests cover start and Stop-button behaviour.
- [x] Run All tests prove that later cells execute while a background cell is
      still running.
- [x] Tangling tests cover same-language context, interleaved languages,
      earlier background cells, `context=none` and diagnostic line mapping.
- [x] Lint, unit tests and production build pass.
