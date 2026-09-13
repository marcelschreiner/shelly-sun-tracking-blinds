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
  + ' windowOpen: windowOpen, angleToSlatPos: angleToSlatPos, qval: qval };';

let T = 0;            // virtual clock, unix seconds
let U = 1000;         // virtual uptime, seconds since boot
let drives = [];      // every cover command the script issued
let writes = 0;       // KVS.Set calls, the flash write budget
let kvs = null;       // the one persisted record
let failCover = false; // true = the cover refuses every command
let deferCover = false; // true = cover callbacks are held in pendingCbs
let pendingCbs = [];
let throwCover = false; // true = the cover call throws, as a runtime error would
let failKvs = false;  // true = the flash write fails
let throwKvs = false; // true = the flash write throws
let coverStatus = { pos_control: true, slat_pos: 0, current_pos: 100 };
let coverConfig = { maxtime_open: 60, maxtime_close: 60 };
let eps = {};         // registered HTTP endpoints
let onStatus = null;  // the cover status handler
let timers = [];      // every Timer.set, {ms, rep, f}
let logs = [];        // every print

// A fresh device. kvs survives unless the caller clears it, which is what
// makes the reboot cases testable. parseFloat and isNaN are deliberately
// absent: they are not part of the documented mJS, the script must not
// depend on them.
function boot() {
  eps = {};
  onStatus = null;
  timers = [];
  const sb = {
    print: s => { logs.push(s); }, JSON, Math,
    Timer: { set: (ms, rep, f) => { timers.push({ ms, rep, f }); return timers.length; } },
    HTTPServer: { registerEndpoint: (n, f) => { eps[n] = f; } },
    Shelly: {
      getComponentStatus: c => {
        if (c === 'sys') return { unixtime: T, utc_offset: 7200, uptime: U };
        if (c === 'cover:0') return coverStatus;
        return null;
      },
      getComponentConfig: c => (c === 'cover:0' ? coverConfig : null),
      getCurrentScriptId: () => 1,
      addStatusHandler: f => { onStatus = f; },
      call: (m, p, cb) => {
        if (m === 'KVS.Get') {
          return kvs === null ? cb && cb(null, -1, 'not found') : cb && cb({ value: kvs }, 0);
        }
        if (m === 'KVS.Set') {
          if (throwKvs) throw new Error('kvs boom');
          writes++;
          if (failKvs) return cb && cb(null, -1, 'no space');
          kvs = p.value;
          return cb && cb(null, 0);
        }
        if (throwCover) throw new Error('cover boom');
        drives.push({ m, p });
        if (!cb) return;
        if (deferCover) { pendingCbs.push(cb); return; }
        cb(null, failCover ? -114 : 0, 'busy');
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
manual('loopback');            // a source the script cannot place
check('an unplaceable report inside selfCmdSec is taken as our own', X.ST.manualDay === -1);

// Stopping the automation the moment it starts: the blind sets off on the
// script's command, and five seconds later the person drives it back up.
// The button can only be a person, the time window does not apply.
kvs = null; X = boot();
at(NOON);
check('the automation has just sent the blind down', drives.length === 1 && drives[0].p.pos === 0, JSON.stringify(drives));
T = NOON + 5;
onStatus({ component: 'cover:0', delta: { source: 'button', state: 'opening' } });
check('a button press five seconds later pauses the day', X.ST.manualDay === X.localDay(T));
check('tracking dropped', X.ST.active === false);
drives = [];
at(NOON + 1800);               // the angle would have moved on by now
check('the automation does not drive it down again', drives.length === 0, JSON.stringify(drives));
at(NOON + 7200);
check('nor later that day', drives.length === 0, JSON.stringify(drives));
// The same from the app, the web interface and the smart home.
const humans = ['SHC', 'WS_in', 'http', 'MQTT', 'cloud', 'switch'];
let allHuman = true;
for (const h of humans) {
  kvs = null; X = boot();
  at(NOON);
  T = NOON + 5;
  manual(h);
  if (X.ST.manualDay !== X.localDay(T)) { allHuman = false; console.log('     not manual: ' + h); }
}
check('app, web, http, mqtt, cloud and switch count at once as well', allHuman);
// But the end of our own travel, however it is reported, does not.
kvs = null; X = boot();
at(NOON);
T = NOON + 60;
manual('limit_switch');
manual('script:1');
manual('timeout');
check('the end of our own travel is not manual', X.ST.manualDay === -1);

// ============================================================
group('learning the own source');
// The script does not need to know how the device names its commands: the
// report that follows within seconds of a command teaches it. From then on
// every other source is somebody else, at any time.
kvs = null; X = boot();
at(NOON);                        // our command
T = NOON + 1;
manual('loopback');              // the device reports our movement under a name we do not know
check('learned from the report right after our command', X.ST.ownSrc === 'loopback', 'ownSrc=' + X.ST.ownSrc);
check('and not taken for manual', X.ST.manualDay === -1);
check('persisted', kvs.indexOf('"s":"loopback"') >= 0, kvs);
T = NOON + 40;
manual('loopback');              // the end of our travel, inside the window
check('the end of our own travel is ours', X.ST.manualDay === -1);
T = NOON + 50;
manual('matter');                // a source the script has never seen, still inside the window
check('an unknown source inside the window is manual once ours is known', X.ST.manualDay === X.localDay(T));

X = boot();                      // kvs kept
check('restored from flash after a restart', X.ST.ownSrc === 'loopback');

// A wrong lesson heals itself: the learned name shows up when nothing of
// ours is moving, so it cannot be ours.
kvs = null; X = boot();
at(NOON);
T = NOON + 1;
manual('matter');                // a foreign controller sent something right after us
check('mislearned', X.ST.ownSrc === 'matter');
T = NOON + 3600;
manual('matter');                // used again, long after our movement
check('unlearned when seen outside our own movement', X.ST.ownSrc === null);
check('and that report counts as manual', X.ST.manualDay === X.localDay(T));

// Nothing is learned from a person or from the device itself.
kvs = null; X = boot();
at(NOON);
T = NOON + 1;
manual('button');
manual('limit_switch');
manual('init');
check('button, limit_switch and init are never learned', X.ST.ownSrc === null);

// The own script id counts as learned too, so the window is gone after the
// first movement even when the device names scripts as expected.
kvs = null; X = boot();
at(NOON);
T = NOON + 1;
manual('script:1');
check('the own script id is remembered as the own name', X.ST.ownSrc === 'script:1', 'ownSrc=' + X.ST.ownSrc);
T = NOON + 50;
manual('matter');
check('so an unknown source inside the window is manual', X.ST.manualDay === X.localDay(T));

kvs = null; X = boot();
at(NIGHT);
manual('WS_in');
check('manual operation at night does not pause', X.ST.manualDay === -1);

kvs = null; X = boot();
at(NOON);
T = NOON + 600;
manual('script:1');
check('the script itself is not manual', X.ST.manualDay === -1);

// A wake call before sunrise moves the blind on its own. Correcting that in
// the dark is a deliberate act, not the three in the morning case the night
// rule is there for.
const WDARK = Date.UTC(2025, 11, 21, 5, 0, 0) / 1000;   // 07:00 local, sun still down
const WSUN = Date.UTC(2025, 11, 21, 9, 0, 0) / 1000;    // sun up and inside the sector
function winterMorning() {
  kvs = null;
  X = boot();
  X.CFG.demandMaxAgeH = 9999;    // December is outside fallbackMonths
  at(WDARK);
  ep('demand', 'v=1');
  ep('wake', '');                // the alarm releases the day and opens
}
winterMorning();
at(WSUN);
check('control: without a manual command the shading runs', X.ST.active === true);

winterMorning();
T = WDARK + 600;                 // still dark, day already released
manual('WS_in');
check('manual after the day release pauses, dark or not', X.ST.manualDay === X.localDay(T));
drives = [];
at(WSUN);
check('and the shading does not drive over it', drives.length === 0, JSON.stringify(drives));
check('tracking stays off', X.ST.active === false);

// The pause must not lock the day out of the automation altogether, or one
// tilt at seven in the morning costs a whole day of shading.
kvs = null; X = boot();
at(MORNING);                     // 07:00 local, day still locked
T = MORNING + 600;
manual('WS_in');
check('manual before the release pauses too', X.ST.manualDay === X.localDay(T));
at(D(8, 0));                     // 10:00 local, past dayFallbackHour
check('the release goes through anyway', X.ST.openedDay === X.localDay(T));
check('and clears the override', X.ST.manualDay === -1);
at(NOON);
check('so the day is shaded after all', X.ST.active === true);

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
group('night phase');
// A minElev below dayNightElev used to restart the tracking minutes after
// the night position had been driven. The phase decides, not the elevation
// alone.
kvs = null; X = boot();
X.CFG.azimuth = 270;             // west window, the sun stays in the sector until it sets
X.CFG.dayNightElev = 10;
X.CFG.minElev = 5;
at(Date.UTC(2025, 5, 21, 18, 0, 0) / 1000);    // 11 degrees up, still day
check('shading runs before the switch', X.ST.active === true);
at(Date.UTC(2025, 5, 21, 18, 30, 0) / 1000);   // 7 degrees, below dayNightElev
check('night position driven', drives.length === 1 && drives[0].p.pos === X.CFG.nightPos,
      JSON.stringify(drives));
at(Date.UTC(2025, 5, 21, 18, 40, 0) / 1000);   // 6 degrees, still above minElev
check('nothing reopens behind it', drives.length === 0, JSON.stringify(drives));
check('and the tracking stays off', X.ST.active === false);

// ============================================================
group('refused commands');
// The runtime never repeats a refused command, and pendingDay is spent by
// the time the day position fails. Without the retry the blind would stay in
// the night position for the rest of the day.
kvs = null; X = boot();
at(MORNING);
failCover = true;
drives = [];
ep('wake', '');
check('the day position is attempted', drives.length === 1 && drives[0].p.pos === 100,
      JSON.stringify(drives));
failCover = false;
at(MORNING + 300);
check('and repeated on the next tick', drives.length === 1 && drives[0].p.pos === 100,
      JSON.stringify(drives));
at(MORNING + 600);
check('once it goes through nothing is repeated again', drives.length === 0, JSON.stringify(drives));

// A cover that stays busy must not be hammered for ever.
kvs = null; X = boot();
at(MORNING);
failCover = true;
ep('wake', '');
let repeats = 0;
for (let i = 1; i <= 6; i++) { at(MORNING + i * 300); repeats += drives.length; }
failCover = false;
check('a command that keeps failing is dropped', repeats === 3, 'repeats=' + repeats);
check('and the retry slot is free again', X.ST.retry === null && X.ST.retryN === 0);

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
// Per day: the release, the start and the end of each shading session, and
// whatever the person or the smart home changes. Not the ticks.
kvs = null; X = boot();
writes = 0;
for (let i = 0; i < 288; i++) at(NOON + i * 300);   // a full day of ticks
check('a day of ticks writes at most a handful', writes <= 6, 'writes=' + writes);
ep('demand', 'v=1');                 // null -> true is a real change, it must write
writes = 0;
for (let i = 0; i < 20; i++) ep('demand', 'v=1');   // same value, over and over
check('repeating the same value never reaches flash', writes === 0, 'writes=' + writes);
ep('demand', 'v=0');
// The flip itself, and the tracking it ends: the active flag is persisted.
check('a real flip does write', writes === 2, 'writes=' + writes);

// ============================================================
group('flash write failure');
kvs = null; X = boot();
T = NOON;
failKvs = true;
ep('demand', 'v=1');
failKvs = false;
writes = 0;
ep('demand', 'v=1');                 // the same value again
check('a failed write is retried on the next occasion', writes === 1, 'writes=' + writes);

// ============================================================
group('refused command vs. the world moving on');
// The cover refuses a tracking step, and before the next tick the person
// moves the blind by hand. Repeating the step would run over that.
kvs = null; X = boot();
failCover = true;
at(NOON);                        // tracking starts, the command is refused
check('the refused step waits for a repeat', X.ST.retry !== null);
failCover = false;
T = NOON + 600;
manual('WS_in');
drives = [];
at(NOON + 900);
check('but not over a manual operation', drives.length === 0, JSON.stringify(drives));
check('and the retry slot is free', X.ST.retry === null && X.ST.retryN === 0);

// The night position is the one movement a pause does not stop, and its
// repeat must not be lost to an override from earlier in the day.
kvs = null; X = boot();
X.CFG.azimuth = 270; X.CFG.dayNightElev = 10; X.CFG.minElev = 5;
at(Date.UTC(2025, 5, 21, 18, 0, 0) / 1000);      // shading, sun 11 degrees up
T = T + 600;
manual('WS_in');
check('paused in the evening', X.ST.manualDay === X.localDay(T));
failCover = true;
at(Date.UTC(2025, 5, 21, 18, 30, 0) / 1000);     // sunset, night position refused
failCover = false;
drives = [];
at(Date.UTC(2025, 5, 21, 18, 35, 0) / 1000);
check('the night position is repeated despite the earlier override',
      drives.length === 1 && drives[0].p.pos === X.CFG.nightPos, JSON.stringify(drives));

// A refusal that comes back after a newer command went out is not a retry.
kvs = null; X = boot();
T = WINTER;
deferCover = true;
ep('demand', 'v=1');             // tracking step A, its callback held back
ep('window', 'v=1');             // the cap, step B, held back as well
check('two commands in flight', pendingCbs.length === 2, 'n=' + pendingCbs.length);
const cbA = pendingCbs[0], cbB = pendingCbs[1];
pendingCbs = [];
deferCover = false;
cbB(null, 0);                    // B went through
cbA(null, -114, 'busy');         // A refused, late
check('the late refusal of the older command is ignored', X.ST.retry === null, JSON.stringify(X.ST.retry));

// ============================================================
group('manual operation, more conditions');
// A repeat is waiting when the wake call comes, so the day position is
// left pending. Then the person takes over.
kvs = null; X = boot();
at(MORNING);
X.ST.retry = { m: 'Cover.Open', p: { id: 0 }, t: T, track: false };
drives = [];
ep('wake', '');
check('the repeat goes first, the day position waits',
      drives.length === 1 && drives[0].m === 'Cover.Open' && X.ST.pendingDay === true, JSON.stringify(drives));
T = MORNING + 600;
manual('WS_in');
check('manual operation clears the pending day position', X.ST.pendingDay === false);
drives = [];
at(MORNING + 900);
check('nothing runs over it', drives.length === 0, JSON.stringify(drives));

// Another script on the same device is a second controller.
kvs = null; X = boot();
at(NOON);
T = NOON + 600;
manual('script:2');
check('another script counts as manual', X.ST.manualDay === X.localDay(T));
kvs = null; X = boot();
at(NOON);
T = NOON + 600;
manual('script:1');
check('our own id does not', X.ST.manualDay === -1);
manual('script');
check('nor a bare "script"', X.ST.manualDay === -1);

// ============================================================
group('startup without a clock');
// Power cut at noon on a released day, and the person straightens the blind
// by hand before NTP is back.
kvs = null; X = boot();
at(MORNING);
ep('wake', '');                  // the release is in flash
X = boot();                      // the power cut
T = 0; U = 100;
manual('button');
check('remembered by uptime', X.ST.manualUp === 100, 'manualUp=' + X.ST.manualUp);
check('and not dated yet', X.ST.manualDay === -1);
U = 400;
at(NOON);                        // the clock arrives five minutes later
check('dated on the first valid tick', X.ST.manualDay === X.localDay(NOON));
check('five minutes back', X.ST.manualTs === NOON - 300, 'ts=' + X.ST.manualTs);
check('and nothing is driven over it', drives.length === 0, JSON.stringify(drives));

// The same, but the clock arrives after midnight: the flag has expired.
kvs = null; X = boot();
T = 0; U = 100;
manual('button');
U = 400;
const PAST_MIDNIGHT = Date.UTC(2025, 5, 21, 22, 2, 0) / 1000;   // 00:02 local on the 22nd
at(PAST_MIDNIGHT);
check('a report from before midnight is not applied to the new day', X.ST.manualDay === -1,
      'manualDay=' + X.ST.manualDay);

// The alarm goes off while the clock is still missing.
kvs = null; X = boot();
T = 0;
const r0 = ep('wake', '');
check('wake without a clock is kept', X.ST.wakePending === true && r0.opened === false, JSON.stringify(r0));
check('and drives nothing yet', drives.length === 0);
at(MORNING);
check('applied on the first valid tick', X.ST.openedDay === X.localDay(T));
check('day position driven', drives.length === 1 && drives[0].p.pos === 100, JSON.stringify(drives));

// A kept wake call must not open the blind at night either.
kvs = null; X = boot();
T = 0;
ep('wake', '');
at(EVENING);
check('a kept wake call is dropped in the evening', X.ST.openedDay === -1 && drives.length === 0,
      JSON.stringify(drives));

// The first tick is retried every 15 s until the clock is valid.
kvs = null; X = boot();
T = 0;
const first = timers.find(x => !x.rep && x.ms === 15000);
timers = [];
first.f();                       // firstRun: self-check, then wait for the clock
check('without a clock a 15 s retry is armed', timers.length === 1 && timers[0].ms === 15000,
      JSON.stringify(timers.map(x => x.ms)));
T = NOON;
timers[0].f();
check('and the first tick runs once the clock is there', X.ST.phase !== null);

// ============================================================
group('wake in the evening with an empty store');
kvs = null; X = boot();
at(EVENING);
drives = [];
ep('wake', '');
check('ignored, nothing opens for the night', X.ST.openedDay === -1 && drives.length === 0,
      JSON.stringify(drives));

// ============================================================
group('tracking survives a restart');
kvs = null; X = boot();
at(NOON);
check('shading running', X.ST.active === true);
check('the active flag is in flash', kvs.indexOf('"a":true') >= 0, kvs);
// Power cut at noon, back at 18:30 local: the sun has left the sector, the
// end action is owed.
X = boot();                      // kvs kept
check('restored as active', X.ST.active === true);
at(D(16, 30));
check('the end action runs after the restart', drives.length === 1 && drives[0].m === 'Cover.Open',
      JSON.stringify(drives));
check('and the tracking is off', X.ST.active === false);

// Power cut at noon, back after sunset: the night position is owed.
kvs = null; X = boot();
at(NOON);
X = boot();
at(EVENING);
check('the night position is driven after the restart',
      drives.length === 1 && drives[0].p.pos === X.CFG.nightPos, JSON.stringify(drives));
at(EVENING + 300);
check('once', drives.length === 0, JSON.stringify(drives));

// A manual operation before the outage cleared the flag, nothing is owed.
kvs = null; X = boot();
at(NOON);
T = NOON + 600;
manual('WS_in');
X = boot();
check('a manual operation before the restart survives it',
      X.ST.active === false && X.ST.manualDay === X.localDay(T));
at(EVENING);
check('so nothing is driven', drives.length === 0, JSON.stringify(drives));

// ============================================================
group('endpoint values');
check('true/false/on/off are understood', X.qval('v=true', 'v') === 1 && X.qval('v=off', 'v') === 0);
check('plain numbers too',
      X.qval('v=0.7', 'v') === 0.7 && X.qval('v=-1', 'v') === -1 && X.qval('a=1&v=100', 'v') === 100);
check('garbage is null',
      X.qval('v=abc', 'v') === null && X.qval('v=', 'v') === null && X.qval('v=1.2.3', 'v') === null);
check('a missing key is null', X.qval('x=1', 'v') === null && X.qval(undefined, 'v') === null);
kvs = null; X = boot();
T = NOON;
let rd = ep('demand', 'v=on');
check('demand?v=on sets the demand', rd.demand === true, JSON.stringify(rd));
rd = ep('demand', 'v=abc');
check('demand?v=abc changes nothing and still answers', rd.demand === true, JSON.stringify(rd));

// ============================================================
group('error guard');
// A runtime error must not end the script. The endpoint still answers, the
// periodic tick still runs next time, and the step that was lost is taken
// then.
kvs = null; X = boot();
T = NOON;
throwCover = true;
let ok = true, rt = null;
try { rt = ep('demand', 'v=1'); } catch (e) { ok = false; }
check('an endpoint whose cycle throws still answers', ok && rt !== null && rt.demand === true, JSON.stringify(rt));
const periodic = timers.find(x => x.rep);
ok = true;
try { periodic.f(); } catch (e) { ok = false; }
check('a throwing tick is caught', ok);
throwCover = false;
drives = [];
periodic.f();
check('and the next tick takes the step that was lost', drives.length === 1, JSON.stringify(drives));
throwKvs = true;
let code = null;
ok = true;
try { eps.demand({ query: 'v=0' }, { send() { code = this.code; } }); } catch (e) { ok = false; }
throwKvs = false;
check('an endpoint that fails before answering answers 500', ok && code === 500, 'code=' + code);
ok = true;
try { onStatus({ component: 'cover:0', delta: { source: 42 } }); } catch (e) { ok = false; }
check('an odd status report is survived', ok);

// ============================================================
group('window contact and the pause');
kvs = null; X = boot();
X.CFG.fallbackMonths = [1];      // never shades in June without a report
at(NOON);
X.ST.lastMove = NOON;
ep('window', 'v=1');
check('with no tracking running the pause is left alone', X.ST.lastMove === NOON, 'lastMove=' + X.ST.lastMove);

// ============================================================
group('startup self-check');
const firstRun = () => timers.find(x => !x.rep && x.ms === 15000).f();
coverStatus = { pos_control: false };
kvs = null; X = boot(); logs = []; firstRun();
check('an uncalibrated cover is reported', logs.some(s => s.indexOf('not calibrated') >= 0), logs.join(' | '));
check('missing slat control is reported', logs.some(s => s.indexOf('slat control') >= 0));
coverStatus = null;
X = boot(); logs = []; firstRun();
check('a missing cover is reported', logs.some(s => s.indexOf('Cover profile') >= 0));
coverStatus = { pos_control: true, slat_pos: 0, current_pos: 100 };
coverConfig = { maxtime_open: 120, maxtime_close: 100 };
X = boot(); logs = []; firstRun();
check('a selfCmdSec below the travel time is reported', logs.some(s => s.indexOf('selfCmdSec') >= 0));
coverConfig = { maxtime_open: 60, maxtime_close: 60 };
X = boot(); logs = []; firstRun();
check('a healthy cover passes quietly', !logs.some(s => s.indexOf('CONFIG') >= 0), logs.join(' | '));

// ============================================================
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
