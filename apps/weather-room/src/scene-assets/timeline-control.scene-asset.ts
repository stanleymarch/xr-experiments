/**
 * WEATHER//ROOM timeline control — reusable deterministic parentless Object3D.
 *
 * A premium exhibition instrument for scrubbing the weather playhead:
 * one continuous chamfered/sloped satin-metal housing, a polished ceramic
 * bezel with an inset dark-glass travel channel, a luminous cyan light
 * guide with a strong NOW→playhead segment, readable tick marks, floating
 * -24 / NOW / +24 signposts, and an enlarged lathed fingertip knob (collar +
 * dished crown + glow ring in the negative space between them) that reads
 * at ~0.8 m over bright passthrough.
 *
 * Contract (all units meters):
 * - +Y up, front face toward +Z, knob travels local X in [-0.45, +0.45]
 *   (maps to playhead hours [-24, +24]).
 * - Origin: center of the housing on the rail axis (y = 0 mid-height,
 *   z = 0 mid-depth).
 * - Envelope: x ±0.48, y [-0.037, +0.09] incl. signposts,
 *   z [-0.024, +0.06] incl. the knob crown.
 * - Articulation: group `TimeKnob` (TimelineSystem renames the clone to
 *   `Weather Timeline Handle`) translates along local X; its origin is the
 *   grip center so OneHandGrabbable/DistanceGrabbable pivot at the crown.
 *   Rest pose: (x, 0, TIMELINE_KNOB_REST_Z).
 * - Named parts: Housing, SlotBezel, SlotFloor, LightGuideBase,
 *   LightGuideFill, TickMarks, NowMarker, EndPointPast, EndPointFuture,
 *   SignpostPast, SignpostNow, SignpostFuture,
 *   TimeKnob/{KnobCollar, KnobCrown, KnobGlowRing}.
 * - State feedback: TimelineSystem clones the materials of KnobGlowRing,
 *   KnobCrown and LightGuideFill once after instantiation and animates
 *   emissiveIntensity/opacity on hover/grab. All other materials stay
 *   shared with this prototype.
 * - No transmission/refraction anywhere: the channel glass is a glossy
 *   low-roughness standard material, safe for passthrough MR.
 *
 * Signposts are deterministic authored stroke glyphs (merged hairline
 * geometry in the tick language) — no canvas, no DOM, no font files, so the
 * prototype evaluates identically in the editor and application realms.
 * Brand typography stays with the real UIKit/HUD surfaces, not this model.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  TorusGeometry,
  Vector2,
} from '@iwsdk/core';
import type { Object3D } from '@iwsdk/core';
import { bevelBox } from './lib/hardsurface.js';

// -- Public contract ----------------------------------------------------------

export const TIMELINE_CONTROL_ASSET_ID = 'timeline-control';
export const TIMELINE_KNOB_PART = 'TimeKnob';
/** Knob travel half-range along local X; maps to playhead hours ±24. */
export const TIMELINE_TRAVEL_HALF = 0.45;
/** Knob rest Z (grip center) relative to the model origin. */
export const TIMELINE_KNOB_REST_Z = 0.0416;

// -- Site palette (staniverse.xyz tokens) --------------------------------------

const GROUND = 0x060b18;
const SURFACE = 0x0d1930;
const INK = 0xeef5ff;
const MUTED = 0x94aac8;
const ACCENT = 0x79d7f2;

// -- Materials (module singletons, shared by every clone) ----------------------

