/**
 * Grabbable props and invisible static colliders for the reading room.
 *
 * Physics note: `PhysicsShape` `Auto` derives its dimensions from the mesh
 * geometry, not from the node transform, so every collider bakes its real
 * size into the geometry. That is also why the room keeps its decoration in
 * one asset while the surfaces props rest on are separate scene nodes.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  type Object3D,
} from '@iwsdk/core';

/** Invisible box used as a static physics surface. */
function createCollider(
  name: string,
  width: number,
  height: number,
  depth: number,
): Object3D {
  const material = new MeshStandardMaterial({ color: 0x808080 });
  material.visible = false;
  const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
  mesh.name = name;
  return mesh;
}

/** Floor of the virtual room. The player walks on `locomotion-floor`. */
export function createRoomFloorCollider(): Object3D {
  return createCollider('room-collider-floor', 6.4, 0.2, 7.8);
}

/** Top of the coffee table. */
export function createTableCollider(): Object3D {
  return createCollider('room-collider-table', 1.3, 0.06, 0.72);
}

/** Whole sideboard body, so props rest on its top rather than inside it. */
export function createSideboardCollider(): Object3D {
  return createCollider('room-collider-sideboard', 1.76, 0.78, 0.46);
}

/** Sofa body up to seat height. */
export function createSofaCollider(): Object3D {
  return createCollider('room-collider-sofa', 0.98, 0.58, 2.12);
}

const pageMaterial = new MeshStandardMaterial({
  color: 0xe9dfc8,
  roughness: 1,
});

/**
 * Hardback book: a coloured cover around a slightly inset page block.
 * Width runs along x, thickness along y, depth along z.
 */
export function createBook(
  color: number,
  width = 0.22,
  thickness = 0.036,
  depth = 0.16,
): Object3D {
  const group = new Group();
  group.name = 'prop-book';

  const cover = new Mesh(
    new BoxGeometry(width, thickness, depth),
    new MeshStandardMaterial({ color, roughness: 0.72 }),
  );
  cover.name = 'prop-book-cover';
  group.add(cover);

  // Pages sit inset on three sides and end flush with the spine at -x.
  const pages = new Mesh(
    new BoxGeometry(width - 0.018, thickness - 0.008, depth - 0.012),
    pageMaterial,
  );
  pages.name = 'prop-book-pages';
  pages.position.x = 0.006;
  group.add(pages);

  return group;
}

/** Soft square cushion. */
export function createCushion(color: number): Object3D {
  const mesh = new Mesh(
    new BoxGeometry(0.42, 0.13, 0.42),
    new MeshStandardMaterial({ color, roughness: 1 }),
  );
  mesh.name = 'prop-cushion';
  return mesh;
}

/** Stoneware mug with a side handle. */
export function createMug(): Object3D {
  const group = new Group();
  group.name = 'prop-mug';

  const body = new Mesh(
    new CylinderGeometry(0.045, 0.04, 0.1, 22),
    new MeshStandardMaterial({ color: 0xdfd6c4, roughness: 0.55 }),
  );
  body.name = 'prop-mug-body';
  group.add(body);

  const handle = new Mesh(
    new TorusGeometry(0.031, 0.008, 8, 18),
    new MeshStandardMaterial({ color: 0xdfd6c4, roughness: 0.55 }),
  );
  handle.name = 'prop-mug-handle';
  handle.position.set(0.05, 0.005, 0);
  handle.rotation.y = Math.PI / 2;
  group.add(handle);

  return group;
}

/** Tall ceramic vase. */
export function createVase(): Object3D {
  const group = new Group();
  group.name = 'prop-vase';
  const glaze = new MeshStandardMaterial({
    color: 0x4d6f6b,
    roughness: 0.28,
    metalness: 0.05,
  });

  const body = new Mesh(new CylinderGeometry(0.058, 0.075, 0.2, 24), glaze);
  body.name = 'prop-vase-body';
  group.add(body);

  const neck = new Mesh(new CylinderGeometry(0.032, 0.05, 0.09, 24), glaze);
  neck.name = 'prop-vase-neck';
  neck.position.y = 0.14;
  group.add(neck);

  const rim = new Mesh(new CylinderGeometry(0.038, 0.034, 0.014, 24), glaze);
  rim.name = 'prop-vase-rim';
  rim.position.y = 0.19;
  group.add(rim);

  return group;
}

/** Polished brass sphere: the easiest way to feel the physics. */
export function createBrassSphere(): Object3D {
  const mesh = new Mesh(
    new SphereGeometry(0.07, 24, 16),
    new MeshStandardMaterial({ color: 0xb08d57, roughness: 0.22, metalness: 0.9 }),
  );
  mesh.name = 'prop-brass-sphere';
  return mesh;
}

/** Small walnut keepsake box with a brass lid line. */
export function createKeepsakeBox(): Object3D {
  const group = new Group();
  group.name = 'prop-keepsake-box';

  const body = new Mesh(
    new BoxGeometry(0.16, 0.1, 0.16),
    new MeshStandardMaterial({ color: 0x4a3626, roughness: 0.6 }),
  );
  body.name = 'prop-keepsake-body';
  group.add(body);

  const lid = new Mesh(
    new BoxGeometry(0.17, 0.02, 0.17),
    new MeshStandardMaterial({ color: 0x5a422e, roughness: 0.5 }),
  );
  lid.name = 'prop-keepsake-lid';
  lid.position.y = 0.06;
  group.add(lid);

  const latch = new Mesh(
    new BoxGeometry(0.03, 0.03, 0.006),
    new MeshStandardMaterial({ color: 0xb08d57, roughness: 0.3, metalness: 0.9 }),
  );
  latch.name = 'prop-keepsake-latch';
  latch.position.set(0, 0.03, 0.086);
  group.add(latch);

  return group;
}
