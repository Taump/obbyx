import type { Argv } from 'yargs';

/** Output of the CLI (stdout / stderr), injectable for tests. */
export interface CliIo {
  out(line?: string): void;
  err(line: string): void;
}

/** Options every command accepts. */
export interface GlobalArgs {
  network: string;
  hub: string | undefined;
}

/** What a command needs from the runner: output and a way to set the exit code. */
export interface CommandContext {
  readonly out: (line?: string) => void;
  readonly err: (line: string) => void;
  /** yargs handlers cannot return a value: the exit code is set here. */
  readonly done: (code: number) => void;
}

/** One command; the builder declares the options/positionals that `A` describes. */
export interface Cmd<A = object> {
  readonly command: string;
  readonly describe: string;
  readonly builder?: (y: Argv) => Argv;
  readonly handler: (args: GlobalArgs & A) => void | Promise<void>;
}

export type AnyCmd = Cmd<never>;
