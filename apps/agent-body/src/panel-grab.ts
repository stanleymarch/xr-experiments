/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root of this source tree.
 */

/**
 * The panel's grab bar.
 *
 * The panel itself is a plain UI surface: it carries `RayInteractable` and
 * `PokeInteractable`, so the trigger clicks its buttons and a finger pokes
 * them. Moving the panel is the job of this handle - a small bar under the
 * panel, the way a Horizon panel has one.
 *
 * The bar is a separate object in the scene. Pointing at it and holding the
 * trigger or the grip takes the panel: the panel follows the pointer along
 * the ray, keeping the distance where it was caught, and the bar travels with
 * it. On release the panel turns towards the user again.
 *
 * The drag is handled here rather than by a `DistanceGrabbable` handle
 * because that handle would swallow the panel's button clicks, and the
 * direct-grip handle needs the controller to be within 7 cm of the bar.
 *
 * A phone in AR has no controllers. There the DOM touch, forwarded into the
 * scene by the canvas pointer system, is the only pointer that reaches the
 * bar: pressing it takes the panel, dragging moves it along the finger's ray
 * exactly like the controller drag, and the release is also watched on the
 * document so the panel is never left "in the hand".
 */

import { createSystem, RayInteractable, type Entity, type Object3D } from '@iwsdk/core';
import { BoxGeometry, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { HAPTIC_GRAB, HAPTIC_RELEASE, pulseHaptics } from './haptics.js';

/** Where the bar sits under the panel, in the panel's own units. */
const BAR_OFFSET = new Vector3(0, -0.82, 0.04);
/** Bar size in metres (the bar is not scaled with the panel). */
const BAR_WIDTH = 0.26;
const BAR_HEIGHT = 0.014;
const BAR_DEPTH = 0.018;
/** Button index of the trigger (0) and the grip (1) on the gamepad layout. */
const TRIGGER_BUTTON = 0;
const GRIP_BUTTON = 1;

interface DragState {
  readonly hand: 'left' | 'right';
  /** Distance from the ray origin to the panel when the drag started. */
  readonly distance: number;
  /** The point on the panel that was grabbed, in world space. */
  readonly anchor: Vector3;
}

/** A ray that travels with a forwarded DOM pointer. */
interface PointerRay {
  origin: Vector3;
  direction: Vector3;
}

interface TouchDragState {
  /** Distance from the camera ray origin to the caught point. */
  distance: number;
  /** The point on the panel that was grabbed, in world space. */
  anchor: Vector3;
  /** The latest ray through the finger, updated on every move. */
  ray: PointerRay;
  /** The id of the forwarded pointer that started the drag. */
  readonly pointerId: string | number;
  /** The raw DOM pointer id, used by the release fallback below. */
  readonly domPointerId: number;
}

/** The fields of a forwarded pmndrs pointer event that this system reads. */
interface ForwardedPointerEvent {
  pointerType?: string;
  pointerId?: string | number;
  nativeEvent?: { pointerId?: number };
  point?: Vector3;
  ray?: PointerRay;
}

export class PanelGrabSystem extends createSystem({}) {
  private panel: Object3D | undefined;
  private bar: Entity | undefined;
  private barMesh: Object3D | undefined;
  private drag: DragState | undefined;
  /** A drag held by a forwarded DOM pointer (a phone touch, an emulator mouse). */
  private touchDrag: TouchDragState | undefined;
  /** The pointer that is currently holding the bar. */
  private hand: 'left' | 'right' = 'right';

  /** Show the bar only while a session is running; on the desktop the panel
   * is a screen space overlay and the bar would float in the scene. */
  setVisible(visible: boolean): void {
    const bar = this.bar?.object3D;
    if (bar) bar.visible = visible;
  }

  init(): void {
    const world = this.world;
    this.panel = world.getSceneObject('agent-panel');
    if (!this.panel) return;
    const mesh = new Mesh(
      new BoxGeometry(BAR_WIDTH, BAR_HEIGHT, BAR_DEPTH),
      new MeshStandardMaterial({ color: 0x8f959b, roughness: 0.45, metalness: 0.15 }),
    );
    mesh.name = 'panel-grab-bar';
    // The bar belongs to the world space panel in an immersive session. On the
    // desktop the panel is a screen space overlay, so the bar must not be
    // created visible: it used to sit in the room as a grey strip until the
    // first mode change hid it.
    mesh.visible = false;
    const entity = world.createTransformEntity(mesh);
    entity.addComponent(RayInteractable);
    this.bar = entity;
    this.barMesh = mesh;
    this.attachTouchDrag(mesh);
    this.park();
  }

  update(): void {
    const panel = this.panel;
    const bar = this.barMesh;
    if (!panel || !bar) return;
    const gamepads = this.world.input.xr?.gamepads;

    if (!this.drag) {
      for (const hand of ['left', 'right'] as const) {
        const pad = gamepads?.[hand];
        if (!pad) continue;
        const held = pad.getButtonPressedByIdx(TRIGGER_BUTTON) || pad.getButtonPressedByIdx(GRIP_BUTTON);
        if (!held) continue;
        const pointer = this.world.input.xr?.multiPointers?.[hand]?.getPointer('ray');
        const hit = pointer?.getIntersection();
        const ray = this.rayOf(pointer);
        if (!hit || !ray || !this.isBar(hit.object)) continue;
        const anchor = hit.point.clone();
        this.drag = { hand, distance: anchor.distanceTo(ray.origin), anchor };
        this.hand = hand;
        pulseHaptics(this.world, hand, HAPTIC_GRAB);
        break;
      }
    } else {
      const pad = gamepads?.[this.drag.hand];
      const held = pad
        ? pad.getButtonPressedByIdx(TRIGGER_BUTTON) || pad.getButtonPressedByIdx(GRIP_BUTTON)
        : false;
      if (!held) {
        this.drag = undefined;
        pulseHaptics(this.world, this.hand, HAPTIC_RELEASE);
        this.faceTheUser();
      } else {
        this.move();
      }
    }

    this.park();
  }

  /** Move the panel so the grabbed point stays under the pointer. */
  private move(): void {
    const drag = this.drag;
    const panel = this.panel;
    if (!drag || !panel) return;
    const pointer = this.world.input.xr?.multiPointers?.[drag.hand]?.getPointer('ray');
    const ray = this.rayOf(pointer);
    if (!ray) return;
    this.moveAlongRay(drag, ray, panel);
  }

  /**
   * Move the panel so the grabbed point stays at `drag.distance` along the
   * given ray - the shared geometry of the controller and the touch drag.
   */
  private moveAlongRay(
    drag: { readonly distance: number; readonly anchor: Vector3 },
    ray: { origin: Vector3; direction: Vector3 },
    panel: Object3D,
  ): void {
    const target = ray.origin.clone().addScaledVector(ray.direction, drag.distance);
    const delta = target.sub(drag.anchor);
    if (delta.lengthSq() > 0) {
      panel.position.add(delta);
      panel.updateMatrixWorld(true);
      drag.anchor.add(delta);
    }
  }

  /** Put the bar back under the panel. */
  private park(): void {
    const panel = this.panel;
    const bar = this.bar;
    if (!panel || !bar?.object3D) return;
    const target = panel.localToWorld(BAR_OFFSET.clone());
    bar.object3D.position.copy(target);
    bar.object3D.quaternion.copy(panel.getWorldQuaternion(new Quaternion()));
    bar.object3D.updateMatrixWorld(true);
  }

  /** Turn the panel back towards the user after it was dragged around. */
  private faceTheUser(): void {
    const panel = this.panel;
    const head = this.world.player?.head;
    if (!panel || !head) return;
    const headPosition = head.getWorldPosition(new Vector3());
    panel.lookAt(headPosition);
    panel.updateMatrixWorld(true);
  }

  /** Is the object under the pointer the grab bar? */
  private isBar(object: Object3D): boolean {
    let node: Object3D | null = object;
    while (node) {
      if (node === this.barMesh) return true;
      node = node.parent;
    }
    return false;
  }

  /** The ray behind a pointer. */
  private rayOf(pointer: unknown): { origin: Vector3; direction: Vector3 } | undefined {
    const intersector = (pointer as { intersector?: { raycaster?: { ray?: { origin: Vector3; direction: Vector3 } } } })
      ?.intersector;
    return intersector?.raycaster?.ray;
  }

  /**
   * Watch the forwarded DOM pointer ('screen-touch', 'screen-mouse') that the
   * canvas pointer system emits during a phone AR session. Touches work here
   * because a forwarded pointer events bubble up from whatever object is
   * under them - and a touch drag must also survive the finger leaving the
   * 26 mm wide bar on its first millimetre of movement.
   */
  private attachTouchDrag(mesh: Object3D): void {
    // three's own event map only knows added/removed/childadded/childremoved,
    // so the listeners are attached through the EventDispatcher API directly.
    const target = mesh as unknown as {
      addEventListener(type: string, listener: (event: unknown) => void): void;
    };
    const scene = this.world.scene as unknown as typeof target;
    const down = (event: unknown): void => this.onTouchDown(event);
    const move = (event: unknown): void => this.onTouchMove(event);
    const end = (event: unknown): void => this.onTouchEnd(event);
    target.addEventListener('pointerdown', down);
    // The scene root sees moves and releases even when the finger has left
    // the bar and is now over another object: the event bubbles to it.
    scene.addEventListener('pointermove', move);
    scene.addEventListener('pointerup', end);
    scene.addEventListener('pointercancel', end);
    // A scene event is only routed while the pointer still intersects the
    // scene at all. The raw DOM release below makes sure a drag can never be
    // left half-held: nothing dies silently, the panel always comes back.
    document.addEventListener('pointerup', this.onDomPointerEnd, { passive: true });
    document.addEventListener('pointercancel', this.onDomPointerEnd, { passive: true });
  }

  /** Start a touch drag when a forwarded screen pointer presses the bar. */
  private onTouchDown(raw: unknown): void {
    if (this.drag || this.touchDrag) return;
    const event = raw as ForwardedPointerEvent;
    // Controller rays ('ray-left' and friends) belong to the gamepad path
    // above; only the forwarded camera pointer is handled here.
    if (!event.pointerType?.startsWith('screen-')) return;
    const ray = event.ray;
    const point = event.point;
    const domPointerId = event.nativeEvent?.pointerId;
    if (!ray || !point || typeof domPointerId !== 'number') return;
    this.touchDrag = {
      distance: point.distanceTo(ray.origin),
      anchor: point.clone(),
      ray: { origin: ray.origin.clone(), direction: ray.direction.clone() },
      pointerId: event.pointerId ?? '',
      domPointerId,
    };
    this.hand = 'right';
    // A phone has no controllers, so the grab pulse is a no-op there.
    pulseHaptics(this.world, 'right', HAPTIC_GRAB);
  }

  /** Update the stored ray and re-place the panel while the finger moves. */
  private onTouchMove(raw: unknown): void {
    const drag = this.touchDrag;
    if (!drag || (raw as ForwardedPointerEvent).pointerId !== drag.pointerId) return;
    const ray = (raw as ForwardedPointerEvent).ray;
    if (!ray) return;
    drag.ray.origin.copy(ray.origin);
    drag.ray.direction.copy(ray.direction);
    const panel = this.panel;
    if (panel) this.moveAlongRay(drag, drag.ray, panel);
  }

  /** End a touch drag when the pointer that started it is released. */
  private onTouchEnd(raw: unknown): void {
    const drag = this.touchDrag;
    if (!drag || (raw as ForwardedPointerEvent).pointerId !== drag.pointerId) return;
    this.endTouchDrag();
  }

  /** Document-level fallback for a release that misses the scene. */
  private readonly onDomPointerEnd = (event: PointerEvent): void => {
    const drag = this.touchDrag;
    if (!drag || event.pointerId !== drag.domPointerId) return;
    this.endTouchDrag();
  };

  private endTouchDrag(): void {
    this.touchDrag = undefined;
    pulseHaptics(this.world, 'right', HAPTIC_RELEASE);
    this.faceTheUser();
  }
}
