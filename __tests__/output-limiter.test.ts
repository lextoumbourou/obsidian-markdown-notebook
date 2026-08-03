import { renderChunksToHtml } from '../src/output/MimeRenderer';
import { OutputLimiter } from '../src/output/OutputLimiter';

describe('OutputLimiter', () => {
  it('caps rendered UTF-8 output and appends a truncation marker', () => {
    const output = new OutputLimiter(1);
    const emitted = output.add({
      type: 'stream', stream: 'stdout', text: '<'.repeat(5000),
    });
    const html = renderChunksToHtml(output.chunks);

    expect(output.truncated).toBe(true);
    expect(emitted.at(-1)?.type).toBe('truncated');
    expect(html).toContain('Output truncated after 1 KB');
    expect(html).toContain('&lt;');
    expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(1024);
  });

  it('reclaims capped output space for a late traceback', () => {
    const output = new OutputLimiter(1);
    output.add({ type: 'stream', stream: 'stdout', text: 'x'.repeat(5000) });
    expect(output.add({ type: 'error', text: 'late traceback' })).toEqual([
      { type: 'error', text: 'late traceback' },
    ]);
    const html = renderChunksToHtml(output.chunks);
    expect(html).toContain('late traceback');
    expect(html).toContain('Output truncated after 1 KB');
    expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(1024);
  });

  it('independently truncates an oversized diagnostic while preserving its tail', () => {
    const output = new OutputLimiter(1);
    output.add({ type: 'stream', stream: 'stdout', text: 'logs'.repeat(1000) });
    output.add({
      type: 'error',
      text: `traceback-start\n${'frame\n'.repeat(1000)}ValueError: important diagnostic`,
    });
    const html = renderChunksToHtml(output.chunks);

    expect(html).toContain('ValueError: important diagnostic');
    expect(html).not.toContain('traceback-start');
    expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(1024);
  });

  it('drops oversized Markdown atomically rather than cutting raw HTML', () => {
    const output = new OutputLimiter(1);
    output.add({
      type: 'rich', mime: 'text/markdown', data: `<table>${'x'.repeat(5000)}</table>`,
    });
    const html = renderChunksToHtml(output.chunks);

    expect(html).not.toContain('<table>');
    expect(html).toContain('Output truncated after 1 KB');
  });

  it('does not split a UTF-8 surrogate pair', () => {
    const output = new OutputLimiter(1);
    output.add({ type: 'stream', stream: 'stdout', text: '🙂'.repeat(1000) });
    const text = output.chunks
      .filter((chunk) => chunk.type === 'stream')
      .map((chunk) => chunk.type === 'stream' ? chunk.text : '')
      .join('');
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(renderChunksToHtml(output.chunks)).toContain('Output truncated');
  });

  it('keeps native PNG data separate when image output will store a link', () => {
    const output = new OutputLimiter(1, true);
    const image = { type: 'rich' as const, mime: 'image/png', data: 'a'.repeat(5000) };

    output.add({ type: 'stream', stream: 'stdout', text: 'x'.repeat(5000) });
    expect(output.add(image)).toEqual([image]);
    expect(output.nativeImageData).toBe(image.data);
    expect(output.chunks.at(-1)?.type).toBe('truncated');
    expect(output.truncated).toBe(true);
  });
});
