// ============================================================
// Solar position shading control for Shelly Gen2+
// Runs entirely on the device. No server, no broker, no cloud.
// Requires: "Cover" profile, calibrated, slat control enabled.
//
// The heat demand arrives from outside as a plain yes/no:
//   http://<shelly-ip>/script/1/demand?v=1   -> too warm, start shading
//   http://<shelly-ip>/script/1/demand?v=0   -> back to normal
//   http://<shelly-ip>/script/1/demand       -> read status only
//   http://<shelly-ip>/script/1/wake         -> release the day (alarm clock)
//   http://<shelly-ip>/script/1/window?v=1   -> window open, keep a gap
//   http://<shelly-ip>/script/1/window?v=0   -> window closed again
//
// Manual operation of the cover pauses the automation for the rest of the
// local day: no day position, no shading, no end action. The night position
// at sunset runs anyway, it is the one movement the pause does not stop.
// Both that flag and the day release are stored as day numbers, so they
// expire at local midnight and survive a reboot without going stale.
//
// Every entry point (tick, status handler, endpoints) runs under try/catch.
// An uncaught error ends the script, and an ended script shades nothing
// until someone notices. One bad value costs one cycle, not the summer.
//
// NOTE on code style: mJS has a very small stack and evaluates
// expressions recursively. Deeply nested terms and long concatenations
// overflow it. Everything here is therefore deliberately flat, using
// intermediate variables instead of elegant one-liners.
// ============================================================

let CFG = {
  coverId: 0,            // only relevant on devices with two covers (Pro Dual Cover PM)

  // --- Location
  // 47 deg 30' N / 9 deg 20' E
  lat: 47.5000,
  lon: 9.3333,

  // --- Window
  azimuth: 180,          // facing direction: 0=N, 90=E, 180=S, 270=W
  tolStart: 85,          // direction tolerance when the sun enters
  tolEnd: 85,            // direction tolerance when the sun leaves
  minElev: 5,            // no shading below this solar elevation

  // --- Slats
  slats: true,           // false = roller shutter without slats
  slatWidth: 70,         // mm
  slatDist: 60,          // mm, distance between two slats
  // Calibration: slat_pos is NOT an angle but a percentage of the tilt
  // travel between the two mechanical end positions. Measure once.
  // Angle in degrees from horizontal, positive = room-side edge up.
  angAtPos0: 80,         // measured angle at slat_pos = 0
  angAtPos100: -10,      // measured angle at slat_pos = 100
  stepDeg: 15,           // tracking granularity
  intervalMin: 20,       // minimum pause between two movements, also between
  // start, end and restart of the tracking
  selfCmdSec: 120,       // the longest a movement of ours can take, from the
  // command to the report that the motor has stopped.
  // Reports of our own source later than this are not
  // ours. Until the script has learned its own source
  // (see the status handler) any report it cannot place
  // inside this window counts as ours as well.

  mode: 1,               // 0 = maximum daylight, 1 = maximum cooling
  coolExtra: 20,         // extra degrees towards closed in mode 1

  // Where the curtain travels while shading. 0 = fully down,
  // 100 = fully up. After that only the slat angle is tracked.
  shadePos: 0,
  endAction: 1,          // 0=nothing, 1=open, 2=close, 3=slats horizontal
  endSkipDeg: 8,         // no end action once the sun is this close to
  // dayNightElev, the sunset action follows anyway.
  // Keep it above minElev, otherwise the evening exit
  // by elevation still opens the blind for minutes.

  // --- Day boundaries. Replaces the schedules in the smart home app so
  // that no second controller writes to the same cover.
  // dayTrigger "sun" = open at sunrise
  // dayTrigger "cmd" = wait for an external command (alarm), see /wake
  dayTrigger: "cmd",
  dayFallbackHour: 9,    // "cmd" only: opens anyway if no command arrives
  wakeAlwaysOpen: false, // true = always fully open on wake, even when
  //        shading would be due immediately
  sunsetAction: true,    // close at sunset
  dayPos: 100, daySlat: 100,      // day position (100 = fully up)
  nightPos: 0, nightSlat: 0,      // night position (0 = closed, slats closed)
  dayNightElev: 0,       // solar elevation at which day and night switch

  // --- Window contact, optional. Both values do nothing without one.
  windowAng: 60,         // while the window is reported open the slats stay at
  // or below this angle, so air still passes. Lower
  // means more air and less shade.
  windowMaxAgeH: 72,     // after this the report counts as lost and the cap
  // is dropped. A contact only reports on a change, so
  // this has to outlast the longest airing.

  // --- Heat demand
  demandMaxAgeH: 24,               // after this the report counts as lost
  fallbackMonths: [4, 5, 6, 7, 8, 9],   // without a valid report the season decides

  tickSec: 300,
  debug: true
};

// ============================================================
// Math. mJS only provides sin, cos, floor, ceil, round, min, max,
// pow, exp, log, random. atan2, atan, asin, tan, sqrt and PI are missing.
// ============================================================
let PI = 3.141592653589793;
let PIH = 1.5707963267948966;
let D2R = 0.017453292519943295;
let R2D = 57.29577951308232;

function abs(x) { return x < 0 ? -x : x; }

function sqrt(v) {
  if (v <= 0) return 0;
  let x = v;
  if (v > 1) x = v / 2;
  for (let i = 0; i < 30; i++) {
    x = x + v / x;
    x = x * 0.5;
  }
  return x;
}

function tan(x) {
  let s = Math.sin(x);
  let c = Math.cos(x);
  return s / c;
}

