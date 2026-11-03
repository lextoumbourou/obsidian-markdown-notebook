/** Source-code presentation; independent of cell execution and output. */
export type InputVisibility = "show" | "collapsed";

export function parseInputVisibility(value: unknown): InputVisibility | undefined {
  return value === "show" || value === "collapsed" ? value : undefined;
}
