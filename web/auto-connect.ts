import type { Status } from "./connection.js";

interface State {
  ready: boolean;
  visible: boolean;
  status?: Status;
  control?: { yours: boolean; owner: string | null };
  devicesLoaded: boolean;
  target?: string;
}

/** Restore ownership when free; device selection remains a single startup attempt. */
export class AutoConnect {
  private pending = true;
  private requestedControl = false;

  cancel() {
    this.pending = false;
  }

  next(
    state: State,
  ): { type: "claim" } | { type: "select-device"; udid: string } | undefined {
    if (!state.visible || !state.ready || !state.status || !state.control)
      return;
    if (state.control.owner && !state.control.yours) {
      this.requestedControl = false;
      return;
    }
    if (!state.control.yours) {
      if (this.requestedControl) return;
      this.requestedControl = true;
      return { type: "claim" };
    }
    this.requestedControl = false;
    if (
      !this.pending ||
      state.status.busy ||
      state.status.switching ||
      !state.devicesLoaded
    )
      return;
    if (!state.target && !state.status.connected) return;
    this.cancel();
    if (
      state.target &&
      (state.target !== state.status.udid || !state.status.connected)
    )
      return { type: "select-device", udid: state.target };
  }
}
