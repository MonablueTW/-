// 把示範資料畫成「攝影機拍到的畫面」（擬真風格：球場、牆、有衣服和球拍的人），給網站的對照影片用。
import * as THREE from 'three';
import { generateDemo } from '../../web/js/demo.js';
import { normalize } from '../../web/js/format.js';
import { COURT } from '../../web/js/court.js';
import { makeOverlayCamera } from '../../web/js/scene.js';

const data = normalize(generateDemo());
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(canvas.width, canvas.height, false);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1f28);
const camera = makeOverlayCamera(data.camera);

// ---------- 場館 ----------
scene.add(new THREE.HemisphereLight(0xe6eeff, 0x2a3440, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(2, 14, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 16, bottom: -16, near: 1, far: 40 });
sun.shadow.radius = 4;
scene.add(sun);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
function plane(w, l, material, y = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), material);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}
const { halfWidth: hw, halfLength: hl, kitchen: k, line: lw } = COURT;
plane(30, 40, mat(0x2d8c7e));
for (const s of [1, -1]) plane(hw * 2, hl - k, mat(0x2f6ad0), 0.002).position.z = s * (k + (hl - k) / 2);
const white = mat(0xf2f4f6);
const line = (x, z, w, l) => { const m = plane(w, l, white, 0.004); m.position.x = x; m.position.z = z; };
for (const s of [1, -1]) {
  line(0, s * (hl - lw / 2), hw * 2, lw);
  line(s * (hw - lw / 2), 0, lw, hl * 2);
  line(0, s * (k - lw / 2), hw * 2, lw);
  line(0, s * (k + (hl - k) / 2), lw, hl - k);
}

// 牆：深色浪板
const wallTex = (() => {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 16;
  const g = c.getContext('2d');
  for (let x = 0; x < 256; x++) {
    const v = 62 + 20 * Math.sin((x / 256) * Math.PI * 2 * 8);
    g.fillStyle = `rgb(${v},${v + 6},${v + 16})`;
    g.fillRect(x, 0, 1, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const hall = new THREE.Mesh(new THREE.BoxGeometry(24, 9, 34), new THREE.MeshStandardMaterial({ map: wallTex, side: THREE.BackSide, roughness: 0.9 }));
hall.position.y = 4.49; // 底面放在地板下面一點，避免和地板重疊閃爍
scene.add(hall);
for (let i = -2; i <= 2; i++) {
  for (const x of [-5, 5]) {
    const lamp = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lamp.position.set(x, 8.9, i * 6);
    lamp.rotation.x = Math.PI / 2;
    scene.add(lamp);
  }
}

// 球網：網柱、網面（格子貼圖）、白色上緣
const netTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(20,24,30,0.95)';
  g.lineWidth = 6;
  g.strokeRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(170, 22);
  return t;
})();
const netTop = (x) => COURT.netCenter + (COURT.netPost - COURT.netCenter) * (x / COURT.postX) ** 2;
const netGeo = new THREE.PlaneGeometry(COURT.postX * 2, 1, 40, 1);
const np = netGeo.attributes.position;
for (let i = 0; i < np.count; i++) np.setY(i, np.getY(i) > 0 ? netTop(np.getX(i)) : 0.04);
const net = new THREE.Mesh(netGeo, new THREE.MeshStandardMaterial({ map: netTex, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide, color: 0x222831 }));
scene.add(net);
const tape = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(
  Array.from({ length: 21 }, (_, i) => { const x = -COURT.postX + (i / 20) * COURT.postX * 2; return new THREE.Vector3(x, netTop(x), 0); })), 40, 0.025, 6), mat(0xffffff));
scene.add(tape);
for (const s of [1, -1]) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, COURT.netPost + 0.05, 12), mat(0x111111, { roughness: 0.4 }));
  post.position.set(s * COURT.postX, (COURT.netPost + 0.05) / 2, 0);
  post.castShadow = true;
  scene.add(post);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.9), mat(0x111111));
  foot.position.set(s * COURT.postX, 0.025, 0);
  scene.add(foot);
}

// ---------- 人 ----------
const SKIN = 0xc99a7a;
const OUTFITS = [
  { shirt: 0xe8c21c, shorts: 0x1e2026 }, // 近場·黃衣
  { shirt: 0x1d1f24, shorts: 0x1e2026 }, // 近場·黑衣
  { shirt: 0xeceff2, shorts: 0x3a3f4a }, // 遠場·白衣
  { shirt: 0x1d1f24, shorts: 0x2a2d35 }, // 遠場·黑衣
];
const J = data.jointIndex;
const Y = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

