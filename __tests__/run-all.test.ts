import { TFile } from 'obsidian';
import {
  activateRunAll,
  cancelRunAll,
  disposeRunAll,
  parseRunBlocks,
  runAll,
  selectRunRange,
} from '../src/RunAll';
import { DEFAULT_SETTINGS } from '../src/settings/Settings';
import { KernelTimeoutError } from '../src/kernels/BaseKernel';
import * as HtmlToImage from '../src/output/HtmlToImage';
import { findRunBlockAtLine } from '../src/CellParser';
import {
  backgroundStartedMessage,
  buildBackgroundProgram,
} from '../src/BackgroundProgram';

type RunAllResult = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
};

type RunAllWithHooks = (
  app: unknown,
  file: TFile,
  getKernel: (language: string) => unknown,
  settings: typeof DEFAULT_SETTINGS,
  hooks?: {
    onProgress?: (progress: { current: number; total: number }) => void;
    onComplete?: (summary: RunAllResult) => void;
  }
) => Promise<RunAllResult>;

function notebook(...sources: string[]): string {
  return sources.map((source) => `\`\`\`python\n${source}\n\`\`\``).join('\n\n');
}

function memoryNotebook(initial: string) {
  let content = initial;
  const file = new TFile();
  file.path = 'note.md';
  Object.assign(file, { extension: 'md' });
  const app = {
    metadataCache: { getFileCache: jest.fn(() => null) },
    vault: {
      read: jest.fn(async () => content),
      process: jest.fn(async (_file: TFile, transform: (raw: string) => string) => {
        content = transform(content);
      }),
      adapter: {
        exists: jest.fn(async () => false),
        writeBinary: jest.fn(async () => undefined),
      },
      createBinary: jest.fn(async () => undefined),
      modifyBinary: jest.fn(async () => undefined),
      createFolder: jest.fn(async () => undefined),
      getAbstractFileByPath: jest.fn(() => null),
    },
  };
  return {
    app,
    file,
    content: () => content,
    setContent: (next: string) => { content = next; },
  };
}

