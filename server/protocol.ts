export interface HostStatus {
  type: "status";
  connected: boolean;
  preview?: boolean;
  ready: boolean;
  busy: boolean;
  switching: boolean;
  revision: number;
  width: number;
  height: number;
  device: string;
  udid?: string;
  supportsHinge: boolean;
  error: string;
}
export interface VideoFrame {
  revision: number;
  timestamp: number;
  keyframe: boolean;
  width: number;
  height: number;
  data: Buffer;
}

/** Length framing survives arbitrary pipe chunk boundaries; cap allocations before parsing. */
export class HostDecoder {
  private pending: Buffer = Buffer.alloc(0);
  constructor(
    private onStatus: (status: HostStatus) => void,
    private onFrame: (frame: VideoFrame) => void,
  ) {}
  push(chunk: Buffer) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length < 1 || length > 8 * 1024 * 1024)
        throw new Error("Invalid host message size");
      if (this.pending.length < length + 4) return;
      const message = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      if (message[0] === 1) {
        const status = JSON.parse(message.subarray(1).toString()) as HostStatus;
        if (status.type !== "status" || !Number.isSafeInteger(status.revision))
          throw new Error("Invalid host status");
        this.onStatus(status);
      } else if (message[0] === 2 && message.length > 18) {
        this.onFrame({
          revision: message.readUInt32BE(1),
          timestamp: Number(
            ((message.readBigUInt64BE(5) * 90n) / 1000n) % 0x100000000n,
          ),
          keyframe: message[13] === 1,
          width: message.readUInt16BE(14),
          height: message.readUInt16BE(16),
          data: message.subarray(18),
        });
      } else throw new Error("Invalid host message kind");
    }
  }
}

export type Input =
  | { type: "visibility"; visible: boolean }
  | {
      type: "pointer";
      phase: "down" | "move" | "up";
      x: number;
      y: number;
      revision: number;
    }
  | {
      type: "action";
      action: "home" | "left" | "right" | "closed" | "partial" | "open";
    }
  | { type: "select-device"; udid: string }
  | { type: "claim" | "release" | "cancel" | "heartbeat" | "keyframe" }
  | { type: "quality"; loss: number; delay: number };

export function parseInput(text: string): Input | null {
  if (text.length > 4096) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  if (value.type === "visibility" && typeof value.visible === "boolean")
    return { type: "visibility", visible: value.visible };
  if (
    ["claim", "release", "cancel", "heartbeat", "keyframe"].includes(
      String(value.type),
    )
  )
    return value as Input;
  if (
    value.type === "pointer" &&
    ["down", "move", "up"].includes(String(value.phase)) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    value.x >= 0 &&
    value.x <= 1 &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    value.y >= 0 &&
    value.y <= 1 &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) >= 0
  )
    return value as Input;
  if (
    value.type === "action" &&
    ["home", "left", "right", "closed", "partial", "open"].includes(
      String(value.action),
    )
  )
    return value as Input;
  if (
    value.type === "select-device" &&
    typeof value.udid === "string" &&
    /^[\da-f-]{36}$/i.test(value.udid)
  )
    return value as Input;
  if (
    value.type === "quality" &&
    typeof value.loss === "number" &&
    Number.isFinite(value.loss) &&
    value.loss >= 0 &&
    value.loss <= 1 &&
    typeof value.delay === "number" &&
    Number.isFinite(value.delay) &&
    value.delay >= 0 &&
    value.delay <= 10
  )
    return value as Input;
  return null;
}
