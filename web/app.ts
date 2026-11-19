import { preparePreview } from "./preview.js";
import { additionalWorkspaceURL } from "./client-identity.js";
import { Connection, type Status, type FrameMarker } from "./connection.js";
import { bindInput } from "./input.js";
import { ReceiverStats } from "./stats.js";
import { chooseDevice, clientScreen, type Device } from "./device-selection.js";
import { AutoConnect } from "./auto-connect.js";
import { ScreenDisplay, isStandalone, logicalSource } from "./display.js";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const video = element<HTMLVideoElement>("screen");
const picker = element<HTMLSelectElement>("device");
const connection = new Connection();

// Older hosts may still send raw process output until the server is restarted.
function userError(message: string) {
  const reference = message.match(/Reference: ([a-f0-9]{8})\.$/)?.[1];
  return (
    "The simulator could not complete this operation. Use the simulator controls to try again or choose another device. If it keeps failing, contact the host administrator." +
    (reference ? ` Reference: ${reference}.` : "")
  );
}
document.body.classList.toggle("mobile", clientScreen().family === "iPhone");
document.body.classList.toggle("standalone", isStandalone());
let status: Status | undefined;
let devices: Device[] | undefined;
let control: { yours: boolean; owner: string | null } | undefined;
let automatic = new AutoConnect();
let preferredDevice: string | undefined;
let refreshing: Promise<void> | undefined;
let deviceListError = "";
let deviceRetryTimer: ReturnType<typeof setTimeout> | undefined;
let deviceRetryDelay = 1000;

function autoConnect() {
  const target =
    devices?.find((device) => device.udid === status?.udid) ??
    devices?.find((device) => device.udid === preferredDevice) ??
    chooseDevice(devices ?? [], clientScreen(), status?.udid);
  const command = automatic.next({
    ready: connection.ready,
    visible: !document.hidden,
    status,
    control,
    devicesLoaded: devices !== undefined,
    target: target?.udid,
  });
  if (command) {
    if (command.type === "select-device") picker.value = command.udid;
    connection.send(command);
  }
}
let mine = false,
  owner: string | null = null;
let displayedRevision = -1;
let markers: FrameMarker[] = [];
let lastFrameAt = 0;
let frameWidth = 0;
let frameHeight = 0;
let frameTimestampSupported = true;
let playbackBlocked = false;
let playbackWaiting = false;
let playbackTimer: ReturnType<typeof setTimeout> | undefined;

function resetPlaybackWait() {
  clearTimeout(playbackTimer);
  playbackTimer = undefined;
  playbackWaiting = false;
}

async function playVideo() {
  const stream = video.srcObject;
  if (!stream || document.hidden) return;
  // Set properties explicitly as well as the HTML attributes for iOS inline playback.
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
    if (video.srcObject !== stream) return;
    if (document.hidden) {
      video.pause();
      return;
    }
    playbackBlocked = video.paused;
  } catch (error) {
    if (
      video.srcObject !== stream ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      return;
    playbackBlocked = true;
  }
  render();
}

function renderPlaceholder() {
  const shown = video.classList.contains("visible");
  const waiting =
    !connection.ready ||
    !(status?.connected || status?.preview) ||
    (!!status?.switching && !status.preview) ||
    !shown ||
    playbackBlocked;
  element("placeholder").hidden = !waiting;
  element("show-controls").hidden =
    !waiting || !status?.error || !document.body.classList.contains("focus");
  element("play-video").hidden =
    !connection.ready ||
    !(status?.connected || status?.preview) ||
    (!!status?.switching && !status.preview) ||
    (!playbackBlocked && !playbackWaiting);
  let title: string;
  let detail: string;
  let indicator = "loading";
  if (document.body.dataset.state === "waiting") {
    title = "Waiting for an available simulator";
    detail =
      "All simulator sessions are in use. This page will retry automatically.";
  } else if (!connection.ready) {
    title = "Connecting to your workspace";
    detail = "The host Mac must be running Simulator Preview.";
  } else if (status?.error) {
    indicator = "warning";
    title = "Simulator unavailable";
    detail = userError(status.error);
  } else if (status?.preview && playbackBlocked) {
    indicator = "play";
    title = "Tap to view startup";
    detail = "Use Play video below to see the simulator starting.";
  } else if (status?.switching) {
    title = "Starting simulator…";
    detail =
      "The host Mac is starting the selected simulator. The first boot can take longer.";
  } else if (status?.connected) {
    if (playbackBlocked || playbackWaiting) indicator = "play";
    title = playbackBlocked ? "Tap to start video" : "Waiting for video…";
    detail = playbackBlocked
      ? "Safari may require a tap to start playback. Use Play video below."
      : "The simulator is running. Waiting for the first video frame.";
  } else if (!devices && deviceListError) {
    indicator = "warning";
    title = "Could not load simulators";
    detail = deviceListError;
  } else if (!devices) {
    title = "Loading simulators…";
    detail = "Getting the available devices from the host Mac.";
  } else if (!devices.length) {
    indicator = "warning";
    title = "No simulators available";
    detail = "Add an iOS simulator in Xcode, then refresh the device list.";
  } else if (!mine) {
    if (owner) indicator = "idle";
    title = owner ? "Active in another tab" : "Connecting simulator…";
    detail = owner
      ? "Return to this tab to control your simulator."
      : "Preparing your simulator automatically.";
  } else {
    title = "Connecting simulator…";
    detail = "Selecting a simulator for your screen. You can also use Connect.";
  }
  element("placeholder-title").textContent = title;
  element("placeholder-detail").textContent = detail;
  element("placeholder").dataset.indicator = indicator;
}