// Minimax polynomial, Horner scheme step by step.
// Total error against a real atan2: below 0.0001 degrees.
function atan2(y, x) {
  if (x === 0) {
    if (y > 0) return PIH;
    if (y < 0) return -PIH;
    return 0;
  }
  let z = y / x;
  let inv = false;
  if (z > 1) { z = 1 / z; inv = true; }
  if (z < -1) { z = 1 / z; inv = true; }

  let z2 = z * z;
  let s = -0.01172120;
  s = s * z2;
  s = s + 0.05265332;
  s = s * z2;
  s = s - 0.11643287;
  s = s * z2;
  s = s + 0.19354346;
  s = s * z2;
  s = s - 0.33262347;
  s = s * z2;
  s = s + 0.99997726;
  let a = s * z;

  if (inv) {
    if (z > 0) a = PIH - a;
    else a = -PIH - a;
  }
  if (x < 0) {
    if (y >= 0) a = a + PI;
    else a = a - PI;
  }
  return a;
}

function asin(x) {
  if (x >= 1) return PIH;
  if (x <= -1) return -PIH;
  let c = 1 - x * x;
  return atan2(x, sqrt(c));
}

function norm360(a) {
  let k = Math.floor(a / 360);
  return a - 360 * k;
}

function norm180(a) {
  let v = norm360(a);
  if (v > 180) v = v - 360;
  return v;
}

function log(s) { if (CFG.debug) print("[shade] " + s); }

function num(x) { return JSON.stringify(x); }

// Month from unix time (mJS has no Date object)
function monthOf(t) {
  let z = Math.floor(t / 86400);
  z = z + 719468;
  let era = Math.floor(z / 146097);
  let doe = z - era * 146097;
  let a = Math.floor(doe / 1460);
  let b = Math.floor(doe / 36524);
  let c = Math.floor(doe / 146096);
  let yoe = Math.floor((doe - a + b - c) / 365);
  let d1 = Math.floor(yoe / 4);
  let d2 = Math.floor(yoe / 100);
  let doy = doe - (365 * yoe + d1 - d2);
  let mp = Math.floor((5 * doy + 2) / 153);
  if (mp < 10) return mp + 3;
  return mp - 9;
}

// ============================================================
// Solar position (NOAA approximation)
// ============================================================
function sunPos(t, lat, lon) {
  let d = (t - 946728000) / 86400;          // days since J2000.0

  let g = 357.529 + 0.98560028 * d;         // mean anomaly
  g = g * D2R;
  let q = 280.459 + 0.98564736 * d;         // mean longitude

  let s1 = Math.sin(g);
  let s2 = Math.sin(2 * g);
  let L = q + 1.915 * s1 + 0.020 * s2;      // ecliptic longitude
  L = L * D2R;

  let e = 23.439 - 0.00000036 * d;          // obliquity of the ecliptic
  e = e * D2R;

  let sinL = Math.sin(L);
  let cosL = Math.cos(L);
  let sinE = Math.sin(e);
  let cosE = Math.cos(e);

  let ra = atan2(cosE * sinL, cosL);        // right ascension
  let dec = asin(sinE * sinL);              // declination

  let gmst = norm360(280.46061837 + 360.98564736629 * d);
  let ha = gmst + lon - ra * R2D;           // hour angle
  ha = ha * D2R;

  let p = lat * D2R;
  let sinP = Math.sin(p);
  let cosP = Math.cos(p);
  let sinD = Math.sin(dec);
  let cosD = Math.cos(dec);
  let sinH = Math.sin(ha);
  let cosH = Math.cos(ha);

  let sinAlt = sinP * sinD + cosP * cosD * cosH;
  let alt = asin(sinAlt) * R2D;

  let den = cosH * sinP - tan(dec) * cosP;
  let az = atan2(sinH, den) * R2D;
  az = norm360(az + 180);

  return { alt: alt, az: az };
}

// ============================================================
// Geometry: profile angle -> slat cut-off angle
//   sin(beta + profile) = (distance / width) * cos(profile)
// ============================================================
function profileAngle(alt, relAz) {
  let t1 = tan(alt * D2R);
  let c1 = Math.cos(relAz * D2R);
  return atan2(t1, c1) * R2D;
}

function cutOffAngle(prof) {
  let r = CFG.slatDist / CFG.slatWidth;
  let s = r * Math.cos(prof * D2R);
  if (s > 1) s = 1;                  // distance > width: never fully tight
  return asin(s) * R2D - prof;
}

// Angle -> slat_pos (0..100) via the calibration points
function angleToSlatPos(ang) {
  let span = CFG.angAtPos100 - CFG.angAtPos0;
  if (span === 0) return 0;
  let p = (ang - CFG.angAtPos0) / span;
  p = p * 100;
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  return Math.round(p);
}

// True when the angle lies between the two calibration points. Outside them
// angleToSlatPos() clamps, several angles collapse onto the same position and
// the blind cannot follow the sun any further.
function angleReachable(ang) {
  let lo = CFG.angAtPos0;
  let hi = CFG.angAtPos100;
  if (lo > hi) { let x = lo; lo = hi; hi = x; }
  if (ang < lo) return false;
  if (ang > hi) return false;
  return true;
}

// ============================================================
// State
//
// Only what cannot be derived again after a restart goes to flash:
// manual override, last heat demand, day release.
// saveState() writes only on an actual change.
// ============================================================
// manualDay and openedDay hold the local day number on which the flag was
// set. Comparing against today makes both expire at local midnight on their
// own, and makes them survive a reboot without going stale.
let T_VALID = 1700000000;   // below this the device clock is not in sync yet