describe('parseRunBlocks', () => {
  it('returns empty array for content with no supported language blocks', () => {
    const content = '# Heading\n\nSome text\n\n```ruby\nx = 1\n```\n';
    expect(parseRunBlocks(content)).toEqual([]);
  });

  it('finds the executable cell under an editor cursor', () => {
    const content = ['# title', '', '```python', 'x = 1', '```', '', 'after'].join('\n');
    expect(findRunBlockAtLine(content, 2)?.source).toBe('x = 1');
    expect(findRunBlockAtLine(content, 3)?.lineStart).toBe(2);
    expect(findRunBlockAtLine(content, 4)?.lineEnd).toBe(4);
    expect(findRunBlockAtLine(content, 1)).toBeNull();
    expect(findRunBlockAtLine(content, 6)).toBeNull();
  });

  it('finds the owning cell when the cursor is inside its attached output', () => {
    const content = [
      '```python', 'x = 1', '```', '',
      '<!-- nb-output hash="abc" format="html" -->',
      '<pre>1</pre>',
      '<!-- /nb-output -->',
      'after',
    ].join('\n');

    expect(findRunBlockAtLine(content, 4)?.source).toBe('x = 1');
    expect(findRunBlockAtLine(content, 5)?.source).toBe('x = 1');
    expect(findRunBlockAtLine(content, 6)?.source).toBe('x = 1');
    expect(findRunBlockAtLine(content, 7)).toBeNull();
  });

  it('parses a plain python block without any args', () => {
    const content = '```python\nprint("hello")\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('python');
    expect(blocks[0].source).toBe('print("hello")');
    expect(blocks[0].lineEnd).toBe(2);
  });

  it('parses multiple blocks in document order', () => {
    const content = [
      '```python',
      'x = 1',
      '```',
      '',
      '```javascript',
      'console.log("hi")',
      '```',
    ].join('\n');
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].language).toBe('python');
    expect(blocks[1].language).toBe('javascript');
  });

  it('parses the output arg', () => {
    const content = '```python {format=image}\nplt.show()\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].format).toBe('image');
  });

  it('parses the id arg', () => {
    const content = '```python {id=my-chart format=image}\nplt.show()\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].id).toBe('my-chart');
    expect(blocks[0].format).toBe('image');
  });

  it('handles blocks with no args', () => {
    const content = '```python\npass\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].id).toBeUndefined();
    expect(blocks[0].format).toBeUndefined();
  });

  it('captures multi-line source correctly', () => {
    const content = '```python\nimport pandas as pd\ndf = pd.DataFrame()\ndf\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].source).toBe('import pandas as pd\ndf = pd.DataFrame()\ndf');
  });

  it('skips unsupported languages', () => {
    const content = '```ruby\nx = 1\n```\n\n```python\ny = 2\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('y = 2');
  });

  it('records the correct lineEnd for each block', () => {
    const content = [
      '```python',   // line 0
      'x = 1',       // line 1
      '```',         // line 2 — lineEnd
      '```python',   // line 3
      'y = 2',       // line 4
      '```',         // line 5 — lineEnd
    ].join('\n');
    const blocks = parseRunBlocks(content);
    expect(blocks[0].lineEnd).toBe(2);
    expect(blocks[1].lineEnd).toBe(5);
  });

  it('parses bash and r blocks', () => {
    const content = '```bash\nls -la\n```\n\n```r\nsummary(cars)\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].language).toBe('bash');
    expect(blocks[1].language).toBe('r');
  });

  it('parses named background cells for every supported language', () => {
    const content = [
      '```python {background=python-server}', 'serve()', '```',
      '```javascript {background=node-server}', 'serve()', '```',
      '```bash {background=shell-server}', 'serve', '```',
      '```r {background=r-server}', 'serve()', '```',
    ].join('\n');
    const blocks = parseRunBlocks(content);

    expect(blocks.map((block) => [block.language, block.background])).toEqual([
      ['python', 'python-server'],
      ['javascript', 'node-server'],
      ['bash', 'shell-server'],
      ['r', 'r-server'],
    ]);
  });

  it('parses quoted fence values with spaces without changing existing args', () => {
    const blocks = parseRunBlocks([
      '```python {id=api format=json background=server context=none ready="Serving on port 8000" future=value}',
      'serve()',
      '```',
    ].join('\n'));

    expect(blocks[0]).toMatchObject({
      id: 'api',
      format: 'json',
      background: 'server',
      context: 'none',
      ready: 'Serving on port 8000',
    });
  });

  it('tangles preceding same-language cells for a background process', () => {
    const blocks = parseRunBlocks([
      '```python', 'from app import server', '```',
      '```bash', 'echo ignored', '```',
      '```python {background=old}', 'old_server.run()', '```',
      '```python', '@server.route("/")', 'def index(): return "ok"', '```',
      '```python {background=server}', 'server.run()', '```',
    ].join('\n'));

    const program = buildBackgroundProgram(blocks, blocks[4]);
    expect(program.source).toBe([
      'from app import server',
      '@server.route("/")\ndef index(): return "ok"',
      'server.run()',
    ].join('\n\n'));
    expect(program.precedingCellCount).toBe(2);
    expect(program.sourceMap).toEqual([
      {
        generatedLineStart: 1, generatedLineEnd: 1,
        noteLineStart: 2, role: 'setup',
      },
      {
        generatedLineStart: 3, generatedLineEnd: 4,
        noteLineStart: 11, role: 'setup',
      },
      {
        generatedLineStart: 6, generatedLineEnd: 6,
        noteLineStart: 15, role: 'background',
      },
    ]);
  });

  it('supports an isolated background process with context=none', () => {
    const blocks = parseRunBlocks([
      '```python', 'setup()', '```',
      '```python {background=server context=none}', 'serve()', '```',
    ].join('\n'));

    const program = buildBackgroundProgram(blocks, blocks[1]);
    expect(program.source).toBe('serve()');
    expect(program.precedingCellCount).toBe(0);
    expect(program.sourceMap).toHaveLength(1);
    expect(backgroundStartedMessage('server', 'python', program)).toBe(
      'Background process "server" started in isolation (context=none).\n',
    );
  });

  it.each([
    ['a trailing newline', 'serve()\n'],
    ['CRLF and a trailing newline', 'serve()\r\n'],
  ])('matches Reading View source with %s', (_description, targetSource) => {
    const blocks = parseRunBlocks([
      '```python', 'setup()', '```',
      '```python {background=server}', 'serve()', '```',
    ].join('\n'));

    const program = buildBackgroundProgram(blocks, {
      ...blocks[1],
      source: targetSource,
    });
    expect(program.source).toBe('setup()\n\nserve()');
    expect(program.precedingCellCount).toBe(1);
    expect(program.sourceMap).toHaveLength(2);
  });

  it('rejects unknown background context modes', () => {
    const blocks = parseRunBlocks(
      '```python {background=server context=kernel}\nserve()\n```',
    );
    expect(() => buildBackgroundProgram(blocks, blocks[0]))
      .toThrow('use "above" or "none"');
  });

  it('resolves language aliases to canonical names', () => {
    const content = '```js\nconsole.log(1)\n```\n\n```sh\nls\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].language).toBe('javascript');
    expect(blocks[1].language).toBe('bash');
  });

  it('handles nb-output blocks between cells without including them in source', () => {
    const content = [
      '```python',
      'x = 1',
      '```',
      '<!-- nb-output hash="abc" format="html" -->',
      '<div>1</div>',
      '<!-- /nb-output -->',
      '```python',
      'y = 2',
      '```',
    ].join('\n');
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toBe('x = 1');
    expect(blocks[1].source).toBe('y = 2');
  });

  it('ignores executable fence-like lines inside persisted output', () => {
    const content = [
      '```python', 'print("first")', '```',
      '<!-- nb-output hash="abc" format="html" -->',
      '<pre>x',
      '```python',
      'y</pre>',
      '<!-- /nb-output -->',
      '```python', 'print("second")', '```',
    ].join('\n');

    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.source)).toEqual([
      'print("first")',
      'print("second")',
    ]);
  });

  it('selects cells above or at-and-below a content-anchored target', () => {
    const blocks = parseRunBlocks(notebook('first', 'second', 'third'));

    expect(selectRunRange(blocks, { mode: 'above', target: blocks[1] }))
      .toEqual([blocks[0]]);
    expect(selectRunRange(blocks, { mode: 'below', target: blocks[1] }))
      .toEqual([blocks[1], blocks[2]]);
    expect(selectRunRange(blocks, {
      mode: 'below', target: { language: 'python', source: 'missing', lineEnd: 0 },
    })).toBeNull();
  });

  it('uses the nearest line hint to select between identical cells', () => {
    const blocks = parseRunBlocks(notebook('same', 'middle', 'same'));
    expect(selectRunRange(blocks, { mode: 'above', target: blocks[2] }))
      .toEqual([blocks[0], blocks[1]]);
  });
});

