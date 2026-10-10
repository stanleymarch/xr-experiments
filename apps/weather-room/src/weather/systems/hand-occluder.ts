/**
 * WEATHER//ROOM hand occluder: depth-only proxy geometry for tracked hands and
 * controllers.
 *
 * Problem this solves: the app's real-world occlusion (see
 * `../depth-occlusion.ts`) tests weather fragments against the runtime's depth
 * image, which contains the room the user is standing in — never the user's
 * hands. Rain streaks and snow flakes therefore fall straight through a tracked
 * hand. No change to the depth test can fix that: the hand has to become
 * virtual geometry.
 *
 * How: one `InstancedMesh` of low-poly spheres per hand, anchored to the joints
 * of the framework's own hand model, rendered with `colorWrite: false` and
 * `depthWrite: true`. The material is opaque (`transparent: false`), so three
 * draws it in the opaque pass — before every transparent weather layer — and the
 * depth it leaves cuts the weather fragments behind the hand. The spheres are
 * never visible; they are a hole in the depth buffer shaped like the hand.
 *
 * Anchors: `input.xr.visualAdapters.hand[h].visual.model` is a Group whose child
 * nodes are named with the WebXR hand joint names — that is exactly how the
 * framework's own skinning finds and drives them (`model.getObjectByName(
 * jointName)`), so the proxy binds the same way. Palm, fingertips, distal
 * phalanges and thumb are covered; the metacarpals carry the palm because a
 * single sphere at the wrist cannot cover a ~10 cm palm. Controller mode has no
 * joints at all and falls back to one larger sphere on `player.gripSpaces[h]`
 * (with controllers `indexTipSpaces` mirrors `raySpaces`, so the grip — where
 * the controller physically is — is the right anchor).
 *
 * Lifecycle: with no hands and no controllers the system allocates nothing and
 * is a no-op. Proxies appear when a source becomes live and are torn down when
 * it goes away (tracking loss, input-mode switch, session end), so a stale
 * occluder can never keep cutting rain at an old hand pose.
 */

