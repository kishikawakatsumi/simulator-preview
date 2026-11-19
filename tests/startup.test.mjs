import test from "node:test";
import assert from "node:assert/strict";
import { chooseDevice } from "../dist/web/device-selection.js";
import { AutoConnect } from "../dist/web/auto-connect.js";
import { displayFromProfile } from "../dist/server/devices.js";

const phone = (udid, width, height, scale = 3, extra = {}) => ({
  udid,
  name: udid,
  runtime: "26.3",
  state: "Shutdown",
  family: "iPhone",
  display: { width, height, scale },
  ...extra,
});
const small = phone("small", 1125, 2436);
const exact = phone("exact", 1170, 2532);
const large = phone("large", 1290, 2796);
const screen = { width: 390, height: 844, scale: 3, family: "iPhone" };

test("matches physical resolution independent of orientation and prefers it to the active device", () => {
  const devices = [large, small, exact];
  assert.equal(chooseDevice(devices, screen, large.udid), exact);
  assert.equal(
    chooseDevice(devices, { ...screen, width: 844, height: 390 }),
    exact,
  );
  assert.equal(devices[0], large, "selection must not reorder the picker");
});

test("same resolution keeps the current device, then booted device, then newest runtime", () => {
  const older = { ...exact, udid: "older", runtime: "18.6" };
  const booted = { ...older, udid: "booted", state: "Booted" };
  assert.equal(chooseDevice([older, exact], screen), exact);
  assert.equal(chooseDevice([older, exact], screen, older.udid), older);
  assert.equal(chooseDevice([older, exact, booted], screen), booted);
});

test("matches logical screen size when density differs, otherwise chooses the nearest size", () => {
  assert.equal(chooseDevice([large, exact], { ...screen, scale: 2 }), exact);
  assert.equal(
    chooseDevice([large, small], { ...screen, width: 393, height: 852 }),
    small,
  );
});

test("tablet clients prefer iPads, and missing display metadata stays selectable", () => {
  const tablet = phone("tablet", 1640, 2360, 2, { family: "iPad" });
  assert.equal(
    chooseDevice([exact, tablet], { ...screen, family: "iPad" }),
    tablet,
  );
  const unknown = {
    udid: "unknown",
    name: "Custom",
    runtime: "26.3",
    family: "iPhone",
    state: "Booted",
  };
  assert.equal(chooseDevice([unknown, exact], screen), exact);
  assert.equal(chooseDevice([unknown], screen), unknown);
  assert.equal(chooseDevice([], screen), undefined);
});

test("desktop clients keep the active simulator or prefer an already booted device", () => {
  const desktop = { width: 1920, height: 1080, scale: 2 };
  const booted = { ...small, state: "Booted" };
  assert.equal(chooseDevice([exact, booted], desktop), booted);
  assert.equal(chooseDevice([exact, booted], desktop, exact.udid), exact);
});

const state = () => ({
  ready: true,
  visible: true,
  devicesLoaded: true,
  target: exact.udid,
  status: { connected: false, busy: false, switching: false },
  control: { yours: false, owner: null },
});

test("automatic control waits for a visible connected tab and selects its simulator once", () => {
  const auto = new AutoConnect();
  const s = state();
  for (const extra of [
    { ready: false },
    { visible: false },
    { status: undefined },
    { control: undefined },
  ])
    assert.equal(auto.next({ ...s, ...extra }), undefined);
  assert.deepEqual(auto.next({ ...s, devicesLoaded: false }), {
    type: "claim",
  });
  assert.equal(auto.next(s), undefined, "do not queue duplicate claims");
  s.control = { yours: true, owner: "me" };
  assert.deepEqual(auto.next(s), { type: "select-device", udid: exact.udid });
  assert.equal(auto.next(s), undefined);
  s.control = { yours: false, owner: null };
  assert.deepEqual(
    auto.next(s),
    { type: "claim" },
    "recover a lost lease without selecting again",
  );
  s.control = { yours: true, owner: "me" };
  assert.equal(auto.next(s), undefined);
});

test("passive updates never steal from another tab; a free lease is reclaimed automatically", () => {
  const auto = new AutoConnect();
  const s = state();
  for (let i = 0; i < 10; i++)
    assert.equal(
      auto.next({ ...s, control: { yours: false, owner: "another-tab" } }),
      undefined,
    );
  assert.deepEqual(auto.next(s), { type: "claim" });
  assert.equal(auto.next(s), undefined);
});

test("backgrounding during startup preserves the pending device selection", () => {
  const auto = new AutoConnect();
  const s = state();
  assert.deepEqual(auto.next(s), { type: "claim" });
  s.control = { yours: true, owner: "me" };
  s.devicesLoaded = false;
  assert.equal(auto.next(s), undefined);
  assert.equal(
    auto.next({ ...s, visible: false, control: { yours: false, owner: null } }),
    undefined,
  );
  s.control = { yours: false, owner: null };
  assert.deepEqual(auto.next(s), { type: "claim" });
  s.devicesLoaded = true;
  s.control = { yours: true, owner: "me" };
  assert.deepEqual(auto.next(s), { type: "select-device", udid: exact.udid });
});

test("startup waits for boot and never reconnects an already selected simulator", () => {
  const auto = new AutoConnect();
  const s = state();
  s.control = { yours: true, owner: "me" };
  s.status.switching = true;
  assert.equal(auto.next(s), undefined);
  s.status = {
    connected: true,
    busy: false,
    switching: false,
    udid: exact.udid,
  };
  assert.equal(auto.next(s), undefined);
  s.target = large.udid;
  assert.equal(auto.next(s), undefined);
});

test("manual device selection does not disable automatic control recovery", () => {
  const auto = new AutoConnect();
  auto.cancel();
  const s = state();
  assert.deepEqual(auto.next(s), { type: "claim" });
  s.control = { yours: true, owner: "me" };
  assert.equal(
    auto.next(s),
    undefined,
    "manual choice must not be overwritten",
  );
  s.control = { yours: false, owner: null };
  assert.deepEqual(auto.next(s), { type: "claim" });
});

test("device profiles expose native pixel size and reject incomplete or invalid metadata", () => {
  assert.deepEqual(
    displayFromProfile({
      mainScreenWidth: 1206,
      mainScreenHeight: 2622,
      mainScreenScale: 3,
    }),
    { width: 1206, height: 2622, scale: 3 },
  );
  for (const invalid of [undefined, 0, -1, "3", NaN, Infinity])
    assert.equal(
      displayFromProfile({
        mainScreenWidth: 1206,
        mainScreenHeight: 2622,
        mainScreenScale: invalid,
      }),
      undefined,
    );
});
