// Shrinks the world's time zone shapes into the small file the app bundles:
// public/alon/timezones.json.
//
// The source has about four million points. This keeps the shape of every
// border to within about 2 km with about a hundredth of that, and stores
// each border once even though two zones share it, so neighbours never gap or
// overlap.
//
// Usage: node alon-timezones-build.mjs <combined-with-oceans-now.json>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** Points snap to a grid of 1/GRID degrees: 0.01 degrees, about 1 km. */
export const GRID = 100;
/** How far a simplified border may stray, in grid units: about 2 km. */
const TOLERANCE = 1.5;
/** Shapes smaller than this (square degrees) are dropped. */
const MIN_AREA = 0.02;
/** Shapes at least this big get a label, and the biggest show from furthest. */
const LABEL_AREA = 25;
const BIG_LABEL_AREA = 400;

const SPAN_Y = 180 * GRID + 1;
const key = (x, y) => (x + 180 * GRID) * SPAN_Y + (y + 90 * GRID);
const keyX = (k) => Math.floor(k / SPAN_Y) - 180 * GRID;
const keyY = (k) => (k % SPAN_Y) - 90 * GRID;

/** One ring as grid keys, without repeats or there-and-back spikes. */
export function snapRing(coordinates) {
  const ring = [];
  for (const [lon, lat] of coordinates) {
    const k = key(Math.round(lon * GRID), Math.round(lat * GRID));
    if (ring[ring.length - 1] === k) continue;
    if (ring.length > 1 && ring[ring.length - 2] === k) ring.pop();
    else ring.push(k);
  }
  while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
  while (ring.length > 2 && ring[1] === ring[ring.length - 1]) {
    ring.shift();
    ring.pop();
  }
  return ring;
}

/**
 * Drop the points a line can lose without moving more than `tolerance`
 * (Douglas-Peucker). The two ends always stay.
 * @param {number[]} line Grid keys.
 */
export function simplifyLine(line, tolerance = TOLERANCE) {
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    const ax = keyX(line[from]);
    const ay = keyY(line[from]);
    const dx = keyX(line[to]) - ax;
    const dy = keyY(line[to]) - ay;
    const length2 = dx * dx + dy * dy;
    let worst = 0;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const px = keyX(line[i]) - ax;
      const py = keyY(line[i]) - ay;
      const along = length2
        ? Math.min(1, Math.max(0, (px * dx + py * dy) / length2))
        : 0;
      const distance2 = (px - along * dx) ** 2 + (py - along * dy) ** 2;
      if (distance2 > worst) {
        worst = distance2;
        at = i;
      }
    }
    if (at >= 0 && worst > tolerance * tolerance) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/** Twice the signed area of a closed ring of grid keys. */
function ringArea2(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += keyX(a) * keyY(b) - keyX(b) * keyY(a);
  }
  return sum;
}

function insideRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = keyX(ring[i]);
    const yi = keyY(ring[i]);
    const xj = keyX(ring[j]);
    const yj = keyY(ring[j]);
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** A point well inside a shape, for its label: the one furthest from any edge. */
function labelPoint(rings) {
  const [outer, ...holes] = rings;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const k of outer) {
    west = Math.min(west, keyX(k));
    east = Math.max(east, keyX(k));
    south = Math.min(south, keyY(k));
    north = Math.max(north, keyY(k));
  }
  // Labels near the poles are squashed and hard to read.
  south = Math.max(south, -60 * GRID);
  north = Math.min(north, 68 * GRID);
  const step = Math.max(GRID / 2, (east - west) / 48, (north - south) / 48);
  let best = null;
  for (let y = south + step / 2; y < north; y += step) {
    const squeeze = Math.cos((y / GRID) * (Math.PI / 180));
    for (let x = west + step / 2; x < east; x += step) {
      if (!insideRing(outer, x, y)) continue;
      if (holes.some((hole) => insideRing(hole, x, y))) continue;
      let nearest = Infinity;
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          const ax = (keyX(a) - x) * squeeze;
          const ay = keyY(a) - y;
          const dx = (keyX(b) - x) * squeeze - ax;
          const dy = keyY(b) - y - ay;
          const length2 = dx * dx + dy * dy;
          const along = length2
            ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length2))
            : 0;
          const distance2 = (ax + along * dx) ** 2 + (ay + along * dy) ** 2;
          if (distance2 < nearest) nearest = distance2;
          if (best && nearest <= best.room) break;
        }
        if (best && nearest <= best.room) break;
      }
      if (!best || nearest > best.room) best = { x, y, room: nearest };
    }
  }
  return best;
}

/**
 * @param {object} collection The source GeoJSON.
 * @returns {object} What the app loads.
 */
