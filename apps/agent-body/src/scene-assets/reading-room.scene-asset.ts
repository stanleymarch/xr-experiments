/**
 * Procedural "reading room" used by desktop and immersive-vr presentation.
 * The runtime entry system hides this asset for immersive-ar passthrough.
 *
 * Contract: parentless, deterministic, Y-up, floor at y=0, 6.4 x 7.8 m
 * interior, 3 m ceiling. The room is decoration only: every piece that the
 * user can pick up lives in the scene document as its own entity with a
 * physics body, and the few surfaces props rest on get invisible static
 * colliders there.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  type Object3D,
} from '@iwsdk/core';

/** Interior extents in metres. */
export const ROOM = {
  minX: -3.2,
  maxX: 3.2,
  minZ: -5.2,
  maxZ: 2.6,
  height: 3,
  centerZ: -1.3,
} as const;

/** Top surface of the pieces props rest on, shared with the scene document. */
export const FURNITURE = {
  tableTopY: 0.45,
  tableCenter: [-0.35, 0.42, -2.6] as const,
  tableSize: [1.3, 0.72] as const,
  sideboardTopY: 0.78,
  sideboardCenter: [0.55, 0, -4.92] as const,
  sideboardSize: [1.76, 0.46] as const,
  sofaSeatY: 0.58,
  sofaCenter: [1.35, 0, -2.6] as const,
  sofaSize: [0.98, 2.12] as const,
  armchairCenter: [-2.05, 0, -2.6] as const,
} as const;

const PALETTE = {
  floor: 0x7d5b3c,
  plankSeam: 0x5b4029,
  rug: 0x2f4a46,
  rugBorder: 0x223532,
  wall: 0xe8e2d6,
  accentWall: 0x2c4136,
  ceiling: 0xf2eee7,
  walnut: 0x4a3626,
  darkWalnut: 0x3a2a1d,
  brass: 0xb08d57,
  rust: 0xa9603f,
  rustLight: 0xc47a52,
  linen: 0xcfc1a9,
  moss: 0x8a9a7b,
  sage: 0x63735a,
  glass: 0xd7e8f6,
  frame: 0x2b2620,
} as const;

const BOOK_COLORS = [
  0xb44a3a, 0xd08b3c, 0x3f6b64, 0xd8c9a8, 0x2f3e5c, 0x8a5a44, 0x6d7f4b, 0xc9b48f,
] as const;

const materialCache = new Map<string, MeshStandardMaterial>();

/** Shared standard material; keyed so repeated colours reuse one instance. */
function standard(
  color: number,
  roughness = 0.85,
  metalness = 0,
  emissive?: number,
  emissiveIntensity = 1,
): MeshStandardMaterial {
  const key = `${color}:${roughness}:${metalness}:${emissive ?? 0}:${emissiveIntensity}`;
  const cached = materialCache.get(key);
  if (cached) return cached;
  const material = new MeshStandardMaterial({
    color,
    roughness,
    metalness,
    emissive: emissive ?? 0x000000,
    emissiveIntensity,
  });
  materialCache.set(key, material);
  return material;
}

function addBox(
  parent: Object3D,
  name: string,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  material: MeshStandardMaterial,
  rotationDeg: readonly [number, number, number] = [0, 0, 0],
): Mesh {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(
    (rotationDeg[0] * Math.PI) / 180,
    (rotationDeg[1] * Math.PI) / 180,
    (rotationDeg[2] * Math.PI) / 180,
  );
  parent.add(mesh);
  return mesh;
}

function addPlane(
  parent: Object3D,
  name: string,
  size: readonly [number, number],
  position: readonly [number, number, number],
  rotationDeg: readonly [number, number, number],
  material: MeshStandardMaterial,
): Mesh {
  const mesh = new Mesh(new PlaneGeometry(size[0], size[1]), material);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(
    (rotationDeg[0] * Math.PI) / 180,
    (rotationDeg[1] * Math.PI) / 180,
    (rotationDeg[2] * Math.PI) / 180,
  );
  parent.add(mesh);
  return mesh;
}