const notice = (text: string) => {
  element("notice").textContent = text;
};
const canInput = () =>
  !document.hidden &&
  mine &&
  connection.ready &&
  !!status?.ready &&
  displayedRevision === status.revision;
const cancelTouch = bindInput(
  video,
  canInput,
  () => displayedRevision,
  (message) => connection.send(message),
  (x, y, clamp) => display.point(x, y, clamp),
);
const display = new ScreenDisplay(
  element("stage"),
  element("screen-viewport"),
  video,
  cancelTouch,
);

function render() {
  const device = devices?.find((item) => item.udid === status?.udid);
  const native = device?.display;
  const frameLandscape = video.videoWidth > video.videoHeight;
  const sourceLandscape = (status?.width ?? 0) > (status?.height ?? 0);
  display.setSource(
    status &&
      status.width > 0 &&
      status.height > 0 &&
      frameLandscape === sourceLandscape &&
      video.videoWidth > 16
      ? logicalSource(status, native?.scale, clientScreen())
      : undefined,
  );
  renderPlaceholder();
  // A restored session can deliver video before the independent catalog request finishes.
  // Keep its current device visible without offering an incomplete selection list.
  if (!devices) {
    const value = status?.udid ?? "";
    const label =
      (value && status?.device) ||
      (deviceListError ? "Device list unavailable" : "Loading simulators…");
    if (
      picker.options.length !== 1 ||
      picker.options[0]?.text !== label ||
      picker.value !== value
    )
      picker.replaceChildren(new Option(label, value, true, true));
  }
  picker.disabled = !devices?.length;
  document.body.dataset.control = mine
    ? "owner"
    : owner
      ? "viewer"
      : "available";
  element("owner").textContent = mine
    ? "Ready to use."
    : owner
      ? "Active in another tab."
      : "Preparing your session…";
  element("device-name").textContent = status?.device || "Choose a simulator";
  const selected = devices?.find((item) => item.udid === picker.value);
  element("device-runtime").textContent = selected
    ? `iOS ${selected.runtime}`
    : devices === undefined
      ? deviceListError
        ? "List unavailable"
        : "Loading list…"
      : "";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-action], [data-palette-action]",
  ))
    button.disabled = !canInput();
  element<HTMLButtonElement>("select-device").disabled =
    !mine ||
    !connection.ready ||
    !!status?.busy ||
    !!status?.switching ||
    !devices?.length ||
    !picker.value;
  element("hinge").hidden = !status?.supportsHinge;
  video.classList.toggle("interactive", canInput());
  if (status?.error) notice(userError(status.error));
}

