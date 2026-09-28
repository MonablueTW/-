// 3D 場景：球場、球網、四個人偶、球、軌跡，以及各種視角。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { COURT, BONES, BALL_COLOR } from './court.js';

const COLORS = {
  background: 0x0d1015,
  ground: 0x216b5c,
  court: 0x2a5bb0,
  line: 0xf4f6f8,
  net: 0x0f2622,
  post: 0x111417,
};
const GROUND = { width: 14, length: 24 };
const PLAYER_TRAIL_SEC = 2.0;
const BALL_TRAIL_SEC = 0.7;
const LIMB_RADIUS = 0.032;
const JOINT_RADIUS = 0.042;
const HEAD_RADIUS = 0.105;

// 各視角的設定。dir = 從注視點指向攝影機的方向，距離會依畫面比例自動調整到能看到整個球場。
export const VIEWS = {
  orbit: { hint: '環繞視角 · 拖曳旋轉、滾輪縮放', dir: [-0.62, 0.74, 0.92], target: [0, 0, 0.6], fov: 40, zoom: 0.78 },
  overlay: { hint: '原機位疊合 · 檢查 3D 和影片對不對得上' },
  top: { hint: '俯視', dir: [0, 1, 0.002], target: [0, 0, 0], fov: 30 },
  behind: { hint: '近場底線後方', dir: [0, 0.3, 1], target: [0, 0.4, -0.8], fov: 55, margin: [0.25, 0.1] },
  side: { hint: '側面（網子正側）', dir: [1, 0.16, 0], target: [0, 0.5, 0], fov: 35, margin: [0.3, 0.6] },
};

