import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from './types.js';

/**
 * 角色在世界中的摆放：平移、单位四元数旋转与**正的非均匀缩放**。
 * 与根运动刚体变换不同，这里允许每个分量独立的正缩放。
 */
export interface SurfaceTransform {
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** 屏幕/世界射线；方向允许非单位长度，内部归一化。 */
export interface SurfaceRay {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/** 射线命中结果：三角形序号、重心坐标与沿射线的距离。 */
export interface SurfaceHit {
  readonly triangleIndex: number;
  readonly barycentric: Vec3;
  readonly distance: number;
}

/** 单个挂件的逐帧世界姿态。 */
export interface AttachmentFrame {
  /** 重心插值位置 + 世界单位法向偏移。 */
  readonly position: Vec3;
  /** 变形后三角形首条边（v0 -> v1）的世界单位切向。 */
  readonly tangent: Vec3;
  /** 按顶点绕序（(v1-v0) x (v2-v0)）的世界单位法向。 */
  readonly normal: Vec3;
}

const DEGENERATE_EPSILON = 1e-12;
const BARYCENTRIC_EPSILON = 1e-6;

function assertVec3(v: readonly number[], what: string): void {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    throw new Error(what + ' 必须是三个有限数');
  }
}

/** 校验角色摆放：有限平移、单位四元数、正且有限的缩放分量。 */
export function assertSurfaceTransform(transform: SurfaceTransform): void {
  if (!transform || typeof transform !== 'object') throw new Error('角色变换缺失');
  assertVec3(transform.translation, '角色平移');
  const rotation = transform.rotation;
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every(Number.isFinite)) {
    throw new Error('角色旋转必须是四个有限数');
  }
  const len = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (Math.abs(len - 1) > 1e-3) throw new Error('角色旋转必须是单位四元数');
  assertVec3(transform.scale, '角色缩放');
  for (const component of transform.scale) {
    if (component <= 0) throw new Error('角色缩放分量必须为正数: ' + String(component));
  }
}

/** 由角色摆放组合世界矩阵（平移 x 旋转 x 缩放），不修改输入。 */
export function surfaceWorldMatrix(transform: SurfaceTransform): Matrix4 {
  assertSurfaceTransform(transform);
  const { translation, rotation, scale } = transform;
  return new Matrix4().compose(
    new Vector3(translation[0], translation[1], translation[2]),
    new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]),
    new Vector3(scale[0], scale[1], scale[2]),
  );
}

/**
 * 把“先形变后蒙皮”得到的角色空间顶点变换到世界空间。
 * 输入顶点不被修改，返回新数组；每次调用独立求值，不缓存实例状态。
 */
export function transformSurfacePositions(
  positions: readonly Vec3[],
  transform: SurfaceTransform,
): Vec3[] {
  const matrix = surfaceWorldMatrix(transform);
  const tmp = new Vector3();
  return positions.map((p, index) => {
    if (!p || !p.every(Number.isFinite)) throw new Error('顶点 ' + index + ' 含非法数值');
    tmp.set(p[0], p[1], p[2]).applyMatrix4(matrix);
    return [tmp.x, tmp.y, tmp.z] as Vec3;
  });
}

function validateBarycentric(barycentric: readonly number[]): Vec3 {
  if (!Array.isArray(barycentric) || barycentric.length !== 3
    || !barycentric.every(Number.isFinite)) {
    throw new Error('重心坐标必须是三个有限数');
  }
  const sum = barycentric[0] + barycentric[1] + barycentric[2];
  if (Math.abs(sum - 1) > BARYCENTRIC_EPSILON) {
    throw new Error('重心坐标之和必须为 1: ' + String(sum));
  }
  for (const component of barycentric) {
    if (component < -BARYCENTRIC_EPSILON) {
      throw new Error('重心坐标分量不能为负: ' + String(component));
    }
  }
  return [barycentric[0] / sum, barycentric[1] / sum, barycentric[2] / sum];
}

function triangleVertices(
  positions: readonly Vec3[],
  indices: readonly number[],
  triangleIndex: number,
): [Vec3, Vec3, Vec3] {
  if (!Number.isInteger(triangleIndex) || triangleIndex < 0
    || triangleIndex * 3 + 2 >= indices.length) {
    throw new Error('三角形序号越界: ' + String(triangleIndex));
  }
  const a = positions[indices[triangleIndex * 3]];
  const b = positions[indices[triangleIndex * 3 + 1]];
  const c = positions[indices[triangleIndex * 3 + 2]];
  if (!a || !b || !c) throw new Error('三角形 ' + triangleIndex + ' 引用了不存在的顶点');
  return [a, b, c];
}

