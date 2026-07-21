import type { MarkdownPostProcessorContext } from 'obsidian';
import {
  activateRunAllToolbar,
  clearRunAllToolbarTimers,
  disposeRunAllToolbar,
  renderRunAllToolbar,
  runAllToolbarHooks,
  scheduleRunAllToolbarRender,
} from '../src/RunAllToolbar';
import { DEFAULT_SETTINGS } from '../src/settings/Settings';

class FakeElement {
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  dataset: Record<string, string> = {};
  textContent = '';
  disabled = false;
  private classes: Set<string>;
  private listeners = new Map<string, () => void | Promise<void>>();

  constructor(className = '') {
    this.classes = new Set(className.split(/\s+/).filter(Boolean));
  }

  createDiv(options: { cls?: string; text?: string } = {}) {
    return this.createEl('div', options);
  }

  createEl(_tag: string, options: { cls?: string; text?: string } = {}) {
    const child = new FakeElement(options.cls ?? '');
    child.textContent = options.text ?? '';
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  prepend(child: FakeElement) {
    this.children = this.children.filter((item) => item !== child);
    child.parentElement = this;
    this.children.unshift(child);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    this.parentElement = null;
  }

  addEventListener(type: string, callback: () => void | Promise<void>) {
    this.listeners.set(type, callback);
  }

  async click() {
    await this.listeners.get('click')?.();
  }

  matches(selector: string) {
    return selector.startsWith('.') && this.classes.has(selector.slice(1));
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function notebook(...sources: string[]): string {
  return sources.map((source) => `\`\`\`python\n${source}\n\`\`\``).join('\n\n');
}

function fixture(markdown = notebook('print("one")')) {
  const file = { path: 'note.md', extension: 'md', parent: { path: '' } };
  const app = {
    vault: {
      read: jest.fn(async () => markdown),
      getAbstractFileByPath: jest.fn((_path?: string): typeof file | null => file),
      process: jest.fn(async (_file: unknown, transform: (raw: string) => string) => {
        markdown = transform(markdown);
      }),
    },
    workspace: { getLeavesOfType: jest.fn(() => []) },
    metadataCache: { getFileCache: jest.fn(() => null) },
  };
  const context = {
    app,
    getKernel: () => ({ executionCount: 0, execute: jest.fn(async () => undefined) }),
    getSettings: () => DEFAULT_SETTINGS,
  };
  const ctx = { sourcePath: file.path } as MarkdownPostProcessorContext;
  return {
    app,
    context,
    ctx,
    file,
    setMarkdown: (next: string) => { markdown = next; },
  };
}

beforeEach(() => activateRunAllToolbar());
afterEach(() => {
  clearRunAllToolbarTimers();
  disposeRunAllToolbar();
  jest.useRealTimers();
});

describe('Run All toolbar', () => {
  it('inserts one toolbar at the top of a rendered notebook and shows the cell count', async () => {
    const { context, ctx } = fixture(notebook('a = 1', 'print(a)'));
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });

    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);
    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);

    expect(host.querySelectorAll('.nb-run-all-toolbar')).toHaveLength(1);
    expect(host.children[0].matches('.nb-run-all-toolbar')).toBe(true);
    expect(host.querySelector('.nb-run-all-button')?.textContent).toBe('▶ Run all cells');
    expect(host.querySelector('.nb-run-all-status')?.textContent).toBe('2 cells');
  });

  it('renders a loading toolbar before the asynchronous file read finishes', async () => {
    const { app, context, ctx } = fixture();
    let finishRead!: (value: string) => void;
    app.vault.read.mockImplementation(() => new Promise<string>((resolve) => {
      finishRead = resolve;
    }));
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });

