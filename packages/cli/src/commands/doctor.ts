import { doctor } from '../lib/doctor.js';
import { resolveNetwork } from '../runtime.js';
import type { CommandContext, Cmd } from './types.js';

export function doctorCommand({ out, done }: CommandContext): Cmd<{ facilitator?: string }> {
  return {
    command: 'doctor',
    describe: 'Check wallet, hub, balance, pending payments',
    builder: (y) =>
      y.option('facilitator', { type: 'string', describe: 'Facilitator URL to check' }),
    handler: async (a) => {
      done(
        await doctor(resolveNetwork(a.network), {
          ...(a.hub === undefined ? {} : { hub: a.hub }),
          ...(a.facilitator === undefined ? {} : { facilitator: a.facilitator }),
          out,
        }),
      );
    },
  };
}
