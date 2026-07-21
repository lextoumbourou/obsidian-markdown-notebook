import MarkdownNotebookPlugin from '../src/main';

describe('MarkdownNotebookPlugin', () => {
  it('registers the notebook-level Run All toolbar postprocessor', async () => {
    const plugin = new MarkdownNotebookPlugin({} as never, {} as never);

    await plugin.onload();

    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledTimes(1);
    expect(plugin.registerMarkdownPostProcessor).toHaveBeenCalledWith(expect.any(Function));
  });
});
