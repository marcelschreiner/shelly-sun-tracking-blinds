// ============================================================
// Runs shading.js unmodified under node, against a stub of the Shelly
// runtime and a virtual clock.
//
//   node test/run.js
//
// Every case under day release, manual override and wake call corresponds to
// a bug that was found and fixed, so the same mistake cannot come back
// unnoticed.
// ============================================================
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'shading.js'), 'utf8')
  + '\nglobalThis.__x = { ST: ST, CFG: CFG, tick: tick, sunPos: sunPos, localDay: localDay,'
  + ' windowOpen: windowOpen, angleToSlatPos: angleToSlatPos };';

let T = 0;            // virtual clock, unix seconds
let drives = [];      // every cover command the script issued
let writes = 0;       // KVS.Set calls, the flash write budget
let kvs = null;       // the one persisted record
let eps = {};         // registered HTTP endpoints
let onStatus = null;  // the cover status handler

// A fresh device. kvs survives unless the caller clears it, which is what
// makes the reboot cases testable.
function boot() {
  eps = {};
  onStatus = null;
  const sb = {
    print: () => {}, JSON, Math, parseFloat, isNaN,
    Timer: { set: () => 0 },
    HTTPServer: { registerEndpoint: (n, f) => { eps[n] = f; } },
    Shelly: {
      getComponentStatus: c => (c === 'sys' ? { unixtime: T, utc_offset: 7200 } : null),
      addStatusHandler: f => { onStatus = f; },
      call: (m, p, cb) => {
        if (m === 'KVS.Get') {
          return kvs === null ? cb && cb(null, -1, 'not found') : cb && cb({ value: kvs }, 0);
        }
        if (m === 'KVS.Set') { writes++; kvs = p.value; return cb && cb(null, 0); }
        drives.push({ m, p });
        if (cb) cb(null, 0);
      }
    }
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(SRC, sb);
  return sb.__x;
}

let X = boot();

const at = t => { T = t; drives = []; X.tick(); };
const ep = (n, q) => {
  let out;
  eps[n]({ query: q }, { send() { out = this.body; } });
  return JSON.parse(out);
};
// A cover report from someone other than us.
const manual = src => onStatus({ component: 'cover:0', delta: { source: src || 'WS_in' } });

let pass = 0, fail = 0;
const check = (n, c, i) => c
  ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (i ? '  -> ' + i : '')));
const group = n => console.log('\n' + n);

// 21 June 2025. Local time is UTC+2, true solar noon at lon 9.3333 is 11:22 UTC.
const D = (h, m) => Date.UTC(2025, 5, 21, h, m || 0, 0) / 1000;
const NOON = D(11, 22);       // sun due south, 66 degrees up
const MORNING = D(5, 0);      // 07:00 local, sun up, before dayFallbackHour
const EVENING = D(20, 30);    // after sunset
const NIGHT = D(1, 0);        // 03:00 local, deep night
// Low winter sun inside the sector: the regular angle lands at 75 degrees,
// above windowAng, so the cap has something to bite on.
const WINTER = Date.UTC(2025, 11, 21, 9, 0, 0) / 1000;

// ============================================================
group('solar position');
const s = X.sunPos(NOON, 47.5, 9.3333);
check('solstice noon elevation is 90-lat+23.44', Math.abs(s.alt - 65.94) < 0.5, 'alt=' + s.alt.toFixed(2));
check('azimuth due south at solar noon', Math.abs(s.az - 180) < 2, 'az=' + s.az.toFixed(1));
const w = X.sunPos(Date.UTC(2025, 11, 21, 11, 22, 0) / 1000, 47.5, 9.3333);
check('winter solstice elevation is 90-lat-23.44', Math.abs(w.alt - 19.06) < 0.5, 'alt=' + w.alt.toFixed(2));

// ============================================================
group('day release, dayTrigger "cmd"');
kvs = null; X = boot();
at(MORNING);
check('stays locked before dayFallbackHour', X.ST.openedDay === -1, 'openedDay=' + X.ST.openedDay);
check('nothing driven while locked', drives.length === 0, JSON.stringify(drives));
ep('wake', '');
check('wake call releases the day', X.ST.openedDay === X.localDay(T));
check('day position driven', drives.length === 1 && drives[0].p.pos === 100, JSON.stringify(drives));

