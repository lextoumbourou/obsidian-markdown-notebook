import MarkdownNotebookPlugin from '../src/main';
import { TFile } from 'obsidian';

describe('MarkdownNotebookPlugin', () => {
  it('registers the notebook-level Run All toolbar postprocessor', async () => {
    const plugin = new MarkdownNotebookPlugin({} as never, {} as never);

    await plugin.onload();

    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledTimes(1);
    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledWith(expect.any(Function));
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
