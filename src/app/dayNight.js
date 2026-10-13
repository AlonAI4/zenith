import * as Cesium from 'cesium';
import { guard } from './addOns.js';

/**
 * Day and night: the night side of the Earth is shaded, city lights show on
 * it, and a line marks where the sun is on the horizon.
 *
 * The sun's place is worked out here from the real time (the same clock the
 * local-time card uses), because the map's own clock does not tick. Both map
 * surfaces are shaded the same way, by a small shader that darkens each pixel
 * by where the sun is and adds the lights: on the 3D map it is attached to
 * the 3D tiles, on the satellite map to the globe. The globe's own sun
 * lighting is not used: it dims the lights as well, and behaves differently
 * with and without detailed terrain.
 *
 * Close to the ground the shading is kept mild so the map stays readable, and
 * the lights fade: the lights picture is too coarse to mean anything there.
 */

const STORAGE_KEY = 'gev.dayNight';
const LIGHTS_URL = '/alon/night-lights.webp';
const CREDIT = 'Night lights: NASA Earth Observatory (Black Marble 2016)';
const SUN_EVERY_MS = 30_000;
const SURFACE_EVERY_MS = 1000;

const rad = (degrees) => (degrees * Math.PI) / 180;
const deg = (radians) => (radians * 180) / Math.PI;
const turn = (degrees) => ((degrees % 360) + 360) % 360;

/**
 * The spot where the sun is straight overhead at this moment.
 * The usual short formulas, good to a few hundredths of a degree.
 * @param {number|Date} [date] Milliseconds since 1970, or a Date.
 * @returns {{ lat: number, lon: number }} Degrees.
 */
export function subsolarPoint(date = Date.now()) {
  const days = Number(date) / 86_400_000 - 10_957.5; // since 1 Jan 2000, 12:00 UTC
  const meanLongitude = turn(280.46 + 0.9856474 * days);
  const anomaly = rad(turn(357.528 + 0.9856003 * days));
  const ecliptic = rad(
    meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly),
  );
  const tilt = rad(23.439 - 0.0000004 * days);
  const declination = Math.asin(Math.sin(tilt) * Math.sin(ecliptic));
  const rightAscension = Math.atan2(
    Math.cos(tilt) * Math.sin(ecliptic),
    Math.cos(ecliptic),
  );
  const greenwich = turn(280.46061837 + 360.98564736629 * days);
  const lon = turn(deg(rightAscension) - greenwich + 180) - 180;
  return { lat: deg(declination), lon };
}

/** Unit vector from the Earth's centre toward a point, in Earth-fixed axes. */
export function directionTo({ lat, lon }) {
  const cosLat = Math.cos(rad(lat));
  return [
    cosLat * Math.cos(rad(lon)),
    cosLat * Math.sin(rad(lon)),
    Math.sin(rad(lat)),
  ];
}

/**
 * Sine of the sun's height above the horizon at a place. Above 0 is day.
 * @param {number} lat
 * @param {number} lon
 * @param {{ lat: number, lon: number }} sub The subsolar point.
 */
export function sunHeight(lat, lon, sub) {
  const here = directionTo({ lat, lon });
  const sun = directionTo(sub);
  return here[0] * sun[0] + here[1] * sun[1] + here[2] * sun[2];
}

/** Day, twilight (sun up to 6 degrees under the horizon) or night. */
export function partOfDay(lat, lon, sub) {
  const height = sunHeight(lat, lon, sub);
  if (height > 0) return 'day';
  return height > Math.sin(rad(-6)) ? 'twilight' : 'night';
}

/**
 * How strong the night look is from this camera height.
 * `floor` is how bright the night side stays (1 is full daylight) and `glow`
 * is how bright the city lights are.
 */
export function nightLook(heightM) {
  // Heights as powers of ten in metres: 5 is 100 km, 6.3 is about 2,000 km.
  const at = Math.log10(Math.max(1, heightM));
  const ease = (from, to) => {
    const t = Math.min(1, Math.max(0, (at - from) / (to - from)));
    return t * t * (3 - 2 * t);
  };
  return {
    floor: 0.38 - 0.32 * ease(5, 6.3),
    // The lights picture only resolves about 11 km, so it is for views of a
    // whole country or more: it fades between 3,000 km and 300 km up.
    glow: 2.2 * ease(5.48, 6.48),
  };
}

