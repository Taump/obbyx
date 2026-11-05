import obyte from 'obyte';

export type PostBehaviour = 'accept' | 'reject' | 'drop' | 'hang';

/**
 * In-memory stand-in for an Obyte hub, shaped like obyte.js `client.api`.
 * Lets tests script every outcome the settlement state machine must handle.
 */
export class FakeHub {
  readonly joints = new Map<string, Record<string, unknown>>();
  readonly definitions = new Map<string, unknown>();
  /** AA state vars by AA address. */
  readonly aaVars = new Map<string, Record<string, unknown>>();
  /** Units proven stable: unit -> is_nonserial. */
  readonly stable = new Map<string, boolean>();
  /** Extra units returned in a payer's history (e.g. a conflicting spend). */
  readonly history: Record<string, unknown>[] = [];
  post: PostBehaviour = 'accept';
  rejectError = 'some inputs are already spent';
  down = false;
  readonly calls: Record<string, number> = {};

  readonly client = {
    api: {
      getJoint: async (unit: string) => {
        this.count('getJoint');
        await this.gate();
        const joint = this.joints.get(unit);
        return joint === undefined
          ? { joint_not_found: unit }
          : { joint: { unit: structuredClone(joint) } };
      },
      getDefinition: async (address: string) => {
        this.count('getDefinition');
        await this.gate();
        return this.definitions.get(address) ?? null;
      },
      getAaStateVars: async ({ address }: { address: string }) => {
        this.count('getAaStateVars');
        await this.gate();
        return structuredClone(this.aaVars.get(address) ?? {});
      },
      getWitnesses: async () => {
        await this.gate();
        return ['W'.repeat(32)];
      },
      getHistory: async (params: { addresses: string[]; requested_joints?: string[] }) => {
        this.count('getHistory');
        await this.gate();
        if (params.requested_joints !== undefined) {
          return {
            joints: [],
            proofchain_balls: params.requested_joints
              .filter((u) => this.stable.has(u))
              .map((u) => ({
                unit: u,
                ball: 'b',
                ...(this.stable.get(u) ? { is_nonserial: true } : {}),
              })),
          };
        }
        return { joints: this.history.map((unit) => ({ unit })) };
      },
      postJoint: async ({ unit }: { unit: Record<string, unknown> }) => {
        this.count('postJoint');
        await this.gate();
        switch (this.post) {
          case 'accept':
            this.joints.set(String(unit['unit']), unit);
            return 'accepted';
          case 'reject':
            return Promise.reject(this.rejectError);
          case 'drop':
            // Accepted by the network, but the response is lost.
            this.joints.set(String(unit['unit']), unit);
            throw new Error('connection closed before response');
          case 'hang':
            return new Promise(() => undefined);
        }
      },
    },
    close: () => undefined,
  };

  /**
   * A real obyte.js client (it can compose and sign) whose hub requests are
   * answered by this FakeHub; it never connects.
   */
  obyteClient(): obyte.Client {
    const c = new obyte.Client('ws://127.0.0.1:9', { testnet: true });
    c.close();
    Object.assign((c as unknown as { api: object }).api, this.client.api);
    return c;
  }

  asClient(): obyte.Client {
    return this.client as unknown as obyte.Client;
  }

  private count(name: string): void {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
  }

  private gate(): Promise<void> {
    return this.down ? new Promise(() => undefined) : Promise.resolve();
  }
}