kvs = null; X = boot();
at(D(8, 0));   // 10:00 local, past dayFallbackHour 9
check('opens on its own past dayFallbackHour', X.ST.openedDay === X.localDay(T));

// The day must actually have been released that morning, otherwise there is
// nothing for the evening call to be redundant with.
kvs = null; X = boot();
at(MORNING);
ep('wake', '');                // released for today
const before = X.ST.openedDay;
at(EVENING);                   // same local day, sun now down
drives = [];
ep('wake', '');
check('wake after sunset is ignored', X.ST.openedDay === before, 'openedDay=' + X.ST.openedDay);
check('and drives nothing', drives.length === 0, JSON.stringify(drives));

// ============================================================
group('manual override');
kvs = null; X = boot();
at(NOON);
check('shading running', X.ST.active === true);
T = NOON + 600;                // past selfCmdSec, so the report is not ours
manual('WS_in');
check('manual operation pauses tracking', X.ST.manualDay === X.localDay(T));
check('tracking reset', X.ST.active === false);
drives = [];
at(NOON + 3600);
check('nothing driven while paused', drives.length === 0, JSON.stringify(drives));

kvs = null; X = boot();
at(NOON);
T = NOON + 10;                 // inside selfCmdSec
manual('WS_in');
check('our own command is not mistaken for manual', X.ST.manualDay === -1);

kvs = null; X = boot();
at(NIGHT);
manual('WS_in');
check('manual operation at night does not pause', X.ST.manualDay === -1);

kvs = null; X = boot();
at(NOON);
T = NOON + 600;
manual('script:1');
check('the script itself is not manual', X.ST.manualDay === -1);

// ============================================================
group('end actions');
// Each variant needs its own boot. Once the tracking has ended it stays
// ended, so reusing one instance would test nothing at all.
function endAction(kind) {
  kvs = null;
  X = boot();
  at(NOON);
  if (X.ST.active !== true) return 'shading never started';
  X.CFG.endAction = kind;
  ep('demand', 'v=0');         // end the tracking the ordinary way
  drives = [];
  at(NOON + 1800);
  return drives;
}
let d = endAction(1);
check('endAction=open sends the blind up', d.length === 1 && d[0].m === 'Cover.Open', JSON.stringify(d));
d = endAction(2);
check('endAction=close sends it down', d.length === 1 && d[0].m === 'Cover.Close', JSON.stringify(d));
d = endAction(3);
check('endAction=slats-horizontal drives shadePos', d.length === 1 && d[0].p.pos === 0, JSON.stringify(d));
d = endAction(0);
check('endAction=nothing drives nothing', d.length === 0, JSON.stringify(d));

// ============================================================
group('window contact, the slat cap');
kvs = null; X = boot();
const steep = X.angleToSlatPos(75);
const capped = X.angleToSlatPos(X.CFG.windowAng);
T = WINTER;
drives = [];
ep('demand', 'v=1');           // outside fallbackMonths in December, and this ticks
check('shading runs on the low winter sun', X.ST.active === true);
check('no contact reported, regular angle commanded', drives.length === 1 && drives[0].p.slat_pos === steep,
      JSON.stringify(drives) + ' expected slat_pos ' + steep);

drives = [];
let r = ep('window', 'v=1');
check('endpoint reports open', r.window_open === true, JSON.stringify(r));
check('opening drives at once, it does not wait out intervalMin', drives.length === 1, JSON.stringify(drives));
check('slats capped towards open', drives.length === 1 && drives[0].p.slat_pos === capped,
      JSON.stringify(drives) + ' expected slat_pos ' + capped);
check('the curtain position is untouched', drives.length === 1 && drives[0].p.pos === X.CFG.shadePos);

drives = [];
ep('window', 'v=0');
check('closing returns to the regular angle', drives.length === 1 && drives[0].p.slat_pos === steep,
      JSON.stringify(drives));

