import type { Input, HostStatus } from "./protocol.js";

/** One active tab per private simulator; handoff always releases a held touch. */
export class ControlLease {
  owner: string | null = null;
  private heartbeat = 0;
  private touching = false;
  constructor(
    private send: (command: object) => void,
    private changed: () => void,
    private now: () => number = Date.now,
  ) {}

  receive(id: string, input: Input, status: HostStatus): boolean {
    const now = this.now();
    if (input.type === "claim") {
      if (this.owner && this.owner !== id) {
        // Tabs in this session belong to the same authenticated user and workspace.
        // Transfer atomically: do not broadcast an unowned state between owners.
        this.cancel();
        this.send({ type: "release" });
      }
      this.owner = id;
      this.heartbeat = now;
      this.changed();
      return true;
    }
    if (this.owner !== id) return false;
    if (input.type === "heartbeat") {
      this.heartbeat = now;
      return true;
    }
    if (input.type === "release") {
      this.release(id);
      return true;
    }
    if (input.type === "cancel") {
      this.cancel();
      return true;
    }
    if (input.type === "pointer") {
      if (!status.ready || input.revision !== status.revision) {
        this.cancel();
        return false;
      }
      if (input.phase === "down") {
        this.cancel();
        this.touching = true;
      } else if (!this.touching) return false;
      this.send(input);
      if (input.phase === "up") this.touching = false;
      return true;
    }
    if (input.type === "select-device" || input.type === "action") {
      if (
        status.busy ||
        status.switching ||
        (input.type === "action" && !status.ready)
      )
        return false;
      this.cancel();
      this.send(input);
      return true;
    }
    return false;
  }

  tick() {
    if (this.owner && this.now() - this.heartbeat > 7000)
      this.release(this.owner);
  }
  cancel() {
    if (this.touching) this.send({ type: "release" });
    this.touching = false;
  }
  release(id: string) {
    if (this.owner !== id) return;
    this.cancel();
    this.send({ type: "release" });
    this.owner = null;
    this.changed();
  }
}
