import { TFile, TFolder } from 'obsidian';
import {
  findOutputBlock,
  writeOutputBlock,
  clearStaleRunningBlocks,
  imageLink,
  saveImageToVault,
} from '../src/OutputBlock';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(basename: string, parentPath: string): TFile {
  const f = new TFile();
  f.basename = basename;
  const folder = new TFolder();
  folder.path = parentPath;
  f.parent = folder;
  return f;
}

function makeVaultMock(initial: string) {
  let content = initial;
  return {
    vault: {
      process: jest.fn((_file: TFile, fn: (s: string) => string) => {
        content = fn(content);
        return Promise.resolve(content);
      }),
      getAbstractFileByPath: jest.fn(() => null),
    },
    get content() { return content; },
  };
}

// ── findOutputBlock ───────────────────────────────────────────────────────────

describe('findOutputBlock', () => {
  it('returns null when no output block follows the fence', () => {
    const lines = ['```python', 'x = 1', '```', ''];
    expect(findOutputBlock(lines, 2)).toBeNull();
  });

  it('finds a block immediately after the fence', () => {
    const lines = [
      '```python',
      'x = 1',
      '```',
      '<!-- nb-output hash="abc12345" format="html" -->',
      '<div>hello</div>',
      '<!-- /nb-output -->',
    ];
    const block = findOutputBlock(lines, 2);
    expect(block).not.toBeNull();
    expect(block!.hash).toBe('abc12345');
    expect(block!.format).toBe('html');
    expect(block!.content).toBe('<div>hello</div>');
    expect(block!.lineStart).toBe(3);
    expect(block!.lineEnd).toBe(5);
  });

  it('finds a block after one blank line', () => {
    const lines = [
      '```python',
      'x = 1',
      '```',
      '',
      '<!-- nb-output hash="abc12345" format="html" -->',
      '<div>hello</div>',
      '<!-- /nb-output -->',
    ];
    const block = findOutputBlock(lines, 2);
    expect(block).not.toBeNull();
    expect(block!.hash).toBe('abc12345');
  });

  it('stops searching when a non-blank, non-marker line is encountered', () => {
    const lines = [
      '```python',
      'x = 1',
      '```',
      'some other text',
      '<!-- nb-output hash="abc12345" format="html" -->',
      '<div>hello</div>',
      '<!-- /nb-output -->',
    ];
    expect(findOutputBlock(lines, 2)).toBeNull();
  });

  it('parses the id attribute', () => {
    const lines = [
      '```python',
      '```',
      '<!-- nb-output id="my-plot" hash="abc12345" format="image" -->',
      '![[my-plot.png]]',
      '<!-- /nb-output -->',
    ];
    const block = findOutputBlock(lines, 1);
    expect(block!.id).toBe('my-plot');
    expect(block!.format).toBe('image');
  });

  it('defaults format to html for legacy blocks without format attribute', () => {
    const lines = [
      '```python',
      '```',
      '<!-- nb-output hash="abc12345" -->',
      '<div>old</div>',
      '<!-- /nb-output -->',
    ];
    const block = findOutputBlock(lines, 1);
    expect(block!.format).toBe('html');
    expect(block!.id).toBeUndefined();
  });

  it('parses the status attribute', () => {
    const lines = [
      '```python',
      '```',
      '<!-- nb-output hash="abc12345" format="html" status="running" -->',
      '',
      '<!-- /nb-output -->',
    ];
    const block = findOutputBlock(lines, 1);
    expect(block!.status).toBe('running');
  });

  it('leaves status undefined when attribute is absent', () => {
    const lines = [
      '```python',
      '```',
      '<!-- nb-output hash="abc12345" format="html" -->',
      '<div>done</div>',
      '<!-- /nb-output -->',
    ];
    const block = findOutputBlock(lines, 1);
    expect(block!.status).toBeUndefined();
  });

  it('handles multi-line content', () => {
    const lines = [
      '```python',
      '```',
      '<!-- nb-output hash="abc12345" format="html" -->',
      '<div>',
      '  <p>hello</p>',
      '</div>',
      '<!-- /nb-output -->',
    ];
    const block = findOutputBlock(lines, 1);
    expect(block!.content).toBe('<div>\n  <p>hello</p>\n</div>');
  });
});

// ── writeOutputBlock ──────────────────────────────────────────────────────────

