import type { Vec3 } from './types.js';

/** 角色拓扑校验信息：顶点数与完整索引序列。 */
export interface CharacterTopology {
  readonly vertexCount: number;
  readonly indices: readonly number[];
}

/** 一条挂件记录：挂在某角色某三角形的重心坐标处。 */
export interface AttachmentRecord {
  readonly id: string;
  readonly characterId: string;
  readonly triangleIndex: number;
  readonly barycentric: Vec3;
  /** 沿世界单位法向的偏移。 */
  readonly offset: number;
}

interface AttachmentSnapshot {
  readonly records: readonly AttachmentRecord[];
  readonly selectedId: string | null;
}

const BARYCENTRIC_EPSILON = 1e-6;

function validateBarycentric(value: unknown, what: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3
    || !value.every((component) => typeof component === 'number' && Number.isFinite(component))) {
    throw new Error(what + ' 重心坐标必须是三个有限数');
  }
  const [u, v, w] = value as number[];
  const sum = u + v + w;
  if (Math.abs(sum - 1) > BARYCENTRIC_EPSILON) {
    throw new Error(what + ' 重心坐标之和必须为 1: ' + String(sum));
  }
  if (u < -BARYCENTRIC_EPSILON || v < -BARYCENTRIC_EPSILON || w < -BARYCENTRIC_EPSILON) {
    throw new Error(what + ' 重心坐标分量不能为负');
  }
  return [u / sum, v / sum, w / sum];
}

function validateOffset(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(what + ' 偏移必须是有限数');
  }
  return value;
}

/**
 * 挂件集合：按角色记录的三角形 + 重心坐标挂件，支持选择、删除、
 * 调整偏移，以及带拓扑校验的 JSON 导出/加载。
 *
 * 构造时登记各角色拓扑（顶点数 + 索引序列）；加载时逐角色比对，
 * 任何错配、越界、非法重心坐标或非有限数都会整体拒绝并保持现状。
 */
export class AttachmentStore {
  private readonly topologies: ReadonlyMap<string, CharacterTopology>;
  private records: AttachmentRecord[] = [];
  private selectedId: string | null = null;
  private nextId = 1;

  constructor(topologies: ReadonlyMap<string, CharacterTopology> | Record<string, CharacterTopology>) {
    const entries = topologies instanceof Map ? [...topologies.entries()] : Object.entries(topologies);
    if (entries.length === 0) throw new Error('挂件库至少需要一个角色拓扑');
    const map = new Map<string, CharacterTopology>();
    for (const [id, topology] of entries) {
      if (typeof id !== 'string' || id.length === 0) throw new Error('角色标识不能为空');
      if (map.has(id)) throw new Error('角色标识重复: ' + id);
      if (!topology || !Number.isInteger(topology.vertexCount) || topology.vertexCount <= 0) {
        throw new Error('角色 ' + id + ' 顶点数必须是正整数');
      }
      const indices = topology.indices;
      if (!Array.isArray(indices) || indices.length === 0 || indices.length % 3 !== 0
        || !indices.every((index) => Number.isInteger(index) && index >= 0
          && index < topology.vertexCount)) {
        throw new Error('角色 ' + id + ' 索引序列非法或越界');
      }
      map.set(id, { vertexCount: topology.vertexCount, indices: [...indices] });
    }
    this.topologies = map;
  }

  /** 当前全部挂件（副本）。 */
  list(): AttachmentRecord[] {
    return this.records.map((record) => ({ ...record, barycentric: [...record.barycentric] as Vec3 }));
  }

  /** 当前选中挂件 ID；未选中为 null。 */
  get selected(): string | null {
    return this.selectedId;
  }

