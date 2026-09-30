import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  FrontSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Scene,
  Vector3,
} from 'three';
import {
  evaluatePose,
  evaluateSurfaceAttachment,
  evaluateTriangleMesh,
  pickSurfaceTriangle,
  transformSurfacePositions,
  type AttachmentRecord,
  type SurfaceHit,
  type SurfaceTransform,
  type Vec3,
} from '../src/index.js';
import type { PageCharacterAsset } from './character.js';

/** 舞台上的独立角色实例：资产、世界摆放与每帧变形结果。 */
export class CharacterInstance {
  readonly id: string;
  readonly asset: PageCharacterAsset;
  readonly transform: SurfaceTransform;
  readonly threeMesh: Mesh;
  /** 当前帧世界空间变形顶点：渲染、拾取、挂件共用同一份。 */
  worldPositions: Vec3[] = [];
  private readonly positionAttribute: BufferAttribute;

  constructor(id: string, asset: PageCharacterAsset, transform: SurfaceTransform, color: number) {
    this.id = id;
    this.asset = asset;
    this.transform = transform;
    const geometry = new BufferGeometry();
    const vertexCount = asset.mesh.positions.length;
    this.positionAttribute = new BufferAttribute(new Float32Array(vertexCount * 3), 3);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setIndex([...asset.mesh.indices]);
    const material = new MeshStandardMaterial({
      color,
      roughness: 0.75,
      flatShading: true,
      side: FrontSide, // 与正面拾取一致
    });
    this.threeMesh = new Mesh(geometry, material);
    this.threeMesh.frustumCulled = false;
  }

  get vertexCount(): number {
    return this.asset.mesh.positions.length;
  }

  get indices(): readonly number[] {
    return this.asset.mesh.indices;
  }

  /** 求值当前帧：先形变后蒙皮（角色空间），再施加世界摆放。 */
  evaluate(time: number): void {
    const { skeleton, mesh, clip } = this.asset;
    const pose = evaluatePose(skeleton, { clip, time, loop: 'loop' });
    const skinned = evaluateTriangleMesh(skeleton, mesh, clip, time, 'loop', pose.worldMatrices);
    this.worldPositions = transformSurfacePositions(skinned, this.transform);
    const array = this.positionAttribute.array as Float32Array;
    for (let i = 0; i < this.worldPositions.length; i++) {
      const p = this.worldPositions[i];
      array[i * 3] = p[0];
      array[i * 3 + 1] = p[1];
      array[i * 3 + 2] = p[2];
    }
    this.positionAttribute.needsUpdate = true;
    this.threeMesh.geometry.computeVertexNormals();
  }
}

export interface StagePick {
  characterId: string;
  hit: SurfaceHit;
}

/** 挂件可视化：圆锥沿世界法向、底面切线沿首条边切向。 */
class BadgeView {
  readonly group = new Group();
  private readonly material: MeshStandardMaterial;

  constructor(selected: boolean) {
    this.material = new MeshStandardMaterial({
      color: 0xffc832,
      emissive: 0x302000,
      side: DoubleSide,
    });
    const cone = new Mesh(new ConeGeometry(0.045, 0.09, 20), this.material);
    cone.geometry.rotateX(Math.PI / 2); // 锥尖指向 +Z（世界法向）
    cone.position.z = 0.045;
    this.group.add(cone);
    this.setSelected(selected);
  }

  setSelected(selected: boolean): void {
    this.material.color = new Color(selected ? 0xff5030 : 0xffc832);
  }

  /** 按挂件帧姿态摆放：X=切向，Z=法向。 */
  apply(position: Vec3, tangent: Vec3, normal: Vec3): void {
    const x = new Vector3(...tangent);
    const z = new Vector3(...normal);
    const y = new Vector3().crossVectors(z, x).normalize();
    const basis = new Matrix4().makeBasis(x, y, z);
    this.group.quaternion.setFromRotationMatrix(basis);
    this.group.position.set(position[0], position[1], position[2]);
  }
}

/** 舞台：持有场景、全部角色实例与挂件视图，逐帧驱动变形。 */
export class Stage {
  readonly scene = new Scene();
  readonly characters: CharacterInstance[] = [];
  private readonly badges = new Map<string, BadgeView>();
  private readonly byId = new Map<string, CharacterInstance>();

  addCharacter(instance: CharacterInstance): void {
    this.characters.push(instance);
    this.byId.set(instance.id, instance);
    this.scene.add(instance.threeMesh);
  }

  /** 推进到指定时间：所有实例用同一时钟独立求值。 */
  update(time: number): void {
    for (const character of this.characters) character.evaluate(time);
  }

  /** 用当前帧世界变形结果拾取最近正面三角形；空白返回 null。 */
  pick(origin: Vec3, direction: Vec3): StagePick | null {
    let best: StagePick | null = null;
    for (const character of this.characters) {
      const hit = pickSurfaceTriangle(character.worldPositions, character.indices, {
        origin,
        direction,
      });
      if (hit && (!best || hit.distance < best.hit.distance)) {
        best = { characterId: character.id, hit };
      }
    }
    return best;
  }

  /** 逐帧重算全部挂件姿态；返回因面退化而被隐藏的挂件 ID。 */
  updateAttachments(records: readonly AttachmentRecord[], selectedId: string | null): string[] {
    const hidden: string[] = [];
    const alive = new Set<string>();
    for (const record of records) {
      alive.add(record.id);
      const character = this.byId.get(record.characterId);
      if (!character) continue;
      let view = this.badges.get(record.id);
      if (!view) {
        view = new BadgeView(record.id === selectedId);
        this.badges.set(record.id, view);
        this.scene.add(view.group);
      }
      view.setSelected(record.id === selectedId);
      const frame = evaluateSurfaceAttachment(
        character.worldPositions,
        character.indices,
        record.triangleIndex,
        record.barycentric,
        record.offset,
      );
      if (!frame) {
        view.group.visible = false; // 面退化：隐藏但保留记录，不换面
        hidden.push(record.id);
        continue;
      }
      view.group.visible = true;
      view.apply(frame.position, frame.tangent, frame.normal);
    }
    for (const [id, view] of this.badges) {
      if (!alive.has(id)) {
        this.scene.remove(view.group);
        this.badges.delete(id);
      }
    }
    return hidden;
  }
}
