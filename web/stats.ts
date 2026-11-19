export interface Metrics {
  fps: number;
  mbps: number;
  rtt: number | null;
  route: string;
  loss: number;
  delay: number;
}
export class ReceiverStats {
  private previous?: {
    time: number;
    bytes: number;
    frames: number;
    lost: number;
    received: number;
    delay: number;
    emitted: number;
  };
  private peer?: RTCPeerConnection;
  private generation = 0;
  reset() {
    this.generation++;
    this.previous = undefined;
  }

  async read(peer: RTCPeerConnection): Promise<Metrics | null> {
    if (this.peer !== peer) {
      this.peer = peer;
      this.previous = undefined;
    }
    const generation = this.generation;
    const reports = await peer.getStats();
    if (generation !== this.generation || this.peer !== peer) return null;
    let inbound: any, pair: any;
    reports.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video")
        inbound = report;
      if (report.type === "transport" && report.selectedCandidatePairId)
        pair = reports.get(report.selectedCandidatePairId);
    });
    if (!inbound) return null;
    const current = {
      time: inbound.timestamp,
      bytes: inbound.bytesReceived ?? 0,
      frames: inbound.framesDecoded ?? 0,
      lost: inbound.packetsLost ?? 0,
      received: inbound.packetsReceived ?? 0,
      delay: inbound.jitterBufferDelay ?? 0,
      emitted: inbound.jitterBufferEmittedCount ?? 0,
    };
    const previous = this.previous;
    this.previous = current;
    if (!previous) return null;
    const elapsed = (current.time - previous.time) / 1000;
    if (elapsed <= 0) return null;
    const local = pair ? reports.get(pair.localCandidateId) : undefined;
    const remote = pair ? reports.get(pair.remoteCandidateId) : undefined;
    const lost = Math.max(0, current.lost - previous.lost);
    return {
      fps: (current.frames - previous.frames) / elapsed,
      mbps: ((current.bytes - previous.bytes) * 8) / elapsed / 1_000_000,
      rtt:
        pair?.currentRoundTripTime !== undefined
          ? pair.currentRoundTripTime * 1000
          : null,
      route:
        local?.candidateType === "relay" || remote?.candidateType === "relay"
          ? "Relay"
          : pair
            ? "Direct"
            : "Connecting",
      loss: lost / Math.max(1, current.received - previous.received + lost),
      delay:
        Math.max(0, current.delay - previous.delay) /
        Math.max(1, current.emitted - previous.emitted),
    };
  }
}
