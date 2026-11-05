import type { ObyteHub } from "../../src/signer";

export type PostBehaviour = "accept" | "reject" | "drop" | "hang" | "transient";

/**
 * In-memory stand-in for an Obyte hub (the subset of obyte.js `client.api`
 * the facilitator uses). Tests script every outcome the state machine handles.
 */
export class FakeHub implements ObyteHub {
  readonly joints = new Map<string, Record<string, unknown>>();
  readonly definitions = new Map<string, unknown>();
  /** Units proven stable: unit -> is_nonserial. */
  readonly stable = new Map<string, boolean>();
  /** Extra units in a payer's history (e.g. a conflicting spend). */
  readonly history: Record<string, unknown>[] = [];
  post: PostBehaviour = "accept";
  rejectError = "some inputs are already spent";
  down = false;
  readonly calls: Record<string, number> = {};

  async getJoint(unit: string) {
    await this.gate("getJoint");
    const joint = this.joints.get(unit);
    return joint === undefined
      ? { joint_not_found: unit }
      : { joint: { unit: structuredClone(joint) } };
  }

  async getDefinition(address: string) {
    await this.gate("getDefinition");
    return this.definitions.get(address) ?? null;
  }

  async getWitnesses() {
    await this.gate("getWitnesses");
    return ["W".repeat(32)];
  }

  async getHistory(params: { addresses: string[]; requested_joints?: string[] }) {
    await this.gate("getHistory");
    if (params.requested_joints !== undefined) {
      return {
        joints: [],
        proofchain_balls: params.requested_joints
          .filter(u => this.stable.has(u))
          .map(u => ({
            unit: u,
            ball: "b",
            ...(this.stable.get(u) ? { is_nonserial: true } : {}),
          })),
      };
    }
    return { joints: this.history.map(unit => ({ unit })) };
  }

  async postJoint({ unit }: { unit: Record<string, unknown> }) {
    await this.gate("postJoint");
    switch (this.post) {
      case "accept":
        this.joints.set(String(unit["unit"]), unit);
        return "accepted";
      case "reject":
        return Promise.reject(this.rejectError);
      case "transient":
        return Promise.reject("known unverified");
      case "drop":
        // Accepted by the network, but the answer is lost.
        this.joints.set(String(unit["unit"]), unit);
        throw new Error("connection closed before response");
      case "hang":
        return new Promise<never>(() => undefined);
    }
  }

  private gate(name: string): Promise<void> {
    this.calls[name] = (this.calls[name] ?? 0) + 1;
    return this.down ? new Promise(() => undefined) : Promise.resolve();
  }
}
