/**
 * Compute a short SHA-256 hash of a code fence's language + source.
 * Returns 16 hex characters (8 bytes) — short enough to be readable,
 * collision-resistant enough for a single file.
 */
export async function hashCodeFence(language: string, source: string): Promise<string> {
  const text = `${language}\n${source}`;
  const encoded = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
