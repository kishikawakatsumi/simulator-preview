import { clientIdentity, workspaceIdentity } from "./client-identity.js";
export interface Status {
  type: "status";
  device: string;
  udid?: string;
  ready: boolean;
  connected: boolean;
  preview?: boolean;
  busy: boolean;
  switching: boolean;
  revision: number;
  width: number;
  height: number;
  supportsHinge: boolean;
  error: string;
}
export interface FrameMarker {
  revision: number;
  timestamp: number;
  width: number;
  height: number;
}
type Message = Record<string, any>;

/** Owns one signaling socket and one peer connection; reconnect replaces both. */
export class Connection {
  enabled = false;
  peer?: RTCPeerConnection;
  private client = clientIdentity();
  private workspace = workspaceIdentity(new URL(location.href));
  private socket?: WebSocket;
  private channel?: RTCDataChannel;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private attempt = 0;
  private generation = 0;
  private heartbeat = setInterval(() => this.send({ type: "heartbeat" }), 2000);
  onmessage: (message: Message) => void = () => {};
  onstate: (state: string) => void = () => {};
  onvideo: (stream: MediaStream) => void = () => {};

  get ready() {
    return this.channel?.readyState === "open";
  }

  connect() {
    if (!this.enabled) return;
    this.stopped = false;
    this.dispose();
    const generation = this.generation;
    this.onstate("connecting");
    const url = new URL("/session", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("client", this.client);
    url.searchParams.set("workspace", this.workspace);
    if (location.pathname.startsWith("/builds/"))
      url.searchParams.set("build", location.pathname);
    const socket = new WebSocket(url);
    let waiting = false;
    this.socket = socket;
    let sequence = Promise.resolve();
    let pendingCandidates: RTCIceCandidateInit[] = [];
    const signal = (message: object) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(message));
    };
    socket.onmessage = (event) => {
      sequence = sequence
        .then(async () => {
          if (generation !== this.generation) return;
          const message = JSON.parse(event.data) as Message;
          if (message.type === "waiting") {
            waiting = true;
            this.onstate("waiting");
            this.onmessage(message);
          } else if (message.type === "configuration") {
            const peer = new RTCPeerConnection({
              iceServers: message.iceServers,
              iceTransportPolicy: message.relayOnly ? "relay" : "all",
              bundlePolicy: "max-bundle",
            });
            this.peer = peer;
            peer.onicecandidate = (event) => {
              if (event.candidate)
                signal({
                  type: "candidate",
                  candidate: event.candidate.candidate,
                  mid: event.candidate.sdpMid,
                });
            };
            peer.ontrack = (event) => {
              // No local camera, microphone or screen permission is requested.
              this.onvideo(event.streams[0] ?? new MediaStream([event.track]));
            };
            peer.ondatachannel = (event) => {
              if (event.channel.label !== "control") {
                event.channel.close();
                return;
              }
              this.channel = event.channel;
              event.channel.onopen = () => {
                this.attempt = 0;
                this.send({ type: "visibility", visible: !document.hidden });
                this.onstate("connected");
              };
              event.channel.onmessage = (event) => {
                this.onmessage(JSON.parse(event.data));
              };
              event.channel.onclose = () => {
                if (generation === this.generation) socket.close();
              };
            };
            peer.onconnectionstatechange = () => {
              if (["failed", "disconnected"].includes(peer.connectionState))
                socket.close();
            };
          } else if (message.type === "description" && this.peer) {
            await this.peer.setRemoteDescription(message.description);
            for (const candidate of pendingCandidates)
              await this.peer.addIceCandidate(candidate);
            pendingCandidates = [];
            await this.peer.setLocalDescription(await this.peer.createAnswer());
            signal({ type: "answer", sdp: this.peer.localDescription!.sdp });
          } else if (message.type === "candidate" && this.peer) {
            if (this.peer.remoteDescription)
              await this.peer.addIceCandidate(message.candidate);
            else pendingCandidates.push(message.candidate);
          } else this.onmessage(message);
        })
        .catch(() => {
          this.onmessage({
            type: "error",
            message: "Could not establish the video connection.",
          });
          socket.close();
        });
    };
    socket.onclose = () => {
      if (generation !== this.generation || this.stopped) return;
      this.dispose();
      this.onstate(waiting ? "waiting" : "disconnected");
      this.retry = setTimeout(
        () => this.connect(),
        Math.min(20_000, 1000 * 2 ** this.attempt++),
      );
    };
    socket.onerror = () => socket.close();
  }

  send(message: object): boolean {
    if (!this.ready) return false;
    if (this.channel!.bufferedAmount > 32 * 1024) {
      // Closing the session makes the host release a potentially held touch.
      this.socket?.close();
      return false;
    }
    this.channel!.send(JSON.stringify(message));
    return true;
  }

  private dispose() {
    this.generation++;
    clearTimeout(this.retry);
    this.socket?.close();
    this.peer?.close();
    this.socket = undefined;
    this.peer = undefined;
    this.channel = undefined;
  }
  stop() {
    this.stopped = true;
    this.send({ type: "release" });
    this.dispose();
    clearInterval(this.heartbeat);
  }
}
