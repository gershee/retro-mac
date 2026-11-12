// RetroTime (web/panels.js): agenda clocks follow the server's time zone, not the browser's. Needs node.
//   TZ=America/Los_Angeles node tests/test_time.js       (run_all.py runs it with a browser zone != server zone)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {}, console, Intl, Date, Math, String, Number, Object, Array, JSON };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'panels.js'), 'utf8'), ctx);
const RT = ctx.window.RetroTime;
let fails = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`));
};
const t = Date.parse('2026-11-12T15:05:00Z');          // 10:05 AM in New York, 7:05 AM in Los Angeles
RT.setTz('America/New_York');
check('clock in server zone', RT.clock(t), '10:05A');
check('hour label', RT.hr(t), '10A');
check('weekday', RT.parts(t).dow, 4);
check('day start = local midnight', new Date(RT.dayStart(t)).toISOString(), '2026-11-12T05:00:00.000Z');
check('same day across UTC midnight', RT.sameDay(t, Date.parse('2026-11-13T04:30:00Z')), true);
check('next day', RT.sameDay(t, Date.parse('2026-11-13T05:30:00Z')), false);
RT.setTz('Asia/Tokyo');
check('switch zone', RT.clock(t), '12:05A');
RT.setTz('Not/AZone');
check('unknown zone keeps the last good one', RT.clock(t), '12:05A');
RT.setTz('America/New_York');
const nowMs = Date.parse('2026-11-12T16:00:00Z');      // 11:00 AM New York
check('weather 30 min old: no stamp', RT.asOf(nowMs / 1000 - 30 * 60, nowMs), '');
check('weather 46 min old: AS OF', RT.asOf(nowMs / 1000 - 46 * 60, nowMs), 'AS OF 10:14A');
check('weather without at: no stamp', RT.asOf(undefined, nowMs), '');
console.log('FAILURES:', fails);
process.exit(fails ? 1 : 0);
