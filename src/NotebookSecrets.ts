import type { SecretEnvironmentBinding } from "./settings/Settings";

export function resolveNotebookSecrets(
  notePath: string,
  bindings: SecretEnvironmentBinding[],
  getSecret: (id: string) => string | null,
): Record<string, string> {
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const binding of bindings) {
    if (binding.notePath !== notePath || !binding.variable || !binding.secretId) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.variable)) {
      throw new Error(`Invalid environment variable name: ${binding.variable}`);
    }
    if (Object.prototype.hasOwnProperty.call(environment, binding.variable)) {
      throw new Error(`Duplicate environment variable for ${notePath}: ${binding.variable}`);
    }
    const value = getSecret(binding.secretId);
    if (value === null) {
      throw new Error(`Secret "${binding.secretId}" for ${binding.variable} was not found`);
    }
    environment[binding.variable] = value;
  }
  return environment;
}
