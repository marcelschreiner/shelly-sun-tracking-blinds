# Shelly Sun Tracking Blinds

Autonomous venetian blind control as a Shelly script. The device computes the solar
position itself, derives the slat angle that blocks direct sunlight, and tracks it
through the day. No server, no broker, no cloud.

Tested on Shelly Gen2 and newer in the Cover profile.

## What it uses

| Input | Comes from | Effect |
|---|---|---|
| **Sun position** | computed on the device, from clock and coordinates | sets the slat angle |
| **Room temperature** | your smart home, via `/demand` | whether to shade at all |
| **Alarm clock** | your smart home, via `/wake` | releases the day, blind opens |
| **Window contact** | your smart home, via `/window` | blocks any downward travel |
| **Manual operation** | the button, app or web interface | pauses automation until midnight |

Only the sun position is required. Every other input is optional, has a fallback, and
reaches the device as a plain yes/no over HTTP. The Shelly stays the only controller:
**no schedule on your smart home platform may write to the same cover**, or the script
cannot tell an automation from a manual command and locks itself out for the day.

## Quick start

1. Enable the Cover profile and calibrate the blind
2. Enable slat control and set the tilt time
3. Under *Scripts*, create a new script and paste [`shading.js`](shading.js)
4. Adjust `CFG`, at minimum coordinates, `azimuth` and the slat dimensions
5. Run the [calibration](#calibration)
6. Start the script and enable *Run on startup*

## Calibration

The one step that cannot be computed. Two values must be measured, the slat angle at
each end of the tilt travel:

- `angAtPos0` — the angle at `slat_pos` 0
- `angAtPos100` — the angle at `slat_pos` 100

<img src="docs/calibration.svg" alt="Slat angle at both mechanical end positions" width="620">

Drive `slat_pos` to each end in the web interface, lay a phone with a spirit level app flat on a slat and read off the angle. Positive means the room-side edge points up, negative values are fine.

Do not assume `slat_pos` 0 is the closed side. It is a percentage of the tilt travel, not an angle, and the polarity depends on the wiring.

## Configuration

All settings live in the `CFG` block at the top of the script. Only some are checked
when it starts: the slat dimensions, the two calibration points, `stepDeg`, the
tolerances and the coordinates. The rest are trusted, and an out of range value simply
behaves oddly rather than failing loudly.

### Location and window

<img src="docs/window-sector.svg" alt="Window orientation and direction tolerance, plan view" width="580">

| Parameter | Meaning | Unit | Range | Default |
|---|---|---|---|---|
| `lat` | Latitude | ° | −90…90 | — |
| `lon` | Longitude | ° | −180…180 | — |
| `azimuth` | Window facing direction, 0=N, 90=E, 180=S, 270=W | ° | 0…360 | `180` |
| `tolStart` / `tolEnd` | Direction tolerance as the sun enters and leaves | ° | 0…90 | `85` |
| `minElev` | Minimum solar elevation for shading | ° | 0…90 | `5` |
| `coverId` | Only relevant on devices with two covers | — | 0…1 | `0` |

### Slats and tracking

<img src="docs/slat-geometry.svg" alt="Slat width, slat distance, profile angle and cut-off angle" width="420">

| Parameter | Meaning | Unit | Range | Default |
|---|---|---|---|---|
| `slats` | `false` for roller shutters without slats | — | true / false | `true` |
| `slatWidth` / `slatDist` | Slat width `w` and distance `d` | mm | > 0 | `70` / `60` |
| `angAtPos0` / `angAtPos100` | Measured end angles, see [calibration](#calibration) | ° | −90…90 | `80` / `-10` |
| `stepDeg` | Angular step of the tracking | ° | > 0 | `15` |
| `intervalMin` | Minimum pause between movements, start and end included | min | ≥ 0 | `20` |
| `mode` | 0 = maximum daylight, 1 = maximum cooling | — | 0…1 | `1` |
| `coolExtra` | Extra slat degrees towards closed in mode 1 | ° | ≥ 0 | `20` |
| `shadePos` | Curtain position while shading | % | 0…100 | `0` |
| `endAction` | 0=nothing, 1=open, 2=close, 3=slats horizontal | — | 0…3 | `1` |
| `endSkipDeg` | End action skipped this close to `dayNightElev`, keep above `minElev` | ° | ≥ 0 | `8` |

### Day and night

| Parameter | Meaning | Unit | Range | Default |
|---|---|---|---|---|
| `dayTrigger` | `"sun"` = sunrise, `"cmd"` = wait for a wake call | — | sun / cmd | `"cmd"` |
| `dayFallbackHour` | Opens at this local hour if no wake call arrives | h | 0…23 | `9` |
| `wakeAlwaysOpen` | `true` = always fully open on wake | — | true / false | `false` |
| `sunsetAction` | Close at sunset | — | true / false | `true` |
| `dayPos` / `daySlat` | Day position | % | 0…100 | `100` / `100` |
| `nightPos` / `nightSlat` | Night position | % | 0…100 | `0` / `0` |
| `dayNightElev` | Day/night switch. Negative closes later, `-4` ≈ civil twilight | ° | −18…90 | `0` |

### Heat demand and system

| Parameter | Meaning | Unit | Range | Default |
|---|---|---|---|---|
| `demandMaxAgeH` | Age at which the heat demand counts as lost | h | > 0 | `24` |
| `fallbackMonths` | Months that shade without a valid demand | — | 1…12 | `[4..9]` |
| `tickSec` | Cycle time | s | > 0 | `300` |
| `selfCmdSec` | Window in which a cover report still counts as our own command | s | ≥ 0 | `90` |
| `debug` | Output to the script console | — | true / false | `true` |

## HTTP endpoints

| Call | Effect |
|---|---|
| `/script/1/demand?v=1` / `?v=0` | Too warm / back to normal |
| `/script/1/wake` | Release the day |
| `/script/1/window?v=1` / `?v=0` | Window open / closed |
| any of them without `?v=` | Read status only |

The `1` is a placeholder: it is the script's ID, the number the Shelly gives it in the
script list. Use `1` if this is the only script on the device, otherwise your own number.

Each one answers with the current state as JSON and triggers a cycle immediately, so there is no wait until the next tick.

## Smart home integration

Examples are Apple Home; the principle holds anywhere. Join the Shelly over Matter and drive the endpoints from your automations.

**Room temperature.** Two automations per room: above the upper threshold call
`demand?v=1`, below the lower one `demand?v=0`. The hysteresis therefore lives in the
app and can differ per room. In Apple Home use *Convert to Shortcut* and *Get Contents
of URL*, which runs on the home hub without a phone.

**Window contact.** One automation per window, opened and closed. Any sensor the
platform can read will do. Shelly BLU sensors need a bridge such as Matterbridge or
Homebridge, they cannot join Apple Home directly.

**Alarm clock.** A personal shortcut automation on *When my alarm is stopped*, calling
`/wake`, with *Ask Before Running* off. This one runs on the phone; a fixed-time home
automation works too but loses the link to the actual alarm.

## How it works

**Solar position.** NOAA approximation from the device unix time, below 0.01 degrees of
error, verified against the theoretical solstice elevations.

**Slat angle.** The profile angle `p` is the sun's apparent angle in the window plane,
from `h` (elevation) and `γ` (azimuth minus window orientation). The cut-off angle `β`
is the flattest slat angle that still shades, see the
[diagram](#slats-and-tracking) above:

```
p = atan( tan(h) / cos(γ) )      sin(β + p) = (d / w) · cos(p)
```

If `d > w` the blind never closes tightly and the script clamps to the steepest value
it can reach.

**Rounding.** Always towards closed, in steps of `stepDeg`. Rounding to the nearest
step would let a stripe of sun through on every second step; rounding one way also
leaves half a step of margin for the mechanical play of the blind.

**When it shades.** Only when all of it holds: no manual override, day released, heat
demand active, window closed, sun inside the sector and above `minElev`.

### Window guard

A blind travelling down into a tilted casement runs its bottom rail into the frame or
the handle. While the window is open, no command that lowers the blind is issued:

- shading does not start, and a running tracking ends
- the sunset position is held back, then driven as soon as the window closes
- of the end actions only `endAction: 1` still runs, because it travels up

Upward movements stay allowed. A contact that was never reported blocks nothing, so a
setup without one behaves as before. If you set `dayPos` to something other than fully
up, that movement is not gated.

### Day cycle

```mermaid
stateDiagram-v2
    [*] --> Night
    Night --> Day_locked: sunrise
    Day_locked --> Day_open: /wake or dayFallbackHour
    Day_open --> Shading: sun in sector<br/>and too warm
    Shading --> Day_open: sun gone<br/>or cool enough
    Day_open --> Manual: manual operation
    Shading --> Manual: manual operation
    Manual --> Night: sunset
    Day_open --> Night: sunset
    Shading --> Night: sunset
    Night --> Night: local midnight<br/>clears both flags
```

`Day_locked` exists only with `dayTrigger: "cmd"`. The blind stays down and shading
stays off, so the morning sun cannot wake anyone. With `"sun"` the state is skipped.

Manual override and day release are stored as local day numbers, not booleans, so they
expire at midnight on their own and survive a reboot without going stale. Three
consequences:

- A wake call after sunset does nothing, the day was already released that morning. One
  before sunrise still works, which is what a winter alarm needs.
- Manual operation below `dayNightElev` does not pause anything. Otherwise adjusting
  the blind at three in the morning would block the whole coming day.
- A wake call while shading is already due skips the day position, instead of
  travelling up and back down seconds later.

## Autonomy

A single device keeps working when everything else fails.

| Failure | Behaviour |
|---|---|
| Network, hub or phone gone | Shading continues, only without a current heat demand |
| Heat demand older than `demandMaxAgeH` | Falls back to `fallbackMonths`, the season decides |
| No wake call arrives | Opens at `dayFallbackHour` at the latest |
| Power loss | Override, heat demand, day release and window state restored from KVS |
| Clock synchronises late after boot | Restored heat demand is stamped on the first valid tick |
| No valid clock after boot | Tracking pauses instead of driving to a wrong position |
| Window contact stops reporting while open | Blind stays up. No season to fall back on, so it errs towards not moving; `window?v=0` clears it |

## Notes on the code

**Flash wear.** The ESP32 tolerates roughly 100,000 writes per sector. Only what cannot
be derived again is persisted: override day, heat demand, day release, window state.
`saveState()` compares against the last written content, which turns several hundred
writes a day into a handful. Everything else lives in RAM.

**mJS is not full JavaScript.** Only `sin`, `cos`, `floor`, `ceil`, `round`, `min`,
`max`, `pow`, `exp`, `log` and `random` exist, so `atan2`, `atan`, `asin`, `tan`, `sqrt`
and `PI` are implemented in the script. And the stack is small: nested expressions
overflow it, which is why everything is deliberately flat and uses intermediate
variables. It looks clumsy, and it is the reason the script runs at all.

## Tests

`shading.js` runs unmodified under node, against a stub of the Shelly runtime and a
virtual clock.

```bash
node test/run.js
```

Covers the solar position against the theoretical solstice elevations, the day release,
manual override and wake behaviour, the window guard, what survives a reboot, and the
flash write budget.

## License

MIT, see [LICENSE](LICENSE).
