import { type Logger, moduleLogger } from '@obbyx/obyte/logger';
import type { ExactObyteFacilitator, SettlementStore } from '@obbyx/x402-obyte';

/**
 * Recovery worker (outbox): periodically re-drives every non-terminal
 * settlement — claimed but not broadcast, broadcast with an unknown outcome,
 * accepted but not yet stable. Runs once at startup, then on an interval;
 * runs never overlap.
 */
export class RecoveryWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly log: Logger;

  constructor(
    private readonly store: SettlementStore,
    private readonly exact: ExactObyteFacilitator,
    logger: Logger,
    private readonly intervalMs: number,
  ) {
    this.log = moduleLogger(logger, 'facilitator.recovery');
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One pass; never rejects (a rejected `void tick()` would crash the process). */
  tick(): Promise<void> {
    if (this.running !== undefined) return this.running;
    this.running = this.run()
      .catch((err: unknown) => this.log.error({ err }, 'recovery pass failed'))
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<void> {
    const active = await this.store.listActive();
    if (active.length === 0) return;
    this.log.debug({ count: active.length }, 'resuming active settlements');
    for (const record of active) {
      try {
        const res = await this.exact.resume(record);
        if (res.errorReason !== 'settlement_pending') {
          this.log.info(
            { proofId: record.unitHash, success: res.success, reason: res.errorReason },
            'settlement resolved',
          );
        }
      } catch (err) {
        this.log.error({ err, proofId: record.unitHash }, 'recovery step failed');
      }
      // Rotate whatever the outcome: a record stuck on an unreachable hub must
      // not keep the oldest slots of every pass and starve the others.
      await this.store.touch(record.key).catch(() => undefined);
    }
  }
}
