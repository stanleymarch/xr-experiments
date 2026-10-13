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