/** Shared by both shaders: daylight, the dusk line and the lights at a point. */
const NIGHT_GLSL = `
const vec3 ZENITH_DUSK = vec3(1.0, 0.62, 0.3);
float zenithDaylight(float sunHeight) {
  return smoothstep(-0.12, 0.10, sunHeight);
}
// The line where the sun is on the horizon, about a pixel and a half wide at
// any zoom. Drawn here, not as a line on the ground: ground lines over the 3D
// buildings cost the map a quarter of its speed.
float zenithDuskLine(float sunHeight) {
  float width = max(fwidth(sunHeight) * 1.5, 4.0e-7);
  return (1.0 - smoothstep(0.0, width, abs(sunHeight))) * 0.85;
}
vec3 zenithLights(vec3 p, sampler2D picture) {
  float lon = atan(p.y, p.x);
  float lat = atan(p.z, length(p.xy) * 0.99330562);
  vec2 uv = vec2(lon / 6.28318530718 + 0.5, lat / 3.14159265359 + 0.5);
  // One pixel of the picture is about 11 km, so a town is a single bright
  // pixel. Read plainly it shows as a hard square from closer in; this
  // smoother read (a cubic spline over four samples) makes it a soft glow.
  vec2 size = vec2(3600.0, 1800.0);
  vec2 st = uv * size - 0.5;
  vec2 cell = floor(st);
  vec2 f = st - cell;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = 1.0 - g0;
  vec2 h0 = (cell - 0.5 + w1 / g0) / size;
  vec2 h1 = (cell + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * texture(picture, vec2(h0.x, h0.y)).rgb + g1.x * texture(picture, vec2(h1.x, h0.y)).rgb) +
    g1.y * (g0.x * texture(picture, vec2(h0.x, h1.y)).rgb + g1.x * texture(picture, vec2(h1.x, h1.y)).rgb);
}`;

// Both shaders stop early in full daylight, and read the lights picture only
// when the lights are showing: on every pixel of every frame, skipped work
// counts.
const TILES_SHADER = `${NIGHT_GLSL}
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  // From eye coordinates: the tiles' own world position is too coarse here,
  // and makes the lights blocky.
  vec3 p = (czm_inverseView * vec4(fsInput.attributes.positionEC, 1.0)).xyz;
  float sunHeight = dot(normalize(p), u_sun);
  float line = zenithDuskLine(sunHeight);
  float day = zenithDaylight(sunHeight);
  if (day > 0.999) return;
  vec3 night = material.diffuse * u_floor * vec3(0.6, 0.75, 1.0);
  if (u_glow > 0.0) night += zenithLights(p, u_lights) * u_glow;
  material.diffuse = mix(mix(night, material.diffuse, day), ZENITH_DUSK, line);
}`;

// Drawn over the globe's pictures: see-through by day, dark with lights by night.
const GLOBE_SHADER = `${NIGHT_GLSL}
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec3 p = (czm_inverseView * vec4(-materialInput.positionToEyeEC, 1.0)).xyz;
  float sunHeight = dot(normalize(p), sunDir);
  float line = zenithDuskLine(sunHeight);
  float day = zenithDaylight(sunHeight);
  material.diffuse = vec3(0.0, 0.01, 0.03);
  material.alpha = 0.0;
  if (day > 0.999) return material;
  if (nightGlow > 0.0) material.diffuse += zenithLights(p, lightsImage) * nightGlow;
  material.diffuse = mix(material.diffuse, ZENITH_DUSK, line);
  material.alpha = max((1.0 - day) * (1.0 - nightFloor), line);
  return material;
}`;

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>';

function readSaved() {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function save(on) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // Private windows can refuse storage; the switch still works this visit.
  }
}

/**
 * @param {{ viewer: Cesium.Viewer, tileset?: object }} scene
 * @param {Document} [doc]
 * @returns {() => void} Removes the layer, the switch and the timers.
 */