  /** 新增挂件并选中；返回新挂件 ID。非法参数抛错且不改变集合。 */
  add(
    characterId: string,
    triangleIndex: number,
    barycentric: readonly number[],
    offset = 0,
  ): string {
    const topology = this.topologyFor(characterId);
    const triangleCount = topology.indices.length / 3;
    if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= triangleCount) {
      throw new Error('角色 ' + characterId + ' 三角形序号越界: ' + String(triangleIndex));
    }
    const record: AttachmentRecord = {
      id: 'att-' + String(this.nextId++),
      characterId,
      triangleIndex,
      barycentric: validateBarycentric(barycentric, '挂件'),
      offset: validateOffset(offset, '挂件'),
    };
    this.records = [...this.records, record];
    this.selectedId = record.id;
    return record.id;
  }

  /** 删除挂件；不存在时返回 false。删除选中项后清空选择。 */
  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((record) => record.id !== id);
    if (this.records.length === before) return false;
    if (this.selectedId === id) this.selectedId = null;
    return true;
  }

  /** 选中挂件；传 null 取消选择。未知 ID 抛错。 */
  select(id: string | null): void {
    if (id === null) {
      this.selectedId = null;
      return;
    }
    if (!this.records.some((record) => record.id === id)) {
      throw new Error('挂件不存在: ' + id);
    }
    this.selectedId = id;
  }

  /** 调整挂件沿世界法向的偏移。 */
  setOffset(id: string, offset: number): void {
    validateOffset(offset, '挂件 ' + id);
    this.records = this.records.map((record) =>
      record.id === id ? { ...record, offset } : record);
    if (!this.records.some((record) => record.id === id)) {
      throw new Error('挂件不存在: ' + id);
    }
  }

  /** 导出 JSON：包含各角色拓扑（顶点数 + 索引序列）与全部挂件。 */
  exportJSON(): string {
    const characters = [...this.topologies.entries()].map(([id, topology]) => ({
      id,
      vertexCount: topology.vertexCount,
      indices: [...topology.indices],
    }));
    return JSON.stringify({
      version: 1,
      characters,
      attachments: this.list().map((record) => ({
        id: record.id,
        characterId: record.characterId,
        triangleIndex: record.triangleIndex,
        barycentric: [...record.barycentric],
        offset: record.offset,
      })),
    }, null, 2);
  }

  /**
   * 从 JSON 加载挂件。逐角色校验顶点数与索引序列完全一致；
   * 任何校验失败都抛错且**保留当前挂件不变**。加载成功后清空选择。
   */
  importJSON(json: string): void {
    if (typeof json !== 'string') throw new Error('挂件数据必须是 JSON 字符串');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('挂件 JSON 解析失败');
    }
    const data = parsed as {
      version?: unknown;
      characters?: unknown;
      attachments?: unknown;
    };
    if (!data || typeof data !== 'object' || data.version !== 1) {
      throw new Error('挂件数据版本不受支持');
    }
    if (!Array.isArray(data.characters)) throw new Error('挂件数据缺少角色拓扑');
    const seenCharacters = new Set<string>();
    for (const character of data.characters as {
      id?: unknown; vertexCount?: unknown; indices?: unknown;
    }[]) {
      if (!character || typeof character.id !== 'string') {
        throw new Error('挂件数据角色缺少标识');
      }
      const topology = this.topologies.get(character.id);
      if (!topology) throw new Error('挂件数据引用了未知角色: ' + character.id);
      if (character.vertexCount !== topology.vertexCount) {
        throw new Error(
          '角色 ' + character.id + ' 顶点数错配: '
            + String(character.vertexCount) + ' vs ' + String(topology.vertexCount),
        );
      }
      const indices = character.indices;
      if (!Array.isArray(indices) || indices.length !== topology.indices.length
        || !indices.every((index, i) => index === topology.indices[i])) {
        throw new Error('角色 ' + character.id + ' 索引序列错配');
      }
      seenCharacters.add(character.id);
    }
    if (!Array.isArray(data.attachments)) throw new Error('挂件数据缺少 attachments');
    const loaded: AttachmentRecord[] = [];
    const usedIds = new Set<string>();
    for (const [i, attachment] of (data.attachments as Record<string, unknown>[]).entries()) {
      const what = '挂件数据第 ' + i + ' 项';
      if (!attachment || typeof attachment !== 'object') throw new Error(what + ' 非法');
      const characterId = attachment.characterId;
      if (typeof characterId !== 'string' || !seenCharacters.has(characterId)) {
        throw new Error(what + ' 引用了未知角色: ' + String(characterId));
      }
      const topology = this.topologies.get(characterId)!;
      const triangleIndex = attachment.triangleIndex;
      if (!Number.isInteger(triangleIndex) || (triangleIndex as number) < 0
        || (triangleIndex as number) >= topology.indices.length / 3) {
        throw new Error(what + ' 三角形序号越界: ' + String(triangleIndex));
      }
      let id = attachment.id;
      if (id === undefined) {
        id = 'att-import-' + String(i + 1);
      }
      if (typeof id !== 'string' || id.length === 0 || usedIds.has(id)) {
        throw new Error(what + ' 挂件 ID 非法或重复');
      }
      usedIds.add(id);
      loaded.push({
        id,
        characterId,
        triangleIndex: triangleIndex as number,
        barycentric: validateBarycentric(attachment.barycentric, what),
        offset: validateOffset(attachment.offset === undefined ? 0 : attachment.offset, what),
      });
    }
    // 全部校验通过后才提交，失败时当前挂件保持不变。
    this.records = loaded;
    this.selectedId = null;
    this.nextId = loaded.reduce((max, record) => {
      const match = /^att-(d+)$/.exec(record.id);
      return match ? Math.max(max, Number(match[1]) + 1) : max;
    }, this.nextId);
  }

  private topologyFor(characterId: string): CharacterTopology {
    const topology = this.topologies.get(characterId);
    if (!topology) throw new Error('未知角色: ' + String(characterId));
    return topology;
  }
}
