import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBKernel } from "../src/kernels/DuckDBKernel";
import { KernelExecutionError, KernelTimeoutError } from "../src/kernels/BaseKernel";
import type { OutputChunk } from "../src/output/MimeRenderer";

const duckdbAvailable = spawnSync("duckdb", ["--version"]).status === 0;
const describeDuckDB = duckdbAvailable ? describe : describe.skip;

describeDuckDB("DuckDBKernel", () => {
  const kernels: DuckDBKernel[] = [];

  afterEach(() => {
    for (const kernel of kernels.splice(0)) kernel.stop();
  });

  function kernel(cwd = process.cwd()): DuckDBKernel {
    const instance = new DuckDBKernel("duckdb", cwd);
    kernels.push(instance);
    return instance;
  }

  async function execute(instance: DuckDBKernel, sql: string): Promise<OutputChunk[]> {
    const chunks: OutputChunk[] = [];
    await instance.execute(sql, (chunk) => chunks.push(chunk), 5000);
    return chunks;
  }

  it("renders query results as a rich HTML table", async () => {
    const chunks = await execute(kernel(), "SELECT 42 AS answer");
    expect(chunks).toEqual([
      expect.objectContaining({
        type: "rich",
        mime: "text/html",
        data: expect.stringContaining("<td>42</td>"),
      }),
    ]);
  });

  it("preserves temporary tables between cells", async () => {
    const instance = kernel();
    await execute(instance, "CREATE TEMP TABLE birds AS SELECT 'duck' AS name;");
    const chunks = await execute(instance, "SELECT * FROM birds;");
    expect(chunks).toEqual([
      expect.objectContaining({ data: expect.stringContaining("<td>duck</td>") }),
    ]);
  });

  it("reports SQL errors without poisoning the session", async () => {
    const instance = kernel();
    const chunks: OutputChunk[] = [];
    await expect(instance.execute(
      "SELECT missing_column;",
      (chunk) => chunks.push(chunk),
      5000,
    )).rejects.toBeInstanceOf(KernelExecutionError);
    expect(chunks).toEqual([
      expect.objectContaining({ type: "error", text: expect.stringContaining("Binder Error") }),
    ]);

    const recovered = await execute(instance, "SELECT 'still alive' AS status;");
    expect(recovered).toEqual([
      expect.objectContaining({ data: expect.stringContaining("still alive") }),
    ]);
  });

  it("queries files relative to the notebook working directory", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nb-duckdb-"));
    await fs.promises.writeFile(
      path.join(directory, "birds.csv"),
      "name,count\nduck,3\ngoose,2\n",
      "utf8",
    );
    try {
      const chunks = await execute(
        kernel(directory),
        "SELECT sum(count) AS total FROM read_csv_auto('birds.csv');",
      );
      expect(chunks).toEqual([
        expect.objectContaining({ data: expect.stringContaining("<td>5</td>") }),
      ]);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  it("interrupts a timed-out query and remains usable", async () => {
    const instance = kernel();
    await expect(instance.execute(
      "SELECT sum(sin(i)) FROM range(10000000000) t(i);",
      () => undefined,
      30,
    )).rejects.toBeInstanceOf(KernelTimeoutError);

    const recovered = await execute(instance, "SELECT 7 AS value;");
    expect(recovered).toEqual([
      expect.objectContaining({ data: expect.stringContaining("<td>7</td>") }),
    ]);
  });

  it("removes its init file when the CLI exits unexpectedly", async () => {
    const instance = kernel();
    await instance.ensureStarted();
    const initFile = (instance as unknown as { initFile: string }).initFile;
    expect(fs.existsSync(initFile)).toBe(true);

    await expect(instance.execute(".quit", () => undefined, 5000))
      .rejects.toThrow("exited during execution");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(initFile)).toBe(false);
  });
});