function addCylinder(
  parent: Object3D,
  name: string,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  position: readonly [number, number, number],
  material: MeshStandardMaterial,
  segments = 16,
): Mesh {
  const mesh = new Mesh(
    new CylinderGeometry(radiusTop, radiusBottom, height, segments),
    material,
  );
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  parent.add(mesh);
  return mesh;
}

/** Deterministic, tiny LCG so the bookshelf looks identical every load. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Floor planks, walls, ceiling, window wall and light strips. */
function buildShell(root: Group): void {
  const width = ROOM.maxX - ROOM.minX;
  const depth = ROOM.maxZ - ROOM.minZ;

  addPlane(
    root,
    'reading-room-floor',
    [width, depth],
    [0, 0, ROOM.centerZ],
    [-90, 0, 0],
    standard(PALETTE.floor, 0.72),
  );

  // Plank seams: cheap geometry, and they give the floor a sense of scale.
  for (let x = ROOM.minX + 0.8; x < ROOM.maxX; x += 0.8) {
    addPlane(
      root,
      'reading-room-plank-seam',
      [0.012, depth],
      [x, 0.002, ROOM.centerZ],
      [-90, 0, 0],
      standard(PALETTE.plankSeam, 0.9),
    );
  }

  addPlane(
    root,
    'reading-room-wall-back',
    [width, ROOM.height],
    [0, ROOM.height / 2, ROOM.minZ],
    [0, 0, 0],
    standard(PALETTE.accentWall, 0.95),
  );
  addPlane(
    root,
    'reading-room-wall-front',
    [width, ROOM.height],
    [0, ROOM.height / 2, ROOM.maxZ],
    [0, 180, 0],
    standard(PALETTE.wall, 0.95),
  );
  addPlane(
    root,
    'reading-room-wall-left',
    [depth, ROOM.height],
    [ROOM.minX, ROOM.height / 2, ROOM.centerZ],
    [0, 90, 0],
    standard(PALETTE.wall, 0.95),
  );

  addPlane(
    root,
    'reading-room-ceiling',
    [width, depth],
    [0, ROOM.height, ROOM.centerZ],
    [90, 0, 0],
    standard(PALETTE.ceiling, 0.95),
  );

  // Light strips: emissive bands that read as recessed ceiling lighting.
  for (const x of [-1.5, 1.5]) {
    addBox(
      root,
      'reading-room-ceiling-strip',
      [0.1, 0.02, 2.6],
      [x, ROOM.height - 0.012, -2.4],
      standard(0xfff1d8, 0.4, 0, 0xffe6bd, 0.9),
    );
  }

  // Pendant over the coffee table: cord, shade and a warm bulb glow.
  const [tableX, , tableZ] = FURNITURE.tableCenter;
  addCylinder(
    root,
    'reading-room-pendant-cord',
    0.006,
    0.006,
    0.62,
    [tableX, ROOM.height - 0.31, tableZ],
    standard(0x2b2b2b, 0.6),
    8,
  );
  addCylinder(
    root,
    'reading-room-pendant-shade',
    0.085,
    0.23,
    0.2,
    [tableX, 2.28, tableZ],
    standard(0x39433a, 0.6, 0.15, 0xffcf94, 0.25),
    28,
  );
  const bulb = new Mesh(
    new SphereGeometry(0.045, 16, 12),
    standard(0xfff2d8, 0.4, 0, 0xffdfae, 1.1),
  );
  bulb.name = 'reading-room-pendant-bulb';
  bulb.position.set(tableX, 2.2, tableZ);
  root.add(bulb);

  // Window wall. Solid strips top and bottom, a solid panel on each end and
  // posts between three tall panes facing +x.
  addBox(
    root,
    'reading-room-window-wall-bottom',
    [0.08, 0.95, depth],
    [ROOM.maxX, 0.475, ROOM.centerZ],
    standard(PALETTE.wall, 0.95),
  );
  addBox(
    root,
    'reading-room-window-wall-top',
    [0.08, 0.55, depth],
    [ROOM.maxX, ROOM.height - 0.275, ROOM.centerZ],
    standard(PALETTE.wall, 0.95),
  );
  addBox(
    root,
    'reading-room-window-wall-near',
    [0.08, ROOM.height, 3.0],
    [ROOM.maxX, ROOM.height / 2, 1.1],
    standard(PALETTE.wall, 0.95),
  );
  addBox(
    root,
    'reading-room-window-wall-far',
    [0.08, ROOM.height, 0.6],
    [ROOM.maxX, ROOM.height / 2, -4.9],
    standard(PALETTE.wall, 0.95),
  );

  const windowEdges = [-4.6, -3.2, -1.8, -0.4];
  for (const z of windowEdges) {
    addBox(
      root,
      'reading-room-window-post',
      [0.1, 1.5, 0.12],
      [ROOM.maxX, 1.7, z],
      standard(PALETTE.wall, 0.9),
    );
  }

  for (let i = 0; i < windowEdges.length - 1; i += 1) {
    const z = (windowEdges[i] + windowEdges[i + 1]) / 2;
    addPlane(
      root,
      'reading-room-window-pane',
      [1.28, 1.5],
      [ROOM.maxX - 0.02, 1.7, z],
      [0, -90, 0],
      standard(0xa9c8e8, 0.12, 0, 0x9dc0e6, 0.22),
    );
    // A garden band at the bottom of each pane so the window reads as a view
    // rather than a glowing white rectangle.
    addPlane(
      root,
      'reading-room-window-garden',
      [1.28, 0.34],
      [ROOM.maxX - 0.03, 1.12, z],
      [0, -90, 0],
      standard(0x6f8763, 0.95),
    );
  }

  addBox(
    root,
    'reading-room-window-sill',
    [0.16, 0.05, 4.3],
    [ROOM.maxX - 0.06, 0.955, -2.5],
    standard(PALETTE.walnut, 0.6),
  );

  // Linen curtains flanking the window run.
  for (const z of [-4.72, -0.28]) {
    addBox(
      root,
      'reading-room-curtain',
      [0.06, 2.4, 0.5],
      [ROOM.maxX - 0.16, 1.4, z],
      standard(0xcdbfa8, 1),
    );
  }

  // Baseboards.
  addBox(
    root,
    'reading-room-baseboard-front',
    [width, 0.11, 0.04],
    [0, 0.055, ROOM.maxZ - 0.02],
    standard(PALETTE.darkWalnut, 0.9),
  );
  addBox(
    root,
    'reading-room-baseboard-back',
    [width, 0.11, 0.04],
    [0, 0.055, ROOM.minZ + 0.02],
    standard(PALETTE.darkWalnut, 0.9),
  );
  addBox(
    root,
    'reading-room-baseboard-left',
    [0.04, 0.11, depth],
    [ROOM.minX + 0.02, 0.055, ROOM.centerZ],
    standard(PALETTE.darkWalnut, 0.9),
  );
}