function watchFrame(_now: number, metadata: VideoFrameCallbackMetadata) {
  // Chromium may produce a 2×2 placeholder before the first RTP video frame.
  if (document.hidden || video.videoWidth < 16 || video.videoHeight < 16) {
    video.requestVideoFrameCallback(watchFrame);
    return;
  }
  lastFrameAt = performance.now();
  const previousRevision = displayedRevision;
  let changed = false;
  const timestamp = (
    metadata as VideoFrameCallbackMetadata & { rtpTimestamp?: number }
  ).rtpTimestamp;
  if (timestamp !== undefined) {
    frameTimestampSupported = true;
    const marker = markers.findLast(
      (item) => (timestamp - item.timestamp) >>> 0 < 900_000,
    );
    if (
      marker &&
      marker.width === video.videoWidth &&
      marker.height === video.videoHeight
    )
      displayedRevision = marker.revision;
  } else if (frameTimestampSupported) {
    frameTimestampSupported = false;
    changed = true;
    notice(
      "This browser can display the stream but does not provide frame timing for safe input. Use a browser with WebRTC frame timestamps.",
    );
  }
  if (
    (status?.connected && !status.switching) ||
    (status?.preview && displayedRevision === status.revision)
  ) {
    if (!video.classList.contains("visible")) {
      video.classList.add("visible");
      changed = true;
    }
    if (!video.paused && playbackBlocked) {
      playbackBlocked = false;
      changed = true;
    }
    if (playbackWaiting) changed = true;
    if (playbackTimer !== undefined || playbackWaiting) resetPlaybackWait();
  }
  if (frameWidth !== video.videoWidth || frameHeight !== video.videoHeight) {
    frameWidth = video.videoWidth;
    frameHeight = video.videoHeight;
    element("resolution").textContent = `${frameWidth} × ${frameHeight}`;
    changed = true;
  }
  // Frame timing remains per-frame; controls and layout only follow state changes.
  if (changed || previousRevision !== displayedRevision) render();
  video.requestVideoFrameCallback(watchFrame);
}
if ("requestVideoFrameCallback" in video)
  video.requestVideoFrameCallback(watchFrame);
else
  notice(
    "This browser does not support video frame callbacks. Please use a current browser.",
  );

connection.onvideo = (stream) => {
  markers = [];
  displayedRevision = -1;
  playbackBlocked = false;
  video.srcObject = stream;
  void playVideo();
};
connection.onstate = (state) => {
  document.body.dataset.state = state;
  element("connection").textContent =
    state === "connected"
      ? "Connected"
      : state === "waiting"
        ? "Waiting…"
        : state === "connecting"
          ? "Connecting…"
          : "Reconnecting…";
  element("dot").classList.toggle("live", state === "connected");
  element("reconnect").hidden = state === "connected";
  if (state !== "connected") {
    cancelTouch();
    mine = false;
    owner = null;
    displayedRevision = -1;
    markers = [];
    status = undefined;
    control = undefined;
    devices = undefined;
    automatic = new AutoConnect();
    video.classList.remove("visible");
    video.srcObject = null;
    playbackBlocked = false;
    resetPlaybackWait();
  } else {
    notice("");
    if (document.hasFocus()) activateControl();
    autoConnect();
    void refreshDevices();
  }
  render();
};
connection.onmessage = (message) => {
  if (message.type === "status") {
    if (message.revision !== status?.revision || !message.ready) {
      cancelTouch();
      displayedRevision = -1;
    }
    if (status?.error && !message.error) notice("");
    const previouslyConnected = status?.connected || status?.preview;
    const previousRevision = status?.revision;
    const previousDevice = status?.udid;
    status = message as Status;
    if (
      status.udid &&
      (status.udid !== previousDevice || !picker.value) &&
      [...picker.options].some((option) => option.value === status!.udid)
    )
      picker.value = status.udid;
    if (
      (status.switching && !status.preview) ||
      (status.preview && status.revision !== previousRevision)
    ) {
      video.classList.remove("visible");
      resetPlaybackWait();
    }
    if ((status.connected || status.preview) && !previouslyConnected) {
      resetPlaybackWait();
      playbackTimer = setTimeout(() => {
        playbackWaiting = !video.classList.contains("visible");
        render();
      }, 10_000);
      void playVideo();
    }
    autoConnect();
    render();
  } else if (message.type === "control") {
    if (!message.yours) cancelTouch();
    mine = message.yours;
    owner = message.owner;
    control = { yours: mine, owner };
    autoConnect();
    render();
  } else if (message.type === "frame") {
    markers.push(message as unknown as FrameMarker);
    markers = markers.slice(-12);
  } else if (message.type === "error") notice(userError(message.message));
  else if (message.type === "waiting") notice(message.message);
};

