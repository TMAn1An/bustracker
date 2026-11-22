// Estimated arrival times at any point of a route, for both trips:
//   morning (to campus): interpolated between stops that have a pick-up time; otherwise departure time + distance / average speed
//   evening (from campus): campus departure time + distance back along the route / average speed
// The same logic runs in the app (js/feed.js → Feed.routeTimes); keep them in step.
import { prepRoute, project } from './_geo.js';

export const DEFAULT_KMH = 22, STOP_MIN = 0.5; // average bus speed in Dhaka traffic; dwell at each stop (minutes)
export const hm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };
export const fmtHM = min => (min == null ? null : `${String(Math.floor(((min % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(Math.round(((min % 60) + 60) % 60) % 60).padStart(2, '0')}`);

/** Stops (far end → campus) with their distance s along the route, plus a timing function for each trip. */
export function routeTimes(route, bus, campus) {
  const geo = prepRoute(route.geometry), L = geo.length;
  let minS = 0;
  const stops = [...route.stops, { ...campus, campus: true }].map((st, i, all) => {
    const s = i === all.length - 1 ? L : project(geo, st.lat, st.lng).s;
    const out = { ...st, s: Math.max(s, minS - 30) }; minS = Math.max(minS, out.s); return out;
  });
  const timed = stops.filter(x => !x.campus && hm(x.time) != null);
  let v = DEFAULT_KMH * 1000 / 60; // metres per minute
  if (timed.length >= 2) {
    const a = timed[0], b = timed[timed.length - 1], dt = hm(b.time) - hm(a.time);
    if (dt > 0 && b.s > a.s) v = Math.min(700, Math.max(250, (b.s - a.s) / dt)); // 15-42 km/h, from the real timetable
  }
  const dwell = (from, to) => STOP_MIN * stops.filter(x => !x.campus && x.s > from + 30 && x.s < to - 30).length;
  const dep = hm(bus?.depart_start ?? bus?.departStart), back = hm(bus?.depart_campus ?? bus?.departCampus);
  const am = s => {
    if (timed.length) {
      for (let i = 1; i < timed.length; i++) {
        const a = timed[i - 1], b = timed[i];
        if (s >= a.s && s <= b.s) return hm(a.time) + (hm(b.time) - hm(a.time)) * ((s - a.s) / ((b.s - a.s) || 1));
      }
      const f = timed[0], l = timed[timed.length - 1];
      return s < f.s ? hm(f.time) - (f.s - s) / v : hm(l.time) + (s - l.s) / v + dwell(l.s, s);
    }
    return dep == null ? null : dep + s / v + dwell(0, s);
  };
  const pm = s => (back == null ? null : back + (L - s) / v + dwell(s, L));
  return { geo, length: L, stops, v, am, pm };
}

/** Where a point lies on the route, how far it is from campus and when the bus should pass it (both trips). */
export function estimatePoint(rt, lat, lng) {
  const p = project(rt.geo, lat, lng);
  const extra = p.dist / rt.v;                       // off the line: assume the bus detours that far
  const beyondStart = p.s < 60 && p.dist > 150;       // past the first stop: the route would be extended, the bus passes it earlier
  const am = rt.am(p.s) == null ? null : rt.am(p.s) + (beyondStart ? -extra : extra), pm = rt.pm(p.s) == null ? null : rt.pm(p.s) + extra;
  const after = rt.stops.filter(x => x.s <= p.s).length; // stops before this point (0 = before the first stop)
  return {
    s: Math.round(p.s), off: Math.round(p.dist), kmToCampus: +((rt.length - p.s + p.dist) / 1000).toFixed(1),
    am: fmtHM(am), pm: fmtHM(pm), beyondStart,
    between: [rt.stops[after - 1]?.name || null, rt.stops[after]?.name || null],
  };
}
