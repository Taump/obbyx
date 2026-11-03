import { homedir } from 'node:os';
import type { z } from 'zod';

interface Def {
  type: string;
  innerType?: z.ZodType;
  defaultValue?: unknown;
  entries?: Record<string, string>;
  in?: z.ZodType;
}
const defOf = (t: z.ZodType) => (t as unknown as { _zod: { def: Def } })._zod.def;

/** Describes one env variable from its zod schema: type, default, required, description. */
export function describeEnv(schema: z.ZodType): {
  type: string;
  default?: string;
  required: boolean;
  description: string;
} {
  let t = schema;
  let required = true;
  let dflt: unknown;
  const description = schema.description ?? '';
  for (;;) {
    const d = defOf(t);
    if (d.type === 'default') {
      required = false;
      dflt =
        typeof d.defaultValue === 'function' ? (d.defaultValue as () => unknown)() : d.defaultValue;
      t = d.innerType as z.ZodType;
    } else if (d.type === 'optional') {
      required = false;
      t = d.innerType as z.ZodType;
    } else break;
  }
  const d = defOf(t);
  const type =
    d.type === 'enum'
      ? Object.values(d.entries ?? {})
          .map((v) => `\`${v}\``)
          .join(' \\| ')
      : d.type === 'pipe'
        ? 'list (comma-separated)'
        : d.type === 'bigint'
          ? 'integer'
          : d.type;
  const shown =
    dflt === undefined
      ? undefined
      : Array.isArray(dflt)
        ? dflt.join(',') || '(empty)'
        : String(dflt).replace(homedir(), '~');
  return { type, ...(shown === undefined ? {} : { default: shown }), required, description };
}

export function renderEnvTable(shape: Record<string, z.ZodType>): string {
  const rows = ['| Variable | Type | Default | Description |', '| --- | --- | --- | --- |'];
  for (const [name, field] of Object.entries(shape)) {
    const e = describeEnv(field);
    const dflt = e.default !== undefined ? `\`${e.default}\`` : e.required ? '**required**' : '—';
    rows.push(
      `| \`${name}\` | ${e.type} | ${dflt} | ${e.description.replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;')} |`,
    );
  }
  return rows.join('\n');
}
