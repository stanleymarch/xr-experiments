/**
 * Adapted from brvtl/act-it-out src/model/timestamps.ts (MIT).
 */
/**
 * Formats seconds to one decimal exactly like Python's `f"{x:.1f}"`, which the model's prompts were rendered with.
 * JS `toFixed` rounds exact binary ties (0.25, 1.25, …) up; Python rounds them half-to-even.
 */
export function formatTimestamp(seconds: number): string {
  // Only odd multiples of 0.25 sit exactly on a .x5 tie in binary; scaling by powers of two is exact.
  const isTie = Number.isInteger(seconds * 4) && !Number.isInteger(seconds * 2);
  if (!isTie) return seconds.toFixed(1);
  const lower = Math.floor(seconds * 10);
  const tenths = lower % 2 === 0 ? lower : lower + 1;
  return (tenths / 10).toFixed(1);
}

/** The timestamp of each temporal patch: the midpoint of its first and last frame, as the processor computes it. */
export function groupTimestamps(frameIndices: readonly number[], fps: number, temporalPatchSize: number): number[] {
  const indices = [...frameIndices];
  const pad = (temporalPatchSize - (indices.length % temporalPatchSize)) % temporalPatchSize;
  for (let i = 0; i < pad; i++) indices.push(indices[indices.length - 1]);
  const out: number[] = [];
  for (let i = 0; i < indices.length; i += temporalPatchSize) {
    out.push((indices[i] + indices[i + temporalPatchSize - 1]) / (2 * fps));
  }
  return out;
}
