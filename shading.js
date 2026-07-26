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
//
// Manual operation of the cover pauses the automation for the rest of the
// local day. Both that flag and the day release are stored as day numbers,
// so they expire at local midnight and survive a reboot without going stale.
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
  intervalMin: 20,       // minimum pause between two movements

  mode: 1,               // 0 = maximum daylight, 1 = maximum cooling
  coolExtra: 20,         // extra degrees towards closed in mode 1

  // Where the curtain travels while shading. 0 = fully down,
  // 100 = fully up. After that only the slat angle is tracked.
  shadePos: 0,
  endAction: 1,          // 0=nothing, 1=open, 2=close, 3=slats horizontal

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

  // --- Heat demand
  demandMaxAgeH: 24,               // after this the report counts as lost
  fallbackMonths: [4,5,6,7,8,9],   // without a valid report the season decides

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
let ST = {
  manualDay: -1,       // day on which manual operation was detected
  active: false,       // tracking is currently running
  lastAng: 999,
  lastMove: 0,
  selfCmd: 0,          // timestamp of our own last movement command
  demand: null,        // true = too warm, false = fine, null = never reported
  demandTs: 0,         // 0 = restored but not yet stamped, see tick()
  phase: null,         // true = day, false = night, null = not yet known
  openedDay: -1,       // day on which the day position was released
  pendingDay: false    // day position still to be driven if no shading
};

let saved = "";        // content last written to flash

function now() {
  let s = Shelly.getComponentStatus("sys");
  if (s && s.unixtime) return s.unixtime;
  return 0;
}

function saveState() {
  let o = { md: ST.manualDay, d: ST.demand, od: ST.openedDay };
  let s = JSON.stringify(o);
  if (s === saved) return;           // unchanged -> no flash access
  saved = s;
  Shelly.call("KVS.Set", { key: "shade_state", value: s });
  log("saved: " + s);
}