// 共用幾何
const CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 10, 1, false);
const SPHERE = new THREE.SphereGeometry(1, 16, 12);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class CourtView {
  constructor(canvas, container, video) {
    this.canvas = canvas;
    this.container = container;
    this.video = video;
    this.data = null;
    this.frame = 0;
    this.viewName = 'orbit';
    this.trailsOn = true;
    this.dirty = true;
    this.tween = null;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.background);
    this.scene = scene;
    this.bgColor = scene.background;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.2, 400);
    this.overlayCamera = null;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 80;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => { this.tween = null; this.userMoved = true; });

    this.buildLights();
    this.buildCourt();
    this.players = [];
    this.ball = null;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setView('orbit', false);
  }

  // ---------- 建立場景 ----------
  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x28323a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-5, 14, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera;
    s.left = -10; s.right = 10; s.top = 14; s.bottom = -14; s.near = 1; s.far = 40;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
  }

  buildCourt() {
    const courtGroup = new THREE.Group(); // 疊合模式會隱藏
    const lineGroup = new THREE.Group(); // 疊合模式保留（半透明），用來檢查校正
    const flat = (w, l, color, y, group, opts = {}) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, l),
        new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, ...opts }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = y;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    };
    flat(GROUND.width, GROUND.length, COLORS.ground, 0, courtGroup);

    const { halfWidth: hw, halfLength: hl, kitchen: k, line: lw } = COURT;
    const serviceLen = hl - k;
    for (const sgn of [1, -1]) {
      const m = flat(hw * 2, serviceLen, COLORS.court, 0.002, courtGroup);
      m.position.z = sgn * (k + serviceLen / 2);
    }

    this.lineMaterial = new THREE.MeshStandardMaterial({ color: COLORS.line, roughness: 0.8, transparent: true });
    const addLine = (x, z, w, l) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), this.lineMaterial);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.004, z);
      m.receiveShadow = true;
      lineGroup.add(m);
    };
    for (const sgn of [1, -1]) {
      addLine(0, sgn * (hl - lw / 2), hw * 2, lw); // 底線
      addLine(sgn * (hw - lw / 2), 0, lw, hl * 2); // 邊線
      addLine(0, sgn * (k - lw / 2), hw * 2, lw); // 廚房線
      addLine(0, sgn * (k + serviceLen / 2), lw, serviceLen); // 中線
    }

    // 球網：中間略低（34 in），網柱處 36 in
    const netTop = (x) => COURT.netCenter + (COURT.netPost - COURT.netCenter) * (x / COURT.postX) ** 2;
    const netGeo = new THREE.PlaneGeometry(COURT.postX * 2, 1, 40, 1);
    const p = netGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setY(i, p.getY(i) > 0 ? netTop(x) : 0.03);
    }
    netGeo.computeVertexNormals();
    const net = new THREE.Mesh(netGeo, new THREE.MeshStandardMaterial({
      color: COLORS.net, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false, roughness: 1,
    }));
    net.castShadow = true;
    courtGroup.add(net);

    const tapePts = [];
    for (let i = 0; i <= 40; i++) {
      const x = -COURT.postX + (i / 40) * COURT.postX * 2;
      tapePts.push(new THREE.Vector3(x, netTop(x), 0));
    }
    const tape = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tapePts), 40, 0.018, 6, false),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
    );
    tape.castShadow = true;
    lineGroup.add(tape);
    for (const sgn of [1, -1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, COURT.netPost + 0.03, 12),
        new THREE.MeshStandardMaterial({ color: COLORS.post, roughness: 0.5 }));
      post.position.set(sgn * COURT.postX, (COURT.netPost + 0.03) / 2, 0);
      post.castShadow = true;
      lineGroup.add(post);
    }

    this.courtGroup = courtGroup;
    this.lineGroup = lineGroup;
    this.scene.add(courtGroup, lineGroup);
  }

  // ---------- 資料 ----------
  setData(data) {
    for (const p of this.players) p.dispose();
    this.ball?.dispose();
    this.data = data;
    this.players = data.players.map((p) => new PlayerFigure(p, data, this.scene));
    this.ball = data.ball ? new BallFigure(data, this.scene) : null;
    this.overlayCamera = data.camera ? makeOverlayCamera(data.camera) : null;
    if (this.viewName === 'overlay' && !this.overlayCamera) this.setView('orbit', false);
    this.applyOverlayStyle();
    this.setFrame(0, true);
  }

  setFrame(frame, force = false) {
    if (!this.data) return;
    if (frame === this.frame && !force) return;
    this.frame = frame;
    for (const p of this.players) p.update(frame, this.trailsOn);
    this.ball?.update(frame, this.trailsOn);
    this.dirty = true;
  }

  setTrails(on) {
    this.trailsOn = on;
    this.setFrame(this.frame, true);
  }

  // ---------- 視角 ----------
  hasOverlay() {
    return !!this.overlayCamera;
  }

  setView(name, animate = true) {
    if (name === 'overlay' && !this.overlayCamera) return false;
    this.viewName = name;
    this.userMoved = false;
    this.applyOverlayStyle();
    this.dirty = true;
    if (name === 'overlay') {
      this.controls.enabled = false;
      this.tween = null;
      this.resize();
      return true;
    }
    this.controls.enabled = true;
    const pose = this.computeViewPose(name);
    if (!animate) {
      this.camera.position.copy(pose.position);
      this.controls.target.copy(pose.target);
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this.tween = null;
    } else {
      this.tween = {
        start: performance.now(),
        duration: 650,
        from: { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov },
        to: pose,
      };
    }
    this.resize();
    return true;
  }

  // 讓整個球場（含場外一點空間與人的高度）剛好塞進畫面
  computeViewPose(name) {
    const v = VIEWS[name];
    const target = new THREE.Vector3(...v.target);
    const dir = new THREE.Vector3(...v.dir).normalize();
    const aspect = this.aspect || 1;
    const pts = [];
    const [marginX, marginZ] = v.margin ?? [0.8, 1.2];
    const mx = COURT.halfWidth + marginX;
    const mz = COURT.halfLength + marginZ;
    for (const x of [-mx, mx]) for (const z of [-mz, mz]) for (const y of [0, 1.9]) pts.push(new THREE.Vector3(x, y, z));
    const cam = new THREE.PerspectiveCamera(v.fov, aspect, 0.1, 500);
    const fits = (d) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      for (const p of pts) {
        const q = p.clone().project(cam);
        if (q.z > 1 || Math.abs(q.x) > 0.94 || Math.abs(q.y) > 0.9) return false;
      }
      return true;
    };
    let lo = 2, hi = 200;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid; else lo = mid;
    }
    const dist = Math.max(hi * (v.zoom ?? 1), v.minDist ?? 0);
    return { position: target.clone().addScaledVector(dir, dist), target, fov: v.fov };
  }

  applyOverlayStyle() {
    const overlay = this.viewName === 'overlay';
    this.courtGroup.visible = !overlay;
    this.lineMaterial.opacity = overlay ? 0.45 : 1;
    for (const p of this.players) p.setOverlay(overlay);
    this.ball?.setOverlay(overlay);
    this.updateBackground();
  }

  updateBackground() {
    const overlay = this.viewName === 'overlay';
    if (overlay && this.video && this.video.readyState >= 2) {
      if (!this.videoTexture) {
        this.videoTexture = new THREE.VideoTexture(this.video);
        this.videoTexture.colorSpace = THREE.SRGBColorSpace;
        this.videoTexture.needsUpdate = true; // 暫停中的影片也要先上傳目前這一格
      }
      this.scene.background = this.videoTexture;
    } else {
      this.scene.background = overlay ? new THREE.Color(0x000000) : this.bgColor;
    }
    this.dirty = true;
  }

  // 影片畫面換了（播放中的新一格或跳轉完成）
  videoFrameChanged() {
    if (this.videoTexture && this.video.readyState >= 2) this.videoTexture.needsUpdate = true;
    this.dirty = true;
  }

  // 影片換了來源時呼叫（VideoTexture 需要重建）
  videoChanged() {
    this.videoTexture?.dispose();
    this.videoTexture = null;
    this.updateBackground();
  }

  // ---------- 尺寸與繪製 ----------
  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.aspect = w / h;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    if (this.overlayCamera) {
      // 依影片比例置中（上下或左右留黑邊）
      const { width: vw, height: vh } = this.data.camera;
      const s = Math.min(w / vw, h / vh);
      const rw = vw * s, rh = vh * s;
      this.overlayViewport = [(w - rw) / 2, (h - rh) / 2, rw, rh];
    }
    if (this.viewName !== 'overlay' && this.viewName !== 'orbit' && !this.tween && !this.userMoved) {
      const pose = this.computeViewPose(this.viewName);
      this.camera.position.copy(pose.position);
      this.controls.target.copy(pose.target);
      this.controls.update();
    }
    this.dirty = true;
  }

  // needsContinuous：影片播放中且在疊合模式時，每一幀都要重畫
  render(needsContinuous = false) {
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.start) / this.tween.duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const { from, to } = this.tween;
      this.camera.position.lerpVectors(from.position, to.position, e);
      this.controls.target.lerpVectors(from.target, to.target, e);
      this.camera.fov = from.fov + (to.fov - from.fov) * e;
      this.camera.updateProjectionMatrix();
      if (t >= 1) this.tween = null;
      this.dirty = true;
    }
    if (this.controls.enabled) this.controls.update();
    if (!this.dirty && !needsContinuous) return;
    this.dirty = false;

    const r = this.renderer;
    if (this.viewName === 'overlay' && this.overlayCamera) {
      const size = r.getSize(new THREE.Vector2());
      r.setScissorTest(false);
      r.setViewport(0, 0, size.x, size.y);
      r.setClearColor(0x000000, 1);
      r.clear();
      const [x, y, w, h] = this.overlayViewport;
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      r.setScissorTest(true);
      r.render(this.scene, this.overlayCamera);
      r.setScissorTest(false);
    } else {
      const size = r.getSize(new THREE.Vector2());
      r.setViewport(0, 0, size.x, size.y);
      r.render(this.scene, this.camera);
    }
  }
}