export function installDayNight({ viewer, tileset }, doc = document) {
  const { scene } = viewer;
  const { globe } = scene;
  let on = readSaved();
  let sub = subsolarPoint();
  let sunAt = 0;
  let shader = null;
  let globeMaterial = null;
  const credit = new Cesium.Credit(CREDIT, true);

  const sunVector = () => Cesium.Cartesian3.fromArray(directionTo(sub));

  const litGlobe = () => {
    // Never replace a look some other part of the app gave the globe.
    if (globe.material && globe.material !== globeMaterial) return;
    globeMaterial ||= new Cesium.Material({
      fabric: {
        type: 'ZenithDayNight',
        uniforms: {
          sunDir: sunVector(),
          lightsImage: LIGHTS_URL,
          nightFloor: 0.06,
          nightGlow: 2.2,
        },
        source: GLOBE_SHADER,
      },
    });
    if (globe.material !== globeMaterial) globe.material = globeMaterial;
  };

  const plainGlobe = () => {
    if (globeMaterial && globe.material === globeMaterial) {
      globe.material = undefined;
    }
  };

  const shadedTiles = () => {
    if (!tileset || tileset.isDestroyed?.()) return;
    if (!shader) {
      shader = new Cesium.CustomShader({
        uniforms: {
          u_sun: { type: Cesium.UniformType.VEC3, value: sunVector() },
          u_floor: { type: Cesium.UniformType.FLOAT, value: 0.06 },
          u_glow: { type: Cesium.UniformType.FLOAT, value: 2.2 },
          u_lights: {
            type: Cesium.UniformType.SAMPLER_2D,
            value: new Cesium.TextureUniform({
              url: LIGHTS_URL,
              repeat: false,
              minificationFilter: Cesium.TextureMinificationFilter.LINEAR,
              magnificationFilter: Cesium.TextureMagnificationFilter.LINEAR,
            }),
          },
        },
        fragmentShaderText: TILES_SHADER,
      });
    }
    if (tileset.customShader !== shader) tileset.customShader = shader;
  };

  const plainTiles = () => {
    if (
      tileset &&
      !tileset.isDestroyed?.() &&
      tileset.customShader === shader
    ) {
      tileset.customShader = undefined;
    }
  };

  // The map can change under us (satellite globe <-> 3D buildings).
  const syncSurface = () => {
    if (viewer.isDestroyed()) return;
    if (!on) {
      const stale =
        (globeMaterial && globe.material === globeMaterial) ||
        (shader && tileset?.customShader === shader);
      plainGlobe();
      plainTiles();
      if (stale) scene.requestRender();
      return;
    }
    if (globe.show === true) {
      litGlobe();
      plainTiles();
    } else {
      plainGlobe();
      shadedTiles();
    }
  };

  const syncSun = () => {
    sub = subsolarPoint();
    sunAt = Date.now();
    shader?.setUniform('u_sun', sunVector());
    if (globeMaterial) globeMaterial.uniforms.sunDir = sunVector();
    scene.requestRender();
  };

  // Every frame: match the strength to how far out the camera is.
  const syncLook = () => {
    if (!on) return;
    const look = nightLook(viewer.camera.positionCartographic?.height ?? 1e7);
    shader?.setUniform('u_floor', look.floor);
    shader?.setUniform('u_glow', look.glow);
    if (globeMaterial) {
      globeMaterial.uniforms.nightFloor = look.floor;
      globeMaterial.uniforms.nightGlow = look.glow;
    }
  };

  const apply = () => {
    if (on) {
      viewer.creditDisplay.addStaticCredit(credit);
      syncSurface();
      syncSun();
    } else {
      syncSurface();
      viewer.creditDisplay.removeStaticCredit(credit);
      scene.requestRender();
    }
  };

  // Runs when off as well: another layer can hand the globe back our shader
  // after the switch was turned off, and it must not stay.
  const surfaceTimer = setInterval(() => {
    syncSurface();
    if (on && Date.now() - sunAt >= SUN_EVERY_MS) syncSun();
  }, SURFACE_EVERY_MS);
  const removeLook = scene.preRender.addEventListener(
    guard('Day and night', syncLook),
  );

  const button = doc.createElement('button');
  button.id = 'day-night-toggle';
  button.type = 'button';
  button.innerHTML = ICON;
  button.setAttribute('aria-label', 'Day and night');
  const paint = () => {
    button.setAttribute('aria-pressed', String(on));
    button.title = on
      ? 'Hide day and night'
      : 'Shade the night side of the Earth, with city lights';
  };
  button.addEventListener('click', () => {
    on = !on;
    save(on);
    paint();
    apply();
  });
  paint();
  doc.getElementById('top-center-actions')?.appendChild(button);
  if (on) apply();

  return () => {
    on = false;
    clearInterval(surfaceTimer);
    removeLook();
    apply();
    button.remove();
  };
}