let ST = {
  manualDay: -1,       // day on which manual operation was detected
  manualTs: 0,         // when it was detected, RAM only, see the retry block
  manualUp: -1,        // uptime of a manual report seen before the clock was
  // valid, -1 = none, dated on the first valid tick
  wakePending: false,  // wake call received before the clock was valid
  ownSrc: null,        // how the cover names our commands, learned from the
  // first report after one, persisted. See the handler.
  active: false,       // tracking is currently running, persisted
  lastAng: 999,
  lastSlat: -1,        // slat_pos last commanded by the tracking, -1 = none
  lastPos: -1,         // cover position last commanded by the tracking
  lastMove: 0,
  selfCmd: 0,          // timestamp of our own last movement command
  cmdSeq: 0,           // counts our commands, a late refusal of an older
  // one must not become a retry
  demand: null,        // true = too warm, false = fine, null = never reported
  demandTs: 0,         // 0 = restored but not yet stamped, see tick()
  phase: null,         // true = day, false = night, null = not yet known
  openedDay: -1,       // day on which the day position was released
  pendingDay: false,   // day position still to be driven if no shading
  window: null,        // true = open, false = closed, null = never reported
  windowTs: 0,         // 0 = restored but not yet stamped, see tick()
  retry: null,         // command the cover refused, resent on the next tick
  retryN: 0            // consecutive failures, see RETRY_MAX
};

let saved = "";        // content last written to flash

function now() {
  let s = Shelly.getComponentStatus("sys");
  if (s && s.unixtime) return s.unixtime;
  return 0;
}

// Seconds since boot. Counts from the first second, clock or no clock.
function uptime() {
  let s = Shelly.getComponentStatus("sys");
  if (s && typeof s.uptime === "number") return s.uptime;
  return 0;
}

// ============================================================
// Error guard
//
// An uncaught error ends the script, in a callback as much as anywhere else,
// and an ended script shades nothing until someone notices and restarts it
// by hand. Every entry point therefore runs under try/catch. Errors are
// printed whatever the debug flag says.
// ============================================================
function errText(e) {
  if (typeof e === "string") return e;
  if (e && typeof e.message === "string") return e.message;
  return num(e);
}

function guard(f, a, b) {
  try { f(a, b); }
  catch (e) { print("[shade] ERROR: " + errText(e)); }
}

// Every RPC gets a callback. Without one a failed call is invisible, and
// the script would keep believing the blind followed its command.
function rpcDone(res, err, msg) {
  if (err === 0) return;
  let m = "RPC failed, code " + num(err);
  if (msg) m = m + ": " + msg;
  log(m);
}

// A failed flash write must not pass for a successful one, or the same
// state would never be written again.
function kvsDone(res, err, msg) {
  if (err === 0) return;
  saved = "";
  rpcDone(res, err, msg);
}

function saveState() {
  let o = { md: ST.manualDay, d: ST.demand, od: ST.openedDay, w: ST.window, a: ST.active, s: ST.ownSrc };
  let s = JSON.stringify(o);
  if (s === saved) return;           // unchanged -> no flash access
  saved = s;
  Shelly.call("KVS.Set", { key: "shade_state", value: s }, kvsDone);
  log("saved: " + s);
}

// Anything coming out of flash is treated as foreign input. A record from an
// older version or a half written one must not kill the script at startup,
// otherwise nothing shades at all until someone restarts it by hand. The
// shape is checked first, and JSON.parse runs under try/catch on top.
function parseState(s) {
  if (typeof s !== "string") { log("stored state not a string, ignored"); return null; }
  let head = s.slice(0, 1);
  let tail = s.slice(s.length - 1);
  if (head !== "{" || tail !== "}") { log("stored state malformed, ignored"); return null; }
  let v = null;
  try { v = JSON.parse(s); } catch (e) { v = null; }
  if (!v) { log("stored state unreadable, ignored"); return null; }
  return v;
}

function onStateLoaded(res, err) {
  if (err !== 0) { log("no stored state"); return; }
  if (!res) return;
  let v = parseState(res.value);
  if (v === null) return;
  saved = res.value;
  if (typeof v.md === "number") ST.manualDay = v.md;
  if (typeof v.od === "number") ST.openedDay = v.od;
  // Only a real boolean counts. Anything else stays null, otherwise
  // shadingDemand() would treat an undefined as a fresh report and skip the
  // seasonal fallback for a whole demandMaxAgeH.
  if (v.d === true || v.d === false) ST.demand = v.d;
  else ST.demand = null;
  if (v.w === true || v.w === false) ST.window = v.w;
  else ST.window = null;
  // A tracking that was running when the power went, or the script was
  // restarted, is resumed or ended properly on the first tick. Without this
  // the blind would sit in its shading position until sunset.
  if (v.a === true) ST.active = true;
  if (typeof v.s === "string") ST.ownSrc = v.s;
  // demandTs stays 0 on purpose. The clock is usually not in sync yet at
  // this point, so now() would return 0 and the value would immediately
  // count as expired. tick() stamps it once the clock is valid.
  log("state restored: " + res.value);
}

function stateLoaded(res, err) { guard(onStateLoaded, res, err); }

function loadState() {
  Shelly.call("KVS.Get", { key: "shade_state" }, stateLoaded);
}

// ============================================================
// Heat demand
// ============================================================
function shadingDemand(t) {
  let maxAge = CFG.demandMaxAgeH * 3600;
  if (ST.demand !== null) {
    if (t - ST.demandTs < maxAge) return ST.demand;
  }
  // Autonomous fallback: no report any more -> the season decides
  let m = monthOf(t);
  for (let i = 0; i < CFG.fallbackMonths.length; i++) {
    if (CFG.fallbackMonths[i] === m) return true;
  }
  return false;
}

// ============================================================
// Window contact
//
// An open window only ever caps the slat angle, it changes no state and no
// decision. Never reported means no cap at all, so a setup without a contact
// behaves exactly as before.
// ============================================================
function windowOpen(t) {
  if (ST.window !== true) return false;
  // A contact reports only when it changes, so silence is normal while the
  // window stays open. Only after windowMaxAgeH is the report treated as lost
  // and the cap dropped, which is the state a setup without a contact is in.
  let maxAge = CFG.windowMaxAgeH * 3600;
  if (t - ST.windowTs >= maxAge) return false;
  return true;
}