// ---------- 人偶 ----------
class PlayerFigure {
  constructor(player, data, scene) {
    this.player = player;
    this.data = data;
    this.J = data.joints.length;
    const idx = (n) => data.jointIndex.get(n);

    this.bones = BONES.map(([a, b]) => [idx(a), idx(b)]).filter(([a, b]) => a != null && b != null);
    this.jointIds = [...new Set(this.bones.flat())];
    this.headIds = ['left_ear', 'right_ear'].map(idx).filter((i) => i != null);
    this.noseId = idx('nose');
    this.shoulderIds = ['left_shoulder', 'right_shoulder'].map(idx);
    this.torsoIds = ['left_shoulder', 'right_shoulder', 'right_hip', 'left_hip'].map(idx);

    const color = new THREE.Color(player.color);
    this.material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05 });
    this.torsoMaterial = new THREE.MeshStandardMaterial({
      color, roughness: 0.6, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    });

    this.group = new THREE.Group();
    this.boneMesh = new THREE.InstancedMesh(CYLINDER, this.material, this.bones.length + 1); // +1 = 脖子
    this.jointMesh = new THREE.InstancedMesh(SPHERE, this.material, Math.max(1, this.jointIds.length));
    this.head = new THREE.Mesh(SPHERE, this.material);
    this.head.scale.setScalar(HEAD_RADIUS);
    for (const m of [this.boneMesh, this.jointMesh, this.head]) {
      m.castShadow = true;
      m.frustumCulled = false;
    }

    const torsoGeo = new THREE.BufferGeometry();
    torsoGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    torsoGeo.setIndex([0, 1, 2, 0, 2, 3]);
    this.torso = new THREE.Mesh(torsoGeo, this.torsoMaterial);
    this.torso.frustumCulled = false;

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.31, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;

    const maxTrail = Math.max(2, Math.round(PLAYER_TRAIL_SEC * data.fps));
    this.trail = makeTrail(maxTrail, color);

    this.group.add(this.boneMesh, this.jointMesh, this.head, this.torso, this.ring, this.trail);
    scene.add(this.group);
    this.scene = scene;
  }

  joint(frame, j, out) {
    if (j == null) return null;
    const o = (frame * this.J + j) * 3;
    const a = this.player.pos;
    if (!Number.isFinite(a[o]) || !Number.isFinite(a[o + 1]) || !Number.isFinite(a[o + 2])) return null;
    return out.set(a[o], a[o + 1], a[o + 2]);
  }

  update(frame, trailsOn) {
    const p = this.player;
    const visible = !!p.valid[frame];
    for (const m of [this.boneMesh, this.jointMesh, this.head, this.torso, this.ring]) m.visible = visible;
    this.updateTrail(frame, trailsOn);
    if (!visible) return;

    const conf = p.conf[frame];
    this.lowConfidence = conf < 0.5;
    this.applyOpacity();

    const A = new THREE.Vector3(), B = new THREE.Vector3();
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const setBone = (i, a, b, r) => {
      const len = a.distanceTo(b);
      if (len < 1e-4) { this.boneMesh.setMatrixAt(i, hidden); return; }
      const mid = a.clone().add(b).multiplyScalar(0.5);
      q.setFromUnitVectors(Y_AXIS, b.clone().sub(a).divideScalar(len));
      s.set(r, len, r);
      this.boneMesh.setMatrixAt(i, mat.compose(mid, q, s));
    };

    this.bones.forEach(([a, b], i) => {
      if (this.joint(frame, a, A) && this.joint(frame, b, B)) setBone(i, A, B, LIMB_RADIUS);
      else this.boneMesh.setMatrixAt(i, hidden);
    });

    // 頭：兩耳中點（沒有耳朵就用鼻子）
    const head = new THREE.Vector3();
    let n = 0;
    for (const j of this.headIds) if (this.joint(frame, j, A)) { head.add(A); n++; }
    if (n) head.divideScalar(n).add(new THREE.Vector3(0, 0.03, 0));
    else if (this.joint(frame, this.noseId, A)) { head.copy(A); n = 1; }
    this.head.visible = n > 0;
    if (n) this.head.position.copy(head);

    // 脖子：兩肩中點 → 頭
    const neckIdx = this.bones.length;
    const [ls, rs] = this.shoulderIds;
    if (n && this.joint(frame, ls, A) && this.joint(frame, rs, B)) {
      setBone(neckIdx, A.add(B).multiplyScalar(0.5), head, LIMB_RADIUS);
    } else this.boneMesh.setMatrixAt(neckIdx, hidden);
    this.boneMesh.instanceMatrix.needsUpdate = true;

    this.jointIds.forEach((j, i) => {
      if (this.joint(frame, j, A)) this.jointMesh.setMatrixAt(i, mat.compose(A, q.identity(), s.setScalar(JOINT_RADIUS)));
      else this.jointMesh.setMatrixAt(i, hidden);
    });
    this.jointMesh.instanceMatrix.needsUpdate = true;

    // 軀幹半透明面
    const tp = this.torso.geometry.attributes.position;
    let ok = true;
    this.torsoIds.forEach((j, i) => {
      if (this.joint(frame, j, A)) tp.setXYZ(i, A.x, A.y, A.z); else ok = false;
    });
    this.torso.visible = ok;
    tp.needsUpdate = true;
    this.torso.geometry.computeVertexNormals();
    this.torso.geometry.computeBoundingSphere();

    const r = p.root;
    if (Number.isFinite(r[frame * 3])) this.ring.position.set(r[frame * 3], 0.01, r[frame * 3 + 2]);
    else this.ring.visible = false;
  }

  updateTrail(frame, on) {
    const r = this.player.root;
    const pts = [];
    if (on) {
      const n = this.trail.userData.max;
      for (let f = Math.max(0, frame - n + 1); f <= frame; f++) {
        if (Number.isFinite(r[f * 3])) pts.push([r[f * 3], 0.012, r[f * 3 + 2]]);
      }
    }
    fillTrail(this.trail, pts);
  }

  setOverlay(on) {
    this.overlay = on;
    this.applyOpacity();
  }

  applyOpacity() {
    const opacity = this.overlay ? 0.82 : this.lowConfidence ? 0.45 : 1;
    this.material.transparent = opacity < 1;
    this.material.opacity = opacity;
    this.torsoMaterial.opacity = 0.35 * opacity;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry && o.geometry !== CYLINDER && o.geometry !== SPHERE) o.geometry.dispose();
    });
    this.material.dispose();
    this.torsoMaterial.dispose();
  }
}

