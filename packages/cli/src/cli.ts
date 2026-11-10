import yargs, { type Argv, type CommandModule } from 'yargs';
import { ObbyxError } from '@obbyx/obyte';
import { addressCommand } from './commands/address.js';
import { balanceCommand } from './commands/balance.js';
import { channelCommands } from './commands/channel.js';
import { decodeCommand } from './commands/decode.js';
import { doctorCommand } from './commands/doctor.js';
import { faucetCommand } from './commands/faucet.js';
import { initCommand } from './commands/init.js';
import { logsCommand } from './commands/logs.js';
import { payCommand } from './commands/pay.js';
import type { AnyCmd, CliIo, CommandContext } from './commands/types.js';

export type { CliIo } from './commands/types.js';
export { decodeAny, resolveNetwork } from './runtime.js';

/**
 * The `obbyx` command line, on yargs. Every command lives in `commands/` as a
 * definition (name, options, handler); this module only assembles them. The
 * CLI reference in the docs is generated from the same definitions
 * (`renderHelp`, `commandPaths`).
 */

/** Commands store their exit code here (yargs handlers cannot return one). */
interface RunState {
  code: number;
  io: CliIo;
}

const EPILOG = `Environment:
  OBBYX_HOME  wallet directory (default ~/.obbyx)
  LOG_LEVEL   logging to stderr (default warn)

Exit codes: 0 ok, 1 error/usage, 2 refused (HTTP error, faucet refusal), 3 pending (retry later)`;

function commands(state: RunState): { top: AnyCmd[]; channel: AnyCmd[] } {
  const ctx: CommandContext = {
    out: state.io.out,
    err: state.io.err,
    done: (code) => {
      state.code = code;
    },
  };
  return {
    top: [
      initCommand(ctx),
      addressCommand(ctx),
      balanceCommand(ctx),
      faucetCommand(ctx),
      payCommand(ctx),
      doctorCommand(ctx),
      logsCommand(ctx),
      decodeCommand(ctx),
    ] as AnyCmd[],
    channel: channelCommands(ctx) as AnyCmd[],
  };
}

/** Builds the yargs parser. `width` fixes the help width (docs generation). */
export function buildCli(argv: readonly string[], state: RunState, width?: number): Argv {
  const defs = commands(state);
  let cli: Argv = yargs([...argv])
    .scriptName('obbyx')
    .usage('obbyx — x402 payments on Obyte\n\nUsage: $0 <command> [options]')
    .option('network', {
      type: 'string',
      default: 'testnet',
      global: true,
      choices: ['testnet', 'livenet', 'obyte:testnet', 'obyte:livenet'],
      describe: 'Obyte network',
    })
    .option('hub', { type: 'string', global: true, describe: 'Obyte hub WebSocket URL' });
  for (const c of defs.top) cli = cli.command(c as unknown as CommandModule);
  cli = cli
    .command(
      'channel',
      'Payment channels: open, list, status, deposit, close, confirm, recover',
      (y) => {
        let ch = y;
        for (const c of defs.channel) ch = ch.command(c as unknown as CommandModule);
        return ch.demandCommand(1, 'Choose a channel command').strict();
      },
    )
    .demandCommand(1, 'Choose a command')
    .recommendCommands()
    .strict()
    .epilog(EPILOG)
    .alias('h', 'help')
    .version(false)
    .exitProcess(false)
    .showHelpOnFail(false)
    .wrap(width ?? Math.min(100, process.stdout.columns ?? 100))
    .fail((msg, e) => {
      throw (
        e ??
        new ObbyxError('usage', msg.startsWith('Did you mean') ? `Unknown command. ${msg}` : msg)
      );
    });
  return cli;
}

/** Runs the CLI; returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const state: RunState = { code: 0, io };
  try {
    let helpOutput = '';
    await buildCli(argv, state).parseAsync([...argv], {}, (_e, _a, output) => {
      helpOutput = output;
    });
    if (helpOutput) io.out(helpOutput);
    return state.code;
  } catch (e) {
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof ObbyxError && e.code === 'usage') io.err('Run `obbyx --help` for usage.');
    return 1;
  }
}

/** Help text of a command path (e.g. `['channel', 'open']`), for the generated CLI reference. */
export async function renderHelp(path: readonly string[], width = 100): Promise<string> {
  const state: RunState = { code: 0, io: { out: () => undefined, err: () => undefined } };
  let text = '';
  await buildCli([...path, '--help'], state, width).parseAsync(
    [...path, '--help'],
    {},
    (_e, _a, output) => {
      text = output;
    },
  );
  return text;
}

/** Command paths for the reference, in display order (from the same definitions). */
export function commandPaths(): string[][] {
  const defs = commands({ code: 0, io: { out: () => undefined, err: () => undefined } });
  const name = (c: AnyCmd) => String(c.command).split(' ')[0] ?? '';
  return [
    [],
    ...defs.top.map((c) => [name(c)]),
    ['channel'],
    ...defs.channel.map((c) => ['channel', name(c)]),
  ];
}
