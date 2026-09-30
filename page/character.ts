import {
  Skeleton,
  type AnimationClip,
  type BoneSpec,
  type Quat,
  type SkinInfluence,
  type TriangleMesh,
  type Vec3,
} from '../src/index.js';

const IDENTITY: Quat = [0, 0, 0, 1];
const UNIT: Vec3 = [1, 1, 1];

function quatZ(angle: number): Quat {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

/** 页面用简易人形骨架：手臂沿 X 轴外展，便于展示挂件朝向。 */
export function pageBones(): BoneSpec[] {
  const bone = (id: string, parentId: string | null, t: Vec3): BoneSpec => ({
    id, parentId, translation: t, rotation: IDENTITY, scale: UNIT,
  });
  return [
    bone('hips', null, [0, 1, 0]),
    bone('spine', 'hips', [0, 0.2, 0]),
    bone('head', 'spine', [0, 0.3, 0]),
    bone('arm.L', 'spine', [-0.22, 0.15, 0]),
    bone('hand.L', 'arm.L', [-0.26, 0, 0]),
    bone('arm.R', 'spine', [0.22, 0.15, 0]),
    bone('hand.R', 'arm.R', [0.26, 0, 0]),
    bone('leg.L', 'hips', [0.1, 0, 0]),
    bone('leg.R', 'hips', [-0.1, 0, 0]),
  ];
}

interface BoxSpec {
  center: Vec3;
  size: Vec3;
  boneId: string;
}

const BOXES: BoxSpec[] = [
  { center: [0, 1.0, 0], size: [0.3, 0.18, 0.18], boneId: 'hips' },
  { center: [0, 1.32, 0], size: [0.34, 0.3, 0.2], boneId: 'spine' },
  { center: [0, 1.66, 0], size: [0.26, 0.26, 0.26], boneId: 'head' },
  { center: [-0.35, 1.35, 0], size: [0.26, 0.09, 0.09], boneId: 'arm.L' },
  { center: [-0.57, 1.35, 0], size: [0.18, 0.08, 0.08], boneId: 'hand.L' },
  { center: [0.35, 1.35, 0], size: [0.26, 0.09, 0.09], boneId: 'arm.R' },
  { center: [0.57, 1.35, 0], size: [0.18, 0.08, 0.08], boneId: 'hand.R' },
  { center: [0.1, 0.5, 0], size: [0.13, 1.0, 0.13], boneId: 'leg.L' },
  { center: [-0.1, 0.5, 0], size: [0.13, 1.0, 0.13], boneId: 'leg.R' },
];

/** 程序化三角网格人形：每个盒子 8 顶点 12 三角形，整体绑定到对应骨骼。 */
export function pageMesh(): TriangleMesh {
  const positions: Vec3[] = [];
  const indices: number[] = [];
  const weights: SkinInfluence[][] = [];
  // 头盒前面（+Z）四个顶点，供表情形变使用。
  const faceVertices: number[] = [];
  for (const box of BOXES) {
    const base = positions.length;
    const [cx, cy, cz] = box.center;
    const [sx, sy, sz] = [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2];
    const corners: Vec3[] = [
      [cx - sx, cy - sy, cz - sz], [cx + sx, cy - sy, cz - sz],
      [cx + sx, cy + sy, cz - sz], [cx - sx, cy + sy, cz - sz],
      [cx - sx, cy - sy, cz + sz], [cx + sx, cy - sy, cz + sz],
      [cx + sx, cy + sy, cz + sz], [cx - sx, cy + sy, cz + sz],
    ];
    positions.push(...corners);
    // 外向绕序的 12 个三角形。
    const quads: [number, number, number, number][] = [
      [4, 5, 6, 7], // +Z 前
      [1, 0, 3, 2], // -Z 后
      [5, 1, 2, 6], // +X 右
      [0, 4, 7, 3], // -X 左
      [7, 6, 2, 3], // +Y 顶
      [0, 1, 5, 4], // -Y 底
    ];
    for (const [a, b, c, d] of quads) {
      indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
    }
    for (let i = 0; i < 8; i++) weights.push([{ boneId: box.boneId, weight: 1 }]);
    if (box.boneId === 'head') {
      faceVertices.push(base + 4, base + 5, base + 6, base + 7); // 前：左下 右下 右上 左上
    }
  }
  const zero: Vec3 = [0, 0, 0];
  const morphField = (fill: (corner: number) => Vec3): Vec3[] => {
    const field: Vec3[] = positions.map(() => [...zero] as Vec3);
    faceVertices.forEach((vertexIndex, corner) => {
      field[vertexIndex] = fill(corner);
    });
    return field;
  };
  return {
    name: 'badge-character',
    positions,
    indices,
    weights,
    morphTargets: [
      {
        name: 'smile',
        // 嘴角（前下两顶点）向上向外。
        displacements: morphField((corner) =>
          corner === 0 ? [-0.03, 0.035, 0.01] : corner === 1 ? [0.03, 0.035, 0.01] : zero),
      },
      {
        name: 'blink',
        // 上眼睑（前上两顶点）下压。
        displacements: morphField((corner) =>
          corner === 2 || corner === 3 ? [0, -0.045, 0.005] : zero),
      },
      {
        name: 'surprise',
        // 整张脸前凸。
        displacements: morphField(() => [0, 0, 0.04]),
      },
    ],
  };
}

/** 身体动作 + 表情共用同一时钟的片段。 */
export function pageClip(): AnimationClip {
  return {
    name: 'walk-wave-face',
    duration: 1.2,
    tracks: [
      {
        boneId: 'hips',
        translations: [
          { time: 0, value: [0, 1, 0] },
          { time: 0.6, value: [0, 1.06, 0] },
          { time: 1.2, value: [0, 1, 0] },
        ],
      },
      {
        boneId: 'leg.L',
        rotations: [
          { time: 0, value: quatZ(0.45) },
          { time: 0.6, value: quatZ(-0.45) },
          { time: 1.2, value: quatZ(0.45) },
        ],
      },
      {
        boneId: 'leg.R',
        rotations: [
          { time: 0, value: quatZ(-0.45) },
          { time: 0.6, value: quatZ(0.45) },
          { time: 1.2, value: quatZ(-0.45) },
        ],
      },
      {
        boneId: 'arm.R',
        rotations: [
          { time: 0, value: quatZ(1.1) },
          { time: 0.6, value: quatZ(1.7) },
          { time: 1.2, value: quatZ(1.1) },
        ],
      },
      {
        boneId: 'hand.R',
        rotations: [
          { time: 0, value: quatZ(0.5) },
          { time: 0.6, value: quatZ(-0.5) },
          { time: 1.2, value: quatZ(0.5) },
        ],
      },
      {
        boneId: 'head',
        rotations: [
          { time: 0, value: quatZ(0.08) },
          { time: 0.6, value: quatZ(-0.08) },
          { time: 1.2, value: quatZ(0.08) },
        ],
      },
    ],
    morphTracks: [
      {
        targetName: 'smile',
        keys: [
          { time: 0, value: 0.2 },
          { time: 0.6, value: 1 },
          { time: 1.2, value: 0.2 },
        ],
      },
      {
        targetName: 'blink',
        keys: [
          { time: 0.1, value: 0 },
          { time: 0.2, value: 1 },
          { time: 0.3, value: 0 },
          { time: 0.9, value: 0 },
          { time: 1.0, value: 1 },
          { time: 1.1, value: 0 },
        ],
      },
      {
        targetName: 'surprise',
        keys: [
          { time: 0, value: 0 },
          { time: 0.4, value: 0.8 },
          { time: 0.8, value: 0 },
        ],
      },
    ],
  };
}

/** 一个完全独立的角色实例数据（骨架、网格、片段互不共享）。 */
export interface PageCharacterAsset {
  skeleton: Skeleton;
  mesh: TriangleMesh;
  clip: AnimationClip;
}

export function createPageCharacter(): PageCharacterAsset {
  return { skeleton: new Skeleton(pageBones()), mesh: pageMesh(), clip: pageClip() };
}