/** Rug under the seating group. */
function buildRug(root: Group): void {
  addBox(
    root,
    'reading-room-rug-border',
    [3.7, 0.012, 3.1],
    [-0.4, 0.006, -2.6],
    standard(PALETTE.rugBorder, 1),
  );
  addBox(
    root,
    'reading-room-rug',
    [3.5, 0.012, 2.9],
    [-0.4, 0.014, -2.6],
    standard(PALETTE.rug, 1),
  );
}

/** Floor-to-ceiling bookcase against the left wall, with decorative books. */
function buildBookcase(root: Group): void {
  const backX = ROOM.minX + 0.02;
  const depth = 0.34;
  const frontX = ROOM.minX + 0.34;
  const centerX = (backX + frontX) / 2;
  const zFrom = -4.9;
  const zTo = -1.7;
  const centerZ = (zFrom + zTo) / 2;
  const widthZ = zTo - zFrom;
  const height = 2.5;
  const boardThickness = 0.035;

  addBox(
    root,
    'reading-room-bookcase-back',
    [0.02, height, widthZ],
    [backX, height / 2, centerZ],
    standard(PALETTE.darkWalnut, 0.9),
  );
  for (const z of [zFrom, zTo]) {
    addBox(
      root,
      'reading-room-bookcase-side',
      [depth, height, 0.03],
      [centerX, height / 2, z],
      standard(PALETTE.walnut, 0.8),
    );
  }

  const boards = [0.1, 0.68, 1.26, 1.84, 2.44];
  for (const y of boards) {
    addBox(
      root,
      'reading-room-bookcase-board',
      [depth, boardThickness, widthZ],
      [centerX, y, centerZ],
      standard(PALETTE.walnut, 0.8),
    );
  }

  const random = createRandom(20261021);
  const bookDepth = 0.2;
  const bookX = frontX - bookDepth / 2 - 0.02;

  for (let board = 0; board < boards.length - 1; board += 1) {
    const baseY = boards[board] + boardThickness / 2;
    const topY = boards[board + 1] - boardThickness / 2;
    let z = zFrom + 0.06;
    let index = 0;
    while (z < zTo - 0.12) {
      if (random() < 0.14) {
        z += 0.08 + random() * 0.08;
        continue;
      }
      const bookWidth = 0.026 + random() * 0.03;
      const bookHeight = Math.min(
        topY - baseY - 0.02,
        0.24 + random() * 0.1,
      );
      const color = BOOK_COLORS[Math.floor(random() * BOOK_COLORS.length)];
      addBox(
        root,
        'reading-room-book',
        [bookDepth, bookHeight, bookWidth],
        [bookX, baseY + bookHeight / 2, z + bookWidth / 2],
        standard(color, 0.82),
      );
      index += 1;
      z += bookWidth + 0.003;
    }

    // One flat stack lying on top of the row for variety.
    if (board < 2) {
      const stackHeight = 0.08;
      addBox(
        root,
        'reading-room-book-stack',
        [bookDepth, stackHeight, 0.24],
        [bookX, baseY + stackHeight / 2, zTo - 0.28],
        standard(BOOK_COLORS[(board + 3) % BOOK_COLORS.length], 0.82),
      );
    }
    void index;
  }
}