class Person {
  constructor(player, outfit) {
    this.player = player;
    this.group = new THREE.Group();
    const limb = (a, b, r, color) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.9, 1, 12), mat(color, { roughness: 0.7 }));
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), m.material);
      m.castShadow = cap.castShadow = true;
      this.group.add(m, cap);
      return { a: J.get(a), b: J.get(b), mesh: m, cap };
    };
    this.limbs = [
      limb('left_shoulder', 'left_elbow', 0.05, outfit.shirt === 0xeceff2 ? outfit.shirt : SKIN),
      limb('right_shoulder', 'right_elbow', 0.05, outfit.shirt === 0xeceff2 ? outfit.shirt : SKIN),
      limb('left_elbow', 'left_wrist', 0.04, SKIN),
      limb('right_elbow', 'right_wrist', 0.04, SKIN),
      limb('left_hip', 'left_knee', 0.078, outfit.shorts),
      limb('right_hip', 'right_knee', 0.078, outfit.shorts),
      limb('left_knee', 'left_ankle', 0.055, SKIN),
      limb('right_knee', 'right_ankle', 0.055, SKIN),
    ];
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.34, 6, 16), mat(outfit.shirt, { roughness: 0.8 }));
    this.torso.scale.set(1.05, 1, 0.68);
    this.pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 10), mat(outfit.shorts));
    this.pelvis.scale.set(1.05, 0.75, 0.75);
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 14), mat(SKIN, { roughness: 0.6 }));
    this.hair = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(0x1b1612));
    this.neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 1, 10), mat(SKIN));
    this.shoes = [0, 1].map(() => new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.27), mat(0xeeeeee, { roughness: 0.5 })));
    this.paddle = new THREE.Group();
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.014, 24), mat(0x2b2f3a, { roughness: 0.4 }));
    face.scale.set(1, 1, 1.3);
    face.rotation.x = Math.PI / 2;
    face.position.y = 0.22;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.13, 8), mat(0x111111));
    handle.position.y = 0.07;
    this.paddle.add(face, handle);
    for (const m of [this.torso, this.pelvis, this.head, this.hair, this.neck, ...this.shoes, face, handle]) m.castShadow = true;
    this.group.add(this.torso, this.pelvis, this.head, this.hair, this.neck, ...this.shoes, this.paddle);
    scene.add(this.group);
  }

  joint(f, name, out = new THREE.Vector3()) {
    const j = typeof name === 'number' ? name : J.get(name);
    const o = (f * data.joints.length + j) * 3;
    return out.set(this.player.pos[o], this.player.pos[o + 1], this.player.pos[o + 2]);
  }

  update(f) {
    const visible = !!this.player.valid[f];
    this.group.visible = visible;
    if (!visible) return;
    const orient = (mesh, a, b, cap) => {
      const len = a.distanceTo(b);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(Y, tmp.copy(b).sub(a).normalize());
      mesh.scale.set(1, len, 1);
      if (cap) cap.position.copy(b);
    };
    for (const l of this.limbs) orient(l.mesh, this.joint(f, l.a), this.joint(f, l.b), l.cap);

    const ls = this.joint(f, 'left_shoulder'), rs = this.joint(f, 'right_shoulder');
    const lh = this.joint(f, 'left_hip'), rh = this.joint(f, 'right_hip');
    const sc = ls.clone().add(rs).multiplyScalar(0.5);
    const hc = lh.clone().add(rh).multiplyScalar(0.5);
    const up = sc.clone().sub(hc).normalize();
    const right = rs.clone().sub(ls);
    right.addScaledVector(up, -right.dot(up)).normalize();
    const fwd = new THREE.Vector3().crossVectors(right, up);
    const basis = new THREE.Matrix4().makeBasis(right, up, fwd);
    this.torso.quaternion.setFromRotationMatrix(basis);
    this.torso.position.copy(hc).lerp(sc, 0.55);
    this.pelvis.quaternion.copy(this.torso.quaternion);
    this.pelvis.position.copy(hc);

    const head = this.joint(f, 'left_ear').add(this.joint(f, 'right_ear')).multiplyScalar(0.5);
    head.y += 0.02;
    this.head.position.copy(head);
    this.hair.position.copy(head).addScaledVector(fwd, -0.01);
    this.hair.quaternion.copy(this.torso.quaternion);
    orient(this.neck, sc, head);
    this.neck.scale.y *= 0.8;

    ['left', 'right'].forEach((side, i) => {
      const heel = this.joint(f, `${side}_heel`), toe = this.joint(f, `${side}_toe`);
      const shoe = this.shoes[i];
      shoe.position.copy(heel).lerp(toe, 0.5);
      shoe.position.y = Math.max(0.035, shoe.position.y + 0.02);
      const d = toe.clone().sub(heel);
      shoe.rotation.set(0, Math.atan2(d.x, d.z), 0);
    });

    // 球拍：沿前臂方向伸出手腕
    const el = this.joint(f, 'right_elbow'), wr = this.joint(f, 'right_wrist');
    const dir = wr.clone().sub(el).normalize();
    const side = new THREE.Vector3().crossVectors(dir, Y);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const normal = new THREE.Vector3().crossVectors(side, dir);
    this.paddle.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, dir, normal));
    this.paddle.position.copy(wr).addScaledVector(dir, -0.03);
  }
}

const people = data.players.map((p, i) => new Person(p, OUTFITS[i % OUTFITS.length]));
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.037, 16, 12), mat(0xd8f03c, { emissive: 0x5a6a10, roughness: 0.5 }));
ball.castShadow = true;
scene.add(ball);

window.frameCount = data.frameCount;
window.renderFrame = (f) => {
  for (const p of people) p.update(f);
  const b = data.ball;
  ball.visible = !!b.valid[f];
  if (ball.visible) ball.position.set(b.pos[f * 3], b.pos[f * 3 + 1], b.pos[f * 3 + 2]);
  renderer.render(scene, camera);
};
window.renderFrame(0);
window.ready = true;