group('window contact, the report expires');
// A contact only speaks when it changes, so the age has to outlast a long
// airing. Past windowMaxAgeH the report counts as lost and the cap is dropped.
kvs = null; X = boot();
X.CFG.demandMaxAgeH = 9999;    // isolate the window, or the heat demand
                               // expires first and December stops shading
const steep2 = X.angleToSlatPos(75);
const capped2 = X.angleToSlatPos(X.CFG.windowAng);
T = WINTER;
drives = [];
ep('demand', 'v=1');
ep('window', 'v=1');
check('capped right after the report', drives[drives.length - 1].p.slat_pos === capped2, JSON.stringify(drives));

const age = X.CFG.windowMaxAgeH * 3600;
at(WINTER + age - 3600);       // one hour short of the limit
check('still capped an hour before the limit', X.windowOpen(T) === true);

drives = [];
at(WINTER + age + 60);         // just past it
check('the report counts as lost', X.windowOpen(T) === false);
check('back to the regular angle', drives.length === 1 && drives[0].p.slat_pos === steep2,
      JSON.stringify(drives) + ' expected slat_pos ' + steep2);

drives = [];
ep('window', 'v=1');           // the contact speaks up again
check('a fresh report caps again', drives.length === 1 && drives[0].p.slat_pos === capped2,
      JSON.stringify(drives));

group('window contact, cap that does not bind');
kvs = null; X = boot();
at(NOON);                      // high summer sun, slats already flat
const flat = drives[0].p.slat_pos;
drives = [];
ep('window', 'v=1');
check('already flat enough, no command at all', drives.length === 0, JSON.stringify(drives));
at(NOON + 3600);
check('and none on the next tick either', drives.length === 0, JSON.stringify(drives));
check('window is open all the same', X.windowOpen(T) === true);
check('the flat angle is below the cap', flat === X.angleToSlatPos(-15));

// ============================================================
group('reboot');
kvs = JSON.stringify({ md: -1, d: true, od: -1 });
let Y = boot();
check('heat demand restored', Y.ST.demand === true, 'demand=' + Y.ST.demand);
check('demandTs stays 0 until the first valid tick', Y.ST.demandTs === 0);

kvs = JSON.stringify({ md: -1, d: 'yes', od: -1 });
Y = boot();
check('non-boolean demand falls back to null', Y.ST.demand === null, 'demand=' + Y.ST.demand);

kvs = JSON.stringify({ md: -1, d: null, od: -1, w: true });
Y = boot();
check('window state restored as open', Y.ST.window === true, 'window=' + Y.ST.window);
check('windowTs stays 0 until the first valid tick', Y.ST.windowTs === 0);
T = WINTER; Y.tick();
check('and is stamped there, not at restore time', Y.ST.windowTs === WINTER, 'ts=' + Y.ST.windowTs);

kvs = JSON.stringify({ md: -1, d: null, od: -1 });
Y = boot();
check('a record without w loads, window stays null', Y.ST.window === null, 'window=' + Y.ST.window);

kvs = 'not json at all';
Y = boot();
check('a malformed record does not kill the script', Y.ST.demand === null && Y.ST.window === null);

// ============================================================
group('demand');
kvs = null; X = boot();
at(NOON);
check('June shades without any report, via fallbackMonths', X.ST.active === true);
ep('demand', 'v=0');
at(NOON + 1800);
check('a demand of 0 ends the tracking', X.ST.active === false);

kvs = null; X = boot();
X.CFG.fallbackMonths = [1];          // June no longer in the fallback
at(NOON);
check('no report and month outside fallbackMonths, no shading', X.ST.active === false);

// ============================================================
group('flash write budget');
kvs = null; X = boot();
writes = 0;
for (let i = 0; i < 288; i++) at(NOON + i * 300);   // a full day of ticks
check('a day of ticks writes at most a handful', writes <= 5, 'writes=' + writes);
ep('demand', 'v=1');                 // null -> true is a real change, it must write
writes = 0;
for (let i = 0; i < 20; i++) ep('demand', 'v=1');   // same value, over and over
check('repeating the same value never reaches flash', writes === 0, 'writes=' + writes);
ep('demand', 'v=0');
check('a real flip does write', writes === 1, 'writes=' + writes);

// ============================================================
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