/** Rust sofa facing the coffee table, with a walnut frame and brass feet. */
function buildSofa(root: Group): void {
  const [x, , z] = FURNITURE.sofaCenter;
  const [width, depth] = FURNITURE.sofaSize;

  addBox(
    root,
    'reading-room-sofa-base',
    [width, 0.34, depth],
    [x, 0.25, z],
    standard(PALETTE.rust, 0.95),
  );
  addBox(
    root,
    'reading-room-sofa-seat-a',
    [width - 0.08, 0.16, depth / 2 - 0.04],
    [x - 0.02, 0.5, z - depth / 4],
    standard(PALETTE.rustLight, 1),
  );
  addBox(
    root,
    'reading-room-sofa-seat-b',
    [width - 0.08, 0.16, depth / 2 - 0.04],
    [x - 0.02, 0.5, z + depth / 4],
    standard(PALETTE.rustLight, 1),
  );
  addBox(
    root,
    'reading-room-sofa-back',
    [0.22, 0.62, depth],
    [x + width / 2 - 0.03, 0.75, z],
    standard(PALETTE.rust, 0.95),
  );
  for (const offset of [-1, 1]) {
    addBox(
      root,
      'reading-room-sofa-back-cushion',
      [0.16, 0.42, depth / 2 - 0.14],
      [x + width / 2 - 0.18, 0.78, z + (offset * depth) / 4],
      standard(PALETTE.rustLight, 1),
    );
    addBox(
      root,
      'reading-room-sofa-arm',
      [width, 0.2, 0.16],
      [x, 0.6, z + (offset * (depth - 0.16)) / 2],
      standard(PALETTE.rust, 0.95),
    );
  }
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      addCylinder(
        root,
        'reading-room-sofa-foot',
        0.025,
        0.025,
        0.09,
        [x + (dx * (width - 0.16)) / 2, 0.045, z + (dz * (depth - 0.2)) / 2],
        standard(PALETTE.brass, 0.35, 0.85),
        10,
      );
    }
  }
}

