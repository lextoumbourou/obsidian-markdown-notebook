import {
  renderChunksToHtml,
  extractImageData,
  OutputChunk,
} from '../src/output/MimeRenderer';

// ── renderChunksToHtml ────────────────────────────────────────────────────────

describe('renderChunksToHtml', () => {
  it('returns empty string for no chunks', () => {
    expect(renderChunksToHtml([])).toBe('');
  });

  it('wraps stdout in nb-output > pre.nb-stream-stdout', () => {
    const chunks: OutputChunk[] = [{ type: 'stream', stream: 'stdout', text: 'hello\n' }];
    const html = renderChunksToHtml(chunks);
    expect(html).toContain('class="nb-output"');
    expect(html).toContain('class="nb-stream-stdout"');
    expect(html).toContain('hello');
  });

  it('wraps stderr in pre.nb-stream-stderr', () => {
    const chunks: OutputChunk[] = [{ type: 'stream', stream: 'stderr', text: 'oops\n' }];
    const html = renderChunksToHtml(chunks);
    expect(html).toContain('class="nb-stream-stderr"');
    expect(html).toContain('oops');
  });

  it('wraps error type in pre.nb-stream-stderr', () => {
    const chunks: OutputChunk[] = [{ type: 'error', text: 'Traceback...' }];
    const html = renderChunksToHtml(chunks);
    expect(html).toContain('class="nb-stream-stderr"');
    expect(html).toContain('Traceback');
  });

  it('renders text/html rich output inside nb-output-html div', () => {
    const chunks: OutputChunk[] = [{ type: 'rich', mime: 'text/html', data: '<table></table>' }];
    const html = renderChunksToHtml(chunks);
    expect(html).toContain('class="nb-output-html"');
    expect(html).toContain('<table></table>');
  });

  it('renders image/png as base64 img tag', () => {
    const chunks: OutputChunk[] = [{ type: 'rich', mime: 'image/png', data: 'abc123==' }];
    const html = renderChunksToHtml(chunks);
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,abc123==');
  });

  it('escapes HTML entities in stdout', () => {
    const chunks: OutputChunk[] = [{ type: 'stream', stream: 'stdout', text: '<script>alert(1)</script>' }];
    const html = renderChunksToHtml(chunks);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('combines multiple chunks', () => {
    const chunks: OutputChunk[] = [
      { type: 'stream', stream: 'stdout', text: 'line1\n' },
      { type: 'stream', stream: 'stderr', text: 'err\n' },
    ];
    const html = renderChunksToHtml(chunks);
    expect(html).toContain('nb-stream-stdout');
    expect(html).toContain('nb-stream-stderr');
  });
});

// ── extractImageData ──────────────────────────────────────────────────────────

describe('extractImageData', () => {
  it('returns null when no image chunk', () => {
    const chunks: OutputChunk[] = [
      { type: 'stream', stream: 'stdout', text: 'hello' },
    ];
    expect(extractImageData(chunks)).toBeNull();
  });

  it('returns null for empty chunks', () => {
    expect(extractImageData([])).toBeNull();
  });

  it('returns base64 data from the first image/png chunk', () => {
    const chunks: OutputChunk[] = [
      { type: 'stream', stream: 'stdout', text: 'before' },
      { type: 'rich', mime: 'image/png', data: 'abc123==' },
    ];
    expect(extractImageData(chunks)).toBe('abc123==');
  });

  it('returns the first image chunk when multiple are present', () => {
    const chunks: OutputChunk[] = [
      { type: 'rich', mime: 'image/png', data: 'first==' },
      { type: 'rich', mime: 'image/png', data: 'second==' },
    ];
    expect(extractImageData(chunks)).toBe('first==');
  });

  it('ignores non-png rich types', () => {
    const chunks: OutputChunk[] = [
      { type: 'rich', mime: 'text/html', data: '<table></table>' },
    ];
    expect(extractImageData(chunks)).toBeNull();
  });
});
