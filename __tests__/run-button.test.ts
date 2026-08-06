import { TFile } from 'obsidian';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { processCodeBlock } from '../src/RunButton';
import { KernelCancelledError, KernelExecutionError } from '../src/kernels/BaseKernel';
import { DEFAULT_SETTINGS } from '../src/settings/Settings';
import { clearRunAllToolbarTimers } from '../src/RunAllToolbar';

class FakeClassList {
  private values = new Set<string>();

  constructor(initial = '') {
    for (const value of initial.split(/\s+/).filter(Boolean)) this.values.add(value);
  }

  add(value: string) { this.values.add(value); }
  remove(value: string) { this.values.delete(value); }
  toggle(value: string, force?: boolean) {
    const enabled = force ?? !this.values.has(value);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
  contains(value: string) { return this.values.has(value); }
}

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  classList: FakeClassList;
  textContent = '';
  innerHTML = '';
  disabled = false;
  private listeners = new Map<string, () => void | Promise<void>>();

  constructor(className = '') {
    this.classList = new FakeClassList(className);
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  createEl(_tag: string, options: { cls?: string; text?: string } = {}) {
    const child = new FakeElement(options.cls ?? '');
    child.textContent = options.text ?? '';
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  createDiv(options: { cls?: string; text?: string } = {}) {
    return this.createEl('div', options);
  }

  setText(text: string) { this.textContent = text; }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  addEventListener(type: string, listener: () => void | Promise<void>) {
    this.listeners.set(type, listener);
  }

  async click() {
    if (!this.disabled) await this.listeners.get('click')?.();
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

describe('Run button', () => {
  afterEach(() => clearRunAllToolbarTimers());

  it('renders with a zero badge without acquiring a kernel', async () => {
    const acquireKernel = jest.fn(() => { throw new Error('No backing note'); });
    const context = {
      app: {
        workspace: { getLeavesOfType: jest.fn(() => []) },
        vault: { getAbstractFileByPath: jest.fn(() => null) },
      },
      getSettings: () => DEFAULT_SETTINGS,
      acquireKernel,
      peekExecutionCount: () => 0,
    };
    const ctx = {
      sourcePath: '',
      getSectionInfo: () => null,
    } as unknown as MarkdownPostProcessorContext;
    Object.assign(globalThis, { window: {}, HTMLPreElement: FakeElement });
    const root = new FakeElement();

    await expect(processCodeBlock(
      'print("render only")',
      root as unknown as HTMLElement,
      ctx,
      context as never,
      'python',
    )).resolves.toBeUndefined();

    expect(root.querySelector('.nb-run-button')).not.toBeNull();
    expect(root.querySelector('.nb-exec-count')?.textContent).toBe('[0]');
    expect(acquireKernel).not.toHaveBeenCalled();

    await expect(root.querySelector('.nb-run-button')!.click()).resolves.toBeUndefined();
    expect(acquireKernel).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.nb-run-button')?.textContent).toBe('▶ Run');
  });

  it('persists escaped traceback output with the failed status', async () => {
    const source = 'raise ValueError("bad")';
    let markdown = `\`\`\`python\n${source}\n\`\`\``;
    const file = new TFile();
    file.path = 'note.md';
    Object.assign(file, { extension: 'md', parent: { path: '' } });
    const app = {
      metadataCache: { getFileCache: jest.fn(() => null) },
      workspace: { getLeavesOfType: jest.fn(() => []) },
      vault: {
        getAbstractFileByPath: jest.fn(() => file),
        process: jest.fn(async (_file: TFile, transform: (raw: string) => string) => {
          markdown = transform(markdown);
        }),
      },
    };
    const kernel = {
      executionCount: 1,
      async execute(_code: string, onChunk: (chunk: unknown) => void) {
        const detail = 'Traceback\nValueError: value < 3\n';
        onChunk({ type: 'stream', stream: 'stdout', text: 'noise\n'.repeat(1000) });
        onChunk({ type: 'error', text: detail });
        throw new KernelExecutionError('ValueError: value < 3', detail);
      },
    };
    const context = {
      app,
      getSettings: () => ({ ...DEFAULT_SETTINGS, outputLimitKb: 1 }),
      acquireKernel: () => kernel,
      peekExecutionCount: () => kernel.executionCount,
    };
    const ctx = {
      sourcePath: file.path,
      getSectionInfo: () => ({ text: markdown, lineStart: 0, lineEnd: 2 }),
    } as unknown as MarkdownPostProcessorContext;
    Object.assign(globalThis, { window: {}, HTMLPreElement: FakeElement });
    const root = new FakeElement();

    await processCodeBlock(source, root as unknown as HTMLElement, ctx, context as never, 'python');
    await root.querySelector('.nb-run-button')!.click();

    expect(markdown).toContain('status="error"');
    expect(markdown).toContain('Execution failed');
    expect(markdown).toContain('Output truncated after 1 KB');
    expect(markdown).toContain('ValueError: value &lt; 3');
    expect(markdown).not.toContain('ValueError: value < 3\n</pre>');
  });

  it('caps persisted output from an individual cell', async () => {
    const source = 'print("lots")';
    let markdown = `\`\`\`python\n${source}\n\`\`\``;
    const file = new TFile();
    file.path = 'note.md';
    Object.assign(file, { extension: 'md', parent: { path: '' } });
    const app = {
      metadataCache: { getFileCache: jest.fn(() => null) },
      workspace: { getLeavesOfType: jest.fn(() => []) },
      vault: {
        getAbstractFileByPath: jest.fn(() => file),
        process: jest.fn(async (_file: TFile, transform: (raw: string) => string) => {
          markdown = transform(markdown);
        }),
      },
    };
    const kernel = {
      executionCount: 1,
      async execute(_code: string, onChunk: (chunk: unknown) => void) {
        onChunk({ type: 'stream', stream: 'stdout', text: '<'.repeat(5000) });
      },
    };
    const context = {
      app,
      getSettings: () => ({ ...DEFAULT_SETTINGS, outputLimitKb: 1 }),
      acquireKernel: () => kernel,
      peekExecutionCount: () => kernel.executionCount,
    };
    const ctx = {
      sourcePath: file.path,
      getSectionInfo: () => ({ text: markdown, lineStart: 0, lineEnd: 2 }),
    } as unknown as MarkdownPostProcessorContext;
    Object.assign(globalThis, { window: {}, HTMLPreElement: FakeElement });
    const root = new FakeElement();

    await processCodeBlock(source, root as unknown as HTMLElement, ctx, context as never, 'python');
    await root.querySelector('.nb-run-button')!.click();

    expect(markdown).toContain('Output truncated after 1 KB');
    expect(markdown).toContain('&lt;');
    expect(new TextEncoder().encode(markdown).byteLength).toBeLessThan(1300);
  });

  it('keeps Stop available after a re-render and writes an interrupted state', async () => {
    const source = 'while True: pass';
    let markdown = `\`\`\`python\n${source}\n\`\`\``;
    const file = new TFile();
    file.path = 'note.md';
    Object.assign(file, { extension: 'md', parent: { path: '' } });
    const app = {
      metadataCache: { getFileCache: jest.fn(() => null) },
      workspace: { getLeavesOfType: jest.fn(() => []) },
      vault: {
        getAbstractFileByPath: jest.fn(() => file),
        process: jest.fn(async (_file: TFile, transform: (raw: string) => string) => {
          markdown = transform(markdown);
        }),
      },
    };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const kernel = {
      executionCount: 0,
      execute: jest.fn((_code, _onChunk, _timeout, signal?: AbortSignal) => {
        markStarted();
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new KernelCancelledError()),
            { once: true },
          );
        });
      }),
    };
    const context = {
      app,
      getSettings: () => DEFAULT_SETTINGS,
      acquireKernel: () => kernel,
      peekExecutionCount: () => kernel.executionCount,
    };
    const ctx = {
      sourcePath: file.path,
      getSectionInfo: () => ({ text: markdown, lineStart: 0, lineEnd: 2 }),
    } as unknown as MarkdownPostProcessorContext;
    Object.assign(globalThis, { window: {} });

    const firstRoot = new FakeElement();
    await processCodeBlock(source, firstRoot as unknown as HTMLElement, ctx, context as never, 'python');
    const firstButton = firstRoot.querySelector('.nb-run-button')!;
    const runningClick = firstButton.click();
    await started;
    expect(firstButton.textContent).toBe('■ Stop');

    const rerenderedRoot = new FakeElement();
    await processCodeBlock(
      source,
      rerenderedRoot as unknown as HTMLElement,
      ctx,
      context as never,
      'python',
    );
    const rerenderedButton = rerenderedRoot.querySelector('.nb-run-button')!;
    expect(rerenderedButton.textContent).toBe('■ Stop');

    await rerenderedButton.click();
    await runningClick;

    expect(kernel.execute).toHaveBeenCalledTimes(1);
    expect(firstButton.textContent).toBe('▶ Run');
    expect(rerenderedButton.textContent).toBe('▶ Run');
    expect(markdown).toContain('status="error"');
    expect(markdown).toContain('Execution was interrupted');
    expect(markdown).not.toContain('status="running"');
  });

  it('starts and stops a named background cell from the same button', async () => {
    const source = 'serve()';
    let markdown = `\`\`\`python {background=server}\n${source}\n\`\`\``;
    const file = new TFile();
    file.path = 'note.md';
    Object.assign(file, { extension: 'md', parent: { path: '' } });
    const app = {
      metadataCache: { getFileCache: jest.fn(() => null) },
      workspace: { getLeavesOfType: jest.fn(() => []) },
      vault: {
        getAbstractFileByPath: jest.fn(() => file),
        process: jest.fn(async (_file: TFile, transform: (raw: string) => string) => {
          markdown = transform(markdown);
        }),
      },
    };
    let running = false;
    const background = {
      start: jest.fn(async (_request, onChunk: (chunk: unknown) => void) => {
        running = true;
        onChunk({ type: 'stream', stream: 'stdout', text: 'ready\n' });
      }),
      stop: jest.fn(async () => { running = false; return true; }),
      isRunning: jest.fn(() => running),
    };
    const context = {
      app,
      getSettings: () => DEFAULT_SETTINGS,
      acquireKernel: jest.fn(),
      peekExecutionCount: () => 0,
      background,
    };
    const ctx = {
      sourcePath: file.path,
      getSectionInfo: () => ({ text: markdown, lineStart: 0, lineEnd: 2 }),
    } as unknown as MarkdownPostProcessorContext;
    Object.assign(globalThis, { window: {}, HTMLPreElement: FakeElement });
    const root = new FakeElement();

    await processCodeBlock(source, root as unknown as HTMLElement, ctx, context as never, 'python');
    const button = root.querySelector('.nb-run-button')!;
    await button.click();

    expect(background.start).toHaveBeenCalledTimes(1);
    expect(context.acquireKernel).not.toHaveBeenCalled();
    expect(button.textContent).toBe('■ Stop');
    expect(markdown).toContain('Background process &quot;server&quot; started.');

    await button.click();

    expect(background.stop).toHaveBeenCalledWith('note.md', 'server');
    expect(button.textContent).toBe('▶ Run');
    expect(markdown).toContain('Background process &quot;server&quot; stopped.');
  });
});