/** Low walnut coffee table with a slim brass frame. */
function buildCoffeeTable(root: Group): void {
  const [x, , z] = FURNITURE.tableCenter;
  const [width, depth] = FURNITURE.tableSize;

  addBox(
    root,
    'reading-room-table-top',
    [width, 0.06, depth],
    [x, FURNITURE.tableTopY - 0.03, z],
    standard(PALETTE.walnut, 0.55),
  );
  addBox(
    root,
    'reading-room-table-apron',
    [width - 0.12, 0.07, depth - 0.12],
    [x, FURNITURE.tableTopY - 0.09, z],
    standard(PALETTE.darkWalnut, 0.7),
  );
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      addCylinder(
        root,
        'reading-room-table-leg',
        0.022,
        0.022,
        FURNITURE.tableTopY - 0.06,
        [
          x + (dx * (width - 0.16)) / 2,
          (FURNITURE.tableTopY - 0.06) / 2,
          z + (dz * (depth - 0.14)) / 2,
        ],
        standard(PALETTE.brass, 0.35, 0.85),
        10,
      );
    }
  }
}

/** Sage armchair on the opposite side of the table, facing +x. */
function buildArmchair(root: Group): void {
  const chair = new Group();
  chair.name = 'reading-room-armchair';
  const [x, , z] = FURNITURE.armchairCenter;
  chair.position.set(x, 0, z);
  chair.rotation.y = Math.PI / 2;

  addBox(
    chair,
    'reading-room-armchair-base',
    [0.84, 0.26, 0.82],
    [0, 0.25, 0],
    standard(PALETTE.sage, 0.95),
  );
  addBox(
    chair,
    'reading-room-armchair-cushion',
    [0.72, 0.14, 0.7],
    [0, 0.45, 0.01],
    standard(PALETTE.linen, 1),
  );
  addBox(
    chair,
    'reading-room-armchair-back',
    [0.84, 0.5, 0.14],
    [0, 0.63, -0.34],
    standard(PALETTE.sage, 0.95),
  );
  addBox(
    chair,
    'reading-room-armchair-back-cushion',
    [0.7, 0.38, 0.1],
    [0, 0.59, -0.24],
    standard(PALETTE.linen, 1),
  );
  for (const dx of [-1, 1]) {
    addBox(
      chair,
      'reading-room-armchair-arm',
      [0.12, 0.26, 0.82],
      [(dx * 0.96) / 2, 0.51, 0],
      standard(PALETTE.sage, 0.95),
    );
  }
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      addCylinder(
        chair,
        'reading-room-armchair-leg',
        0.02,
        0.02,
        0.12,
        [(dx * 0.66) / 2, 0.06, (dz * 0.64) / 2],
        standard(PALETTE.walnut, 0.5),
        8,
      );
    }
  }
  root.add(chair);
}