/**
 * 在当前**世界空间变形结果**上拾取最近的正面三角形（Moller-Trumbore）。
 *
 * - 只命中传入的当前帧顶点，不使用绑定姿态或包围盒近似；
 * - 背面（射线与绕序法向同向）与退化（近零面积）三角形一律跳过；
 * - 未命中任何三角形时返回 null。
 */
export function pickSurfaceTriangle(
  positions: readonly Vec3[],
  indices: readonly number[],
  ray: SurfaceRay,
): SurfaceHit | null {
  if (!Array.isArray(positions) || !Array.isArray(indices)) {
    throw new Error('拾取缺少顶点或索引');
  }
  if (indices.length % 3 !== 0) throw new Error('三角索引长度必须是 3 的倍数');
  assertVec3(ray.origin, '射线原点');
  assertVec3(ray.direction, '射线方向');
  const dirLength = Math.hypot(ray.direction[0], ray.direction[1], ray.direction[2]);
  if (dirLength === 0) throw new Error('射线方向不能为零向量');
  const dir: Vec3 = [
    ray.direction[0] / dirLength,
    ray.direction[1] / dirLength,
    ray.direction[2] / dirLength,
  ];

  let best: SurfaceHit | null = null;
  for (let triangleIndex = 0; triangleIndex < indices.length / 3; triangleIndex++) {
    const [a, b, c] = triangleVertices(positions, indices, triangleIndex);
    const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    // p = dir x e2
    const px = dir[1] * e2[2] - dir[2] * e2[1];
    const py = dir[2] * e2[0] - dir[0] * e2[2];
    const pz = dir[0] * e2[1] - dir[1] * e2[0];
    const det = e1[0] * px + e1[1] * py + e1[2] * pz;
    // det <= 0：背面或射线与面平行；det 过小：退化面，统一跳过。
    if (det <= DEGENERATE_EPSILON) continue;
    const invDet = 1 / det;
    const tx = ray.origin[0] - a[0];
    const ty = ray.origin[1] - a[1];
    const tz = ray.origin[2] - a[2];
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < -BARYCENTRIC_EPSILON || u > 1 + BARYCENTRIC_EPSILON) continue;
    // q = tvec x e1
    const qx = ty * e1[2] - tz * e1[1];
    const qy = tz * e1[0] - tx * e1[2];
    const qz = tx * e1[1] - ty * e1[0];
    const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
    if (v < -BARYCENTRIC_EPSILON || u + v > 1 + BARYCENTRIC_EPSILON) continue;
    const distance = (e2[0] * qx + e2[1] * qy + e2[2] * qz) * invDet;
    if (distance <= DEGENERATE_EPSILON) continue;
    if (best && distance >= best.distance) continue;
    const w = 1 - u - v;
    best = {
      triangleIndex,
      barycentric: [Math.max(0, w), Math.max(0, u), Math.max(0, v)],
      distance,
    };
  }
  return best;
}

/**
 * 逐帧求值挂件世界姿态。
 *
 * 位置为重心坐标在当前世界顶点上的插值，再加 `offset` 个**世界单位**
 * 沿世界法向的偏移；切向取变形后首条边，法向按顶点绕序叉积。
 * 三角形当前退化（近零面积）时返回 null，调用方应隐藏挂件并保留记录，
 * 不得改挂到其他面。
 */
export function evaluateSurfaceAttachment(
  positions: readonly Vec3[],
  indices: readonly number[],
  triangleIndex: number,
  barycentric: readonly number[],
  offset = 0,
): AttachmentFrame | null {
  if (!Number.isFinite(offset)) throw new Error('挂件偏移必须是有限数: ' + String(offset));
  const weights = validateBarycentric(barycentric);
  const [a, b, c] = triangleVertices(positions, indices, triangleIndex);
  const e1: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const normalLength = Math.hypot(nx, ny, nz);
  const tangentLength = Math.hypot(e1[0], e1[1], e1[2]);
  if (normalLength <= DEGENERATE_EPSILON || tangentLength <= DEGENERATE_EPSILON) {
    return null; // 面退化：隐藏挂件，等待恢复。
  }
  const normal: Vec3 = [nx / normalLength, ny / normalLength, nz / normalLength];
  const tangent: Vec3 = [
    e1[0] / tangentLength,
    e1[1] / tangentLength,
    e1[2] / tangentLength,
  ];
  const position: Vec3 = [
    a[0] * weights[0] + b[0] * weights[1] + c[0] * weights[2] + normal[0] * offset,
    a[1] * weights[0] + b[1] * weights[1] + c[1] * weights[2] + normal[1] * offset,
    a[2] * weights[0] + b[2] * weights[1] + c[2] * weights[2] + normal[2] * offset,
  ];
  return { position, tangent, normal };
}