const materials = {
  /** Satin blue-steel housing. */
  housing: new MeshStandardMaterial({
    color: 0x182a47,
    metalness: 0.88,
    roughness: 0.34,
  }),
  /** Satin ceramic bezel ring around the channel. */
  bezel: new MeshStandardMaterial({
    color: SURFACE,
    metalness: 0.25,
    roughness: 0.48,
  }),
  /** Dark glass channel floor — glossy approximation, no transmission. */
  glass: new MeshStandardMaterial({
    color: GROUND,
    metalness: 0.55,
    roughness: 0.14,
    envMapIntensity: 1.2,
  }),
  /** Light-guide hairline — lifted to survive bright passthrough. */
  guideBase: new MeshBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0.45,
    blending: AdditiveBlending,
    depthWrite: false,
  }),
  /** Luminous NOW→playhead segment; system animates opacity + scale.x. */
  guideFill: new MeshBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 0.75,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  }),
  /** Ticks + signposts: brightened past MUTED so hairlines read at 0.8 m. */
  tick: new MeshBasicMaterial({
    color: 0xb9cfe8,
    transparent: true,
    opacity: 0.95,
    side: DoubleSide,
  }),
  now: new MeshBasicMaterial({ color: INK }),
  endPoint: new MeshBasicMaterial({
    color: ACCENT,
    transparent: true,
    opacity: 1.0,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  }),
  /** Satin machined-metal knob collar + stem. */
  knobMetal: new MeshStandardMaterial({
    color: 0x273850,
    metalness: 0.9,
    roughness: 0.3,
  }),
  /** Fingertip crown, dark satin ceramic with a faint cyan rest glow. */
  knobCeramic: new MeshStandardMaterial({
    color: 0x101d31,
    metalness: 0.15,
    roughness: 0.42,
    emissive: ACCENT,
    emissiveIntensity: 0.15,
  }),
  /** Emissive ring set into the collar/crown negative space. */
  glowRing: new MeshStandardMaterial({
    color: GROUND,
    emissive: ACCENT,
    emissiveIntensity: 1.6,
    roughness: 0.4,
  }),
};

// -- Housing: chamfered wedge profile extruded along X --------------------------

/** Side-view profile [y, z], clockwise seen from +X: sloped brow, leaning
 * front face, chamfered edges. */
const HOUSING_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [-0.03, 0.0205],
  [-0.0235, 0.0245],
  [0.03, 0.022],
  [0.0375, -0.013],
  [0.031, -0.0235],
  [-0.024, -0.0235],
  [-0.0305, -0.0165],
  [-0.0365, 0.012],
];

/**
 * Extrude a Y/Z side profile along X with chamfered end caps. Emits
 * non-indexed triangles with guaranteed outward winding (checked against the
 * profile centroid), so flat-shaded facets read as a machined enclosure.
 */
