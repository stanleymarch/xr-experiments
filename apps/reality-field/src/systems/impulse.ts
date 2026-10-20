/**
 * REALITY//FIELD — gestures and impulses.
 *
 * The interaction language of the experience:
 *
 * - **pinch** (or the controller trigger) charges an impulse. The longer the
 *   pinch is held, the stronger the strike; releasing fires it at the point
 *   where the pointing ray meets the room.
 * - **open palm** pushes the motes in the air away from the hand.
 * - **fist** pulls them in.
 * - **two pinches** stretch the field: the distance between the hands is
 *   the tension, and tension raises both the speed and the strength of
 *   every wave.
 *
 * The strike is the only thing that writes into the wave field, so the room
 * answers exactly one gesture: being touched.
 */

import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Hovered,
  InputComponent,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Points,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { Field } from '../field-component.js';
import { gestureOf } from '../field/hands.js';
import type { PointerPose } from '../field/hands.js';
import { fieldRuntime } from '../field/runtime.js';
import { fieldState } from '../field/state.js';
import type { Handedness } from '../field/state.js';

/** Pinch strength above which a hand is considered closed. */
const PINCH_ON = 0.6;
/** Pinch strength below which a released hand fires its impulse. */
const PINCH_OFF = 0.35;
/** Longest charge, seconds. */
const MAX_CHARGE_S = 1.2;
/** Distance between two pinching hands that means "fully stretched". */
const FULL_STRETCH_M = 0.7;
/** How long an impact ring stays alive, seconds. */
const RING_LIFE_S = 1.2;

/** Live impact rings. */
interface RingSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  active: boolean;
}

/**
 * The "spark of intent": a soft point of light on the surface the player is
 * pointing at. In DREAM mode it is the only aiming feedback — a mote of light
 * that grows as the pinch charges — so the strike never lands somewhere
 * unexpected.
 */
const AIM_VERTEX_SHADER = /* glsl */ `
attribute float aSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize / max(-mv.z, 0.25), 5.0, 140.0);
  gl_Position = projectionMatrix * mv;
}
`;

const AIM_FRAGMENT_SHADER = /* glsl */ `
void main() {
  vec2 offset = gl_PointCoord - 0.5;
  float d = dot(offset, offset);
  if (d > 0.25) discard;
  float core = exp(-d * 26.0);
  float halo = exp(-d * 6.0);
  vec3 color = mix(vec3(0.42, 0.72, 1.0), vec3(0.96, 0.99, 1.0), core);
  gl_FragColor = vec4(color, halo * 0.45 + core * 0.65);
}
`;

const hands: readonly Handedness[] = ['left', 'right'];