// ============================================================
// Movement commands
//
// A refused command is gone: the runtime never repeats it and the script
// would keep believing the blind followed. Everything therefore goes through
// sendCmd, which keeps the failed command for the next tick. Without that a
// cover that was busy for a moment loses its day or night position for the
// whole day. Only the tracking heals itself, on its next angle step.
// ============================================================
let RETRY_MAX = 3;     // repeats of a refused command before it is dropped

// track = true marks a tracking step. Its retry is dropped once the tracking
// itself has been dropped, the angle would be stale by then. The retry also
// remembers when the command was issued, so a manual operation in between
// wins over it, see tick().
function sendCmd(m, p, track) {
  let t = now();
  ST.selfCmd = t;
  ST.cmdSeq = ST.cmdSeq + 1;
  let seq = ST.cmdSeq;
  Shelly.call(m, p, function (res, err, msg) {
    if (err === 0) { ST.retryN = 0; ST.retry = null; return; }
    rpcDone(res, err, msg);
    // A newer command went out before this refusal came back. The newer
    // target is the one that counts, repeating the older one would drive
    // the blind backwards.
    if (seq !== ST.cmdSeq) { log("refusal of a superseded command, ignored"); return; }
    ST.retryN = ST.retryN + 1;
    if (ST.retryN > RETRY_MAX) {
      ST.retryN = 0;
      log("command dropped after " + num(RETRY_MAX) + " repeats");
      return;
    }
    ST.retry = { m: m, p: p, t: t, track: (track === true) };
  });
}

function drive(pos, slatPos, track) {
  let p = { id: CFG.coverId, pos: pos };
  if (CFG.slats && slatPos !== null) p.slat_pos = slatPos;
  // Position and slats must be sent in ONE call, otherwise the second
  // command overrides the first.
  sendCmd("Cover.GoToPosition", p, track);
  let m = "drive pos=" + num(pos);
  m = m + " slat=" + num(slatPos);
  log(m);
}

// Everything the tracking remembers about its last movement. Called wherever
// the tracking is dropped, so no stale value can suppress the next command.
// The active flag is persisted, so the change goes to flash right here.
function resetTracking() {
  ST.active = false;
  ST.lastAng = 999;
  ST.lastSlat = -1;
  ST.lastPos = -1;
  saveState();
}

function runEndAction(t, alt) {
  // Right before the day/night switch the sunset action follows within
  // minutes. Opening fully here would mean two full travels for nothing.
  if (CFG.sunsetAction) {
    let near = CFG.dayNightElev + CFG.endSkipDeg;
    if (alt < near) { log("tracking ended, end action skipped, sunset is near"); return; }
  }
  if (CFG.endAction === 1) {
    ST.lastMove = t;
    sendCmd("Cover.Open", { id: CFG.coverId });
  } else if (CFG.endAction === 2) {
    ST.lastMove = t;
    sendCmd("Cover.Close", { id: CFG.coverId });
  } else if (CFG.endAction === 3) {
    ST.lastMove = t;
    drive(CFG.shadePos, angleToSlatPos(0));
  }
  log("tracking ended, end action " + num(CFG.endAction));
}

// Local time from device time. utc_offset also covers daylight saving.
// Without it the device falls back to UTC, which shifts dayFallbackHour and
// moves the midnight rollover of both day flags, so it is worth a warning.
let warnedOffset = false;

function localOffset() {
  let s = Shelly.getComponentStatus("sys");
  if (s && s.utc_offset !== undefined) return s.utc_offset;
  if (!warnedOffset) {
    warnedOffset = true;
    log("WARNING: no utc_offset from the device, running on UTC");
  }
  return 0;
}

function localDay(t) {
  return Math.floor((t + localOffset()) / 86400);
}

function localHour(t) {
  let v = t + localOffset();
  let d = Math.floor(v / 86400);
  let rem = v - d * 86400;
  return Math.floor(rem / 3600);
}

function isManual(t) { return ST.manualDay === localDay(t); }
function isOpened(t) { return ST.openedDay === localDay(t); }

// Release the day. Drives nothing here, only records the intent.
// The tick then decides between day position and shading.
function openDay(t, why) {
  ST.openedDay = localDay(t);
  ST.manualDay = -1;               // the day release wins over an override
  resetTracking();
  ST.pendingDay = true;
  log("day released (" + why + ")");
  saveState();
}

// Dark and past noon: the sun is on its way down, not up. A wake call now
// would open the blind for the night. Normally isOpened() catches it, the
// day was released that morning. This is the safety net for an empty store,
// the first evening after installation.
function isEvening(t) {
  if (localHour(t) < 12) return false;
  let sun = sunPos(t, CFG.lat, CFG.lon);
  if (sun.alt >= CFG.dayNightElev) return false;
  return true;
}

// ============================================================
// Manual operation
//
// Everything after the filters of the status handler. Also used for a report
// that arrived before the clock was valid, with its back-dated time.
// ============================================================
function markManual(t, src) {
  if (isManual(t)) return;
  // A manual command in the dark must not consume the coming day. The flag
  // expires at local midnight, so anything touched between midnight and
  // sunrise would otherwise block the whole day, day position included.
  //
  // Only while the day is still locked, though. After a wake call before
  // sunrise the blind has already moved on its own, and whoever corrects it
  // in the dark means it. Between sunset and midnight the day is released as
  // well, so the flag is set there too, where it changes nothing: it expires
  // at midnight and the night is over before the automation acts again.
  let sun = sunPos(t, CFG.lat, CFG.lon);
  if (sun.alt < CFG.dayNightElev && !isOpened(t)) {
    log("manual operation (" + src + ") before the day release, automation not paused");
    return;
  }
  ST.manualDay = localDay(t);
  ST.manualTs = t;
  // A day position still waiting to be driven would run over the manual
  // command on the next tick. The person has chosen a position, and that is
  // the day position now.
  ST.pendingDay = false;
  resetTracking();
  log("manual operation (" + src + ") -> tracking paused until midnight");
  saveState();
}

