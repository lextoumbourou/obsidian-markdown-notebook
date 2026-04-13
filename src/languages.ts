export const SUPPORTED_LANGUAGES = ["python", "javascript", "bash", "r"] as const;

export const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  sh: "bash",
  shell: "bash",
};

/** Returns the canonical language name, or null if unsupported. */
export function canonicalLang(lang: string): string | null {
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) return lang;
  return LANG_ALIASES[lang] ?? null;
}
