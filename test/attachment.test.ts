import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AttachmentStore,
  evaluateSurfaceAttachment,
  pickSurfaceTriangle,
  surfaceWorldMatrix,
  transformSurfacePositions,
  type SurfaceTransform,
  type Vec3,
} from '../src/index.js';
import { quatY } from './helpers.js';

// 单个三角形：(0,0,0) (1,0,0) (0,1,0)，法向 +Z。
const positions: Vec3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
const indices = [0, 1, 2];

function nearlyEqual(a: readonly number[], b: readonly number[], eps = 1e-9): void {
  assert.equal(a.length, b.length);
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < eps,
    '分量 ' + i + ': ' + value + ' vs ' + b[i]));
}

test('角色变换支持平移、旋转与正的非均匀缩放', () => {
  const transform: SurfaceTransform = {
    translation: [10, 20, 30],
    rotation: quatY(Math.PI / 2),
    scale: [2, 3, 4],
  };
  const world = transformSurfacePositions([[1, 1, 1]], transform);
  // 局部 (1,1,1) -> 缩放 (2,3,4) -> 绕Y旋转 (x,y,z)->(z,y,-x) -> (4,3,-2) -> 平移
  nearlyEqual(world[0], [14, 23, 28]);
  const src: Vec3[] = [[1, 2, 3]];
  transformSurfacePositions(src, transform);
  nearlyEqual(src[0], [1, 2, 3]); // 输入不被修改
});

test('非法角色变换被拒绝', () => {
  const base: SurfaceTransform = { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  assert.throws(() => surfaceWorldMatrix({ ...base, scale: [1, -1, 1] }), /正数/);
  assert.throws(() => surfaceWorldMatrix({ ...base, scale: [1, 0, 1] }), /正数/);
  assert.throws(() => surfaceWorldMatrix({ ...base, rotation: [0, 0, 0, 2] }), /单位四元数/);
  assert.throws(() => surfaceWorldMatrix({ ...base, translation: [0, NaN, 0] }), /有限数/);
});

test('拾取命中最近的正面三角形并返回重心坐标', () => {
  const hit = pickSurfaceTriangle(positions, indices, {
    origin: [0.25, 0.25, 5],
    direction: [0, 0, -1],
  });
  assert.ok(hit);
  assert.equal(hit.triangleIndex, 0);
  nearlyEqual(hit.barycentric, [0.5, 0.25, 0.25]);
  assert.ok(Math.abs(hit.distance - 5) < 1e-9);
});

test('背面三角形不命中', () => {
  const hit = pickSurfaceTriangle(positions, indices, {
    origin: [0.25, 0.25, -5],
    direction: [0, 0, 1], // 从背后射向正面
  });
  assert.equal(hit, null);
});

test('空白区域不命中，退化面被跳过', () => {
  const miss = pickSurfaceTriangle(positions, indices, {
    origin: [5, 5, 5],
    direction: [0, 0, -1],
  });
  assert.equal(miss, null);
  // 退化三角形（三点共线）+ 一个正常三角形
  const degenPositions: Vec3[] = [...positions, [0, 0, 0], [1, 0, 0], [2, 0, 0]];
  const degenIndices = [3, 4, 5, 0, 1, 2];
  const hit = pickSurfaceTriangle(degenPositions, degenIndices, {
    origin: [0.25, 0.25, 5],
    direction: [0, 0, -1],
  });
  assert.ok(hit);
  assert.equal(hit.triangleIndex, 1); // 跳过退化的 0 号面
});

test('多三角形时取最近命中', () => {
  const twoPositions: Vec3[] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
    [0, 0, 2], [1, 0, 2], [0, 1, 2],
  ];
  const twoIndices = [0, 1, 2, 3, 4, 5];
  const hit = pickSurfaceTriangle(twoPositions, twoIndices, {
    origin: [0.25, 0.25, 5],
    direction: [0, 0, -1],
  });
  assert.ok(hit);
  assert.equal(hit.triangleIndex, 1);
  assert.ok(Math.abs(hit.distance - 3) < 1e-9);
});

test('挂件位置随变形帧变化，朝向取首条边切向与绕序法向', () => {
  const barycentric: Vec3 = [0.5, 0.25, 0.25];
  const frame1 = evaluateSurfaceAttachment(positions, indices, 0, barycentric, 0);
  assert.ok(frame1);
  nearlyEqual(frame1.position, [0.25, 0.25, 0]);
  nearlyEqual(frame1.tangent, [1, 0, 0]);
  nearlyEqual(frame1.normal, [0, 0, 1]);
  // 变形后（顶点移动）同一三角形同一重心坐标得到新位置
  const moved: Vec3[] = [[0, 0, 1], [2, 0, 1], [0, 1, 1]];
  const frame2 = evaluateSurfaceAttachment(moved, indices, 0, barycentric, 0);
  assert.ok(frame2);
  nearlyEqual(frame2.position, [0.5, 0.25, 1]);
  nearlyEqual(frame2.tangent, [1, 0, 0]);
});