// Cover reports name their source. Ours is "script:<id>". Another script on
// the same device is a second controller and counts as manual, but only when
// the own id is known. Without it every script has to count as us, or the
// automation would pause itself after each of its own movements.
let OWN_ID = -1;
if (Shelly.getCurrentScriptId) {
  let sid = Shelly.getCurrentScriptId();
  if (typeof sid === "number") OWN_ID = sid;
}

function isOwnSource(src) {
  if (src.indexOf("script") !== 0) return false;   // not a script at all
  if (OWN_ID < 0) return true;                      // id unknown, see above
  if (src === "script") return true;                // no id reported
  if (src === "script:" + num(OWN_ID)) return true;
  return false;
}

// Sources that can only be a person or an external controller: the two
// physical inputs, the app over the cloud, the web interface and anything
// that talks to the device over WebSocket, HTTP or MQTT. A report with one
// of these is never the tail end of our own command, so it counts as manual
// at once, and it is never mistaken for our own source below. The list need
// not be complete: any source not on it is placed by the learning in the
// status handler.
let HUMAN_SRC = ["button", "switch", "SHC", "WS_in", "HTTP_in", "http", "HTTP", "cloud", "CLD", "MQTT", "mqtt", "UI"];

let LEARN_SEC = 3;     // a report this soon after our command is its start

function isHumanSource(src) {
  for (let i = 0; i < HUMAN_SRC.length; i++) {
    if (HUMAN_SRC[i] === src) return true;
  }
  return false;
}