describe('writeOutputBlock', () => {
  const pyCell = (source: string, hintLine = 0) => ({ language: 'python', source, hintLine });

  it('inserts a new block after the code fence end line', async () => {
    const initial = '```python\nx = 1\n```\n\nsome other text';
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    const written = await writeOutputBlock(
      mock as never, file, pyCell('x = 1', 2), 'abc12345', '<div>out</div>', 'html'
    );

    expect(written).toBe(true);
    expect(mock.content).toContain('<!-- nb-output hash="abc12345" format="html" -->');
    expect(mock.content).toContain('<div>out</div>');
    expect(mock.content).toContain('<!-- /nb-output -->');
  });

  it('replaces an existing block in-place', async () => {
    const initial = [
      '```python',
      'x = 1',
      '```',
      '<!-- nb-output hash="old00000" format="html" -->',
      '<div>old</div>',
      '<!-- /nb-output -->',
    ].join('\n');
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(mock as never, file, pyCell('x = 1', 2), 'new11111', '<div>new</div>', 'html');

    expect(mock.content).not.toContain('old00000');
    expect(mock.content).not.toContain('<div>old</div>');
    expect(mock.content).toContain('new11111');
    expect(mock.content).toContain('<div>new</div>');
  });

  it('includes id attribute in the marker when provided', async () => {
    const initial = '```python\n```\n';
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(mock as never, file, pyCell('', 1), 'abc12345', '![[plot.png]]', 'image', 'my-plot');

    expect(mock.content).toContain('id="my-plot"');
    expect(mock.content).toContain('format="image"');
  });

  it('includes status attribute in the marker when provided', async () => {
    const initial = '```python\n```\n';
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(mock as never, file, pyCell('', 1), 'abc12345', '', 'html', undefined, 'running');

    expect(mock.content).toContain('status="running"');
  });

  it('omits status attribute when not provided', async () => {
    const initial = '```python\n```\n';
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(mock as never, file, pyCell('', 1), 'abc12345', '<div>done</div>', 'html');

    expect(mock.content).not.toContain('status=');
  });

  it('re-anchors when lines shifted after the position was captured', async () => {
    // Two cells; cell B's position was captured before cell A's output
    // (3 lines) was inserted above it — its hintLine is stale by 3.
    const initial = [
      '```python',          // 0
      'print("a")',         // 1
      '```',                // 2
      '<!-- nb-output hash="aaa" format="html" -->', // 3  (cell A just wrote this)
      '<div>a</div>',       // 4
      '<!-- /nb-output -->',// 5
      '',                   // 6
      '```python',          // 7
      'print("b")',         // 8
      '```',                // 9   <- cell B's real fence end (captured as 6, pre-shift)
    ].join('\n');
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(mock as never, file, pyCell('print("b")', 6), 'bbb', '<div>b</div>', 'html');

    const lines = mock.content.split('\n');
    // Cell A's block is untouched, and B's block sits directly under B's fence
    expect(lines[3]).toContain('hash="aaa"');
    expect(lines[4]).toBe('<div>a</div>');
    expect(lines[10]).toContain('hash="bbb"');
    expect(lines[11]).toBe('<div>b</div>');
  });

  it('matches fences by alias (js fence, javascript cell)', async () => {
    const initial = '```js\nconsole.log(1)\n```';
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(
      mock as never, file,
      { language: 'javascript', source: 'console.log(1)', hintLine: 2 },
      'abc', '<div>1</div>', 'html'
    );

    expect(mock.content).toContain('hash="abc"');
  });

  it('drops the write when the cell no longer exists in the file', async () => {
    const initial = '```python\nprint("edited away")\n```';
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    const written = await writeOutputBlock(
      mock as never, file, pyCell('print("original")', 2), 'abc', '<div>x</div>', 'html'
    );

    expect(written).toBe(false);
    expect(mock.content).toBe(initial);
  });

  it('handles CRLF files: replaces the block and preserves CRLF endings', async () => {
    const initial = [
      '```python',
      'x = 1',
      '```',
      '<!-- nb-output hash="old00000" format="html" -->',
      '<div>old</div>',
      '<!-- /nb-output -->',
    ].join('\r\n');
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(mock as never, file, pyCell('x = 1', 2), 'new11111', '<div>new</div>', 'html');

    expect(mock.content).not.toContain('old00000');
    expect(mock.content).toContain('new11111');
    expect(mock.content).toContain('\r\n');
    // No duplicate block appended — exactly one start marker
    expect(mock.content.match(/<!-- nb-output /g)).toHaveLength(1);
  });

  it('disambiguates identical cells by nearest hint line', async () => {
    const initial = [
      '```python',  // 0
      'x',          // 1
      '```',        // 2
      '',
      '```python',  // 4
      'x',          // 5
      '```',        // 6
    ].join('\n');
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await writeOutputBlock(mock as never, file, pyCell('x', 6), 'second', '<div>2nd</div>', 'html');

    const lines = mock.content.split('\n');
    expect(lines[7]).toContain('hash="second"');
    expect(lines[3]).toBe('');
  });
});