test('挂件偏移沿世界单位法向（含非均匀缩放后的法向）', () => {
  const transform: SurfaceTransform = {
    translation: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [2, 1, 5],
  };
  const world = transformSurfacePositions(positions, transform);
  const frame = evaluateSurfaceAttachment(world, indices, 0, [1, 0, 0], 0.5);
  assert.ok(frame);
  nearlyEqual(frame.normal, [0, 0, 1]); // 单位法向
  nearlyEqual(frame.position, [0, 0, 0.5]);
  nearlyEqual(frame.tangent, [1, 0, 0]);
});

test('面退化时挂件求值返回 null，恢复后继续且不换面', () => {
  const barycentric: Vec3 = [0.5, 0.25, 0.25];
  const collapsed: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]]; // 共线退化
  assert.equal(evaluateSurfaceAttachment(collapsed, indices, 0, barycentric, 0), null);
  const restored = evaluateSurfaceAttachment(positions, indices, 0, barycentric, 0);
  assert.ok(restored);
  nearlyEqual(restored.position, [0.25, 0.25, 0]);
  assert.throws(() => evaluateSurfaceAttachment(positions, indices, 7, barycentric, 0), /越界/);
  assert.throws(() => evaluateSurfaceAttachment(positions, indices, 0, [1, 1, -1], 0), /为负/);
  assert.throws(() => evaluateSurfaceAttachment(positions, indices, 0, [NaN, 0, 1], 0), /有限数/);
});

function makeStore(): AttachmentStore {
  return new AttachmentStore({
    hero: { vertexCount: 3, indices: [0, 1, 2] },
    npc: { vertexCount: 4, indices: [0, 1, 2, 0, 2, 3] },
  });
}

test('挂件库支持新增、选择、删除与调整偏移', () => {
  const store = makeStore();
  const id = store.add('hero', 0, [0.5, 0.25, 0.25], 0.1);
  assert.equal(store.selected, id);
  store.setOffset(id, 0.3);
  assert.equal(store.list()[0].offset, 0.3);
  assert.throws(() => store.add('hero', 1, [1, 0, 0]), /越界/);
  assert.throws(() => store.add('ghost', 0, [1, 0, 0]), /未知角色/);
  assert.throws(() => store.add('hero', 0, [0.5, 0.5, 0.5]), /之和/);
  assert.throws(() => store.setOffset(id, Infinity), /有限数/);
  store.select(null);
  assert.equal(store.selected, null);
  assert.equal(store.remove(id), true);
  assert.equal(store.remove(id), false);
  assert.equal(store.list().length, 0);
});

test('挂件 JSON 导出后可重新加载（往返一致）', () => {
  const store = makeStore();
  store.add('hero', 0, [0.5, 0.25, 0.25], 0.1);
  store.add('npc', 1, [0.2, 0.3, 0.5], -0.05);
  const json = store.exportJSON();
  const restored = makeStore();
  restored.importJSON(json);
  const strip = (list: ReturnType<AttachmentStore['list']>) =>
    list.map(({ id, ...rest }) => rest);
  assert.deepEqual(strip(restored.list()), strip(store.list()));
});

test('加载拒绝拓扑错配、越界、非法重心与非有限数，失败保留现状', () => {
  const store = makeStore();
  store.add('hero', 0, [1, 0, 0], 0.2);
  const before = store.list();
  const base = JSON.parse(store.exportJSON()) as {
    characters: { id: string; vertexCount: number; indices: number[] }[];
    attachments: Record<string, unknown>[];
  };
  const attempt = (mutate: (data: typeof base) => void, pattern: RegExp): void => {
    const data = JSON.parse(JSON.stringify(base)) as typeof base;
    mutate(data);
    assert.throws(() => store.importJSON(JSON.stringify(data)), pattern);
    assert.deepEqual(store.list(), before); // 现状不变
  };
  attempt((d) => { d.characters[0].vertexCount = 99; }, /顶点数错配/);
  attempt((d) => { d.characters[0].indices[1] = 7; }, /索引序列错配/);
  attempt((d) => { d.characters = d.characters.slice(1); }, /未知角色/);
  attempt((d) => { d.attachments[0].triangleIndex = 5; }, /越界/);
  attempt((d) => { d.attachments[0].barycentric = [0.5, 0.5, 0.5]; }, /之和/);
  attempt((d) => { d.attachments[0].barycentric = [1, 0, -0.5]; }, /为负|之和/);
  attempt((d) => { d.attachments[0].offset = 1e999; }, /有限数/);
  attempt((d) => { d.attachments[0].barycentric = [1e999, 0, 0]; }, /有限数/);
  assert.throws(() => store.importJSON('not json'), /解析失败/);
  assert.deepEqual(store.list(), before);
});
