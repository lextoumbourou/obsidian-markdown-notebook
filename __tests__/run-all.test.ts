import { parseRunBlocks } from '../src/RunAll';

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
