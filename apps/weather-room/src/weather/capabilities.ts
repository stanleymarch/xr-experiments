/**
 * WEATHER//ROOM capability profile: what the active XR session can do.
 * Derived from the session's granted features — never user-agent sniffing.
 * Outside XR (IWER/desktop preview): conservative defaults, full particles.
 */

import type { World } from '@iwsdk/core';
import { signal } from '@iwsdk/core';
import type { ReadonlySignal } from '@iwsdk/core';

export interface CapabilityProfile {
  planes: boolean;
  meshes: boolean;
  hitTest: boolean;
  hands: boolean;
  particleBudget: 'full' | 'reduced';
}

const FULL: CapabilityProfile = {
  planes: true,
  meshes: true,
  hitTest: true,
  hands: true,
  particleBudget: 'full',
};

/**
 * Read the active XR session's granted features. `enabledFeatures` is the
 * authoritative source (verified in world.d.ts: `world.xrSession` exposes the
 * active session, whose granted features mirror the requested `hitTest` /
 * `planeDetection` / `meshDetection` flags). Any access is guarded — outside
 * XR this returns the conservative IWER default.
 */
export function detectCapabilities(world: World): CapabilityProfile {
  const session = world.xrSession;
  if (session == null) {
    // IWER desktop / non-immersive preview: no real surfaces, but the
    // desktop GPU preview can afford the full particle budget.
    return { planes: false, meshes: false, hitTest: false, hands: false, particleBudget: 'full' };
  }
  const features = session.enabledFeatures ?? [];
  const planes = features.includes('plane-detection');
  const meshes = features.includes('mesh-detection');
  const hitTest = features.includes('hit-test');
  const hands = features.includes('hand-tracking');
  return {
    planes,
    meshes,
    hitTest,
    hands,
    // Reduced = typical Android WebXR (no mesh detection): halve particles,
    // disable surface-coupled splashes (floor-y fallback), keep the rest.
    particleBudget: meshes ? 'full' : 'reduced',
  };
}

const profileSignal = signal<CapabilityProfile>({ ...FULL });
let installed = false;

/**
 * Install session start/end tracking (via `visibilityState`, verified in
 * world.d.ts) and return the shared profile holder systems `peek()` each
 * frame. Idempotent — safe to call from every system init.
 */
export function capabilityProfile(world: World): ReadonlySignal<CapabilityProfile> {
  profileSignal.value = detectCapabilities(world);
  if (!installed) {
    installed = true;
    world.visibilityState.subscribe(() => {
      profileSignal.value = detectCapabilities(world);
    });
  }
  return profileSignal;
}