// ---------- 球 ----------
class BallFigure {
  constructor(data, scene) {
    this.data = data;
    const color = new THREE.Color(BALL_COLOR);
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 20, 14),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.45 }),
    );
    this.mesh.castShadow = true;
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.14, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.trail = makeTrail(Math.max(2, Math.round(BALL_TRAIL_SEC * data.fps)), color);
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.marker, this.trail);
    scene.add(this.group);
    this.scene = scene;
  }

  update(frame, trailsOn) {
    const { pos, valid } = this.data.ball;
    const visible = !!valid[frame];
    this.mesh.visible = this.marker.visible = visible;
    if (visible) {
      const [x, y, z] = pos.subarray(frame * 3, frame * 3 + 3);
      this.mesh.position.set(x, y, z);
      this.marker.position.set(x, 0.011, z);
    }
    const pts = [];
    if (trailsOn) {
      const n = this.trail.userData.max;
      for (let f = Math.max(0, frame - n + 1); f <= frame; f++) {
        if (valid[f]) pts.push([pos[f * 3], pos[f * 3 + 1], pos[f * 3 + 2]]);
        else pts.length = 0; // 中斷的地方不要連線
      }
    }
    fillTrail(this.trail, pts);
  }

  setOverlay(on) {
    this.marker.material.opacity = on ? 0.5 : 0.8;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => o.geometry?.dispose());
  }
}

