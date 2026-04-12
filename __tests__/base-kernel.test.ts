import { stripAnsi, kernelEnv } from '../src/kernels/BaseKernel';

describe('stripAnsi', () => {
  it('removes basic colour escape codes', () => {
    expect(stripAnsi('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  it('removes multi-part codes', () => {
    expect(stripAnsi('\x1b[1;32mbold green\x1b[0m')).toBe('bold green');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('handles multiple escape sequences on one line', () => {
    const input = '\x1b[31mError:\x1b[0m \x1b[33mwarning\x1b[0m';
    expect(stripAnsi(input)).toBe('Error: warning');
  });

  it('handles Python traceback ANSI output', () => {
    const input = '\x1b[0;31mTraceback (most recent call last):\x1b[0m\n  File "test.py"';
    expect(stripAnsi(input)).toBe('Traceback (most recent call last):\n  File "test.py"');
  });
});

describe('kernelEnv', () => {
  it('returns an object containing PATH', () => {
    const env = kernelEnv();
    expect(env.PATH).toBeDefined();
  });

  it('includes /usr/local/bin in PATH', () => {
    const env = kernelEnv();
    expect(env.PATH!.split(':')).toContain('/usr/local/bin');
  });

  it('includes /opt/homebrew/bin in PATH', () => {
    const env = kernelEnv();
    expect(env.PATH!.split(':')).toContain('/opt/homebrew/bin');
  });

  it('places extra dirs before the original PATH entries', () => {
    const env = kernelEnv();
    const parts = env.PATH!.split(':');
    const homebrewIdx = parts.indexOf('/opt/homebrew/bin');
    // Extra dirs that weren't already in PATH should appear near the front
    if (homebrewIdx !== -1 && !(process.env.PATH ?? '').includes('/opt/homebrew/bin')) {
      expect(homebrewIdx).toBeLessThan(5);
    }
  });

  it('does not introduce new duplicates for the prepended entries', () => {
    const env = kernelEnv();
    const parts = env.PATH!.split(':');
    // Each of the known extra dirs should appear at most once
    for (const extra of ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin']) {
      const count = parts.filter((p) => p === extra).length;
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it('preserves other environment variables', () => {
    const env = kernelEnv();
    if (process.env.HOME) {
      expect(env.HOME).toBe(process.env.HOME);
    }
  });
});
