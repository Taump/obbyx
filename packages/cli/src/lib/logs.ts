import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * `obbyx logs` — follow ONE payment through the JSON logs of the seller
 * middleware, the facilitator and the watcher (they share correlation fields:
 * requestId, binding, proofId, aa, seq). Reads files or stdin.
 */
export interface LogFilter {
  readonly binding?: string;
  readonly proof?: string;
  readonly aa?: string;
  readonly request?: string;
  readonly level?: string;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const SHOWN = [
  'binding',
  'proofId',
  'aa',
  'seq',
  'reason',
  'from',
  'to',
  'transaction',
  'amountSpent',
  'status',
  'err',
];

export function matches(entry: Record<string, unknown>, f: LogFilter): boolean {
  if (f.binding !== undefined && entry['binding'] !== f.binding) return false;
  if (f.proof !== undefined && entry['proofId'] !== f.proof && entry['unit'] !== f.proof)
    return false;
  if (f.aa !== undefined && entry['aa'] !== f.aa) return false;
  if (f.request !== undefined && entry['requestId'] !== f.request && entry['reqId'] !== f.request)
    return false;
  if (f.level !== undefined) {
    const min = LEVELS.indexOf(f.level);
    if (min >= 0 && LEVELS.indexOf(String(entry['level'])) < min) return false;
  }
  return true;
}

export function format(entry: Record<string, unknown>): string {
  const time = String(entry['time'] ?? '').slice(11, 23);
  const extra = SHOWN.filter((k) => entry[k] !== undefined)
    .map(
      (k) => `${k}=${typeof entry[k] === 'object' ? JSON.stringify(entry[k]) : String(entry[k])}`,
    )
    .join(' ');
  return `${time} ${String(entry['level'] ?? '').padEnd(5)} ${String(entry['service'] ?? '-')}/${String(entry['module'] ?? '-')}: ${String(entry['msg'] ?? '')}${extra ? `  ${extra}` : ''}`;
}

export async function logs(
  files: readonly string[],
  filter: LogFilter,
  out: (s: string) => void,
): Promise<number> {
  const sources = files.length > 0 ? files : ['-'];
  const found: Record<string, unknown>[] = [];
  for (const file of sources) {
    const input = file === '-' ? process.stdin : createReadStream(file, 'utf8');
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.startsWith('{')) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (matches(entry, filter)) found.push(entry);
      } catch {
        // not a JSON log line
      }
    }
  }
  // Several components' logs merged into one timeline.
  found.sort((a, b) => String(a['time'] ?? '').localeCompare(String(b['time'] ?? '')));
  for (const entry of found) out(format(entry));
  return found.length > 0 ? 0 : 1;
}
