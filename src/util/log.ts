import pc from "picocolors";

export const log = {
  info: (msg: string) => console.error(`${pc.blue("i")} ${msg}`),
  success: (msg: string) => console.error(`${pc.green("✓")} ${msg}`),
  warn: (msg: string) => console.error(`${pc.yellow("!")} ${msg}`),
  error: (msg: string) => console.error(`${pc.red("✗")} ${msg}`),
  step: (msg: string) => console.error(`${pc.cyan("→")} ${msg}`),
  dim: (msg: string) => console.error(pc.dim(msg)),
};

export class UserError extends Error {}
