// Polyfill Web Crypto for Node < 19 where it isn't exposed as a global.
import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto = webcrypto;
}