// ---------- 軌跡線（越舊越透明） ----------
function makeTrail(max, color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 4), 4));
  geo.setDrawRange(0, 0);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  line.frustumCulled = false;
  line.userData = { max, color };
  return line;
}

function fillTrail(line, pts) {
  const { color } = line.userData;
  const pos = line.geometry.attributes.position;
  const col = line.geometry.attributes.color;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    pos.setXYZ(i, pts[i][0], pts[i][1], pts[i][2]);
    const a = n > 1 ? (i / (n - 1)) ** 1.5 : 1;
    col.setXYZW(i, color.r, color.g, color.b, a * 0.95);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  line.geometry.setDrawRange(0, n >= 2 ? n : 0);
}

// ---------- 原機位相機：由校正得到的內參 K 與外參 R、t 建立 ----------
// K、R、t 採 OpenCV 慣例：X_cam = R · X_world + t，影像座標 u = fx·X/Z + cx
export function makeOverlayCamera({ width: W, height: H, K, R, t }) {
  const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
  const near = 0.1, far = 300;
  const cam = new THREE.PerspectiveCamera();
  cam.matrixAutoUpdate = false;
  cam.matrixWorldAutoUpdate = false;
  cam.projectionMatrix.set(
    (2 * fx) / W, 0, 1 - (2 * cx) / W, 0,
    0, (2 * fy) / H, (2 * cy) / H - 1, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0,
  );
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  // 相機中心 C = -Rᵀt；OpenGL 相機的 x 軸 = R 第 0 列，y 軸 = -R 第 1 列，z 軸 = -R 第 2 列
  const C = [0, 1, 2].map((i) => -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]));
  cam.matrixWorld.set(
    R[0][0], -R[1][0], -R[2][0], C[0],
    R[0][1], -R[1][1], -R[2][1], C[1],
    R[0][2], -R[1][2], -R[2][2], C[2],
    0, 0, 0, 1,
  );
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  cam.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
  return cam;
}