    const rendering = renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);
    await Promise.resolve();

    expect(host.querySelector('.nb-run-all-status')?.textContent).toBe('Loading cells…');
    finishRead(notebook('print("one")'));
    await rendering;
    expect(host.querySelector('.nb-run-all-status')?.textContent).toBe('1 cell');
  });

  it('refreshes the cell count after the note changes', async () => {
    const { context, ctx, setMarkdown } = fixture();
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });
    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);

    setMarkdown(notebook('a = 1', 'print(a)'));
    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);

    expect(host.querySelector('.nb-run-all-status')?.textContent).toBe('2 cells');
  });

  it('removes the toolbar when the note no longer has executable cells', async () => {
    const { context, ctx, setMarkdown } = fixture();
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });
    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);

    setMarkdown('# No code here');
    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);

    expect(host.querySelector('.nb-run-all-toolbar')).toBeNull();
  });

  it('replaces a toolbar when the preview container is reused for another note', async () => {
    const { app, context, ctx } = fixture();
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });
    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);

    const nextFile = { path: 'next.md', extension: 'md', parent: { path: '' } };
    app.vault.getAbstractFileByPath.mockImplementation((path?: string) =>
      path === nextFile.path ? nextFile : null
    );
    const nextContext = { sourcePath: nextFile.path } as MarkdownPostProcessorContext;
    await renderRunAllToolbar(section as unknown as HTMLElement, nextContext, context as never);

    expect(host.querySelectorAll('.nb-run-all-toolbar')).toHaveLength(1);
    expect(host.querySelector('.nb-run-all-toolbar')?.dataset.sourcePath).toBe(nextFile.path);
  });

  it('queues the latest note when a previous render is still reading the file', async () => {
    const { app, context, ctx, file } = fixture();
    const nextFile = { path: 'next.md', extension: 'md', parent: { path: '' } };
    app.vault.getAbstractFileByPath.mockImplementation((path?: string) => {
      if (path === file.path) return file;
      if (path === nextFile.path) return nextFile;
      return null;
    });
    let finishFirstRead!: (value: string) => void;
    app.vault.read.mockImplementation((candidate?: { path?: string }) => {
      if (candidate?.path === file.path) {
        return new Promise<string>((resolve) => { finishFirstRead = resolve; });
      }
      return Promise.resolve(notebook('print("next")'));
    });
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });

    const firstRender = renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);
    await Promise.resolve();
    await Promise.resolve();
    const nextContext = { sourcePath: nextFile.path } as MarkdownPostProcessorContext;
    await renderRunAllToolbar(section as unknown as HTMLElement, nextContext, context as never);
    finishFirstRead(notebook('print("first")'));
    await firstRender;
    await Promise.resolve();
    await Promise.resolve();

    expect(host.querySelectorAll('.nb-run-all-toolbar')).toHaveLength(1);
    expect(host.querySelector('.nb-run-all-toolbar')?.dataset.sourcePath).toBe(nextFile.path);
  });

  it('reruns a same-note refresh requested while an earlier read is pending', async () => {
    const { app, context, ctx } = fixture();
    let finishFirstRead!: (value: string) => void;
    let reads = 0;
    app.vault.read.mockImplementation(() => {
      reads += 1;
      if (reads === 1) {
        return new Promise<string>((resolve) => { finishFirstRead = resolve; });
      }
      return Promise.resolve('# All executable cells were removed');
    });
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });

    const firstRender = renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);
    await Promise.resolve();
    await Promise.resolve();
    await renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);
    finishFirstRead(notebook('print("stale snapshot")'));
    await firstRender;
    await Promise.resolve();
    await Promise.resolve();

    expect(reads).toBe(2);
    expect(host.querySelector('.nb-run-all-toolbar')).toBeNull();
  });

  it('removes toolbars and ignores delayed renders after plugin unload', async () => {
    const { app, context, ctx } = fixture();
    let finishRead!: (value: string) => void;
    app.vault.read.mockImplementation(() => new Promise<string>((resolve) => {
      finishRead = resolve;
    }));
    const host = new FakeElement('markdown-preview-sizer');
    const section = host.createDiv({ cls: 'markdown-preview-section' });

    const rendering = renderRunAllToolbar(section as unknown as HTMLElement, ctx, context as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(host.querySelector('.nb-run-all-toolbar')).not.toBeNull();

    disposeRunAllToolbar();
    finishRead(notebook('print("late")'));
    await rendering;

    expect(host.querySelector('.nb-run-all-toolbar')).toBeNull();
  });

  it('uses the stable Markdown preview container discovered through the workspace', async () => {
    jest.useFakeTimers();
    const { app, context, ctx, file } = fixture();
    const viewContainer = new FakeElement('workspace-leaf-content');
    const previewView = viewContainer.createDiv({ cls: 'markdown-preview-view' });
    previewView.createDiv({ cls: 'markdown-preview-sizer' });
    app.workspace.getLeavesOfType.mockReturnValue([{
      view: { file, contentEl: viewContainer, containerEl: viewContainer },
    }] as never);

    scheduleRunAllToolbarRender(ctx, context as never, 0);
    await jest.runAllTimersAsync();

    const toolbar = viewContainer.querySelector('.nb-run-all-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.parentElement).toBe(previewView);
  });

  it('renders a toolbar in every pane when the same note is open twice', async () => {
    jest.useFakeTimers();
    const { app, context, ctx, file } = fixture();
    const firstContainer = new FakeElement('workspace-leaf-content');
    const firstPreview = firstContainer.createDiv({ cls: 'markdown-preview-view' });
    firstPreview.createDiv({ cls: 'markdown-preview-sizer' });
    const secondContainer = new FakeElement('workspace-leaf-content');
    const secondPreview = secondContainer.createDiv({ cls: 'markdown-preview-view' });
    secondPreview.createDiv({ cls: 'markdown-preview-sizer' });
    app.workspace.getLeavesOfType.mockReturnValue([
      { view: { file, contentEl: firstContainer, containerEl: firstContainer } },
      { view: { file, contentEl: secondContainer, containerEl: secondContainer } },
    ] as never);

    scheduleRunAllToolbarRender(ctx, context as never, 0);
    await jest.runAllTimersAsync();

    expect(firstPreview.querySelectorAll('.nb-run-all-toolbar')).toHaveLength(1);
    expect(secondPreview.querySelectorAll('.nb-run-all-toolbar')).toHaveLength(1);

    runAllToolbarHooks(file.path).onProgress?.({ current: 1, total: 1 });
    expect(firstPreview.querySelector('.nb-run-all-status')?.textContent).toBe('Running 1 / 1');
    expect(secondPreview.querySelector('.nb-run-all-status')?.textContent).toBe('Running 1 / 1');
  });
});
