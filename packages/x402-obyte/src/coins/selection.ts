/** Coin selection from a light history (pure functions). */
export interface Utxo {
  readonly unit: string;
  readonly messageIndex: number;
  readonly outputIndex: number;
  readonly asset: string;
  readonly amount: bigint;
}

export function inputKey(
  network: string,
  u: Pick<Utxo, 'unit' | 'messageIndex' | 'outputIndex'>,
): string {
  return `${network}:${u.unit}:${u.messageIndex}:${u.outputIndex}`;
}

export interface HistoryJoint {
  unit: {
    unit: string;
    main_chain_index?: number | null;
    authors?: { address: string }[];
    messages?: {
      app: string;
      payload?: {
        asset?: string;
        inputs?: { unit?: string; message_index?: number; output_index?: number }[];
        outputs?: { address: string; amount: number }[];
      };
    }[];
  };
  ball?: string;
}

/**
 * Unspent outputs of `address` from a `light/get_history` response.
 * Others' outputs count only if stable and at or before `lastBallMci`.
 */
export function unspentOutputs(
  joints: readonly HistoryJoint[],
  address: string,
  lastBallMci: number,
): Utxo[] {
  const spent = new Set<string>();
  for (const j of joints) {
    for (const m of j.unit.messages ?? []) {
      if (m.app !== 'payment') continue;
      for (const i of m.payload?.inputs ?? []) {
        if (i.unit !== undefined) spent.add(`${i.unit}:${i.message_index}:${i.output_index}`);
      }
    }
  }
  const utxos: Utxo[] = [];
  for (const j of joints) {
    const own = j.unit.authors?.some((a) => a.address === address) === true;
    const stable = j.ball !== undefined;
    const mci = j.unit.main_chain_index;
    if (!own && !(stable && typeof mci === 'number' && mci <= lastBallMci)) continue;
    (j.unit.messages ?? []).forEach((m, messageIndex) => {
      if (m.app !== 'payment') return;
      (m.payload?.outputs ?? []).forEach((o, outputIndex) => {
        if (o.address !== address || spent.has(`${j.unit.unit}:${messageIndex}:${outputIndex}`))
          return;
        utxos.push({
          unit: j.unit.unit,
          messageIndex,
          outputIndex,
          asset: m.payload?.asset ?? 'base',
          amount: BigInt(o.amount),
        });
      });
    });
  }
  return utxos;
}

/** Largest-first selection until the target is covered. */
export function selectCoins(
  utxos: readonly Utxo[],
  asset: string,
  target: bigint,
): Utxo[] | undefined {
  const candidates = utxos
    .filter((u) => u.asset === asset)
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const picked: Utxo[] = [];
  let total = 0n;
  for (const u of candidates) {
    if (total >= target) break;
    picked.push(u);
    total += u.amount;
  }
  return total >= target ? picked : undefined;
}
