import { resolveNotebookSecrets } from "../src/NotebookSecrets";
import { notebookKernelSessionKey } from "../src/NotebookKernelConfig";
import { kernelEnv } from "../src/kernels/BaseKernel";

describe("notebook secret environment", () => {
  const bindings = [
    { notePath: "notes/Agent.md", variable: "OPENAI_API_KEY", secretId: "openai-personal" },
  ];

  it("provides a secret only to its configured note and keeps the parent environment unchanged", () => {
    const original = process.env.OPENAI_API_KEY;
    const getSecret = jest.fn(() => "test-secret");

    expect(resolveNotebookSecrets("notes/Other.md", bindings, getSecret))
      .toEqual({});
    expect(getSecret).not.toHaveBeenCalled();

    const environment = resolveNotebookSecrets("notes/Agent.md", bindings, getSecret);
    expect(kernelEnv(environment).OPENAI_API_KEY).toBe("test-secret");
    expect(kernelEnv({ PATH: "/custom/bin", OPENAI_API_KEY: "test-secret" }).PATH)
      .toContain("/custom/bin");
    expect(process.env.OPENAI_API_KEY).toBe(original);
  });

  it("fails clearly when a configured secret is missing", () => {
    expect(() => resolveNotebookSecrets("notes/Agent.md", bindings, () => null))
      .toThrow('Secret "openai-personal" for OPENAI_API_KEY was not found');
  });

  it("uses a different session when the secret changes without putting it in the key", () => {
    const base = { notePath: "notes/Agent.md", language: "python", executable: "python3", cwd: "/vault" };
    const first = notebookKernelSessionKey({ ...base, environment: { OPENAI_API_KEY: "first-secret" } });
    const second = notebookKernelSessionKey({ ...base, environment: { OPENAI_API_KEY: "second-secret" } });
    expect(first).not.toBe(second);
    expect(first).not.toContain("first-secret");
  });
});
