import { logs } from '../lib/logs.js';
import type { CommandContext, Cmd } from './types.js';

interface LogsArgs {
  files: string[];
  binding?: string;
  proof?: string;
  aa?: string;
  request?: string;
  level?: string;
}
export function logsCommand({ out, done }: CommandContext): Cmd<LogsArgs> {
  return {
    command: 'logs <files..>',
    describe: 'Follow one payment through JSON log files',
    builder: (y) =>
      y
        .positional('files', {
          type: 'string',
          array: true,
          demandOption: true,
          describe: 'JSON log files',
        })
        .option('binding', { type: 'string', describe: 'Only entries of this payment binding' })
        .option('proof', { type: 'string', describe: 'Only entries of this proof id' })
        .option('aa', { type: 'string', describe: 'Only entries of this channel AA' })
        .option('request', { type: 'string', describe: 'Only entries of this request id' })
        .option('level', {
          type: 'string',
          describe: 'Minimum level (debug, info, warn, ...)',
        }),
    handler: async (a) => {
      done(
        await logs(
          a.files,
          {
            ...(a.binding === undefined ? {} : { binding: a.binding }),
            ...(a.proof === undefined ? {} : { proof: a.proof }),
            ...(a.aa === undefined ? {} : { aa: a.aa }),
            ...(a.request === undefined ? {} : { request: a.request }),
            ...(a.level === undefined ? {} : { level: a.level }),
          },
          out,
        ),
      );
    },
  };
}
