/**
 * WEATHER//ROOM probe sampler: head-anchored hit-test sweep for the "room
 * is not mesh-mapped" case. Engages only when no XRPlane/XRMesh owns the
 * room model; each probe is a persistent EnvironmentRaycastTarget entity
 * (viewer space + fixed offset quaternion) whose xrHitTestResult pose is
 * recorded into the same viewer-anchored height grid the mesh path fills.
 * Missing hit-test capability (feature not granted, no session, raycast
 * system absent): entities are never created and behaviour is exactly
 * today's fallback box with spawning particles.
 *
 * Fixed sampling contract: 8 rays (centre + seven gaze-relative sweeps),
 * one rotating subset per 0.5 s tick: the subset advances by 3 slots each
 * tick, so a few ticks sweep ~1.2 m of floor around the viewer instead of
 * re-poking the same 0.25 m patch. The centre ray tilts 60 degrees down
 * from gaze and lands near 0.9 m ahead of a 1.6 m head, inside the compact
 * weather volume. Per-tick cost is O(8) pose reads + grid records; between
 * ticks the per-frame cost is a single cheap predicate (no surfaces,
 * capability present, 0.5 s elapsed). Yaw offsets are gaze-relative sweeps:
 * only wall-facing (low-+Y-normal) hits are discarded, never assumed to be
 * floor.
 */

