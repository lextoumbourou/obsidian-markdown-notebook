import { parseRunBlocks } from '../src/RunAll';

describe('parseRunBlocks', () => {
  it('returns empty array for content with no run blocks', () => {
    const content = '# Heading\n\nSome text\n\n```python\nx = 1\n```\n';
    expect(parseRunBlocks(content)).toEqual([]);
  });

  it('parses a single python run block', () => {
    const content = '```python {run}\nprint("hello")\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe('python');
    expect(blocks[0].source).toBe('print("hello")');
    expect(blocks[0].lineEnd).toBe(2);
  });

  it('parses multiple run blocks in document order', () => {
    const content = [
      '```python {run}',
      'x = 1',
      '```',
      '',
      '```javascript {run}',
      'console.log("hi")',
      '```',
    ].join('\n');
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].language).toBe('python');
    expect(blocks[1].language).toBe('javascript');
  });

  it('parses the output arg', () => {
    const content = '```python {run output=image}\nplt.show()\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].output).toBe('image');
  });

  it('parses the id arg', () => {
    const content = '```python {run id=my-chart output=image}\nplt.show()\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].id).toBe('my-chart');
    expect(blocks[0].output).toBe('image');
  });

  it('handles blocks with no args beyond run', () => {
    const content = '```python {run}\npass\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].id).toBeUndefined();
    expect(blocks[0].output).toBeUndefined();
  });

  it('captures multi-line source correctly', () => {
    const content = '```python {run}\nimport pandas as pd\ndf = pd.DataFrame()\ndf\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks[0].source).toBe('import pandas as pd\ndf = pd.DataFrame()\ndf');
  });

  it('skips plain code blocks without {run}', () => {
    const content = '```python\nx = 1\n```\n\n```python {run}\ny = 2\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('y = 2');
  });

  it('records the correct lineEnd for each block', () => {
    const content = [
      '```python {run}',  // line 0
      'x = 1',            // line 1
      '```',              // line 2 — lineEnd
      '```python {run}',  // line 3
      'y = 2',            // line 4
      '```',              // line 5 — lineEnd
    ].join('\n');
    const blocks = parseRunBlocks(content);
    expect(blocks[0].lineEnd).toBe(2);
    expect(blocks[1].lineEnd).toBe(5);
  });

  it('parses bash and r blocks', () => {
    const content = '```bash {run}\nls -la\n```\n\n```r {run}\nsummary(cars)\n```\n';
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].language).toBe('bash');
    expect(blocks[1].language).toBe('r');
  });

  it('handles nb-output blocks between cells without including them in source', () => {
    const content = [
      '```python {run}',
      'x = 1',
      '```',
      '<!-- nb-output hash="abc" format="html" -->',
      '<div>1</div>',
      '<!-- /nb-output -->',
      '```python {run}',
      'y = 2',
      '```',
    ].join('\n');
    const blocks = parseRunBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toBe('x = 1');
    expect(blocks[1].source).toBe('y = 2');
  });
});