function loadState() {
  Shelly.call("KVS.Get", { key: "shade_state" }, function (res, err) {
    if (err !== 0) { log("no stored state"); return; }
    if (!res) return;
    saved = res.value;
    let v = JSON.parse(res.value);
    if (v.md !== undefined) ST.manualDay = v.md;
    if (v.od !== undefined) ST.openedDay = v.od;
    ST.demand = v.d;
    // demandTs stays 0 on purpose. The clock is usually not in sync yet at
    // this point, so now() would return 0 and the value would immediately
    // count as expired. tick() stamps it once the clock is valid.
    log("state restored: " + res.value);
  });
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
// Movement commands
// ============================================================
function drive(pos, slatPos) {
  let p = { id: CFG.coverId, pos: pos };
  if (CFG.slats && slatPos !== null) p.slat_pos = slatPos;
  ST.selfCmd = now();
  // Position and slats must be sent in ONE call, otherwise the second
  // command overrides the first.
  Shelly.call("Cover.GoToPosition", p);
  let m = "drive pos=" + num(pos);
  m = m + " slat=" + num(slatPos);
  log(m);
}

function runEndAction() {
  if (CFG.endAction === 1) {
    ST.selfCmd = now();
    Shelly.call("Cover.Open", { id: CFG.coverId });
  } else if (CFG.endAction === 2) {
    ST.selfCmd = now();
    Shelly.call("Cover.Close", { id: CFG.coverId });
  } else if (CFG.endAction === 3) {
    drive(CFG.shadePos, angleToSlatPos(0));
  }
  log("tracking ended, end action " + num(CFG.endAction));
}

// Local time from device time. utc_offset also covers daylight saving.
// Without it the device falls back to UTC, which shifts dayFallbackHour.
function localOffset() {
  let s = Shelly.getComponentStatus("sys");
  if (s && s.utc_offset) return s.utc_offset;
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
  ST.manualDay = -1;               // a wake call or sunrise wins over an override
  ST.active = false;
  ST.lastAng = 999;
  ST.pendingDay = true;
  log("day released (" + why + ")");
  saveState();
}

// ============================================================
// Main cycle
// ============================================================
function tick() {
  let t = now();
  if (t < 1700000000) { log("no valid clock, tracking paused"); return; }

  // A value restored from KVS is stamped here, on the first tick with a
  // valid clock, not in loadState() where the clock is usually still 0.
  if (ST.demand !== null && ST.demandTs === 0) ST.demandTs = t;

  let sun = sunPos(t, CFG.lat, CFG.lon);

  // Day/night change. Only triggered on the transition, not on every tick,
  // so that a manual command during the night stays untouched.
  let isDay = false;
  if (sun.alt >= CFG.dayNightElev) isDay = true;

  if (ST.phase === null) {
    ST.phase = isDay;              // on startup only remember the phase
  } else if (isDay !== ST.phase) {
    ST.phase = isDay;
    ST.active = false;
    ST.lastAng = 999;
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
  if (isDay && !isOpened(t) && !isManual(t)) {
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
  if (!isManual(t) && isOpened(t) && demand && inSector && sun.alt >= CFG.minElev) should = true;

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
    ST.pendingDay = false;
    drive(CFG.dayPos, CFG.daySlat);
    return;                        // shading follows on the next tick
  }

  if (!should) {
    if (ST.active) {
      ST.active = false;
      ST.lastAng = 999;
      ST.pendingDay = false;
      runEndAction();
    } else if (ST.pendingDay) {
      ST.pendingDay = false;
      drive(CFG.dayPos, CFG.daySlat);
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

  let started = !ST.active;
  let due = false;
  if (t - ST.lastMove >= CFG.intervalMin * 60) due = true;
  let changed = false;
  if (abs(ang - ST.lastAng) >= CFG.stepDeg) changed = true;

  if (started || (due && changed)) {
    ST.active = true;
    ST.lastAng = ang;
    ST.lastMove = t;
    let m2 = "profile=" + num(Math.round(prof));
    m2 = m2 + " -> slat angle=" + num(ang);
    log(m2);
    let sp = null;
    if (CFG.slats) sp = angleToSlatPos(ang);
    drive(CFG.shadePos, sp);
  }
}

// ============================================================
// Detect manual operation (button, app, web, cloud)
// -> pause tracking for the rest of the day
// ============================================================
Shelly.addStatusHandler(function (e) {
  let want = "cover:" + num(CFG.coverId);
  if (e.component !== want) return;
  if (!e.delta) return;
  if (e.delta.source === undefined) return;
  let src = e.delta.source;
  if (src === "script") return;
  if (src === "init") return;
  if (src === "limit_switch") return;
  let t = now();
  if (t === 0) return;                      // no clock yet, cannot date the flag
  if (t - ST.selfCmd < 8) return;           // our own command
  if (isManual(t)) return;
  ST.manualDay = localDay(t);
  ST.active = false;
  ST.lastAng = 999;
  log("manual operation (" + src + ") -> tracking paused until midnight");
  saveState();
});

// ============================================================
// Receive the heat demand
//   http://<shelly-ip>/script/1/demand?v=1
// ============================================================
function qval(q, key) {
  if (typeof q !== "string") return null;
  let parts = q.split("&");
  for (let i = 0; i < parts.length; i++) {
    let kv = parts[i].split("=");
    if (kv[0] === key && kv.length > 1) return parseFloat(kv[1]);
  }
  return null;
}

HTTPServer.registerEndpoint("demand", function (req, res) {
  let v = qval(req.query, "v");
  let changed = false;
  if (v !== null && !isNaN(v)) {
    let nv = (v > 0.5);
    if (nv !== ST.demand) changed = true;   // only a real flip needs a cycle
    ST.demand = nv;
    ST.demandTs = now();
    saveState();                            // writes only on an actual change
  }
  let o = { demand: ST.demand, active: ST.active, manual: isManual(now()) };
  res.code = 200;
  res.body = JSON.stringify(o);
  res.send();
  if (changed) tick();
});

// Wake call: releases the day and lets the tick decide what to drive.
//   http://<shelly-ip>/script/1/wake
HTTPServer.registerEndpoint("wake", function (req, res) {
  let t = now();
  let fresh = false;
  // isOpened() is day-stamped, so a stray call after sunset is ignored: the
  // day was already released this morning. A call before sunrise still works.
  if (t > 1700000000 && !isOpened(t)) { openDay(t, "alarm"); fresh = true; }
  let o = { opened: (t > 0 && isOpened(t)), demand: ST.demand, manual: (t > 0 && isManual(t)) };
  res.code = 200;
  res.body = JSON.stringify(o);
  res.send();
  if (fresh) tick();               // decide immediately, do not wait for the next tick
});

// ============================================================
// Startup
// ============================================================
function init() {
  let m = "location " + num(CFG.lat);
  m = m + " / " + num(CFG.lon);
  log(m);
  loadState();
  Timer.set(CFG.tickSec * 1000, true, tick);
  Timer.set(15000, false, tick);   // first run once the clock is in sync
}

init();
