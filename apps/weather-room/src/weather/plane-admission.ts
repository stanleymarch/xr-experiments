/**
 * Plane admission rules for the measured-room height grid.
 *
 * The framework flattens every detected plane into an XZ plate
 * (createPlaneGeometry reads polygon x/z extents only), so on real headsets
 * the plate of a vertical wall plane lands at the wall origin height with an
 * up-facing normal — the height grid would record a "floor" at chest level.
 * Real ceiling plates have the same shape one storey up: without a floor
 * plane they would serve as the lowest layer (puddles overhead). Plane
 * plates are admitted only between these sanity cuts; mesh shells keep
 * their generic triangle path.
 */

/** Subset of the raw XRPlane payload the admission rules read. */
export type PlaneSource = {
  lastChangedTime?: number;
  orientation?: string;
  polygon?: readonly { x: number; y: number; z: number }[];
};

/** Head clearance for horizontal plane plates. */
export const PLATE_CEILING_MARGIN_M = 0.35;

/** A plane the runtime explicitly reports as vertical (a wall). */
export function isWallPlane(raw: unknown): boolean {
  if (raw == null || typeof raw !== 'object') return false;
  return (raw as PlaneSource).orientation === 'vertical';
}

/** A horizontal plate above the viewer's head: a ceiling, never a floor. */
export function isCeilingPlate(plateY: number, headY: number): boolean {
  return plateY > headY + PLATE_CEILING_MARGIN_M;
}

/**
 * Smallest XZ footprint of a plate that can stand for a real horizontal
 * surface. The framework builds the plate from the polygon's x/z extents
 * only, so a wall polygon — whose second axis is *height* — collapses to a
 * line: one extent is ~0 m while the plate still carries the wall's
 * up-facing normal and the wall's origin height. Footprint is the one signal
 * that works without trusting `orientation` (real headsets may omit it),
 * because a genuine floor/table/ceiling plane is two-dimensional in XZ.
 */
export const PLATE_MIN_EXTENT_M = 0.1;

/** A plate that is a line in XZ: a wall polygon flattened, not a surface. */
export function isDegeneratePlate(sizeX: number, sizeZ: number): boolean {
  return Math.min(Math.abs(sizeX), Math.abs(sizeZ)) < PLATE_MIN_EXTENT_M;
}

/**
 * How vertical the plate's own up axis must be. A plate whose local +Y is
 * not near world up is a wall seen edge-on; its "normal" says nothing about
 * a floor. cos(30 degrees).
 */
export const PLATE_MIN_UP_DOT = 0.87;

/** A plate tilted away from world up: an edge-on wall, never a floor. */
export function isTiltedPlate(worldUpDot: number): boolean {
  return Math.abs(worldUpDot) < PLATE_MIN_UP_DOT;
}