// ── clearStaleRunningBlocks ───────────────────────────────────────────────────

describe('clearStaleRunningBlocks', () => {
  const running = (hash: string) => [
    `<!-- nb-output hash="${hash}" format="html" status="running" -->`,
    '<div class="nb-status-running">Running...</div>',
    '<!-- /nb-output -->',
  ];

  it('replaces a stale running block with an interrupted error block', async () => {
    const initial = ['```python', 'x', '```', ...running('stale123')].join('\n');
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await clearStaleRunningBlocks(mock as never, file, () => false);

    expect(mock.content).toContain('status="error"');
    expect(mock.content).toContain('Execution was interrupted');
    expect(mock.content).not.toContain('status="running"');
    expect(mock.content).toContain('hash="stale123"');
  });

  it('leaves a running block alone while its cell is in flight', async () => {
    const initial = ['```python', 'x', '```', ...running('live456')].join('\n');
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await clearStaleRunningBlocks(mock as never, file, (hash) => hash === 'live456');

    expect(mock.content).toBe(initial);
  });

  it('does not touch completed output blocks', async () => {
    const initial = [
      '```python', 'x', '```',
      '<!-- nb-output hash="done789" format="html" -->',
      '<div>done</div>',
      '<!-- /nb-output -->',
    ].join('\n');
    const mock = makeVaultMock(initial);
    const file = makeFile('note', '');

    await clearStaleRunningBlocks(mock as never, file, () => false);

    expect(mock.content).toBe(initial);
  });
});

// ── imageLink ─────────────────────────────────────────────────────────────────

describe('imageLink', () => {
  it('produces a wikilink by default', () => {
    const file = makeFile('analysis', 'notes');
    expect(imageLink('plot.png', 'notes/plot.png', file, false)).toBe('![[plot.png]]');
  });

  it('produces a markdown link with relative path when image is in the same folder', () => {
    const file = makeFile('analysis', 'notes');
    expect(imageLink('plot.png', 'notes/plot.png', file, true)).toBe('![](plot.png)');
  });

  it('produces a markdown link traversing up when image is in a sibling folder', () => {
    const file = makeFile('analysis', 'notes');
    expect(imageLink('plot.png', 'attachments/plot.png', file, true)).toBe('![](../attachments/plot.png)');
  });

  it('produces a markdown link from a nested note to root attachment', () => {
    const file = makeFile('analysis', 'notes/2024');
    expect(imageLink('plot.png', 'attachments/plot.png', file, true)).toBe('![](../../attachments/plot.png)');
  });

  it('handles note at vault root', () => {
    const file = makeFile('analysis', '');
    expect(imageLink('plot.png', 'attachments/plot.png', file, true)).toBe('![](attachments/plot.png)');
  });
});

// ── saveImageToVault ──────────────────────────────────────────────────────────

function makeAppMock() {
  return {
    vault: {
      adapter: {
        exists: jest.fn().mockResolvedValue(false),
        writeBinary: jest.fn().mockResolvedValue(undefined),
      },
      createFolder: jest.fn().mockResolvedValue(undefined),
      createBinary: jest.fn().mockResolvedValue(undefined),
      modifyBinary: jest.fn().mockResolvedValue(undefined),
      getAbstractFileByPath: jest.fn().mockReturnValue(null),
    },
  };
}

describe('saveImageToVault', () => {
  const base64 = btoa('fake-png-data');

  it('strips trailing slash from mediaPath', async () => {
    const app = makeAppMock();
    const file = makeFile('note', '');
    const { vaultPath } = await saveImageToVault(app as never, file, 'chart', 'abc123', base64, 'attachments/');
    expect(vaultPath).toBe('attachments/chart.png');
  });

  it('strips multiple trailing slashes', async () => {
    const app = makeAppMock();
    const file = makeFile('note', '');
    const { vaultPath } = await saveImageToVault(app as never, file, 'chart', 'abc123', base64, 'attachments///');
    expect(vaultPath).toBe('attachments/chart.png');
  });

  it('works correctly without a trailing slash', async () => {
    const app = makeAppMock();
    const file = makeFile('note', '');
    const { vaultPath } = await saveImageToVault(app as never, file, 'chart', 'abc123', base64, 'attachments');
    expect(vaultPath).toBe('attachments/chart.png');
  });
});
