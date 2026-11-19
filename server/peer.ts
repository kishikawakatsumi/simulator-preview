import rtc, { type DataChannel } from "node-datachannel";
import type { BrowserIceServer } from "./turn.js";
import { nativeIceServers } from "./turn.js";
import { parseInput, type Input, type VideoFrame } from "./protocol.js";
import type { Config } from "./config.js";

export class ViewerPeer {
  private connection: InstanceType<typeof rtc.PeerConnection>;
  private track: InstanceType<typeof rtc.Track>;
  private channel: DataChannel;
  private packetization: InstanceType<typeof rtc.RtpPacketizationConfig>;
  private waitingForKeyframe = true;
  private viewing = false;
  private closed = false;
  private windowStarted = Date.now();
  private messages = 0;
  private revision = -1;
  private requestAt = 0;
  private answered = false;
  private candidates: { candidate: string; mid: string }[] = [];

  constructor(
    id: string,
    config: Config,
    servers: BrowserIceServer[],
    private signal: (message: object) => void,
    private input: (message: Input) => void,
    private keyframe: () => void,
    private ended: () => void,
  ) {
    this.connection = new rtc.PeerConnection(id, {
      iceServers: nativeIceServers(servers),
      disableAutoNegotiation: true,
      iceTransportPolicy: config.relayOnly ? "relay" : "all",
      maxMessageSize: 64 * 1024,
    });
    const video = new rtc.Video("video", "SendOnly");
    video.addH264Codec(
      96,
      "profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1",
    );
    video.addSSRC(1, "studio", "studio", "screen");
    const track = this.connection.addTrack(video);
    this.track = track;
    this.packetization = new rtc.RtpPacketizationConfig(
      1,
      "studio",
      96,
      90_000,
    );
    const packetizer = new rtc.H264RtpPacketizer(
      "StartSequence",
      this.packetization,
      1200,
    );
    const reports = new rtc.RtcpSrReporter(this.packetization);
    reports.addToChain(new rtc.RtcpNackResponder(512));
    packetizer.addToChain(reports);
    track.setMediaHandler(packetizer);
    track.onOpen(() => this.requestKeyframe());
    track.onError((error) => {
      console.error("Video track failed:", error);
      this.ended();
    });
    track.onMessage((packet) => {
      // Compound RTCP: PLI/FIR requests are not media and must reach the encoder.
      for (let offset = 0; offset + 4 <= packet.length;) {
        const size = (packet.readUInt16BE(offset + 2) + 1) * 4;
        if (size < 4 || offset + size > packet.length) break;
        if (packet[offset + 1] === 206 && [1, 4].includes(packet[offset]! & 31))
          this.requestKeyframe();
        offset += size;
      }
    });
    this.channel = this.connection.createDataChannel("control");
    this.channel.onOpen(() => this.requestKeyframe());
    this.channel.onClosed(() => this.ended());
    this.channel.onError((error) => {
      console.error("Control channel failed:", error);
      this.ended();
    });
    this.channel.onMessage((raw) => {
      if (this.closed) return;
      if (Date.now() - this.windowStarted >= 1000) {
        this.windowStarted = Date.now();
        this.messages = 0;
      }
      if (++this.messages > 180 || typeof raw !== "string") {
        this.ended();
        return;
      }
      const message = parseInput(raw);
      if (!message) return;
      if (message.type === "keyframe") this.requestKeyframe();
      else this.input(message);
    });
    this.connection.onLocalDescription((sdp, type) =>
      this.signal({ type: "description", description: { sdp, type } }),
    );
    this.connection.onLocalCandidate((candidate, mid) =>
      this.signal({ type: "candidate", candidate: { candidate, sdpMid: mid } }),
    );
    this.connection.onStateChange((state) => {
      this.signal({ type: "connection", state });
      if (["closed", "failed", "disconnected"].includes(state)) this.ended();
    });
    this.connection.setLocalDescription("offer");
  }

  accept(message: Record<string, unknown>) {
    if (this.closed) return;
    if (
      message.type === "answer" &&
      typeof message.sdp === "string" &&
      message.sdp.length < 64 * 1024 &&
      !this.answered
    ) {
      this.connection.setRemoteDescription(message.sdp, "answer");
      this.answered = true;
      for (const item of this.candidates)
        this.connection.addRemoteCandidate(item.candidate, item.mid);
      this.candidates = [];
    } else if (
      message.type === "candidate" &&
      typeof message.candidate === "string" &&
      message.candidate.length < 4096 &&
      typeof message.mid === "string" &&
      message.mid.length < 32
    ) {
      if (this.answered)
        this.connection.addRemoteCandidate(message.candidate, message.mid);
      else if (this.candidates.length < 64)
        this.candidates.push({
          candidate: message.candidate,
          mid: message.mid,
        });
    }
  }

  send(frame: VideoFrame) {
    if (
      this.closed ||
      !this.viewing ||
      !this.track.isOpen() ||
      !this.channel.isOpen()
    )
      return;
    if (this.revision !== frame.revision) this.waitingForKeyframe = true;
    // Media tracks in the macOS binding send datagrams synchronously; unlike
    // DataChannel they do not expose bufferedAmount at runtime. Receiver feedback
    // adjusts the encoder instead of building a JavaScript frame queue.
    if (this.waitingForKeyframe && !frame.keyframe) return;
    this.waitingForKeyframe = false;
    this.revision = frame.revision;
    this.packetization.timestamp = frame.timestamp;
    if (frame.keyframe)
      this.message({
        type: "frame",
        revision: frame.revision,
        timestamp: frame.timestamp,
        width: frame.width,
        height: frame.height,
      });
    if (!this.track.sendMessageBinary(frame.data)) {
      this.waitingForKeyframe = true;
      this.requestKeyframe();
    }
  }

  message(message: object) {
    if (!this.closed && this.channel.isOpen()) {
      if (this.channel.bufferedAmount() > 64 * 1024) {
        this.ended();
        return;
      }
      this.channel.sendMessage(JSON.stringify(message));
    }
  }

  setViewing(viewing: boolean) {
    if (this.viewing === viewing) return;
    this.viewing = viewing;
    // A resumed decoder must not receive deltas referencing frames it missed.
    this.waitingForKeyframe = true;
    if (viewing) {
      this.requestAt = 0;
      this.requestKeyframe();
    }
  }

  private requestKeyframe() {
    if (!this.viewing || Date.now() - this.requestAt < 500) return;
    this.requestAt = Date.now();
    this.keyframe();
  }

  isConnected() {
    return !this.closed && this.connection.state() === "connected";
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.connection.close();
    }
  }
}
