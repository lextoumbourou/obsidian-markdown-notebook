# Planned Features

This file tracks likely product work beyond the current release.

## DuckDB / SQL support

- [x] Add `sql` as an executable fence language backed by a persistent DuckDB CLI session.
- [x] Implement `DuckDBKernel` using completion markers, rich output, and structured execution errors.
- [x] Preserve session state across cells, including attached databases, temporary tables, and macros.
- [x] Render query results as HTML tables through the existing MIME output pipeline.
- [x] Make relative CSV, Parquet, and JSON paths resolve from the note working directory.
- [x] Support interruption, timeout draining, process exit, and language-level errors without losing the session unnecessarily.
- [x] Add a global DuckDB executable setting and a per-note `notebook.duckdb` override.
- [x] Support DuckDB cells in both the Obsidian plugin and `nb-run` CLI.
- [x] Add unit tests and real smoke tests for queries, errors, state persistence, relative files, output limits, and cancellation.
- [x] Document installation, configuration, supported SQL fences, and direct file-query examples; add an example-vault note.

## TypeScript cells

- [ ] Confirm how Node's type stripping integrates with the existing persistent `vm`-based kernel.
- [ ] Define the minimum supported Node.js version and provide a clear error on older runtimes.
- [ ] Route `typescript` and `ts` fences through the Node kernel while preserving JavaScript session state and diagnostics.
- [ ] Test type syntax, imports, thrown errors, rich output, and plugin/CLI parity.
- [ ] Update the language table, runtime requirements, and examples.

## Julia support

- [ ] Prototype a persistent Julia kernel against the `BaseKernel` lifecycle.
- [ ] Design completion/error framing, rich display output, interruption, and timeout recovery.
- [ ] Add executable settings and per-note frontmatter overrides.
- [ ] Add plugin/CLI integration, tests, documentation, and an example note.