// ============================================================
// Main cycle
// ============================================================
function tick() {
  let t = now();
  if (t < T_VALID) { log("no valid clock, tracking paused"); return; }

  // What arrived while the clock was not valid yet, dated now.
  //
  // A manual report is dated by uptime. Typical after a power cut: the
  // person straightens the blind by hand before the clock is back, and the
  // automation must not run over that five minutes later. Dated before
  // midnight it has already expired, then it changes nothing.
  if (ST.manualUp >= 0) {
    let tm = t - (uptime() - ST.manualUp);
    ST.manualUp = -1;
    if (localDay(tm) === localDay(t)) markManual(tm, "before clock sync");
    else log("manual operation before clock sync expired at midnight, ignored");
  }
  // A wake call is applied as if it came now. Without this the alarm
  // would be lost and the blind stays down until dayFallbackHour.
  if (ST.wakePending) {
    ST.wakePending = false;
    if (!isOpened(t) && !isEvening(t)) openDay(t, "alarm, before clock sync");
  }
  // A value restored from KVS is stamped here, on the first tick with a
  // valid clock, not in loadState() where the clock is usually still 0.
  if (ST.demand !== null && ST.demandTs === 0) ST.demandTs = t;
  if (ST.window !== null && ST.windowTs === 0) ST.windowTs = t;

  // A refused command is repeated before anything else is decided, so the
  // blind reaches the position the script already believes it is in. The
  // day/night check below is level based, not edge based, so a transition
  // falling on this tick is not lost, only postponed by one.
  //
  // Unless the world moved on: a manual operation since the command was
  // issued wins over it, whatever the command was. And a tracking step is
  // worthless once the tracking itself has been dropped.
  if (ST.retry !== null) {
    let r = ST.retry;
    ST.retry = null;
    let drop = null;
    if (ST.manualTs >= r.t) drop = "manual operation since";
    else if (r.track && !ST.active) drop = "tracking ended since";
    if (drop !== null) {
      ST.retryN = 0;
      log("refused command dropped, " + drop);
    } else {
      log("repeating the refused command");
      sendCmd(r.m, r.p, r.track);
      return;
    }
  }

  let sun = sunPos(t, CFG.lat, CFG.lon);

  // Day/night change. Only triggered on the transition, not on every tick,
  // so that a manual command during the night stays untouched.
  let isDay = false;
  if (sun.alt >= CFG.dayNightElev) isDay = true;

  if (ST.phase === null) {
    ST.phase = isDay;              // on startup only remember the phase
    // A tracking restored from flash while the sun is already down: the end
    // of the day fell into the outage. The night position, or the end action
    // where there is none, is still owed. A manual operation before the
    // outage would have cleared the flag, so nothing is driven over it.
    if (!isDay && ST.active) {
      resetTracking();
      ST.pendingDay = false;
      log("tracking was running when the script stopped, sun is down now");
      if (CFG.sunsetAction) drive(CFG.nightPos, CFG.nightSlat);
      else runEndAction(t, sun.alt);
      return;
    }
  } else if (isDay !== ST.phase) {
    ST.phase = isDay;
    resetTracking();
    if (isDay) {
      log("sunrise");
    } else {
      log("sunset");
      ST.pendingDay = false;
      if (CFG.sunsetAction) drive(CFG.nightPos, CFG.nightSlat);
      return;
    }
  }

  // Day release. Deliberately outside the transition block so that it also
  // fires when the script starts up in the middle of a day.
  //
  // A manual override does not block it. The release clears the override,
  // exactly as a wake call does. Otherwise someone tilting the blind before
  // the release, in the hour between sunrise and dayFallbackHour, would lock
  // the whole day out of the automation, shading included, which is the one
  // thing the pause is not meant to do.
  if (isDay && !isOpened(t)) {
    if (CFG.dayTrigger === "sun") {
      openDay(t, "sun");
    } else if (localHour(t) >= CFG.dayFallbackHour) {
      openDay(t, "fallback");      // alarm never called, open anyway
    }
  }

  let rel = norm180(sun.az - CFG.azimuth);
  let tol = CFG.tolStart;
  if (ST.active) tol = CFG.tolEnd;

  let ar = abs(rel);
  let inSector = false;
  if (ar <= tol && ar < 90) inSector = true;

  let demand = shadingDemand(t);
  let should = false;
  // isDay, not only minElev: a minElev below dayNightElev would otherwise
  // restart the tracking minutes after the night position was driven.
  if (isDay && isOpened(t) && !isManual(t)) {
    if (demand && inSector && sun.alt >= CFG.minElev) should = true;
  }

  let m = "alt=" + num(Math.round(sun.alt));
  m = m + " az=" + num(Math.round(sun.az));
  m = m + " rel=" + num(Math.round(rel));
  m = m + " demand=" + num(demand);
  m = m + " sector=" + num(inSector);
  m = m + " manual=" + num(isManual(t));
  log(m);

  // By default a pending day position is dropped when shading is already
  // due, so the blind does not travel up and back down seconds later.
  // wakeAlwaysOpen opts out of that and takes the extra movement.
  if (should && ST.pendingDay && CFG.wakeAlwaysOpen) {
    drive(CFG.dayPos, CFG.daySlat);
    ST.pendingDay = false;
    return;                        // shading follows on the next tick
  }

  let pause = CFG.intervalMin * 60;
  let due = false;
  if (t - ST.lastMove >= pause) due = true;

  if (!should) {
    if (ST.active) {
      // The pause applies to the end of the tracking as well. A heat demand
      // toggling around its threshold would otherwise drive the blind fully
      // up and down on every flip. Not due yet means: try again next tick.
      if (!due) { log("end action delayed, pause not over"); return; }
      ST.pendingDay = false;
      resetTracking();
      runEndAction(t, sun.alt);
    } else if (ST.pendingDay) {
      drive(CFG.dayPos, CFG.daySlat);
      ST.pendingDay = false;
    }
    return;
  }

  ST.pendingDay = false;           // shading takes over
  let prof = profileAngle(sun.alt, rel);
  let ang = cutOffAngle(prof);
  if (CFG.mode === 1) ang = ang + CFG.coolExtra;   // maximum cooling: further closed
  // Always round towards closed, otherwise a stripe of sun would get through
  let k = Math.ceil(ang / CFG.stepDeg);
  ang = k * CFG.stepDeg;

  // An open window keeps a gap. Only a cap, so when the sun already calls for
  // a flatter angle nothing changes at all. Applied after the rounding, which
  // would otherwise push the angle back past the cap.
  if (windowOpen(t) && ang > CFG.windowAng) ang = CFG.windowAng;

  let sp = null;
  if (CFG.slats) sp = angleToSlatPos(ang);

  // The pause also gates the start, otherwise a flipping demand would restart
  // the tracking seconds after the end action.
  if (!due) return;

  // Compare what is actually commanded, not the raw angle. Beyond the
  // calibration points many angles map to the same slat_pos, and comparing
  // angles kept re-sending a command the blind had already executed.
  let changed = false;
  if (CFG.slats) {
    if (sp !== ST.lastSlat) changed = true;
  } else if (CFG.shadePos !== ST.lastPos) {
    changed = true;
  }

  let started = !ST.active;
  if (!started && !changed) return;

  let m2 = "profile=" + num(Math.round(prof));
  m2 = m2 + " -> slat angle=" + num(ang);
  log(m2);
  if (CFG.slats && !angleReachable(ang)) {
    let m3 = "angle " + num(ang) + " outside the calibrated range, clamped to slat_pos ";
    m3 = m3 + num(sp);
    log(m3);
  }
  // Send first, remember second. Should the send itself fail with an error,
  // the next tick finds a step not yet taken instead of one believed done.
  drive(CFG.shadePos, sp, true);
  ST.active = true;
  ST.lastAng = ang;
  ST.lastSlat = sp;
  ST.lastPos = CFG.shadePos;
  ST.lastMove = t;
  saveState();                     // the active flag, written on the start only
}

function tickGuarded() { guard(tick); }

// ============================================================
// Detect manual operation (button, app, web, cloud)
// -> pause tracking for the rest of the day
// ============================================================
function onCoverStatus(e) {
  let want = "cover:" + num(CFG.coverId);
  if (e.component !== want) return;
  if (!e.delta) return;
  if (e.delta.source === undefined) return;
  let src = e.delta.source;
  if (typeof src !== "string") return;
  let t = now();
  let age = t - ST.selfCmd;
  if (isOwnSource(src)) {
    // Our own script id. Remembered as the own name as well, so that from
    // here on every other source can be placed as foreign, see below.
    if (ST.ownSrc === null && t >= T_VALID && age <= LEARN_SEC) {
      ST.ownSrc = src;
      log("own command reported with source " + src + ", learned");
      saveState();
    }
    return;
  }
  // The device's own stops: init after a boot, limit_switch at an end
  // position, timeout when the motor ran its computed time, which is how
  // every slat tilt and every stop between the ends is reported. Seen on a
  // Plus 2PM with firmware 1.7.1: our commands arrive as "loopback", their
  // ends as limit_switch or timeout, an HTTP command as "HTTP_in".
  if (src === "init") return;
  if (src === "limit_switch") return;
  if (src === "timeout") return;
  if (t < T_VALID) {
    // No clock yet, so the flag cannot be dated. Remembered by uptime and
    // dated on the first valid tick. No command of ours can be behind it,
    // nothing is sent without a clock.
    if (ST.manualUp < 0) ST.manualUp = uptime();
    log("manual operation (" + src + ") before the clock is valid, remembered");
    return;
  }
  // How the cover names our commands is not documented, and a name the
  // script does not know would make it pause itself after each of its own
  // movements. So it learns the name: the motor starts the moment a command
  // goes out, and the report of that start follows within seconds. Once the
  // name is known every report of ours can be placed, ours or limit_switch,
  // and any other source is somebody else, whatever the time says. That is
  // what lets a person stop the automation the moment it sets off, from a
  // button, an app or a controller the script has never heard of.
  //
  // Until the name is known, a report that cannot be placed counts as ours
  // inside selfCmdSec, the old rule. And a wrong lesson heals itself: the
  // learned name showing up while nothing of ours is moving cannot be ours,
  // so it is forgotten and the report counts as what it is.
  if (ST.ownSrc !== null && src === ST.ownSrc) {
    if (age < CFG.selfCmdSec) return;      // our own movement
    ST.ownSrc = null;
    log("source " + src + " seen outside our own movement, no longer taken as ours");
    saveState();
  } else if (!isHumanSource(src)) {
    if (ST.ownSrc === null && age <= LEARN_SEC) {
      ST.ownSrc = src;
      log("own command reported with source " + src + ", learned");
      saveState();
      return;
    }
    if (ST.ownSrc === null && age < CFG.selfCmdSec) {
      log("cover report (" + src + ") inside selfCmdSec, taken as our own");
      return;
    }
  }
  markManual(t, src);
}