import {
  createSystem,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';

/** Sphere radius baked into the shared geometry, in meters. */
const SPHERE_RADIUS = 0.018;
const SPHERE_SEGMENTS = 8;
const SPHERE_RINGS = 6;

/** Size multiplier for the single controller-mode sphere. */
const CONTROLLER_SCALE = 2.6;
const CONTROLLER_SCALES = Float32Array.of(CONTROLLER_SCALE);

/**
 * Hand joint anchors and their size multipliers (applied through the instance
 * matrix, so the geometry itself stays one 8x6 sphere). Names are the exact
 * WebXR hand joint names the framework's `AnimatedHand` model is built with.
 */
const HAND_ANCHORS: ReadonlyArray<{ readonly joint: string; readonly scale: number }> = [
  // Palm: the wrist hub plus the four metacarpal bases spread across it.
  { joint: 'wrist', scale: 2.8 },
  { joint: 'index-finger-metacarpal', scale: 1.8 },
  { joint: 'middle-finger-metacarpal', scale: 1.8 },
  { joint: 'ring-finger-metacarpal', scale: 1.8 },
  { joint: 'pinky-finger-metacarpal', scale: 1.6 },
  // Fingertips.
  { joint: 'index-finger-tip', scale: 1.1 },
  { joint: 'middle-finger-tip', scale: 1.1 },
  { joint: 'ring-finger-tip', scale: 1.1 },
  { joint: 'pinky-finger-tip', scale: 1.0 },
  // Distal phalanges: the segment just behind each tip.
  { joint: 'index-finger-phalanx-distal', scale: 1.2 },
  { joint: 'middle-finger-phalanx-distal', scale: 1.2 },
  { joint: 'ring-finger-phalanx-distal', scale: 1.2 },
  { joint: 'pinky-finger-phalanx-distal', scale: 1.1 },
  // Thumb: its metacarpal sits at the palm edge, then the two distal segments.
  { joint: 'thumb-metacarpal', scale: 1.7 },
  { joint: 'thumb-phalanx-proximal', scale: 1.3 },
  { joint: 'thumb-phalanx-distal', scale: 1.2 },
  { joint: 'thumb-tip', scale: 1.1 },
];

type Handedness = 'left' | 'right';

/** One live proxy: an instanced sphere cloud following `source`'s subtree. */
interface ProxyState {
  readonly mode: 'hand' | 'controller';
  /** Object whose subtree is refreshed before the instance matrices are read. */
  readonly source: Object3D;
  readonly anchors: readonly Object3D[];
  readonly scales: Float32Array;
  readonly mesh: InstancedMesh;
  readonly entity: Entity;
}

export class HandOccluderSystem extends createSystem({}) {
  private readonly proxies: Record<Handedness, ProxyState | null> = {
    left: null,
    right: null,
  };
  /** Created only on first use, disposed once with the system. */
  private geometry: SphereGeometry | null = null;
  private material: MeshBasicMaterial | null = null;
  private readonly tmpPosition = new Vector3();
  private readonly tmpMatrix = new Matrix4();
  /** Zero-scale matrix: an unplaced instance contributes no depth. */
  private readonly parkedMatrix = new Matrix4().makeScale(0, 0, 0);

  init(): void {
    this.cleanupFuncs.push(() => {
      this.drop('left');
      this.drop('right');
      this.geometry?.dispose();
      this.geometry = null;
      this.material?.dispose();
      this.material = null;
    });
  }

  update(): void {
    // No immersive session, no tracked hands or controllers turned into rig
    // spaces: nothing to occlude with, and anything left from a previous
    // session is dropped at the session edge.
    if (this.world.xrSession == null) {
      this.drop('left');
      this.drop('right');
      return;
    }
    this.sync('left');
    this.sync('right');
    const left = this.proxies.left;
    if (left != null) this.place(left);
    const right = this.proxies.right;
    if (right != null) this.place(right);
  }

  /** Match one hand's proxy to whichever input source is live for it. */
  private sync(hand: Handedness): void {
    const adapters = this.input.xr.visualAdapters;
    // A live hand visual means the runtime is tracking that hand, whether or
    // not the framework chose to show the mesh (it hides the non-primary one),
    // so the hand wins over a controller reporting the same handedness.
    const model = adapters.hand[hand].visual?.model;
    if (model != null) {
      this.bindHand(hand, model);
      return;
    }
    if (adapters.controller[hand].connected) {
      this.bindController(hand);
      return;
    }
    this.drop(hand);
  }

  private bindHand(hand: Handedness, model: Object3D): void {
    const current = this.proxies[hand];
    if (current != null && current.mode === 'hand' && current.source === model) return;

    const anchors: Object3D[] = [];
    const scales: number[] = [];
    const missing: string[] = [];
    for (let index = 0; index < HAND_ANCHORS.length; index += 1) {
      const anchor = HAND_ANCHORS[index];
      const node = model.getObjectByName(anchor.joint);
      if (node == null) {
        missing.push(anchor.joint);
        continue;
      }
      anchors.push(node);
      scales.push(anchor.scale);
    }
    if (missing.length > 0) {
      console.warn(
        `[weather-room] hand occluder (${hand}): hand model has no joint node ${missing.join(', ')}`,
      );
    }
    if (anchors.length === 0) {
      this.drop(hand);
      return;
    }
    this.drop(hand);
    this.proxies[hand] = this.createProxy('hand', hand, model, anchors, Float32Array.from(scales));
  }

  private bindController(hand: Handedness): void {
    const current = this.proxies[hand];
    if (current != null && current.mode === 'controller') return;
    const grip = this.player.gripSpaces[hand];
    this.drop(hand);
    this.proxies[hand] = this.createProxy('controller', hand, grip, [grip], CONTROLLER_SCALES);
  }

  private createProxy(
    mode: ProxyState['mode'],
    hand: Handedness,
    source: Object3D,
    anchors: readonly Object3D[],
    scales: Float32Array,
  ): ProxyState {
    const mesh = new InstancedMesh(this.ensureGeometry(), this.ensureMaterial(), anchors.length);
    mesh.name = `hand-occluder-${hand}-${mode}`;
    // The proxy is invisible depth state, never an interaction surface: no ray
    // may hit it (poke/ray/grab targeting) and its bounds say nothing about
    // where the instances actually are, so it must not be frustum culled.
    mesh.raycast = () => {};
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let index = 0; index < anchors.length; index += 1) {
      mesh.setMatrixAt(index, this.parkedMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return {
      mode,
      source,
      anchors,
      scales,
      mesh,
      entity: this.world.createTransformEntity(mesh),
    };
  }

  /**
   * Write this frame's instance matrices from the tracked joint world
   * transforms. Allocation-free: only the preallocated vector and matrix are
   * reused, and nothing is created per frame.
   */
  private place(state: ProxyState): void {
    // The joints are Object3D nodes whose local transforms the input layer set
    // earlier this frame; their world matrices are still the previous frame's
    // until the renderer updates them, so refresh the subtree here.
    state.source.updateWorldMatrix(true, true);
    const { anchors, scales, mesh } = state;
    for (let index = 0; index < anchors.length; index += 1) {
      this.tmpPosition.setFromMatrixPosition(anchors[index].matrixWorld);
      const scale = scales[index];
      // A joint position plus a uniform scale is the whole placement: spheres
      // are rotationally symmetric, and dropping the joint's own scale keeps a
      // non-uniform bone transform from squashing the proxy.
      this.tmpMatrix.makeScale(scale, scale, scale);
      this.tmpMatrix.setPosition(this.tmpPosition);
      mesh.setMatrixAt(index, this.tmpMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private drop(hand: Handedness): void {
    const state = this.proxies[hand];
    if (state == null) return;
    this.proxies[hand] = null;
    // Frees this proxy's instanceMatrix buffer. The geometry and material are
    // shared between both hands, so the entity must not dispose its resources.
    state.mesh.dispose();
    state.entity.dispose({ disposeResources: false });
  }

  private ensureGeometry(): SphereGeometry {
    let geometry = this.geometry;
    if (geometry == null) {
      geometry = new SphereGeometry(SPHERE_RADIUS, SPHERE_SEGMENTS, SPHERE_RINGS);
      this.geometry = geometry;
    }
    return geometry;
  }

  private ensureMaterial(): MeshBasicMaterial {
    let material = this.material;
    if (material == null) {
      material = new MeshBasicMaterial({
        // Depth-only draw: nothing reaches the color buffer, but the fragments
        // still fill the depth buffer in the opaque pass, which is what cuts
        // the transparent weather layers drawn after it.
        colorWrite: false,
        depthWrite: true,
        depthTest: true,
        transparent: false,
      });
      this.material = material;
    }
    return material;
  }
}
