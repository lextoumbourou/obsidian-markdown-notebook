import { parseArgs, parseNotebookFrontmatter, selectCells, CliOptions } from '../src/cli';

describe('parseArgs', () => {
  const ok = (argv: string[]): CliOptions => {
    const r = parseArgs(argv);
    if ('error' in r || 'help' in r) throw new Error(`expected options, got ${JSON.stringify(r)}`);
    return r;
  };

  it('parses a bare file argument with defaults', () => {
    const opts = ok(['Note.md']);
    expect(opts.file).toBe('Note.md');
    expect(opts.write).toBe(false);
    expect(opts.only).toBe(false);
    expect(opts.paths.python).toBe('python3');
  });

  it('parses selectors and flags', () => {
    const opts = ok(['Note.md', '--cell', '3', '--only', '--write', '--timeout', '5000']);
    expect(opts.cell).toBe(3);
    expect(opts.only).toBe(true);
    expect(opts.write).toBe(true);
    expect(opts.timeout).toBe(5000);
  });

  it('parses interpreter path overrides', () => {
    const opts = ok(['Note.md', '--python', '/venv/bin/python3', '--r', '/usr/local/bin/R']);
    expect(opts.paths.python).toBe('/venv/bin/python3');
    expect(opts.paths.r).toBe('/usr/local/bin/R');
  });

  it('returns help for -h', () => {
    expect(parseArgs(['-h'])).toEqual({ help: true });
  });

  it('errors on missing file', () => {
    expect(parseArgs(['--list'])).toHaveProperty('error');
  });

  it('errors on unknown option', () => {
    expect(parseArgs(['Note.md', '--frobnicate'])).toHaveProperty('error');
  });

  it('errors on non-numeric --cell', () => {
    expect(parseArgs(['Note.md', '--cell', 'abc'])).toHaveProperty('error');
  });

  it('errors when a value option ends the argv', () => {
    expect(parseArgs(['Note.md', '--id'])).toHaveProperty('error');
  });
});

describe('parseNotebookFrontmatter', () => {
  it('returns empty for files without frontmatter', () => {
    expect(parseNotebookFrontmatter('# Title\n```python\n```')).toEqual({});
  });

  it('parses the notebook block', () => {
    const content = [
      '---',
      'title: My Note',
      'notebook:',
      '  format: image',
      '  media: attachments',
      '  timeout: 60000',
      '  markdownLinks: true',
      '---',
      '# Body',
    ].join('\n');
    expect(parseNotebookFrontmatter(content)).toEqual({
      format: 'image',
      media: 'attachments',
      timeout: 60000,
      markdownLinks: true,
    });
  });

  it('ignores keys outside the notebook block', () => {
    const content = ['---', 'format: image', 'timeout: 5', '---', ''].join('\n');
    expect(parseNotebookFrontmatter(content)).toEqual({});
  });

  it('rejects invalid format values', () => {
    const content = ['---', 'notebook:', '  format: gif', '---', ''].join('\n');
    expect(parseNotebookFrontmatter(content)).toEqual({});
  });

  it('handles CRLF content', () => {
    const content = ['---', 'notebook:', '  timeout: 1000', '---', ''].join('\r\n');
    expect(parseNotebookFrontmatter(content)).toEqual({ timeout: 1000 });
  });
});

describe('selectCells', () => {
  const blocks = [{ id: undefined }, { id: 'chart' }, { id: undefined }, { id: undefined }];

  it('defaults to all cells', () => {
    expect(selectCells(blocks, { only: false })).toEqual([0, 1, 2, 3]);
  });

  it('runs up to and including the target cell', () => {
    expect(selectCells(blocks, { cell: 3, only: false })).toEqual([0, 1, 2]);
  });

  it('runs only the target cell with --only', () => {
    expect(selectCells(blocks, { cell: 3, only: true })).toEqual([2]);
  });

  it('selects by id', () => {
    expect(selectCells(blocks, { id: 'chart', only: false })).toEqual([0, 1]);
    expect(selectCells(blocks, { id: 'chart', only: true })).toEqual([1]);
  });

  it('errors on unknown id', () => {
    expect(selectCells(blocks, { id: 'nope', only: false })).toHaveProperty('error');
  });

  it('errors on out-of-range cell', () => {
    expect(selectCells(blocks, { cell: 0, only: false })).toHaveProperty('error');
    expect(selectCells(blocks, { cell: 5, only: false })).toHaveProperty('error');
  });
});