function coverStatus(e) { guard(onCoverStatus, e); }

Shelly.addStatusHandler(coverStatus);

// ============================================================
// Receive the heat demand
//   http://<shelly-ip>/script/1/demand?v=1
// ============================================================
// Plain decimal number from a string, null when it is not one. Written out
// because parseFloat is not part of the documented mJS, and a missing global
// would kill the script on the first call. Uses slice and indexOf only.
function toNum(s) {
  let i = 0;
  let sign = 1;
  let c = s.slice(0, 1);
  if (c === "-") { sign = -1; i = 1; }
  else if (c === "+") { i = 1; }
  let v = 0;
  let frac = 0;
  let scale = 1;
  let digits = 0;
  let dot = false;
  while (i < s.length) {
    c = s.slice(i, i + 1);
    let d = "0123456789".indexOf(c);
    if (d >= 0) {
      if (dot) { scale = scale * 10; frac = frac * 10 + d; }
      else v = v * 10 + d;
      digits = digits + 1;
    } else if (c === "." && !dot) {
      dot = true;
    } else {
      return null;
    }
    i = i + 1;
  }
  if (digits === 0) return null;
  v = v + frac / scale;
  return sign * v;
}

// Value of ?key= as a number, null when absent or unreadable. Accepts 1/0,
// true/false and on/off as well, so the smart home may send what it has.
function qval(q, key) {
  if (typeof q !== "string") return null;
  let parts = q.split("&");
  for (let i = 0; i < parts.length; i++) {
    let kv = parts[i].split("=");
    if (kv[0] === key && kv.length > 1) {
      let s = kv[1];
      if (s === "1" || s === "true" || s === "on") return 1;
      if (s === "0" || s === "false" || s === "off") return 0;
      return toNum(s);
    }
  }
  return null;
}

// The handlers return true when a cycle should follow. safeEp() runs it
// after the answer has gone out, under its own guard.
function onDemand(req, res) {
  let v = qval(req.query, "v");
  let changed = false;
  if (v !== null) {
    let nv = (v > 0.5);
    if (nv !== ST.demand) changed = true;   // only a real flip needs a cycle
    ST.demand = nv;
    ST.demandTs = now();
    saveState();                            // writes only on an actual change
  }
  let t = now();
  let o = { demand: ST.demand, active: ST.active, manual: isManual(t), window_open: windowOpen(t) };
  res.code = 200;
  res.body = JSON.stringify(o);
  res.send();
  return changed;
}

// Wake call: releases the day and lets the tick decide what to drive.
//   http://<shelly-ip>/script/1/wake
function onWake(req, res) {
  let t = now();
  let fresh = false;
  if (t < T_VALID) {
    // No clock yet, typically right after a power cut with the alarm going
    // off minutes later. Kept and applied on the first valid tick.
    ST.wakePending = true;
    log("wake call before the clock is valid, remembered");
  } else if (isOpened(t)) {
    // isOpened() is day-stamped, so a stray call after sunset is ignored:
    // the day was already released this morning. A call before sunrise
    // still works.
    log("wake call, day already released");
  } else if (isEvening(t)) {
    log("wake call in the evening, ignored");
  } else {
    openDay(t, "alarm");
    fresh = true;
  }
  let o = { opened: (t > 0 && isOpened(t)), demand: ST.demand, manual: (t > 0 && isManual(t)) };
  res.code = 200;
  res.body = JSON.stringify(o);
  res.send();
  return fresh;                    // decide immediately, do not wait for the next tick
}

// Window contact: caps the slat angle while the window is open.
//   http://<shelly-ip>/script/1/window?v=1
function onWindow(req, res) {
  let v = qval(req.query, "v");
  let t = now();
  let before = windowOpen(t);
  if (v !== null) {
    ST.window = (v > 0.5);
    ST.windowTs = t;
    saveState();                            // writes only on an actual change
  }
  let after = windowOpen(t);
  let o = { window_open: after, active: ST.active, manual: isManual(t) };
  res.code = 200;
  res.body = JSON.stringify(o);
  res.send();
  // Compare the effect, not the value. Repeating the same value changes
  // nothing, but one arriving after windowMaxAgeH revives a lapsed cap.
  if (before === after) return false;
  // A person opening a window wants air now: the pause guards the motor
  // against the drifting sun, not against the two commands a person causes.
  // Only while the tracking runs, though. Otherwise the cap changes nothing,
  // and lifting the pause would only let the next start or end action jump
  // the queue.
  if (ST.active) ST.lastMove = 0;
  return true;
}