/** Walnut sideboard against the accent wall. */
function buildSideboard(root: Group): void {
  const [x, , z] = FURNITURE.sideboardCenter;
  const [width, depth] = FURNITURE.sideboardSize;
  const bodyHeight = 0.66;

  addBox(
    root,
    'reading-room-sideboard-body',
    [width, bodyHeight, depth],
    [x, 0.075 + bodyHeight / 2, z],
    standard(0x5a422e, 0.7),
  );
  addBox(
    root,
    'reading-room-sideboard-top',
    [width + 0.06, 0.045, depth + 0.04],
    [x, FURNITURE.sideboardTopY - 0.0225, z],
    standard(PALETTE.darkWalnut, 0.5),
  );
  for (const dx of [-1, 1]) {
    addBox(
      root,
      'reading-room-sideboard-door',
      [width / 2 - 0.06, bodyHeight - 0.1, 0.012],
      [x + (dx * (width / 4)), 0.075 + bodyHeight / 2, z + depth / 2 - 0.004],
      standard(0x4a3626, 0.6),
    );
    addCylinder(
      root,
      'reading-room-sideboard-handle',
      0.012,
      0.012,
      0.14,
      [x + dx * 0.12, 0.42, z + depth / 2 + 0.012],
      standard(PALETTE.brass, 0.3, 0.9),
      10,
    );
  }
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      addCylinder(
        root,
        'reading-room-sideboard-leg',
        0.018,
        0.018,
        0.075,
        [x + (dx * (width - 0.2)) / 2, 0.0375, z + (dz * (depth - 0.12)) / 2],
        standard(PALETTE.brass, 0.35, 0.85),
        8,
      );
    }
  }
}

/** Floor lamp beside the window with a warm shade. */
function buildFloorLamp(root: Group): void {
  const x = 2.6;
  const z = -4.5;

  addCylinder(
    root,
    'reading-room-lamp-base',
    0.17,
    0.17,
    0.025,
    [x, 0.013, z],
    standard(0x2b2b2b, 0.5, 0.6),
    24,
  );
  addCylinder(
    root,
    'reading-room-lamp-pole',
    0.015,
    0.015,
    1.5,
    [x, 0.78, z],
    standard(PALETTE.brass, 0.35, 0.85),
    10,
  );
  addCylinder(
    root,
    'reading-room-lamp-shade',
    0.15,
    0.23,
    0.3,
    [x, 1.62, z],
    standard(0xf0dfc2, 0.9, 0, 0xffd9a0, 0.22),
    24,
  );
}

/** Framed prints on the accent wall. */
function buildWallArt(root: Group): void {
  const frames: Array<{ x: number; y: number; w: number; h: number; art: number; accent: number }> = [
    { x: -1.75, y: 1.66, w: 0.66, h: 0.86, art: 0xc9b48f, accent: 0x8a6a4b },
    { x: -0.86, y: 1.56, w: 0.46, h: 0.58, art: 0x9fb3ad, accent: 0x3f5b55 },
  ];
  for (const frame of frames) {
    addBox(
      root,
      'reading-room-art-frame',
      [frame.w, frame.h, 0.04],
      [frame.x, frame.y, ROOM.minZ + 0.02],
      standard(PALETTE.frame, 0.6),
    );
    // Cream mat, then a two-tone print so the frames do not read as blank
    // rectangles from across the room.
    addPlane(
      root,
      'reading-room-art-mat',
      [frame.w - 0.07, frame.h - 0.07],
      [frame.x, frame.y, ROOM.minZ + 0.043],
      [0, 0, 0],
      standard(0xf0e9dc, 1),
    );
    addPlane(
      root,
      'reading-room-art-print',
      [frame.w * 0.54, frame.h * 0.6],
      [frame.x, frame.y + frame.h * 0.06, ROOM.minZ + 0.046],
      [0, 0, 0],
      standard(frame.art, 0.95),
    );
    addPlane(
      root,
      'reading-room-art-band',
      [frame.w * 0.54, frame.h * 0.14],
      [frame.x, frame.y - frame.h * 0.19, ROOM.minZ + 0.047],
      [0, 0, 0],
      standard(frame.accent, 0.95),
    );
  }
}

export function createReadingRoom(): Object3D {
  const root = new Group();
  // Kept as `vr-space` so the runtime entry system can hide the whole virtual
  // environment for immersive-ar passthrough with one lookup.
  root.name = 'vr-space';

  buildShell(root);
  buildRug(root);
  buildBookcase(root);
  buildSofa(root);
  buildCoffeeTable(root);
  buildArmchair(root);
  buildSideboard(root);
  buildFloorLamp(root);
  buildWallArt(root);

  return root;
}
