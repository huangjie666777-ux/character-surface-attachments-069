import {
  AmbientLight,
  Color,
  DirectionalLight,
  GridHelper,
  PerspectiveCamera,
  Raycaster,
  Vector2,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AttachmentStore, type Vec3 } from '../src/index.js';
import { createPageCharacter } from './character.js';
import { CharacterInstance, Stage } from './stage.js';

const container = document.getElementById('viewport')!;
const hintEl = document.getElementById('hint')!;
const listEl = document.getElementById('attachments')!;
const playButton = document.getElementById('play') as HTMLButtonElement;
const restartButton = document.getElementById('restart') as HTMLButtonElement;
const timeSlider = document.getElementById('time') as HTMLInputElement;
const offsetSlider = document.getElementById('offset') as HTMLInputElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;
const importButton = document.getElementById('import') as HTMLButtonElement;
const deleteButton = document.getElementById('delete') as HTMLButtonElement;
const jsonArea = document.getElementById('json') as HTMLTextAreaElement;

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);
const camera = new PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(0, 1.6, 4.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);

const stage = new Stage();
stage.scene.background = new Color(0x1c2230);
stage.scene.add(new AmbientLight(0xffffff, 0.55));
const sun = new DirectionalLight(0xffffff, 1.4);
sun.position.set(3, 6, 4);
stage.scene.add(sun);
stage.scene.add(new GridHelper(10, 20, 0x334, 0x223));

// 两个完全独立的角色实例：各自的骨架/网格/片段与独立世界摆放
// （平移、旋转、正的非均匀缩放）。
const hero = new CharacterInstance('hero', createPageCharacter(), {
  translation: [-0.9, 0, 0],
  rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)],
  scale: [1, 1, 1],
}, 0x7fb2e5);
const npc = new CharacterInstance('npc', createPageCharacter(), {
  translation: [1.0, 0, -0.3],
  rotation: [0, -Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)],
  scale: [1.25, 0.85, 1.1],
}, 0xe5a37f);
stage.addCharacter(hero);
stage.addCharacter(npc);

const store = new AttachmentStore({
  hero: { vertexCount: hero.vertexCount, indices: hero.indices },
  npc: { vertexCount: npc.vertexCount, indices: npc.indices },
});

const CLIP_DURATION = 1.2;
let playing = true;
let time = 0;
let lastTick = performance.now();
let hiddenBadges: string[] = [];

function setHint(message: string): void {
  const degenerate = hiddenBadges.length > 0
    ? ' 挂件 ' + hiddenBadges.join(', ') + ' 所在面退化，已暂时隐藏。'
    : '';
  hintEl.textContent = message + degenerate;
}

function refreshList(): void {
  listEl.innerHTML = '';
  for (const record of store.list()) {
    const item = document.createElement('li');
    const label = document.createElement('button');
    label.textContent = record.id + ' @ ' + record.characterId
      + ' 面' + record.triangleIndex + ' 偏移' + record.offset.toFixed(2);
    label.className = record.id === store.selected ? 'selected' : '';
    label.addEventListener('click', () => {
      store.select(record.id);
      offsetSlider.value = String(record.offset);
      refreshList();
    });
    item.appendChild(label);
    listEl.appendChild(item);
  }
}

// 点击放置：区分拖拽旋转与单击。
let pointerDown: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDown = { x: event.clientX, y: event.clientY };
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!pointerDown) return;
  const moved = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
  pointerDown = null;
  if (moved > 5) return; // 拖拽视角，不放置
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const origin = raycaster.ray.origin;
  const direction = raycaster.ray.direction;
  const picked = stage.pick(
    [origin.x, origin.y, origin.z] as Vec3,
    [direction.x, direction.y, direction.z] as Vec3,
  );
  if (!picked) {
    setHint('未命中变形表面，未创建挂件。');
    return;
  }
  const offset = Number(offsetSlider.value);
  const id = store.add(picked.characterId, picked.hit.triangleIndex, picked.hit.barycentric, offset);
  setHint('已放置 ' + id + '：' + picked.characterId
    + ' 面' + picked.hit.triangleIndex
    + ' 重心(' + picked.hit.barycentric.map((n) => n.toFixed(2)).join(', ') + ')');
  refreshList();
});

playButton.addEventListener('click', () => {
  playing = !playing;
  playButton.textContent = playing ? '暂停' : '播放';
});
restartButton.addEventListener('click', () => {
  time = 0;
  playing = true;
  playButton.textContent = '暂停';
});
timeSlider.addEventListener('input', () => {
  time = Number(timeSlider.value);
  playing = false;
  playButton.textContent = '播放';
});
offsetSlider.addEventListener('input', () => {
  const selected = store.selected;
  if (!selected) return;
  store.setOffset(selected, Number(offsetSlider.value));
  refreshList();
});
deleteButton.addEventListener('click', () => {
  const selected = store.selected;
  if (selected && store.remove(selected)) {
    setHint('已删除 ' + selected);
    refreshList();
  }
});
exportButton.addEventListener('click', () => {
  jsonArea.value = store.exportJSON();
  setHint('已导出 ' + store.list().length + ' 个挂件的 JSON。');
});
importButton.addEventListener('click', () => {
  try {
    store.importJSON(jsonArea.value);
    setHint('加载成功，共 ' + store.list().length + ' 个挂件。');
    refreshList();
  } catch (error) {
    setHint('加载失败（保留当前挂件）：' + (error as Error).message);
  }
});

function resize(): void {
  const width = container.clientWidth;
  const height = container.clientHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function tick(now: number): void {
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  if (playing) {
    time = (time + dt) % CLIP_DURATION;
    timeSlider.value = String(time);
  }
  stage.update(time); // 变形帧：渲染/拾取/挂件共用
  hiddenBadges = stage.updateAttachments(store.list(), store.selected);
  if (hiddenBadges.length > 0) setHint('');
  controls.update();
  renderer.render(stage.scene, camera);
  requestAnimationFrame(tick);
}
setHint('点击角色表面放置徽章；拖动旋转视角。');
requestAnimationFrame(tick);