// Endpoints answer first and act second. When the handler fails before the
// answer, the caller gets a 500 instead of waiting for the 10 s timeout. The
// cycle it asked for runs afterwards, under its own guard.
function safeEp(f, req, res) {
  let more = false;
  try { more = f(req, res); }
  catch (e) {
    print("[shade] ERROR in endpoint: " + errText(e));
    try { res.code = 500; res.body = "{\"error\":true}"; res.send(); } catch (e2) { }
  }
  if (more === true) guard(tick);
}

function epDemand(req, res) { safeEp(onDemand, req, res); }
function epWake(req, res) { safeEp(onWake, req, res); }
function epWindow(req, res) { safeEp(onWindow, req, res); }

HTTPServer.registerEndpoint("demand", epDemand);
HTTPServer.registerEndpoint("wake", epWake);
HTTPServer.registerEndpoint("window", epWindow);

// ============================================================
// Startup
// ============================================================
// The values that would otherwise fail silently: a zero slat width divides by
// zero, two identical calibration points make every angle map to the same
// position. Both leave a running script that simply never shades correctly.
function pctOut(v) { return v < 0 || v > 100; }

function checkConfig() {
  if (CFG.slatWidth <= 0) log("CONFIG ERROR: slatWidth must be greater than 0");
  if (CFG.slatDist <= 0) log("CONFIG ERROR: slatDist must be greater than 0");
  if (CFG.angAtPos0 === CFG.angAtPos100) log("CONFIG ERROR: angAtPos0 and angAtPos100 are identical, calibration missing");
  if (CFG.stepDeg <= 0) log("CONFIG ERROR: stepDeg must be greater than 0");
  if (!angleReachable(CFG.windowAng)) log("CONFIG WARNING: windowAng outside the calibrated range, the cap cannot be reached");
  if (CFG.tolEnd < CFG.tolStart) log("CONFIG WARNING: tolEnd below tolStart, the sector edge can flap");
  if (CFG.minElev <= CFG.dayNightElev) log("CONFIG WARNING: minElev not above dayNightElev, the night phase ends the shading before minElev does");
  if (CFG.lat > 90 || CFG.lat < -90) log("CONFIG ERROR: lat outside -90..90");
  if (CFG.lon > 180 || CFG.lon < -180) log("CONFIG ERROR: lon outside -180..180");
  if (CFG.dayTrigger !== "sun" && CFG.dayTrigger !== "cmd") log("CONFIG ERROR: dayTrigger is neither \"sun\" nor \"cmd\", only dayFallbackHour releases the day");
  if (CFG.dayFallbackHour < 0 || CFG.dayFallbackHour > 23) log("CONFIG ERROR: dayFallbackHour outside 0..23");
  if (pctOut(CFG.shadePos)) log("CONFIG ERROR: shadePos outside 0..100");
  if (pctOut(CFG.dayPos) || pctOut(CFG.daySlat)) log("CONFIG ERROR: dayPos or daySlat outside 0..100");
  if (pctOut(CFG.nightPos) || pctOut(CFG.nightSlat)) log("CONFIG ERROR: nightPos or nightSlat outside 0..100");
  if (CFG.tickSec < 10) log("CONFIG ERROR: tickSec below 10 s, the device would do little else");
  if (CFG.intervalMin < 0) log("CONFIG ERROR: intervalMin must not be negative");
  if (CFG.selfCmdSec < 0) log("CONFIG ERROR: selfCmdSec must not be negative");
  if (CFG.demandMaxAgeH <= 0) log("CONFIG ERROR: demandMaxAgeH must be greater than 0");
  if (CFG.windowMaxAgeH <= 0) log("CONFIG ERROR: windowMaxAgeH must be greater than 0");
}

// The cover itself. Everything the script sends is refused when the device
// is not in the Cover profile, not calibrated, or has slat control disabled,
// and the log would only ever show the refusals one at a time. Runs once the
// device has settled, not in the first second of the boot.
function checkCover() {
  let key = "cover:" + num(CFG.coverId);
  let st = Shelly.getComponentStatus(key);
  if (!st) { log("CONFIG ERROR: " + key + " not found, is the device in the Cover profile?"); return; }
  if (st.pos_control !== true) log("CONFIG ERROR: cover not calibrated, every position command is refused");
  if (CFG.slats && st.slat_pos === undefined) log("CONFIG ERROR: cover reports no slat_pos, slat control is not enabled");
  let cf = Shelly.getComponentConfig(key);
  if (!cf) return;
  let mt = 0;
  if (typeof cf.maxtime_open === "number") mt = cf.maxtime_open;
  if (typeof cf.maxtime_close === "number" && cf.maxtime_close > mt) mt = cf.maxtime_close;
  if (mt > CFG.selfCmdSec) {
    let m = "CONFIG WARNING: selfCmdSec " + num(CFG.selfCmdSec);
    m = m + " is below the cover travel time of up to " + num(mt);
    m = m + " s, own movements could count as manual operation";
    log(m);
  }
}

// The first tick waits for the clock. Without NTP right after a boot, a
// power cut for example, it is checked every 15 s instead of once per
// tickSec, so the automation starts seconds after the clock is back, not
// minutes. The periodic tick runs alongside and simply returns until then.
function waitClock() {
  if (now() < T_VALID) { Timer.set(15000, false, waitClock); return; }
  guard(tick);
}

function firstRun() {
  guard(checkCover);
  waitClock();
}

function init() {
  let m = "location " + num(CFG.lat);
  m = m + " / " + num(CFG.lon);
  log(m);
  checkConfig();
  loadState();
  Timer.set(CFG.tickSec * 1000, true, tickGuarded);
  Timer.set(15000, false, firstRun);   // once the device has settled
}

init();