describe('runAll', () => {
  const runAllWithHooks = runAll as unknown as RunAllWithHooks;

  beforeEach(() => activateRunAll());
  afterEach(() => disposeRunAll());

  it('acquires each language kernel once before executing cells', async () => {
    const memory = memoryNotebook(notebook('x = 1', 'print(x)'));
    const kernel = {
      executionCount: 0,
      execute: jest.fn(async () => undefined),
    };
    const acquire = jest.fn(() => kernel);

    await runAllWithHooks(memory.app, memory.file, acquire, DEFAULT_SETTINGS);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(kernel.execute).toHaveBeenCalledTimes(2);
  });

  it('starts a background cell and continues to later cells', async () => {
    const memory = memoryNotebook([
      '```python', 'setup()', '```',
      '',
      '```python {background=server ready=port:8765}', 'serve()', '```',
      '',
      '```python', 'print("client")', '```',
    ].join('\n'));
    let running = false;
    const background = {
      start: jest.fn(async (_request, onChunk: (chunk: unknown) => void) => {
        running = true;
        onChunk({ type: 'stream', stream: 'stdout', text: 'ready\n' });
      }),
      stop: jest.fn(async () => { running = false; return true; }),
      isRunning: jest.fn(() => running),
    };
    const kernel = {
      executionCount: 0,
      execute: jest.fn(async (_source: string, onChunk: (chunk: unknown) => void) => {
        onChunk({ type: 'stream', stream: 'stdout', text: 'client\n' });
      }),
    };
    const acquire = jest.fn(() => kernel);

    const result = await runAll(
      memory.app as never,
      memory.file,
      acquire as never,
      DEFAULT_SETTINGS,
      {},
      undefined,
      background,
    );

    expect(result).toEqual({ total: 3, succeeded: 3, failed: 0, skipped: false });
    expect(background.start).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(background.start).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'setup()\n\nserve()',
        precedingCellCount: 1,
        ready: 'port:8765',
      }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(kernel.execute).toHaveBeenCalledWith(
      'setup()', expect.any(Function), expect.any(Number), expect.any(AbortSignal),
    );
    expect(kernel.execute).toHaveBeenCalledWith(
      'print("client")', expect.any(Function), expect.any(Number), expect.any(AbortSignal),
    );
    expect(memory.content()).toContain(
      'Background process &quot;server&quot; started with 1 preceding python cell.',
    );
  });

  it('does not execute the next cell until background readiness resolves', async () => {
    const memory = memoryNotebook([
      '```python {background=server ready=port:8765}', 'serve()', '```', '',
      '```python', 'call_server()', '```',
    ].join('\n'));
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const events: string[] = [];
    let running = false;
    const background = {
      start: jest.fn(async () => {
        events.push('starting');
        await ready;
        running = true;
        events.push('ready');
      }),
      stop: jest.fn(async () => { running = false; return true; }),
      isRunning: jest.fn(() => running),
    };
    const kernel = {
      executionCount: 0,
      execute: jest.fn(async () => { events.push('client'); }),
    };

    const run = runAll(
      memory.app as never,
      memory.file,
      (() => kernel) as never,
      DEFAULT_SETTINGS,
      {},
      undefined,
      background,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['starting']);

    markReady();
    await run;
    expect(events).toEqual(['starting', 'ready', 'client']);
  });

  it('continues after a failed cell when stop on first error is disabled', async () => {
    const memory = memoryNotebook(notebook('print("one")', 'FAIL', 'print("three")'));
    const executed: string[] = [];
    const progress: number[] = [];
    const kernel = {
      executionCount: 0,
      async execute(source: string, onChunk: (chunk: unknown) => void) {
        this.executionCount += 1;
        executed.push(source);
        if (source === 'FAIL') throw new Error('expected failure');
        onChunk({ type: 'stream', stream: 'stdout', text: `${source}\n` });
      },
    };

    const result = await runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      { ...DEFAULT_SETTINGS, stopOnFirstError: false },
      { onProgress: ({ current }) => progress.push(current) }
    );

    expect(result).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: false });
    expect(executed).toEqual(['print("one")', 'FAIL', 'print("three")']);
    expect(progress).toEqual([1, 2, 3]);
    expect(memory.content().match(/<!-- nb-output/g)).toHaveLength(3);
    expect(memory.content()).toContain('status="error"');
    expect(memory.content()).toContain('expected failure');
  });

  it('stops after the first failed cell by default', async () => {
    const memory = memoryNotebook(notebook('print("one")', 'FAIL', 'print("three")'));
    const executed: string[] = [];
    const progress: number[] = [];
    const kernel = {
      executionCount: 0,
      async execute(source: string, onChunk: (chunk: unknown) => void) {
        this.executionCount += 1;
        executed.push(source);
        if (source === 'FAIL') throw new Error('expected failure');
        onChunk({ type: 'stream', stream: 'stdout', text: `${source}\n` });
      },
    };

    const result = await runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS,
      { onProgress: ({ current }) => progress.push(current) }
    );

    expect(result).toEqual({ total: 3, succeeded: 1, failed: 1, skipped: false });
    expect(executed).toEqual(['print("one")', 'FAIL']);
    expect(progress).toEqual([1, 2]);
    expect(memory.content().match(/<!-- nb-output/g)).toHaveLength(2);
    expect(memory.content()).toContain('status="error"');
    expect(memory.content()).toContain('expected failure');
  });

  it('writes the timeout message only once', async () => {
    const memory = memoryNotebook(notebook('while True: pass'));
    const kernel = {
      executionCount: 0,
      async execute() {
        throw new KernelTimeoutError(30000);
      },
    };

    await runAllWithHooks(memory.app, memory.file, () => kernel, DEFAULT_SETTINGS);

    expect(memory.content()).toContain('status="timeout"');
    expect(memory.content().match(/Execution timed out/g)).toHaveLength(1);
  });

  it('caps persisted output and records that it was truncated', async () => {
    const memory = memoryNotebook(notebook('print("lots")'));
    const kernel = {
      executionCount: 0,
      async execute(_source: string, onChunk: (chunk: unknown) => void) {
        onChunk({ type: 'stream', stream: 'stdout', text: '<'.repeat(5000) });
      },
    };

    await runAllWithHooks(
      memory.app, memory.file, () => kernel,
      { ...DEFAULT_SETTINGS, outputLimitKb: 1 },
    );

    expect(memory.content()).toContain('Output truncated after 1 KB');
    expect(memory.content()).toContain('&lt;');
    expect(new TextEncoder().encode(memory.content()).byteLength).toBeLessThan(1300);
  });

  it('persists a code output format as fenced Markdown', async () => {
    const memory = memoryNotebook('```python {format=json}\nprint("json")\n```');
    const kernel = {
      executionCount: 0,
      async execute(_source: string, onChunk: (chunk: unknown) => void) {
        onChunk({ type: 'stream', stream: 'stdout', text: '{"ok": true}\n' });
      },
    };

    await runAllWithHooks(memory.app, memory.file, () => kernel, DEFAULT_SETTINGS);

    expect(memory.content()).toContain('```json\n{"ok": true}\n```');
    expect(memory.content()).toContain('format="json"');
  });

  it('skips an overlapping run for the same file', async () => {
    const memory = memoryNotebook(notebook('print("held")'));
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const kernel = {
      executionCount: 0,
      async execute() {
        calls += 1;
        this.executionCount += 1;
        if (calls === 1) {
          markStarted();
          await firstGate;
        }
      },
    };

    const first = runAllWithHooks(memory.app, memory.file, () => kernel, DEFAULT_SETTINGS);
    await started;
    const second = await runAllWithHooks(memory.app, memory.file, () => kernel, DEFAULT_SETTINGS);
    releaseFirst();
    await first;

    expect(second.skipped).toBe(true);
    expect(calls).toBe(1);
  });

  it('stops the active cell and does not run remaining cells', async () => {
    const memory = memoryNotebook(notebook('print("done")', 'print("held")', 'print("never")'));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const executed: string[] = [];
    const onCancel = jest.fn();
    const kernel = {
      executionCount: 0,
      execute(
        source: string,
        onChunk: (chunk: unknown) => void,
        _timeout: number,
        signal?: AbortSignal,
      ) {
        executed.push(source);
        if (source === 'print("done")') {
          onChunk({ type: 'stream', stream: 'stdout', text: 'done\n' });
          return Promise.resolve();
        }
        markStarted();
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        });
      },
    };

    const running = runAll(
      memory.app as never,
      memory.file,
      () => kernel as never,
      DEFAULT_SETTINGS,
      { onCancel },
    );
    await started;
    expect(cancelRunAll(memory.file.path)).toBe(true);
    const result = await running;

    expect(result).toEqual({ total: 3, succeeded: 1, failed: 0, skipped: true });
    expect(executed).toEqual(['print("done")', 'print("held")']);
    expect(onCancel).toHaveBeenCalledWith({ current: 2, total: 3 });
    expect(memory.content().match(/<!-- nb-output/g)).toHaveLength(1);
    expect(memory.content()).toContain('done');
  });

  it('stops remaining output writes when cancelled during the write phase', async () => {
    const memory = memoryNotebook(notebook('print("one")', 'print("two")'));
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    let writes = 0;
    memory.app.vault.process.mockImplementation(
      async (_file: TFile, transform: (raw: string) => string) => {
        writes += 1;
        if (writes === 1) {
          markWriteStarted();
          await writeGate;
        }
        memory.setContent(transform(memory.content()));
      },
    );
    const kernel = {
      executionCount: 0,
      async execute(source: string, onChunk: (chunk: unknown) => void) {
        this.executionCount += 1;
        onChunk({ type: 'stream', stream: 'stdout', text: `${source}\n` });
      },
    };
    const onCancel = jest.fn();

    const running = runAll(
      memory.app as never,
      memory.file,
      () => kernel as never,
      DEFAULT_SETTINGS,
      { onCancel },
    );
    await writeStarted;
    expect(cancelRunAll(memory.file.path)).toBe(true);
    releaseWrite();
    const result = await running;

    expect(result).toEqual({ total: 2, succeeded: 2, failed: 0, skipped: true });
    expect(writes).toBe(1);
    expect(onCancel).toHaveBeenCalledWith({ current: 2, total: 2 });
    expect(memory.content()).not.toContain('<!-- nb-output');
  });

  it('marks a cell failed when it was edited before its output could be saved', async () => {
    const memory = memoryNotebook(notebook('print("original")'));
    const kernel = {
      executionCount: 0,
      async execute() {
        this.executionCount += 1;
        memory.setContent('# Cell edited while execution was running');
      },
    };

    const result = await runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS
    );

    expect(result).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: false });
    expect(memory.content()).not.toContain('<!-- nb-output');
  });

  it('continues to later cells when hashing one cell fails', async () => {
    const memory = memoryNotebook(notebook('print("first")', 'print("second")'));
    const digest = jest.spyOn(globalThis.crypto.subtle, 'digest');
    digest.mockRejectedValueOnce(new Error('digest unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const executed: string[] = [];
    const kernel = {
      executionCount: 0,
      async execute(source: string) {
        this.executionCount += 1;
        executed.push(source);
      },
    };

    const result = await runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS
    );
    digest.mockRestore();
    consoleError.mockRestore();

    expect(result).toEqual({ total: 2, succeeded: 1, failed: 1, skipped: false });
    expect(executed).toEqual(['print("second")']);
    expect(memory.content().match(/<!-- nb-output/g)).toHaveLength(1);
  });

  it('cancels remaining cells and hooks when the plugin unloads', async () => {
    const memory = memoryNotebook(notebook('print("first")', 'print("second")'));
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const executed: string[] = [];
    const onComplete = jest.fn();
    const kernel = {
      executionCount: 0,
      async execute(source: string) {
        this.executionCount += 1;
        executed.push(source);
        if (executed.length === 1) {
          markStarted();
          await gate;
        }
      },
    };

    const running = runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS,
      { onComplete }
    );
    await started;
    disposeRunAll();
    release();
    const result = await running;

    expect(result.skipped).toBe(true);
    expect(executed).toEqual(['print("first")']);
    expect(onComplete).not.toHaveBeenCalled();
    expect(memory.content()).not.toContain('<!-- nb-output');
  });

  it('keeps the same TFile locked if it is renamed during execution', async () => {
    const memory = memoryNotebook(notebook('print("held")'));
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const kernel = {
      executionCount: 0,
      async execute() {
        calls += 1;
        this.executionCount += 1;
        markStarted();
        await gate;
      },
    };

    const first = runAllWithHooks(memory.app, memory.file, () => kernel, DEFAULT_SETTINGS);
    await started;
    memory.file.path = 'renamed.md';
    const second = await runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS
    );
    release();
    await first;

    expect(second.skipped).toBe(true);
    expect(calls).toBe(1);
  });

  it('treats a vault read rejection after unload as cancellation', async () => {
    const memory = memoryNotebook(notebook('print("never")'));
    let rejectRead!: (error: Error) => void;
    memory.app.vault.read.mockImplementation(() => new Promise<string>((_resolve, reject) => {
      rejectRead = reject;
    }));
    const onComplete = jest.fn();

    const running = runAllWithHooks(
      memory.app,
      memory.file,
      () => ({ executionCount: 0, execute: jest.fn() }),
      DEFAULT_SETTINGS,
      { onComplete }
    );
    await Promise.resolve();
    disposeRunAll();
    rejectRead(new Error('vault closed'));
    const result = await running;

    expect(result.skipped).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not save an image when unload occurs during HTML rendering', async () => {
    const memory = memoryNotebook('```python {format=image}\nprint("plot")\n```');
    let finishRender!: (data: string | null) => void;
    let markRendering!: () => void;
    const rendering = new Promise<void>((resolve) => { markRendering = resolve; });
    const renderSpy = jest.spyOn(HtmlToImage, 'renderHtmlToPng').mockImplementation(() => {
      markRendering();
      return new Promise<string | null>((resolve) => { finishRender = resolve; });
    });
    const kernel = {
      executionCount: 0,
      async execute(_source: string, onChunk: (chunk: unknown) => void) {
        this.executionCount += 1;
        onChunk({ type: 'stream', stream: 'stdout', text: 'plot\n' });
      },
    };

    const running = runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS
    );
    await rendering;
    disposeRunAll();
    finishRender('aGVsbG8=');
    const result = await running;
    renderSpy.mockRestore();

    expect(result.skipped).toBe(true);
    expect(memory.app.vault.adapter.exists).not.toHaveBeenCalled();
    expect(memory.app.vault.createBinary).not.toHaveBeenCalled();
    expect(memory.app.vault.process).not.toHaveBeenCalled();
  });

  it('does not continue image mutations when unload occurs during a vault check', async () => {
    const memory = memoryNotebook('```python {format=image}\nprint("plot")\n```');
    let finishExists!: (exists: boolean) => void;
    let markChecking!: () => void;
    const checking = new Promise<void>((resolve) => { markChecking = resolve; });
    memory.app.vault.adapter.exists.mockImplementation(() => {
      markChecking();
      return new Promise<boolean>((resolve) => { finishExists = resolve; });
    });
    const kernel = {
      executionCount: 0,
      async execute(_source: string, onChunk: (chunk: unknown) => void) {
        this.executionCount += 1;
        onChunk({ type: 'rich', mime: 'image/png', data: 'aGVsbG8=' });
      },
    };

    const running = runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS
    );
    await checking;
    disposeRunAll();
    finishExists(false);
    const result = await running;

    expect(result.skipped).toBe(true);
    expect(memory.app.vault.createBinary).not.toHaveBeenCalled();
    expect(memory.app.vault.process).not.toHaveBeenCalled();
  });

  it('does not save an image when the cell was edited during execution', async () => {
    const memory = memoryNotebook('```python {format=image}\nprint("plot")\n```');
    const kernel = {
      executionCount: 0,
      async execute(_source: string, onChunk: (chunk: unknown) => void) {
        this.executionCount += 1;
        onChunk({ type: 'rich', mime: 'image/png', data: 'aGVsbG8=' });
        memory.setContent('# Cell removed while execution was running');
      },
    };

    const result = await runAllWithHooks(
      memory.app,
      memory.file,
      () => kernel,
      DEFAULT_SETTINGS
    );

    expect(result).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: false });
    expect(memory.app.vault.createBinary).not.toHaveBeenCalled();
  });
});