export class ImpulseSystem extends createSystem({
  field: { required: [Field] },
  // A hovered UI element captures the trigger: pressing a panel button must
  // not also strike the room behind the panel.
  ui: { required: [Hovered] },
}) {
  private readonly charge: Record<Handedness, number> = { left: 0, right: 0 };
  /** Latched select press (the session's selectstart event). */
  private readonly latched: Record<Handedness, boolean> = { left: false, right: false };
  /** Latched joint pinch (hand-tracking fallback). */
  private readonly pinched: Record<Handedness, boolean> = { left: false, right: false };
  /** When this hand last struck, so one gesture cannot strike twice. */
  private readonly lastFireAt: Record<Handedness, number> = { left: -1000, right: -1000 };
  /** The active XR session, for the select events. */
  private session: XRSession | null = null;
  /**
   * Simulation clock for the field, accumulated from frame deltas.
   *
   * The wave must not run on wall-clock time: a tab that stalls, a paused
   * simulation or a slow frame would let the front leave the room between
   * two frames. Accumulating the delta keeps the wave attached to the
   * frames the player actually sees.
   */
  private simTime = 0;
  /** True while a pointer hovers a UI element (the panel). */
  private uiHovered = false;
  private readonly rings: RingSlot[] = [];
  private ringGeometry: RingGeometry | null = null;
  private readonly hitPoint = new Vector3();
  private readonly hitNormal = new Vector3(0, 1, 0);
  private readonly cameraPos = new Vector3();
  private readonly sparkPos = new Vector3();
  private readonly firePoint = new Vector3();
  private readonly fireDirection = new Vector3(0, 1, 0);
  private readonly scratch = new Vector3();
  private readonly rayEnd = new Vector3();
  private rayLine: Line | null = null;
  private markerMesh: Mesh | null = null;
  private normalLine: Line | null = null;
  private aimPoints: Points | null = null;
  private aimGeometry: BufferGeometry | null = null;
  private aimMaterial: ShaderMaterial | null = null;
  private aimPosition: Float32BufferAttribute | null = null;
  private aimSize: Float32BufferAttribute | null = null;

  init(): void {
    this.createRings();
    this.createAimIndicator();
    this.createDebugHelpers();
  }

  update(delta: number, _time: number): void {
    this.simTime += delta;
    this.uiHovered = false;
    for (const entity of this.queries.ui.entities) {
      this.uiHovered = entity != null;
      break;
    }
    this.syncSession();
    const pointers = fieldRuntime.pointers;
    pointers.update(this.world);

    this.updateTension();
    this.updateHands(delta);
    this.updateMarker();

    const waveWidth = this.readFieldValue('waveWidth', 0.09);
    fieldRuntime.wave.update(this.simTime, waveWidth);

    this.updateRings(delta);
  }

  /**
   * Follow the active session so the select events can be heard.
   *
   * The session's `selectstart` / `selectend` are the authoritative pinch
   * signal: a controller trigger and a hand pinch both arrive as select
   * events, and every WebXR runtime — including the emulator — reports
   * them. The gamepad and the joint distance are kept as fallbacks for
   * runtimes that only fill the gamepad state.
   */
  private syncSession(): void {
    const session = this.world.xrSession ?? null;
    if (session === this.session) return;
    this.detachSession();
    if (session == null) return;
    this.session = session;
    session.addEventListener('selectstart', this.onSelectStart);
    session.addEventListener('selectend', this.onSelectEnd);
  }

  private detachSession(): void {
    if (this.session == null) return;
    this.session.removeEventListener('selectstart', this.onSelectStart);
    this.session.removeEventListener('selectend', this.onSelectEnd);
    this.session = null;
    this.latched.left = false;
    this.latched.right = false;
    // The field belongs to the room: a new session starts with an empty one.
    fieldRuntime.wave.clear();
    fieldState.impactCount = 0;
  }

  private readonly onSelectStart = (event: Event): void => {
    const hand = this.handednessOf(event);
    if (hand == null) return;
    this.latched[hand] = true;
  };

  private readonly onSelectEnd = (event: Event): void => {
    const hand = this.handednessOf(event);
    if (hand == null) return;
    if (!this.latched[hand]) return;
    this.latched[hand] = false;
    this.strike(hand);
  };

  /** The hand behind a select event. */
  private handednessOf(event: Event): Handedness | null {
    const source = (event as Event & { inputSource?: { handedness?: string } }).inputSource;
    const handedness = source?.handedness;
    return handedness === 'left' || handedness === 'right' ? handedness : null;
  }

  /** Fire the impulse for one hand and clear its charge. */
  private strike(hand: Handedness): void {
    // The trigger belongs to the UI while a panel element is hovered.
    if (this.uiHovered) {
      this.charge[hand] = 0;
      return;
    }
    const charge = this.charge[hand];
    this.charge[hand] = 0;
    this.lastFireAt[hand] = this.simTime;
    this.fire(hand, charge, this.simTime);
  }

  /** Read one authored value from the `Field` component. */
  private readFieldValue(key: 'waveSpeed' | 'waveWidth', fallback: number): number {
    for (const entity of this.queries.field.entities) {
      const value = entity.getValue(Field, key);
      if (typeof value === 'number') return value;
    }
    return fallback;
  }

  /** Two pinching hands stretch the field; the distance is the tension. */
  private updateTension(): void {
    const left = fieldRuntime.pointers.pose('left');
    const right = fieldRuntime.pointers.pose('right');
    // A held select counts as a pinch as well: on controllers the trigger is
    // the pinch, and some runtimes report the select without precise joints.
    const leftPinching = left.present && (left.pinch > PINCH_ON || this.latched.left);
    const rightPinching = right.present && (right.pinch > PINCH_ON || this.latched.right);
    if (leftPinching && rightPinching) {
      const span = left.palm.distanceTo(right.palm);
      fieldState.tension = Math.min(1, Math.max(0, (span - 0.15) / FULL_STRETCH_M));
    } else {
      fieldState.tension = Math.max(0, fieldState.tension - 0.04);
    }
  }

  /** Read both hands: gesture, charge and the impulse they fire. */
  private updateHands(delta: number): void {
    let label = 'idle';
    for (const hand of hands) {
      const pose = fieldRuntime.pointers.pose(hand);
      const snapshot = fieldState.hands[hand];
      snapshot.present = pose.present;
      snapshot.kind = pose.kind;
      snapshot.pinch = pose.pinch;
      snapshot.rayOrigin.copy(pose.rayOrigin);
      snapshot.rayDirection.copy(pose.rayDirection);
      snapshot.palm.copy(pose.palm);

      let charging = false;
      let fire = false;
      const latched = this.latched[hand];
      const jointPinching = pose.kind === 'hand' && pose.pinch > PINCH_ON;
      const triggerHeld =
        pose.kind === 'controller'
          ? (this.input.xr.gamepads[hand]?.getButtonPressed(InputComponent.Trigger) ?? false)
          : false;
      charging = latched || jointPinching || triggerHeld;
      snapshot.pinched = charging;
      snapshot.charging = charging;
      snapshot.gesture = gestureOf(pose, charging);

      if (charging) {
        this.charge[hand] = Math.min(MAX_CHARGE_S, this.charge[hand] + delta);
      }

      // Fallback strike for runtimes that fill the gamepad but never send
      // select events, and for hand pinches the session never reports.
      if (pose.kind === 'controller') {
        const triggerUp =
          this.input.xr.gamepads[hand]?.getButtonUp(InputComponent.Trigger) ?? false;
        if (triggerUp && charging && this.simTime - this.lastFireAt[hand] > 0.25) {
          this.strike(hand);
        }
      } else if (pose.kind === 'hand') {
        const released = this.pinched[hand] && pose.pinch < PINCH_OFF;
        if (released && this.simTime - this.lastFireAt[hand] > 0.25) {
          this.strike(hand);
        }
        this.pinched[hand] = jointPinching;
      }

      if (pose.present) {
        label = `${hand}: ${snapshot.gesture}`;
        this.updateRay(pose);
      }
    }
    fieldState.gestureLabel = label;
  }

  /** Fire one impulse at the point where the ray meets the room. */
  private fire(hand: Handedness, charge: number, time: number): void {
    const pose = fieldRuntime.pointers.pose(hand);
    const strength = 0.1 + 0.24 * Math.min(1, charge / MAX_CHARGE_S);
    const amplitude = strength * (1 + 0.8 * fieldState.tension);
    const speed = 1.7 * (1 + 0.5 * fieldState.tension);

    const hit = fieldRuntime.picker.pick(
      pose.rayOrigin,
      pose.rayDirection,
      this.hitPoint,
      this.hitNormal,
    );
    if (hit) {
      this.firePoint.copy(this.hitPoint);
      // The strike pushes into the surface: opposite to the normal, which
      // points into the room.
      this.fireDirection.copy(this.hitNormal).negate();
    } else {
      // Nothing measured in the ray: the impulse still happens, in the air.
      this.firePoint.copy(pose.rayOrigin).addScaledVector(pose.rayDirection, 1.2);
      this.fireDirection.copy(pose.rayDirection).negate();
    }
    fieldRuntime.wave.emit(this.firePoint, this.fireDirection, amplitude, speed, time);
    fieldState.impactPosition.copy(this.firePoint);
    fieldState.impactNormal.copy(this.fireDirection).negate();
    fieldState.lastImpactAt = time;
    fieldState.impactCount += 1;
    this.spawnRing(this.firePoint, this.fireDirection);
  }

  /** Create the pool of expanding impact rings. */
  private createRings(): void {
    // A thin band: a thick ring reads as a graphic overlay, not as a ripple
    // in the surface.
    this.ringGeometry = new RingGeometry(0.16, 0.195, 48);
    for (let i = 0; i < 6; i += 1) {
      const material = new MeshBasicMaterial({
        color: 0x9fdcff,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      });
      const mesh = new Mesh(this.ringGeometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.world.createTransformEntity(mesh);
      this.rings.push({ mesh, material, age: 0, active: false });
    }
  }

  /** Spawn an impact ring on the struck surface. */
  private spawnRing(point: Vector3, direction: Vector3): void {
    const slot = this.rings.find((ring) => !ring.active) ?? this.rings[0];
    slot.active = true;
    slot.age = 0;
    slot.mesh.visible = true;
    slot.mesh.position.copy(point);
    this.scratch.set(0, 0, 1);
    slot.mesh.quaternion.setFromUnitVectors(this.scratch, direction);
    slot.mesh.scale.setScalar(0.4);
    slot.material.opacity = 0.55;
  }

  /** Advance and fade the impact rings. */
  private updateRings(delta: number): void {
    for (const slot of this.rings) {
      if (!slot.active) continue;
      slot.age += delta;
      const life = slot.age / RING_LIFE_S;
      if (life >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      slot.mesh.scale.setScalar(0.4 + life * 1.5);
      // Fade fast: the ring is a punctuation mark, the wave is the sentence.
      slot.material.opacity = 0.55 * Math.pow(1 - life, 1.6);
    }
  }

  /** The soft point of light that marks where the strike will land. */
  private createAimIndicator(): void {
    const geometry = new BufferGeometry();
    const position = new Float32BufferAttribute(new Float32Array(3), 3);
    const size = new Float32BufferAttribute(new Float32Array([12]), 1);
    geometry.setAttribute('position', position);
    geometry.setAttribute('aSize', size);
    geometry.computeBoundingSphere();
    const material = new ShaderMaterial({
      vertexShader: AIM_VERTEX_SHADER,
      fragmentShader: AIM_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;
    this.world.createTransformEntity(points);
    this.aimPoints = points;
    this.aimGeometry = geometry;
    this.aimMaterial = material;
    this.aimPosition = position;
    this.aimSize = size;
  }

  /** Debug helpers: the pointing ray, the contact point and its normal. */
  private createDebugHelpers(): void {
    const rayGeometry = new BufferGeometry();
    rayGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    this.rayLine = new Line(
      rayGeometry,
      new LineBasicMaterial({ color: 0x9dff6b, transparent: true, opacity: 0.9 }),
    );
    this.rayLine.frustumCulled = false;
    this.rayLine.visible = false;
    this.world.createTransformEntity(this.rayLine);

    const marker = new Mesh(
      new SphereGeometry(0.025, 12, 8),
      new MeshBasicMaterial({ color: 0x9dff6b, transparent: true, opacity: 0.95 }),
    );
    marker.frustumCulled = false;
    marker.visible = false;
    this.world.createTransformEntity(marker);
    this.markerMesh = marker;

    const normalGeometry = new BufferGeometry();
    normalGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    this.normalLine = new Line(
      normalGeometry,
      new LineBasicMaterial({ color: 0xff9d6b, transparent: true, opacity: 0.9 }),
    );
    this.normalLine.frustumCulled = false;
    this.normalLine.visible = false;
    this.world.createTransformEntity(this.normalLine);
  }

  /** Draw the pointing ray of the most recent hand. */
  private updateRay(pose: PointerPose): void {
    if (this.rayLine == null) return;
    const visible = fieldState.mode === 'debug';
    this.rayLine.visible = visible;
    if (!visible) return;
    const attribute = this.rayLine.geometry.getAttribute('position') as Float32BufferAttribute;
    this.rayEnd.copy(pose.rayOrigin).addScaledVector(pose.rayDirection, 3);
    attribute.setXYZ(0, pose.rayOrigin.x, pose.rayOrigin.y, pose.rayOrigin.z);
    attribute.setXYZ(1, this.rayEnd.x, this.rayEnd.y, this.rayEnd.z);
    attribute.needsUpdate = true;
  }

  /** Draw the last contact point and the surface normal there. */
  private updateMarker(): void {
    const debug = fieldState.mode === 'debug';
    const pose = fieldState.hands.right.present
      ? fieldState.hands.right
      : fieldState.hands.left;
    const hit = pose.present
      ? fieldRuntime.picker.pick(
          pose.rayOrigin,
          pose.rayDirection,
          this.hitPoint,
          this.hitNormal,
        ) && !this.uiHovered
      : false;
    fieldState.touching = hit;

    // The aiming cue: a soft spark on the surface, growing with the charge.
    // It exists only in DREAM — in DEBUG the technical marker says the same
    // thing with a hard edge.
    if (this.aimPoints != null && this.aimPosition != null && this.aimSize != null) {
      this.aimPoints.visible = hit && !debug;
      if (hit && !debug) {
        const charge = Math.max(this.charge.left, this.charge.right);
        const fraction = Math.min(1, charge / MAX_CHARGE_S);
        const pulse = fraction > 0.01 ? 1 + 0.09 * Math.sin(this.simTime * 9) : 1;
        // Lift the spark toward the viewer, not along the surface normal:
        // the picker's normal can point into the surface, which would bury
        // the marker inside the mesh where the depth test hides it.
        this.world.camera.getWorldPosition(this.cameraPos);
        this.sparkPos
          .copy(this.hitPoint)
          .sub(this.cameraPos)
          .normalize()
          .multiplyScalar(0.012)
          .add(this.hitPoint);
        this.aimPosition.setXYZ(0, this.sparkPos.x, this.sparkPos.y, this.sparkPos.z);
        this.aimPosition.needsUpdate = true;
        this.aimSize.setX(0, (90 + fraction * 140) * pulse);
        this.aimSize.needsUpdate = true;
      }
    }

    if (this.markerMesh == null || this.normalLine == null) return;
    this.markerMesh.visible = hit && debug;
    this.normalLine.visible = hit && debug;
    if (!hit || !debug) return;
    this.markerMesh.position.copy(this.hitPoint);
    const attribute = this.normalLine.geometry.getAttribute('position') as Float32BufferAttribute;
    attribute.setXYZ(0, this.hitPoint.x, this.hitPoint.y, this.hitPoint.z);
    attribute.setXYZ(
      1,
      this.hitPoint.x + this.hitNormal.x * 0.25,
      this.hitPoint.y + this.hitNormal.y * 0.25,
      this.hitPoint.z + this.hitNormal.z * 0.25,
    );
    attribute.needsUpdate = true;
  }

  override destroy(): void {
    super.destroy();
    this.ringGeometry?.dispose();
    this.ringGeometry = null;
    this.rings.length = 0;
    this.aimGeometry?.dispose();
    this.aimMaterial?.dispose();
    this.aimGeometry = null;
    this.aimMaterial = null;
    this.aimPoints = null;
    this.aimPosition = null;
    this.aimSize = null;
  }
}