// A foreground tab takes over its own private workspace without a manual button.
// Passive status updates only claim when unowned, avoiding a tug-of-war between windows.
function activateControl() {
  if (!document.hidden && connection.ready && !mine) {
    cancelTouch();
    connection.send({ type: "claim" });
  }
}
window.addEventListener("focus", activateControl);
element("reconnect").onclick = () => connection.connect();
const additional = element<HTMLAnchorElement>("additional-workspace");
additional.href = additionalWorkspaceURL(new URL(location.href));
additional.addEventListener("click", () => {
  additional.href = additionalWorkspaceURL(new URL(location.href));
});
element("play-video").onclick = () => {
  void playVideo();
  connection.send({ type: "keyframe" });
};
video.addEventListener("pause", () => {
  if (
    !document.hidden &&
    video.srcObject &&
    connection.ready &&
    (status?.connected || status?.preview)
  ) {
    playbackBlocked = true;
    render();
  }
});
video.addEventListener("playing", () => {
  playbackBlocked = video.paused;
  render();
});
picker.onchange = () => {
  automatic.cancel();
  render();
};
element("select-device").onclick = () => {
  automatic.cancel();
  preferredDevice = picker.value;
  cancelTouch();
  notice("");
  connection.send({ type: "select-device", udid: picker.value });
};
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-action], [data-palette-action]",
)) {
  button.onclick = () => {
    cancelTouch();
    connection.send({
      type: "action",
      action: button.dataset.action ?? button.dataset.paletteAction,
    });
    closePalette();
  };
}

function refreshDevices(): Promise<void> {
  if (refreshing) return refreshing;
  clearTimeout(deviceRetryTimer);
  deviceRetryTimer = undefined;
  const button = element<HTMLButtonElement>("refresh");
  button.disabled = true;
  picker.setAttribute("aria-busy", "true");
  refreshing = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65_000);
    let retry = true;
    try {
      const response = await fetch(
        location.pathname.startsWith("/builds/")
          ? "/api/devices?build=" + encodeURIComponent(location.pathname)
          : "/api/devices",
        {
          signal: controller.signal,
        },
      );
      if (response.status === 401 || response.status === 403) retry = false;
      if (!response.ok) throw new Error("Device list request failed");
      const result = (await response.json()) as { devices: Device[] };
      if (!Array.isArray(result.devices))
        throw new Error("Invalid device list");
      devices = result.devices;
      deviceListError = "";
      deviceRetryDelay = 1000;
      const previous = picker.value;
      picker.replaceChildren(
        new Option(
          devices.length ? "Select a device" : "No simulators available",
          "",
        ),
      );
      const groups = new Map<string, HTMLOptGroupElement>();
      for (const device of devices) {
        let group = groups.get(device.runtime);
        if (!group) {
          group = document.createElement("optgroup");
          group.label = `iOS ${device.runtime}`;
          groups.set(device.runtime, group);
        }
        group.append(new Option(device.name, device.udid));
      }
      for (const runtime of [...groups.keys()].sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true }),
      ))
        picker.append(groups.get(runtime)!);
      picker.value =
        devices.find((device) => device.udid === previous)?.udid ??
        devices.find((device) => device.udid === status?.udid)?.udid ??
        chooseDevice(devices, clientScreen())?.udid ??
        "";
      notice("");
      autoConnect();
      render();
    } catch {
      deviceListError = retry
        ? "The device list is temporarily unavailable. Retrying automatically. The host may still be starting a simulator."
        : "Your session needs authentication. Reload this page to sign in again.";
      notice(deviceListError);
      render();
      if (retry && !document.hidden) {
        deviceRetryTimer = setTimeout(
          () => void refreshDevices(),
          deviceRetryDelay,
        );
        deviceRetryDelay = Math.min(deviceRetryDelay * 2, 10_000);
      }
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
      picker.setAttribute("aria-busy", "false");
      refreshing = undefined;
    }
  })();
  return refreshing;
}
element("refresh").onclick = () => {
  void refreshDevices();
};