export function buildZones(collection) {
  const zones = [];
  const shapes = [];
  for (const feature of collection.features) {
    const zone = zones.push(feature.properties.tzid) - 1;
    const polygons =
      feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates;
    for (const polygon of polygons)
      shapes.push({ zone, rings: polygon.map(snapRing) });
  }

  // A point where three or more borders meet has to stay put, or the zones
  // around it would stop fitting together.
  const neighbours = new Map();
  const link = (a, b) => {
    const seen = neighbours.get(a);
    if (!seen) neighbours.set(a, [b]);
    else if (!seen.includes(b)) seen.push(b);
  };
  for (const { rings } of shapes)
    for (const ring of rings)
      for (let i = 0; i < ring.length; i++) {
        link(ring[i], ring[(i + 1) % ring.length]);
        link(ring[(i + 1) % ring.length], ring[i]);
      }
  const fixed = (k) => neighbours.get(k).length !== 2;

  // Cut every ring into the stretches between those points, and keep one copy
  // of each stretch however many rings use it.
  const arcs = [];
  const arcIndex = new Map();
  const arcRef = (stretch) => {
    const end = stretch.length - 1;
    const backwards =
      stretch[0] > stretch[end] ||
      (stretch[0] === stretch[end] && stretch[1] > stretch[end - 1]);
    const line = backwards ? stretch.slice().reverse() : stretch;
    const name = line.join(',');
    let index = arcIndex.get(name);
    if (index === undefined) {
      index = arcs.push(simplifyLine(line)) - 1;
      arcIndex.set(name, index);
    }
    return backwards ? ~index : index;
  };
  for (const shape of shapes) {
    shape.refs = shape.rings.map((ring) => {
      if (ring.length < 3) return [];
      let start = ring.findIndex(fixed);
      if (start < 0) start = ring.indexOf(Math.min(...ring));
      const turned = [...ring.slice(start), ...ring.slice(0, start), ring[start]];
      const refs = [];
      let from = 0;
      for (let i = 1; i < turned.length; i++) {
        if (i === turned.length - 1 || fixed(turned[i])) {
          refs.push(arcRef(turned.slice(from, i + 1)));
          from = i;
        }
      }
      return refs;
    });
  }

  const rebuilt = (refs) => {
    const ring = [];
    for (const ref of refs) {
      const arc = arcs[ref < 0 ? ~ref : ref];
      if (ref < 0) for (let i = arc.length - 1; i > 0; i--) ring.push(arc[i]);
      else for (let i = 0; i < arc.length - 1; i++) ring.push(arc[i]);
    }
    return ring;
  };
  const bigEnough = (refs) => {
    const ring = rebuilt(refs);
    return (
      ring.length >= 3 && Math.abs(ringArea2(ring)) / 2 / GRID ** 2 >= MIN_AREA
    );
  };

  const polygons = [];
  const labels = [];
  for (const { zone, refs } of shapes) {
    if (!refs[0].length || !bigEnough(refs[0])) continue;
    const kept = [refs[0], ...refs.slice(1).filter(bigEnough)];
    polygons.push([zone, kept]);
    const rings = kept.map(rebuilt);
    const area =
      rings.reduce(
        (sum, ring, i) => sum + (i ? -1 : 1) * Math.abs(ringArea2(ring)),
        0,
      ) /
      2 /
      GRID ** 2;
    if (area < LABEL_AREA) continue;
    const spot = labelPoint(rings);
    if (spot)
      labels.push([
        zone,
        Math.round(spot.x) / GRID,
        Math.round(spot.y) / GRID,
        area >= BIG_LABEL_AREA ? 0 : 1,
      ]);
  }

  // Renumber so the file holds only the borders that are still used.
  const renumber = new Map();
  const usedArcs = [];
  for (const [, rings] of polygons)
    for (const refs of rings)
      for (let i = 0; i < refs.length; i++) {
        const old = refs[i] < 0 ? ~refs[i] : refs[i];
        if (!renumber.has(old)) {
          renumber.set(old, usedArcs.length);
          usedArcs.push(arcs[old]);
        }
        refs[i] = refs[i] < 0 ? ~renumber.get(old) : renumber.get(old);
      }

  return {
    about:
      'Time zone shapes, simplified from timezone-boundary-builder ' +
      '(https://github.com/evansiroky/timezone-boundary-builder). ' +
      'Data (c) OpenStreetMap contributors, Open Database Licence (ODbL) 1.0.',
    grid: GRID,
    zones,
    // Each border: its first point, then the step to each next point.
    arcs: usedArcs.map((arc) => {
      const flat = [];
      let lastX = 0;
      let lastY = 0;
      for (const k of arc) {
        flat.push(keyX(k) - lastX, keyY(k) - lastY);
        lastX = keyX(k);
        lastY = keyY(k);
      }
      return flat;
    }),
    polygons,
    labels,
  };
}

if (process.argv[1]?.endsWith('alon-timezones-build.mjs')) {
  const source = process.argv[2];
  const built = buildZones(JSON.parse(readFileSync(source, 'utf8')));
  mkdirSync('public/alon', { recursive: true });
  const text = JSON.stringify(built);
  writeFileSync('public/alon/timezones.json', text);
  const points = built.arcs.reduce((sum, arc) => sum + arc.length / 2, 0);
  console.log(
    `${built.zones.length} zones, ${built.polygons.length} shapes, ` +
      `${built.arcs.length} borders, ${points} points, ` +
      `${built.labels.length} labels, ${Math.round(text.length / 1024)} KB`,
  );
}