function extrudeProfileX(
  profile: ReadonlyArray<readonly [number, number]>,
  halfWidth: number,
  endChamfer: number,
  chamferScale: number,
): BufferGeometry {
  const sections = [
    { x: -halfWidth, s: chamferScale },
    { x: -halfWidth + endChamfer, s: 1 },
    { x: halfWidth - endChamfer, s: 1 },
    { x: halfWidth, s: chamferScale },
  ];
  const n = profile.length;
  let cy = 0;
  let cz = 0;
  for (const [y, z] of profile) {
    cy += y;
    cz += z;
  }
  cy /= n;
  cz /= n;
  const pt = (si: number, pi: number): [number, number, number] => {
    const sec = sections[si];
    const [y, z] = profile[pi];
    return [sec.x, y * sec.s, z * sec.s];
  };
  const positions: number[] = [];
  const tri = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    out: [number, number, number],
  ): void => {
    // Flip the triangle when its normal does not point along `out`.
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * out[0] + ny * out[1] + nz * out[2] >= 0) {
      positions.push(...a, ...b, ...c);
    } else {
      positions.push(...a, ...c, ...b);
    }
  };
  for (let s = 0; s < sections.length - 1; s++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = pt(s, i);
      const b = pt(s, j);
      const c = pt(s + 1, j);
      const d = pt(s + 1, i);
      const my = (a[1] + b[1] + c[1] + d[1]) / 4 - cy;
      const mz = (a[2] + b[2] + c[2] + d[2]) / 4 - cz;
      tri(a, b, c, [0, my, mz]);
      tri(a, c, d, [0, my, mz]);
    }
  }
  for (const end of [0, sections.length - 1] as const) {
    const sec = sections[end];
    const out: [number, number, number] = [end === 0 ? -1 : 1, 0, 0];
    const center: [number, number, number] = [sec.x, cy * sec.s, cz * sec.s];
    for (let i = 0; i < n; i++) {
      tri(center, pt(end, i), pt(end, (i + 1) % n), out);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

// -- Flat quad merging (ticks + signpost stems share one mesh) -----------------

function pushQuadXY(positions: number[], cx: number, cy: number, cz: number, w: number, h: number): void {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  positions.push(x0, y0, cz, x1, y0, cz, x1, y1, cz, x0, y0, cz, x1, y1, cz, x0, y1, cz);
}

// -- Signposts: deterministic authored stroke glyphs -----------------------------

/**
 * Labels are vector strokes merged into one geometry per signpost — no
 * canvas, no fonts, identical in every realm and preview. Geometric-sans
 * letterforms echo the site's Unbounded display voice, consistent with the
 * tick/stem marks. Cap height 14 mm, stroke 2.2 mm: legible at ~0.8 m.
 */
const GLYPH_CAP = 0.014;
const GLYPH_STROKE = 0.0022;
/** Extra advance between glyphs, in units of cap height. */
const GLYPH_TRACKING = 0.22;

type Stroke = readonly [number, number, number, number];
type GlyphChar = '-' | '+' | '2' | '4' | 'N' | 'O' | 'W';
interface Glyph {
  /** Advance width in units of cap height. */
  width: number;
  strokes: readonly Stroke[];
}

function ringStrokes(cx: number, cy: number, rx: number, ry: number, segments: number): Stroke[] {
  const strokes: Stroke[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    strokes.push([
      cx + Math.cos(a0) * rx,
      cy + Math.sin(a0) * ry,
      cx + Math.cos(a1) * rx,
      cy + Math.sin(a1) * ry,
    ]);
  }
  return strokes;
}

const GLYPHS: Record<GlyphChar, Glyph> = {
  '-': { width: 0.6, strokes: [[0.05, 0.5, 0.55, 0.5]] },
  '+': { width: 0.6, strokes: [[0.05, 0.5, 0.55, 0.5], [0.3, 0.22, 0.3, 0.78]] },
  '2': {
    width: 0.62,
    strokes: [
      [0.06, 0.72, 0.14, 0.9],
      [0.14, 0.9, 0.4, 0.97],
      [0.4, 0.97, 0.56, 0.82],
      [0.56, 0.82, 0.4, 0.55],
      [0.4, 0.55, 0.06, 0],
      [0.06, 0, 0.58, 0],
    ],
  },
  '4': {
    width: 0.62,
    strokes: [
      [0.45, 0, 0.45, 1],
      [0.45, 1, 0.05, 0.36],
      [0.05, 0.36, 0.58, 0.36],
    ],
  },
  N: {
    width: 0.62,
    strokes: [
      [0.06, 0, 0.06, 1],
      [0.06, 1, 0.56, 0],
      [0.56, 0, 0.56, 1],
    ],
  },
  O: { width: 0.68, strokes: ringStrokes(0.34, 0.5, 0.27, 0.48, 18) },
  W: {
    width: 0.88,
    strokes: [
      [0.04, 1, 0.18, 0],
      [0.18, 0, 0.44, 0.6],
      [0.44, 0.6, 0.7, 0],
      [0.7, 0, 0.84, 1],
    ],
  },
};

/** Emit one stroke as a flat quad facing +Z at geometry-local z=0. */
function pushStrokeQuad(
  positions: number[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  positions.push(
    x1 + nx, y1 + ny, 0,
    x1 - nx, y1 - ny, 0,
    x2 - nx, y2 - ny, 0,
    x1 + nx, y1 + ny, 0,
    x2 - nx, y2 - ny, 0,
    x2 + nx, y2 + ny, 0,
  );
}

/** Merge a signpost string into one geometry, centered on x=0 and mid-cap. */
function buildSignpostGeometry(text: string): BufferGeometry {
  const chars = [...text] as GlyphChar[];
  let advance = 0;
  for (const ch of chars) advance += GLYPHS[ch].width + GLYPH_TRACKING;
  advance -= GLYPH_TRACKING;
  const positions: number[] = [];
  let cursor = -advance / 2;
  for (const ch of chars) {
    const glyph = GLYPHS[ch];
    for (const [x1, y1, x2, y2] of glyph.strokes) {
      pushStrokeQuad(
        positions,
        (cursor + x1) * GLYPH_CAP,
        y1 * GLYPH_CAP,
        (cursor + x2) * GLYPH_CAP,
        y2 * GLYPH_CAP,
        GLYPH_STROKE,
      );
    }
    cursor += glyph.width + GLYPH_TRACKING;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  geometry.translate(0, -GLYPH_CAP / 2, 0);
  return geometry;
}

function createSignpost(name: string, text: string, material: MeshBasicMaterial, x: number): Mesh {
  const mesh = new Mesh(buildSignpostGeometry(text), material);
  mesh.name = name;
  mesh.position.set(x, 0.075, 0.005);
  return mesh;
}

// -- Knob: lathed collar + dished crown + glow ring -----------------------------

function latheAlongZ(profile: ReadonlyArray<readonly [number, number]>, segments: number): BufferGeometry {
  const points = profile.map(([r, z]) => new Vector2(r, z));
  const geometry = new LatheGeometry(points, segments);
  geometry.rotateX(Math.PI / 2); // revolve axis +Y -> +Z (toward the viewer)
  return geometry;
}

function buildKnob(): Group {
  const knob = new Group();
  knob.name = TIMELINE_KNOB_PART;
  // Origin at the grip center; stem reaches back to the channel floor.
  knob.position.set(0, 0, TIMELINE_KNOB_REST_Z);

  const collar = new Mesh(
    latheAlongZ(
      [
        [0.0042, -0.016],
        [0.0042, -0.006],
        [0.0068, -0.0045],
        [0.019, -0.0035],
        [0.0215, -0.0015],
        [0.021, 0.0005],
        [0.0145, 0.0015],
        [0.011, 0.0025],
      ],
      48,
    ),
    materials.knobMetal,
  );
  collar.name = 'KnobCollar';
  knob.add(collar);

  const crown = new Mesh(
    latheAlongZ(
      [
        [0.0105, 0.0008],
        [0.014, 0.0028],
        [0.018, 0.0055],
        [0.0195, 0.009],
        [0.018, 0.0135],
        [0.0145, 0.017],
        [0.009, 0.0185],
        [0.0055, 0.0175],
        [0.0018, 0.018],
        [0.0, 0.0182],
      ],
      48,
    ),
    materials.knobCeramic,
  );
  crown.name = 'KnobCrown';
  knob.add(crown);

  const ring = new Mesh(new TorusGeometry(0.0205, 0.0014, 12, 56), materials.glowRing);
  ring.name = 'KnobGlowRing';
  ring.position.z = 0.0002;
  knob.add(ring);
  return knob;
}

// -- Root assembly --------------------------------------------------------------

function buildTimelineControl(): Group {
  const root = new Group();
  root.name = 'TimelineControl';

  const housing = new Mesh(
    extrudeProfileX(HOUSING_PROFILE, 0.48, 0.014, 0.94),
    materials.housing,
  );
  housing.name = 'Housing';
  root.add(housing);

  const bezel = new Group();
  bezel.name = 'SlotBezel';
  const bezelRailDepth = 0.004;
  const bezelCenterZ = 0.0248;
  const bezelSideWidth = 0.01;
  const bezelInnerWidth = 0.92;
  const bezelOuterHeight = 0.024;
  const bezelInnerHeight = 0.018;
  const bezelSideX = 0.465;
  const bezelRailBevel = 0.0007;
  for (const [name, width, height, x, y] of [
    ['Left', bezelSideWidth, bezelOuterHeight, -bezelSideX, 0],
    ['Right', bezelSideWidth, bezelOuterHeight, bezelSideX, 0],
    ['Top', bezelInnerWidth, (bezelOuterHeight - bezelInnerHeight) / 2, 0,
      (bezelOuterHeight + bezelInnerHeight) / 4],
    ['Bottom', bezelInnerWidth, (bezelOuterHeight - bezelInnerHeight) / 2, 0,
      -(bezelOuterHeight + bezelInnerHeight) / 4],
  ] as const) {
    const rail = new Mesh(
      bevelBox(width, height, bezelRailDepth, bezelRailBevel),
      materials.bezel,
    );
    rail.name = `${name}Rail`;
    rail.position.set(x, y, bezelCenterZ);
    bezel.add(rail);
  }
  root.add(bezel);

  const floor = new Mesh(bevelBox(0.915, 0.014, 0.002, 0.0008), materials.glass);
  floor.name = 'SlotFloor';
  floor.position.set(0, 0, 0.0246);
  root.add(floor);

  const guideBase = new Mesh(new PlaneGeometry(0.9, 0.004), materials.guideBase);
  guideBase.name = 'LightGuideBase';
  guideBase.position.set(0, 0, 0.0258);
  root.add(guideBase);

  // Unit-width strip anchored at x=0; the system sets scale.x = knob local X
  // so the luminous segment always spans NOW -> playhead. DoubleSided because
  // a negative scale flips winding when scrubbing into the past.
  const fillGeo = new PlaneGeometry(1, 0.008);
  fillGeo.translate(0.5, 0, 0);
  const guideFill = new Mesh(fillGeo, materials.guideFill);
  guideFill.name = 'LightGuideFill';
  guideFill.position.set(0, 0, 0.0259);
  guideFill.scale.x = 0.0001;
  root.add(guideFill);

  // Readable ticks every 6 h (NOW has its own marker) + signpost stems.
  const tickPositions: number[] = [];
  for (let k = 0; k <= 8; k++) {
    if (k === 4) continue;
    pushQuadXY(tickPositions, -TIMELINE_TRAVEL_HALF + k * 0.1125, 0, 0.0258, 0.002, 0.01);
  }
  for (const x of [-TIMELINE_TRAVEL_HALF, 0, TIMELINE_TRAVEL_HALF]) {
    pushQuadXY(tickPositions, x, 0.052, 0.005, 0.0016, 0.03);
  }
  const tickGeo = new BufferGeometry();
  tickGeo.setAttribute('position', new BufferAttribute(new Float32Array(tickPositions), 3));
  tickGeo.computeVertexNormals();
  const ticks = new Mesh(tickGeo, materials.tick);
  ticks.name = 'TickMarks';
  root.add(ticks);

  const nowMarker = new Mesh(bevelBox(0.004, 0.018, 0.0008, 0.0004), materials.now);
  nowMarker.name = 'NowMarker';
  nowMarker.position.set(0, 0, 0.026);

  for (const [name, x] of [
    ['EndPointPast', -TIMELINE_TRAVEL_HALF],
    ['EndPointFuture', TIMELINE_TRAVEL_HALF],
  ] as const) {
    const point = new Mesh(new CircleGeometry(0.0045, 24), materials.endPoint);
    point.name = name;
    point.position.set(x, 0, 0.026);
    root.add(point);
  }

  root.add(createSignpost('SignpostPast', '-24', materials.tick, -TIMELINE_TRAVEL_HALF));
  root.add(createSignpost('SignpostNow', 'NOW', materials.now, 0));
  root.add(createSignpost('SignpostFuture', '+24', materials.tick, TIMELINE_TRAVEL_HALF));

  root.add(buildKnob());
  return root;
}

/** Parentless prototype for the asset manifest under `timeline-control`. */
export const timelineControl: Object3D = buildTimelineControl();
