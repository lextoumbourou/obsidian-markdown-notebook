import { hashCodeFence } from '../src/HashUtils';

describe('hashCodeFence', () => {
  it('returns a 16-character hex string', async () => {
    const hash = await hashCodeFence('python', 'x = 1');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await hashCodeFence('python', 'x = 1');
    const b = await hashCodeFence('python', 'x = 1');
    expect(a).toBe(b);
  });

  it('produces different hashes for different source code', async () => {
    const a = await hashCodeFence('python', 'x = 1');
    const b = await hashCodeFence('python', 'x = 2');
    expect(a).not.toBe(b);
  });

  it('produces different hashes for different languages with same source', async () => {
    const a = await hashCodeFence('python', 'x = 1');
    const b = await hashCodeFence('javascript', 'x = 1');
    expect(a).not.toBe(b);
  });

  it('handles empty source', async () => {
    const hash = await hashCodeFence('python', '');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles multi-line source', async () => {
    const hash = await hashCodeFence('python', 'import pandas as pd\ndf = pd.DataFrame()\ndf');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});