import {
  createSystem,
  EnvironmentRaycastSystem,
  EnvironmentRaycastTarget,
  Euler,
  Quaternion,
  RaycastSpace,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { roomModel } from '../room.js';

/**
 * Probe rays per resample tick. One XRHitTestSource is bound per entity by
 * the IWSDK raycast system, so a lattice needs N persistent probe entities
 * rather than re-requesting sources per tick (request churn would break the
 * bounded-cost contract).
 */
export const PROBE_RAY_COUNT = 8;
/** Downward tilt of the centre probe ray from gaze, in radians. */
const PROBE_TILT_RAD = Math.PI / 3;
/** Sweep rays cover the nearby floor/table patch inside the volume. */
const PROBE_SWEEP_YAW = Math.atan2(0.6, 1);
const PROBE_SWEEP_PITCH = Math.atan2(0.35, 1);
/** Rays read per tick: a rotating subset keeps per-tick cost bounded. */
const PROBE_SUBSET = 5;
/** Seconds between resample ticks (matches the mesh-path debounce). */
const SAMPLE_INTERVAL_S = 0.5;
/** Hit-test hits farther than this from the head do not count as surfaces. */
const MAX_PROBE_DISTANCE = 6;

const headPosition = new Vector3();
const hitPosition = new Vector3();

export class DepthSamplingSystem extends createSystem({
  probes: { required: [EnvironmentRaycastTarget] },
}) {
  private probes: Entity[] = [];
  private engaged = false;
  private lastSampleAt = -SAMPLE_INTERVAL_S;
  private sweepCursor = 0;
  private readonly probeOrigin = new Vector3();
  private readonly probeTilt = new Quaternion();
  private readonly probeEuler = new Euler();

  override init(): void {
    this.cleanupFuncs.push(() => this.teardownProbes());
  }

  override update(_delta: number, time: number): void {
    // Cheap gate first: mesh/plane knowledge always wins, and probing is
    // pointless while a mesh build is still consuming its frame budget.
    if (roomModel.hasMeshSurfaces || roomModel.building) {
      if (this.engaged) this.standDown();
      return;
    }
    if (!this.hasHitTest()) {
      if (this.engaged) this.standDown();
      return;
    }
    if (time - this.lastSampleAt < SAMPLE_INTERVAL_S) return;
    this.lastSampleAt = time;
    if (!this.engaged && !this.engage()) return;
    this.world.player.head.getWorldPosition(headPosition);
    if (!roomModel.beginProbeVolume(headPosition)) {
      // A mesh rebuild landed between the gate and the tick: yield.
      this.standDown();
      return;
    }
    // One rotating subset per tick: five of eight pose reads + grid records,
    // then quiet for another 0.5 s. Never a per-cell raycast storm.
    for (let i = 0; i < PROBE_SUBSET; i += 1) {
      const probe = this.probes[(this.sweepCursor + i) % this.probes.length];
      if (probe != null) this.recordProbe(probe);
    }
    this.sweepCursor = (this.sweepCursor + 3) % Math.max(1, this.probes.length);
  }

  /**
   * Capability gate: a live XR session whose granted features include
   * hit-test. `world.xrSession` is undefined outside XR (IWER/desktop
   * preview), and `enabledFeatures` mirrors the granted session flags —
   * the same source detectCapabilities() reads.
   */
  private hasHitTest(): boolean {
    const session = this.world.xrSession;
    if (session == null) return false;
    return (session.enabledFeatures ?? []).includes('hit-test');
  }

  /**
   * Create the persistent probe entities (viewer space, fixed offset
   * quaternions: centre down-tilt plus wider gaze-relative sweeps). Returns
   * false when the built-in raycast system is unavailable, so no probe
   * entity is ever created without something to serve it.
   */
  private engage(): boolean {
    if (this.world.getSystem(EnvironmentRaycastSystem) == null) return false;
    try {
      for (const { yaw, pitch } of DepthSamplingSystem.probeOffsets()) {
        this.probes.push(this.createProbeEntity(yaw, pitch));
      }
    } catch {
      this.teardownProbes();
      return false;
    }
    this.engaged = this.probes.length === PROBE_RAY_COUNT;
    if (!this.engaged) this.teardownProbes();
    return this.engaged;
  }

  /** Fixed offsets: centre plus seven gaze-relative sweeps (~1.2 m patch). */
  static probeOffsets(): { yaw: number; pitch: number }[] {
    return [
      { yaw: 0, pitch: 0 },
      { yaw: PROBE_SWEEP_YAW, pitch: 0 },
      { yaw: -PROBE_SWEEP_YAW, pitch: 0 },
      { yaw: 0, pitch: PROBE_SWEEP_PITCH },
      { yaw: 0, pitch: -PROBE_SWEEP_PITCH },
      { yaw: PROBE_SWEEP_YAW * 0.6, pitch: PROBE_SWEEP_PITCH * 0.6 },
      { yaw: -PROBE_SWEEP_YAW * 0.6, pitch: PROBE_SWEEP_PITCH * 0.6 },
      { yaw: 0, pitch: -PROBE_SWEEP_PITCH * 0.5 },
    ];
  }

  private createProbeEntity(yaw: number, pitch: number): Entity {
    // Viewer space is already head-relative: the ray starts at the eyes and
    // the offset quaternion tilts it from forward (-Z) toward the floor.
    this.probeOrigin.set(0, 0, 0);
    this.probeTilt.setFromEuler(
      this.probeEuler.set(-PROBE_TILT_RAD + pitch, yaw, 0, 'YXZ'),
    );
    const entity = this.world.createTransformEntity();
    entity.addComponent(EnvironmentRaycastTarget, {
      space: RaycastSpace.Viewer,
      maxDistance: MAX_PROBE_DISTANCE,
      offsetPosition: this.probeOrigin.clone(),
      offsetQuaternion: this.probeTilt.clone(),
    });
    return entity;
  }

  /** Read one probe's measured world-space hit into the height grid. */
  private recordProbe(probe: Entity): void {
    const raw: unknown = probe.getValue(EnvironmentRaycastTarget, 'xrHitTestResult');
    if (raw == null || typeof raw !== 'object') return;
    const result = raw as XRHitTestResult;
    if (typeof result.getPose !== 'function') return;
    const referenceSpace = this.xrManager.getReferenceSpace();
    if (referenceSpace == null) return;
    let pose: XRPose | null | undefined = null;
    try {
      pose = result.getPose(referenceSpace);
    } catch {
      return;
    }
    if (pose == null) return;
    // XRRigidTransform.matrix is column-major: translation is elements 12-14
    // (the same layout EnvironmentRaycastSystem decomposes in applyHitResult).
    const matrix = pose.transform.matrix;
    // Hit-test +Y is the measured surface normal; walls do not supply a
    // horizontal contact patch. A genuine floor may be at y=0 (local-floor)
    // or below it after reference-space drift; height is not a validity gate.
    if (matrix[5] < 0.5) return;
    hitPosition.set(matrix[12], matrix[13], matrix[14]);
    if (hitPosition.distanceTo(headPosition) > MAX_PROBE_DISTANCE) return;
    roomModel.recordProbePoint(hitPosition.x, hitPosition.y, hitPosition.z);
  }

  private standDown(): void {
    this.teardownProbes();
    this.engaged = false;
    this.sweepCursor = 0;
    roomModel.endProbing();
  }

  private teardownProbes(): void {
    for (const probe of this.probes) {
      try {
        // Empty Object3Ds only: no geometry/materials, so destroy() frees
        // nothing GPU-bound. Removal disqualifies the raycast-system query,
        // which cancels the probe's XRHitTestSource.
        probe.destroy();
      } catch {
        // Entity already gone with the world; nothing to clean.
      }
    }
    this.probes = [];
  }

  override destroy(): void {
    super.destroy();
    this.engaged = false;
    roomModel.endProbing();
  }
}
