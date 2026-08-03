import MarkdownNotebookPlugin from '../src/main';
import { TFile, type Command } from 'obsidian';
import { cancelRunAll, runAll } from '../src/RunAll';
import { KernelCancelledError } from '../src/kernels/BaseKernel';

describe('MarkdownNotebookPlugin', () => {
  it('registers the notebook-level Run All toolbar postprocessor', async () => {
    const plugin = new MarkdownNotebookPlugin({} as never, {} as never);

    await plugin.onload();

    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledTimes(1);
    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledWith(expect.any(Function));
    const commandCalls = (plugin.addCommand as jest.Mock).mock.calls as Array<[Command]>;
    expect(commandCalls.map(([command]) => command.id)).toEqual(
      expect.arrayContaining(['clear-cell-output', 'clear-all-outputs']),
    );
  });

  it('clears the cursor cell output and then all remaining outputs', async () => {
    const plugin = new MarkdownNotebookPlugin({} as never, {} as never);
    await plugin.onload();
    const file = new TFile();
    file.path = 'Notebook.md';
    Object.assign(file, { extension: 'md', parent: { path: '' } });
    let markdown = [
      '```python', 'x = 1', '```',
      '<!-- nb-output hash="one" format="html" -->', '<div>one</div>', '<!-- /nb-output -->',
      '```python', 'x = 2', '```',
      '<!-- nb-output hash="two" format="html" -->', '<div>two</div>', '<!-- /nb-output -->',
    ].join('\n');
    (plugin.app.vault.process as jest.Mock).mockImplementation(
      async (_file: TFile, transform: (raw: string) => string) => {
        markdown = transform(markdown);
      },
    );
    (plugin.app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue({ file });
    const commandCalls = (plugin.addCommand as jest.Mock).mock.calls as Array<[Command]>;
    const commands = new Map<string, Command>(
      commandCalls.map(([command]) => [command.id, command]),
    );
    const clearCell = commands.get('clear-cell-output');
    const editor = {
      getValue: () => markdown,
      getCursor: () => ({ line: 4, ch: 0 }),
    };

    expect(clearCell!.editorCheckCallback!(true, editor as never, { file } as never)).toBe(true);
    expect(clearCell!.editorCheckCallback!(false, editor as never, { file } as never)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(markdown).not.toContain('hash="one"');
    expect(markdown).toContain('hash="two"');

    const clearAll = commands.get('clear-all-outputs');
    expect(clearAll!.checkCallback!(false)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(markdown).not.toContain('<!-- nb-output');
    expect(markdown).toContain('x = 1');
    expect(markdown).toContain('x = 2');
  });

  it('refuses to clear outputs while Run All is active', async () => {
    const plugin = new MarkdownNotebookPlugin({} as never, {} as never);
    await plugin.onload();
    const file = new TFile();
    file.path = 'Notebook.md';
    Object.assign(file, { extension: 'md', parent: { path: '' } });
    const markdown = [
      '```python', 'while True: pass', '```',
      '<!-- nb-output hash="old" format="html" -->', '<div>old</div>', '<!-- /nb-output -->',
    ].join('\n');
    (plugin.app.vault.read as jest.Mock).mockResolvedValue(markdown);
    (plugin.app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue({ file });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const kernel = {
      executionCount: 0,
      execute(_source: string, _onChunk: unknown, _timeout: number, signal?: AbortSignal) {
        markStarted();
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new KernelCancelledError()), { once: true });
        });
      },
    };
    const running = runAll(
      plugin.app,
      file,
      () => kernel as never,
      plugin.settings,
    );
    await started;
    const commandCalls = (plugin.addCommand as jest.Mock).mock.calls as Array<[Command]>;
    const clearAll = commandCalls.find(([command]) => command.id === 'clear-all-outputs')![0];

    expect(clearAll.checkCallback!(false)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(plugin.app.vault.process).not.toHaveBeenCalled();

    expect(cancelRunAll(file.path)).toBe(true);
    await running;
  });

  it('reuses kernels within a note but isolates different notes', async () => {
    const plugin = new MarkdownNotebookPlugin({} as never, {} as never);
    await plugin.onload();

    const first = new TFile();
    first.path = 'one/Notebook.md';
    Object.assign(first, { extension: 'md', parent: { path: 'one' } });
    const second = new TFile();
    second.path = 'two/Notebook.md';
    Object.assign(second, { extension: 'md', parent: { path: 'two' } });
    const files = new Map([[first.path, first], [second.path, second]]);
    Object.assign(plugin.app.vault, {
      adapter: { getBasePath: () => '/vault' },
      getAbstractFileByPath: jest.fn((sourcePath: string) => files.get(sourcePath)),
    });

    const firstKernel = plugin.acquireKernel('python', first.path);
    expect(plugin.acquireKernel('python', first.path)).toBe(firstKernel);
    expect(plugin.acquireKernel('python', second.path)).not.toBe(firstKernel);
    expect((firstKernel as unknown as { cwd: string }).cwd).toBe('/vault/one');

    const stop = jest.spyOn(firstKernel, 'stop');
    (firstKernel as unknown as { executionCount: number }).executionCount = 3;
    expect(plugin.peekExecutionCount('python', first.path)).toBe(3);
    expect(plugin.peekExecutionCount('python', 'missing.md')).toBe(0);
    expect(stop).not.toHaveBeenCalled();

    plugin.restartKernel('pythonPath');
    expect(stop).toHaveBeenCalled();
    expect(plugin.acquireKernel('python', first.path)).not.toBe(firstKernel);
  });

  it('stops sessions when notes are renamed, deleted, or no longer open', async () => {
    const plugin = new MarkdownNotebookPlugin({} as never, {} as never);
    await plugin.onload();
    const makeFile = (filePath: string) => {
      const file = new TFile();
      file.path = filePath;
      Object.assign(file, { extension: 'md', parent: { path: filePath.split('/')[0] } });
      return file;
    };
    const renamed = makeFile('one/Notebook.md');
    const deleted = makeFile('two/Notebook.md');
    const closed = makeFile('three/Notebook.md');
    const files = new Map([renamed, deleted, closed].map((file) => [file.path, file]));
    Object.assign(plugin.app.vault, {
      adapter: { getBasePath: () => '/vault' },
      getAbstractFileByPath: jest.fn((sourcePath: string) => files.get(sourcePath)),
    });
    const renamedKernel = plugin.acquireKernel('python', renamed.path);
    const deletedKernel = plugin.acquireKernel('python', deleted.path);
    const closedKernel = plugin.acquireKernel('python', closed.path);
    const renamedStop = jest.spyOn(renamedKernel, 'stop');
    const deletedStop = jest.spyOn(deletedKernel, 'stop');
    const closedStop = jest.spyOn(closedKernel, 'stop');

    const vaultOn = plugin.app.vault.on as jest.Mock;
    const rename = vaultOn.mock.calls.find(([name]) => name === 'rename')![1];
    const remove = vaultOn.mock.calls.find(([name]) => name === 'delete')![1];
    rename(renamed, renamed.path);
    remove(deleted);

    expect(renamedStop).toHaveBeenCalled();
    expect(deletedStop).toHaveBeenCalled();
    expect(closedStop).not.toHaveBeenCalled();

    const workspaceOn = plugin.app.workspace.on as jest.Mock;
    const layoutChange = workspaceOn.mock.calls.find(([name]) => name === 'layout-change')![1];
    (plugin.app.workspace.getLeavesOfType as jest.Mock).mockReturnValue([
      { view: { file: closed } },
    ]);
    layoutChange();
    expect(closedStop).not.toHaveBeenCalled();

    (plugin.app.workspace.getLeavesOfType as jest.Mock).mockReturnValue([]);
    layoutChange();
    expect(closedStop).toHaveBeenCalled();
  });
});
