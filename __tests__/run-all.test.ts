import { TFile } from 'obsidian';
import {
  activateRunAll,
  disposeRunAll,
  parseRunBlocks,
  runAll,
} from '../src/RunAll';
import { DEFAULT_SETTINGS } from '../src/settings/Settings';
import * as HtmlToImage from '../src/output/HtmlToImage';

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
});

describe('runAll', () => {
  const runAllWithHooks = runAll as unknown as RunAllWithHooks;

  beforeEach(() => activateRunAll());
  afterEach(() => disposeRunAll());

  it('continues after a failed cell and reports progress and totals', async () => {
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

    expect(result).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: false });
    expect(executed).toEqual(['print("one")', 'FAIL', 'print("three")']);
    expect(progress).toEqual([1, 2, 3]);
    expect(memory.content().match(/<!-- nb-output/g)).toHaveLength(3);
    expect(memory.content()).toContain('status="error"');
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
