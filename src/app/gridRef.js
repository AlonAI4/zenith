/**
 * British National Grid references, such as "TQ 30047 79951", from GPS
 * latitude and longitude: the grid Ordnance Survey maps use.
 *
 * Two steps, as Ordnance Survey's own guide describes them: a Helmert
 * transformation from the GPS (WGS84) Earth shape to the British one (OSGB36,
 * on the Airy 1830 ellipsoid), good to about five metres, then the Transverse
 * Mercator projection to eastings and northings in metres.
 */

const RAD = Math.PI / 180;
const WGS84 = { a: 6378137, b: 6356752.314245 };
const AIRY = { a: 6377563.396, b: 6356256.909 };
/** WGS84 to OSGB36: shifts in metres, scale in parts per million, turns in seconds of arc. */
const HELMERT = {
  tx: -446.448,
  ty: 125.157,
  tz: -542.06,
  s: 20.4894,
  rx: -0.1502,
  ry: -0.247,
  rz: -0.8421,
};
const F0 = 0.9996012717;
const LAT0 = 49 * RAD;
const LON0 = -2 * RAD;
const E0 = 400000;
const N0 = -100000;

function toCartesian(lat, lon, { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const sinLat = Math.sin(lat);
  const nu = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  return [
    nu * Math.cos(lat) * Math.cos(lon),
    nu * Math.cos(lat) * Math.sin(lon),
    (1 - e2) * nu * sinLat,
  ];
}

function toLatLon([x, y, z], { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return [lat, Math.atan2(y, x)];
}

function helmert([x, y, z]) {
  const { tx, ty, tz, s, rx, ry, rz } = HELMERT;
  const k = 1 + s / 1e6;
  const [r1, r2, r3] = [rx, ry, rz].map((v) => (v / 3600) * RAD);
  return [
    tx + k * x - r3 * y + r2 * z,
    ty + r3 * x + k * y - r1 * z,
    tz - r2 * x + r1 * y + k * z,
  ];
}

/**
 * Eastings and northings in metres from OSGB36 latitude and longitude (in
 * radians), by Ordnance Survey's Transverse Mercator formulas.
 */
export function osgbToGrid(lat, lon) {
  const { a, b } = AIRY;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const tan = Math.tan(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const eta2 = nu / rho - 1;
  const dLat = lat - LAT0;
  const sLat = lat + LAT0;
  const M =
    b *
    F0 *
    ((1 + n + (5 / 4) * n ** 2 + (5 / 4) * n ** 3) * dLat -
      (3 * n + 3 * n ** 2 + (21 / 8) * n ** 3) *
        Math.sin(dLat) *
        Math.cos(sLat) +
      ((15 / 8) * n ** 2 + (15 / 8) * n ** 3) *
        Math.sin(2 * dLat) *
        Math.cos(2 * sLat) -
      (35 / 24) * n ** 3 * Math.sin(3 * dLat) * Math.cos(3 * sLat));
  const I = M + N0;
  const II = (nu / 2) * sin * cos;
  const III = (nu / 24) * sin * cos ** 3 * (5 - tan ** 2 + 9 * eta2);
  const IIIA = (nu / 720) * sin * cos ** 5 * (61 - 58 * tan ** 2 + tan ** 4);
  const IV = nu * cos;
  const V = (nu / 6) * cos ** 3 * (nu / rho - tan ** 2);
  const VI =
    (nu / 120) *
    cos ** 5 *
    (5 - 18 * tan ** 2 + tan ** 4 + 14 * eta2 - 58 * tan ** 2 * eta2);
  const dLon = lon - LON0;
  return {
    easting: E0 + IV * dLon + V * dLon ** 3 + VI * dLon ** 5,
    northing: I + II * dLon ** 2 + III * dLon ** 4 + IIIA * dLon ** 6,
  };
}

/** Eastings and northings in metres from GPS latitude and longitude in degrees. */
export function wgs84ToGrid(latDeg, lonDeg) {
  const [lat, lon] = toLatLon(
    helmert(toCartesian(latDeg * RAD, lonDeg * RAD, WGS84)),
    AIRY,
  );
  return osgbToGrid(lat, lon);
}

/**
 * "TQ 30047 79951" for a spot in Great Britain, to the metre, or null for a
 * spot outside the grid.
 */
export function gridReference(latDeg, lonDeg) {
  if (
    !Number.isFinite(latDeg) ||
    !Number.isFinite(lonDeg) ||
    latDeg < 49.7 ||
    latDeg > 61.1 ||
    lonDeg < -9 ||
    lonDeg > 2.1
  )
    return null;
  // The grid's box also covers northern France and Ireland, which have
  // grids of their own.
  if (lonDeg > 1.5 && latDeg < 51.25) return null;
  if (latDeg > 51.3 && latDeg < 55.25 && lonDeg < -5.42) return null;
  const { easting, northing } = wgs84ToGrid(latDeg, lonDeg);
  if (!(
    easting >= 0 &&
    easting < 700000 &&
    northing >= 0 &&
    northing < 1300000
  ))
    return null;
  const e100k = Math.floor(easting / 100000);
  const n100k = Math.floor(northing / 100000);
  let first = 19 - n100k - ((19 - n100k) % 5) + Math.floor((e100k + 10) / 5);
  let second = (((19 - n100k) * 5) % 25) + (e100k % 5);
  // The grid's letters skip I.
  if (first > 7) first += 1;
  if (second > 7) second += 1;
  const digits = (value) => String(Math.floor(value) % 100000).padStart(5, '0');
  return `${String.fromCharCode(65 + first, 65 + second)} ${digits(easting)} ${digits(northing)}`;
}