function closePalette() {
  element("focus-palette").hidden = true;
  element("focus-menu").setAttribute("aria-expanded", "false");
}
function updateFocusControls() {
  const focused = document.body.classList.contains("focus");
  const palette = isStandalone() && document.body.classList.contains("mobile");
  element("focus-menu").hidden = !focused || !palette;
  element("exit-focus").hidden = !focused || palette;
  if (!focused) closePalette();
}
element("focus-menu").onclick = () => {
  cancelTouch();
  const open = element("focus-palette").hidden;
  element("focus-palette").hidden = !open;
  element("focus-menu").setAttribute("aria-expanded", String(open));
};
element("palette-dismiss").onclick = () => closePalette();
element("copy-display-info").onclick = async () => {
  // Capture before opening a native dialog, which can change the viewport itself.
  const report = JSON.stringify({
    ...display.diagnostics(),
    catalog: devices === undefined ? "loading" : "loaded",
    catalogDeviceFound: !!devices?.some(
      (device) => device.udid === status?.udid,
    ),
    simulator: status ? { width: status.width, height: status.height } : null,
  });
  try {
    await navigator.clipboard.writeText(report);
    alert("Display info copied. Paste it into your support conversation.");
  } catch {
    prompt("Copy this display info into your support conversation:", report);
  }
};
element("palette-exit").onclick = () => {
  void exitFocus();
};

async function exitFocus() {
  closePalette();
  cancelTouch();
  if (document.fullscreenElement) await document.exitFullscreen();
  document.body.classList.remove("focus");
  updateFocusControls();
  display.refresh();
  render();
}
element("show-controls").onclick = () => {
  void exitFocus();
};
element("fullscreen").onclick = async () => {
  cancelTouch();
  document.body.classList.add("focus");
  updateFocusControls();
  display.refresh();
  render();
  try {
    await element("stage").requestFullscreen();
  } catch {
    /* iPhone uses the full viewport fallback. */
  }
};
element("exit-focus").onclick = () => {
  void exitFocus();
};
document.addEventListener("fullscreenchange", () => {
  cancelTouch();
  if (!document.fullscreenElement) {
    document.body.classList.remove("focus");
    updateFocusControls();
  }
  display.refresh();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!element("focus-palette").hidden) {
      closePalette();
      element("focus-menu").focus({ preventScroll: true });
    } else void exitFocus();
  }
});
document.addEventListener("visibilitychange", () => {
  connection.send({ type: "visibility", visible: !document.hidden });
  stats.reset();
  if (document.hidden) {
    clearTimeout(deviceRetryTimer);
    deviceRetryTimer = undefined;
    closePalette();
    cancelTouch();
    // Release even if the preceding claim has not been acknowledged yet.
    connection.send({ type: "release" });
    video.pause();
    resetPlaybackWait();
  } else {
    display.refresh();
    lastFrameAt = performance.now();
    activateControl();
    autoConnect();
    void playVideo();
    void refreshDevices();
  }
});
window.addEventListener("pagehide", () => connection.stop());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

if (isStandalone() && document.body.classList.contains("mobile")) {
  document.body.classList.add("focus");
  updateFocusControls();
  display.refresh();
}

const stats = new ReceiverStats();
let polling = false;
setInterval(async () => {
  if (!connection.peer || polling || document.hidden) return;
  const peer = connection.peer;
  polling = true;
  try {
    const metrics = await stats.read(peer);
    if (document.hidden || connection.peer !== peer) {
      stats.reset();
      return;
    }
    if (metrics) {
      element("fps").textContent = metrics.fps.toFixed(0);
      element("bandwidth").textContent = metrics.mbps.toFixed(2);
      element("latency").textContent = metrics.rtt?.toFixed(0) ?? "—";
      element("route").textContent = metrics.route;
      connection.send({
        type: "quality",
        loss: metrics.loss,
        delay: metrics.delay,
      });
    }
    if (
      connection.ready &&
      (status?.connected || status?.preview) &&
      performance.now() - lastFrameAt > 4000
    )
      connection.send({ type: "keyframe" });
    if (connection.ready && status?.connected && !frameTimestampSupported)
      render();
  } catch {
    /* A peer can close while getStats is in flight. */
  } finally {
    polling = false;
  }
}, 2000);

try {
  const response = await fetch("/api/session");
  if (!response.ok)
    throw new Error(
      "Sign in through your organization’s Simulator Preview address.",
    );
  const session = await response.json();
  if (session.previewEnabled) await preparePreview(session.demo);
  connection.enabled = true;
  preferredDevice = session.defaultDevice;
  connection.connect();
  void refreshDevices();
} catch (error) {
  notice(error instanceof Error ? error.message : "Workspace unavailable");
}
