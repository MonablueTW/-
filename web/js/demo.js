// 示範資料產生器：用程式「演」一個雙打回合（發球 → 回發 → 第三拍放小球 → 網前輕吊 → 快攻截擊 → 殺球得分），
// 輸出和 pipeline 相同格式的 JSON 物件。沒有任何真實影片，所以不涉及肖像或版權。
import { COURT, JOINTS, PLAYER_COLORS } from './court.js';

const FPS = 30;
const DURATION = 15.5;
const G = 9.81;

// ---------- 小工具：3D 向量 ----------
const v = (x = 0, y = 0, z = 0) => [x, y, z];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const madd = (...terms) => terms.reduce((acc, [vec, s]) => add(acc, mul(vec, s)), v());
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smooth = (t) => t * t * (3 - 2 * t);
const UP = v(0, 1, 0);

// ---------- 球員 ----------
// side：near = 近場（面向 -Z），far = 遠場（面向 +Z）
const PLAYERS = [
  { name: '近場·黃衣', side: 'near' },
  { name: '近場·黑衣', side: 'near' },
  { name: '遠場·白衣', side: 'far' },
  { name: '遠場·黑衣', side: 'far' },
];

// 每位球員的移動關鍵點：[時間, x, z, 蹲低程度 0~1]
const MOVES = [
  [[0, -1.6, 7.0, 0.3], [3.8, -1.6, 6.95, 0.35], [5.3, -1.6, 4.4, 0.25], [6.4, -1.55, 2.5, 0.6], [7.6, -1.45, 2.35, 0.65],
    [9.0, -1.5, 2.3, 0.65], [11.0, -1.45, 2.35, 0.65], [11.7, -1.55, 2.45, 0.7], [13.4, -1.25, 2.8, 0.3], [15.5, -0.9, 3.5, 0.05]],
  [[0, 1.0, 7.38, 0.15], [0.95, 1.0, 7.38, 0.2], [2.6, 1.25, 7.0, 0.35], [4.6, 1.3, 6.9, 0.35], [5.6, 1.4, 4.3, 0.25],
    [6.6, 1.45, 2.45, 0.6], [9.3, 1.3, 2.3, 0.65], [11.8, 1.2, 2.35, 0.65], [14.0, 0.3, 3.0, 0.2], [15.5, 0.5, 3.6, 0.05]],
  [[0, -0.85, -8.1, 0.35], [2.2, -0.85, -8.1, 0.4], [4.0, -1.1, -5.4, 0.25], [5.2, -1.25, -2.6, 0.55], [6.3, -1.2, -2.3, 0.65],
    [10.3, -1.2, -2.3, 0.65], [11.7, -1.15, -2.35, 0.65], [13.2, -1.0, -2.7, 0.3], [15.5, -1.0, -3.3, 0.05]],
  [[0, 1.4, -2.5, 0.55], [3.0, 1.3, -2.4, 0.6], [5.5, 1.25, -2.25, 0.6], [7.5, 1.2, -2.3, 0.65], [10.3, 1.1, -2.3, 0.65],
    [12.5, 1.0, -2.4, 0.5], [13.3, 0.8, -2.8, 0.3], [15.5, 0.9, -3.4, 0.05]],
];

// ---------- 擊球清單 ----------
// hitter：球員編號；stroke：fh 正手 / bh 反手 / serve 發球 / smash 殺球；volley：截擊（揮拍較短）
// contact：擊球點；land：落地點與時間（沒寫 = 對方直接截擊，不落地）
const SHOTS = [
  { hitter: 1, stroke: 'serve', t: 1.4, contact: v(1.2, 0.6, 7.0), land: { t: 2.45, x: -1.45, z: -5.2 } },
  { hitter: 2, stroke: 'fh', t: 2.85, contact: v(-1.35, 0.75, -7.8), land: { t: 4.05, x: -0.95, z: 4.6 } },
  { hitter: 0, stroke: 'fh', t: 4.5, contact: v(-1.1, 0.65, 6.6), land: { t: 5.75, x: 0.7, z: -1.2 } },
  { hitter: 3, stroke: 'fh', t: 6.2, contact: v(0.75, 0.3, -1.75), land: { t: 7.15, x: 1.0, z: 1.35 }, low: true },
  { hitter: 1, stroke: 'bh', t: 7.55, contact: v(1.0, 0.32, 1.8), land: { t: 8.5, x: -0.8, z: -1.3 }, low: true },
  { hitter: 2, stroke: 'bh', t: 8.9, contact: v(-0.85, 0.3, -1.85), land: { t: 9.85, x: -1.1, z: 1.45 }, low: true },
  { hitter: 0, stroke: 'fh', t: 10.25, contact: v(-1.1, 0.34, 1.9), land: { t: 11.2, x: 0.25, z: -1.5 }, low: true },
  { hitter: 3, stroke: 'fh', t: 11.6, contact: v(0.35, 0.55, -1.95) },
  { hitter: 0, stroke: 'fh', t: 12.0, contact: v(-1.2, 1.0, 2.35), volley: true },
  { hitter: 2, stroke: 'bh', t: 12.38, contact: v(-0.9, 0.95, -2.45), volley: true },
  { hitter: 1, stroke: 'smash', t: 12.78, contact: v(0.45, 1.45, 2.4), land: { t: 13.11, x: 0.3, z: -3.6 }, final: true },
];

const facingYaw = (side) => (side === 'near' ? Math.PI : 0);
const frameOf = (yaw) => {
  const F = v(Math.sin(yaw), 0, Math.cos(yaw));
  return { F, R: v(-Math.cos(yaw), 0, Math.sin(yaw)) };
};

// 擊球時身體要站在哪裡（依正反手，球在身體的右前方或左前方）
function bodyForShot(shot) {
  const side = PLAYERS[shot.hitter].side;
  const { F, R } = frameOf(facingYaw(side));
  const c = shot.contact;
  const lateral = { fh: -0.55, serve: -0.2, smash: -0.35, bh: 0.45 }[shot.stroke];
  const forward = shot.volley ? -0.25 : shot.stroke === 'serve' ? -0.38 : -0.35;
  const scale = shot.volley || shot.low ? 0.8 : 1;
  const p = madd([c, 1], [R, lateral * scale], [F, shot.low ? -0.28 : forward]);
  return [p[0], p[2]];
}

// ---------- 球的軌跡 ----------
function buildBall() {
  // 片段：{ t0, t1, p0, v0 }，位置 = p0 + v0·dt + ½·g·dt²
  const segs = [];
  const arc = (t0, p0, t1, p1) => {
    const T = t1 - t0;
    const v0 = mul(sub(sub(p1, p0), v(0, -0.5 * G * T * T, 0)), 1 / T);
    segs.push({ t0, t1, p0, v0 });
    return v0;
  };
  for (let i = 0; i < SHOTS.length; i++) {
    const s = SHOTS[i];
    const next = SHOTS[i + 1];
    if (s.land) {
      const L = v(s.land.x, 0, s.land.z);
      const vIn = arc(s.t, s.contact, s.land.t, L);
      if (next) arc(s.land.t, L, next.t, next.contact);
      else bounceOut(segs, s.land.t, L, add(vIn, v(0, -G * (s.land.t - s.t), 0)));
    } else if (next) {
      arc(s.t, s.contact, next.t, next.contact);
    }
  }
  const serve = SHOTS[0];
  const hold = add(serve.contact, v(0, 0.5 * G * 0.35 * 0.35, 0));
  return {
    hold, // 發球前球拿在左手
    release: serve.t - 0.35,
    at(t) {
      if (t < serve.t - 0.35) return hold;
      if (t < serve.t) {
        const dt = t - (serve.t - 0.35);
        return sub(hold, v(0, 0.5 * G * dt * dt, 0));
      }
      for (const s of segs) {
        if (t >= s.t0 && t <= s.t1) {
          const dt = t - s.t0;
          const p = madd([s.p0, 1], [s.v0, dt]);
          p[1] -= 0.5 * G * dt * dt;
          return Math.abs(p[2]) > 11.5 || Math.abs(p[0]) > 6.5 ? null : p;
        }
      }
      return null;
    },
  };
}

// 最後一球落地後照物理彈跳出場
function bounceOut(segs, t, p, vIn) {
  let vel = v(vIn[0] * 0.75, -vIn[1] * 0.6, vIn[2] * 0.75);
  let pos = p;
  for (let k = 0; k < 4 && t < DURATION; k++) {
    const T = (2 * vel[1]) / G;
    segs.push({ t0: t, t1: t + T, p0: pos, v0: vel });
    pos = add(pos, mul(vel, T));
    pos[1] = 0;
    t += T;
    vel = v(vel[0] * 0.8, vel[1] * 0.6, vel[2] * 0.8);
  }
}

// ---------- 移動路徑（通過關鍵點的平滑曲線） ----------
function buildPath(keys) {
  keys = [...keys].sort((a, b) => a[0] - b[0]);
  const n = keys.length;
  const tangents = keys.map((k, i) => {
    if (i === 0 || i === n - 1) return [0, 0, 0];
    const a = keys[i - 1], b = keys[i + 1];
    const dt = b[0] - a[0];
    return [1, 2, 3].map((j) => (0.8 * (b[j] - a[j])) / dt);
  });
  return (t) => {
    if (t <= keys[0][0]) return keys[0].slice(1);
    if (t >= keys[n - 1][0]) return keys[n - 1].slice(1);
    let i = 0;
    while (t > keys[i + 1][0]) i++;
    const [t0, t1] = [keys[i][0], keys[i + 1][0]];
    const h = t1 - t0, s = (t - t0) / h;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s;
    const h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    return [1, 2, 3].map((j, k) =>
      h00 * keys[i][j] + h10 * h * tangents[i][k] + h01 * keys[i + 1][j] + h11 * h * tangents[i + 1][k]);
  };
}

// ---------- 姿勢 ----------
const BODY = { hip: 0.93, spine: 0.52, thigh: 0.45, shin: 0.44, upper: 0.3, fore: 0.27, ankle: 0.085 };

// 兩節骨頭的 IK：給起點、終點、骨長與彎曲方向，回傳中間關節位置
function ik(a, c, l1, l2, pole) {
  let d = sub(c, a);
  let D = len(d);
  if (D > l1 + l2 - 1e-3) {
    c = add(a, mul(d, (l1 + l2 - 1e-3) / D));
    d = sub(c, a);
    D = l1 + l2 - 1e-3;
  }
  const dir = mul(d, 1 / D);
  const along = (l1 * l1 - l2 * l2 + D * D) / (2 * D);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  let perp = sub(pole, mul(dir, dot(pole, dir)));
  if (len(perp) < 1e-6) perp = v(0, 0, 1);
  return { mid: madd([a, 1], [dir, along], [norm(perp), h]), end: c };
}

// 揮拍：回傳這一刻的「手腕目標」與「軀幹扭轉角」
function swingState(t, shots) {
  let best = null;
  for (const s of shots) {
    const k = s.volley ? 0.55 : s.stroke === 'serve' ? 1.3 : 1;
    if (t > s.t - 0.6 * k && t < s.t + 0.8 * k) best = { shot: s, k };
  }
  return best;
}

function wristKeys(stroke, B, contactWrist, k) {
  const { SC, SR, SL, R, F } = B;
  const ready = madd([SC, 1], [F, 0.38], [R, 0.12], [UP, -0.3]);
  let back, follow, twist;
  if (stroke === 'fh') {
    back = madd([SR, 1], [R, 0.32], [F, -0.3], [UP, contactWrist[1] - SR[1] - 0.05]);
    follow = madd([SC, 1], [R, -0.22], [F, 0.35], [UP, 0.15]);
    twist = [0.6, -0.5];
  } else if (stroke === 'bh') {
    back = madd([SL, 1], [R, -0.12], [F, -0.05], [UP, contactWrist[1] - SL[1] + 0.05]);
    follow = madd([SR, 1], [R, 0.3], [F, 0.2], [UP, 0.25]);
    twist = [-0.7, 0.4];
  } else if (stroke === 'serve') {
    back = madd([SR, 1], [R, 0.15], [F, -0.35], [UP, -0.75]);
    follow = madd([SC, 1], [F, 0.4], [UP, 0.3], [R, 0.05]);
    twist = [0.35, -0.25];
  } else {
    back = madd([SR, 1], [R, 0.2], [F, -0.15], [UP, 0.45]);
    follow = madd([SC, 1], [R, -0.15], [F, 0.35], [UP, -0.35]);
    twist = [0.5, -0.55];
  }
  if (k < 1) {
    back = lerp(ready, back, 0.45);
    follow = lerp(ready, follow, 0.5);
  }
  return { ready, back, follow, twist };
}

function makePose(ctx) {
  const { root, yaw, crouch, speed, moveDir, gait, t, swing, holdBall, lookAt } = ctx;
  let { F, R } = frameOf(yaw);

  // 揮拍時間軸 → 扭轉角
  let twist = 0, wristTarget = null;
  const phase = swing ? (t - swing.shot.t) / swing.k : null;
  const keysAt = (sc) => {
    // 骨盆
    const hipY = BODY.hip - 0.2 * crouch - 0.025 * Math.abs(Math.sin(gait)) * Math.min(1, speed / 2);
    const pelvis = add(root, v(0, hipY, 0));
    const lean = 0.18 + 0.32 * crouch + 0.05 * Math.min(1, speed / 3);
    const Ft = madd([F, Math.cos(sc)], [R, Math.sin(sc)]);
    const Rt = madd([R, Math.cos(sc)], [F, -Math.sin(sc)]);
    const spineDir = norm(madd([UP, Math.cos(lean)], [Ft, Math.sin(lean)]));
    const SC = madd([pelvis, 1], [spineDir, BODY.spine]);
    return { pelvis, SC, SR: madd([SC, 1], [Rt, 0.19]), SL: madd([SC, 1], [Rt, -0.19]), R: Rt, F: Ft, spineDir, hipY };
  };

  let B = keysAt(0);
  if (swing) {
    const s = swing.shot;
    const toBall = sub(s.contact, B.SR);
    const reach = Math.min(len(toBall) - 0.26, BODY.upper + BODY.fore - 0.02);
    const contactWrist = madd([B.SR, 1], [norm(toBall), Math.max(0.2, reach)]);
    const K = wristKeys(s.stroke, B, contactWrist, swing.k);
    // 時間點（相對擊球，已依 k 縮放）：-0.6 就緒 → -0.2 引拍 → 0 擊球 → +0.3 收拍 → +0.8 回就緒
    const seq = [[-0.6, K.ready, 0], [-0.2, K.back, K.twist[0]], [0, contactWrist, 0], [0.3, K.follow, K.twist[1]], [0.8, K.ready, 0]];
    let i = 0;
    while (i < seq.length - 2 && phase > seq[i + 1][0]) i++;
    const u = smooth(clamp((phase - seq[i][0]) / (seq[i + 1][0] - seq[i][0]), 0, 1));
    twist = seq[i][2] + (seq[i + 1][2] - seq[i][2]) * u;
    B = keysAt(twist);
    // 手腕目標用扭轉後的身體重新計算，只有擊球點固定在世界座標
    const K2 = wristKeys(s.stroke, B, contactWrist, swing.k);
    const seq2 = [K2.ready, K2.back, contactWrist, K2.follow, K2.ready];
    wristTarget = lerp(seq2[i], seq2[i + 1], u);
  }

  const { pelvis, SC, SR, SL, spineDir } = B;
  const Rt = B.R, Ft = B.F;
  const hipL = madd([pelvis, 1], [R, -0.1]);
  const hipR = madd([pelvis, 1], [R, 0.1]);

  // 腳：原地站穩，移動時照步態循環抬腳
  const stance = 0.26 + 0.07 * crouch;
  const stride = speed / Math.max(1.4, 1.2 + 0.55 * speed);
  const lift = Math.min(0.13, 0.05 * speed);
  const foot = (sgn, ph) => {
    const u = ((ph / (2 * Math.PI)) % 1 + 1) % 1;
    let off, h = 0;
    if (u < 0.5) off = stride * (0.25 - u);
    else { off = stride * (-0.25 + (u - 0.5)); h = Math.sin((u - 0.5) * 2 * Math.PI) * lift; }
    const base = madd([root, 1], [R, sgn * stance], [F, sgn * 0.04]);
    return madd([base, 1], [moveDir, off], [UP, BODY.ankle + h]);
  };
  const ankleL = foot(-1, gait);
  const ankleR = foot(1, gait + Math.PI);
  const kneeL = ik(hipL, ankleL, BODY.thigh, BODY.shin, madd([F, 1], [R, -0.2])).mid;
  const kneeR = ik(hipR, ankleR, BODY.thigh, BODY.shin, madd([F, 1], [R, 0.2])).mid;
  const toe = (ankle, sgn) => madd([ankle, 1], [F, 0.15], [R, sgn * 0.03], [UP, -0.065]);
  const heel = (ankle) => madd([ankle, 1], [F, -0.06], [UP, -0.065]);

  // 頭：比軀幹更直一點，稍微轉向球
  const headDir = norm(add(spineDir, mul(UP, 1.2)));
  const head = madd([SC, 1], [headDir, 0.24]);
  let Fh = Ft;
  if (lookAt) {
    const d = sub(lookAt, head);
    d[1] = 0;
    if (len(d) > 0.3) Fh = norm(lerp(Ft, norm(d), 0.5));
  }
  const Rh = norm(cross(Fh, UP));

  // 手臂
  const wristR = wristTarget ?? madd([SC, 1], [Ft, 0.38], [Rt, 0.12], [UP, -0.3]);
  const wristL = holdBall ? sub(holdBall, v(0, 0.045, 0)) : madd([SC, 1], [Ft, 0.3], [Rt, -0.2], [UP, -0.28]);
  const armR = ik(SR, wristR, BODY.upper, BODY.fore, madd([UP, -1], [Rt, 0.6], [Ft, -0.3]));
  const armL = ik(SL, wristL, BODY.upper, BODY.fore, madd([UP, -1], [Rt, -0.6], [Ft, -0.3]));

  const J = {
    nose: madd([head, 1], [Fh, 0.1], [UP, -0.02]),
    left_eye: madd([head, 1], [Fh, 0.085], [Rh, -0.035], [UP, 0.02]),
    right_eye: madd([head, 1], [Fh, 0.085], [Rh, 0.035], [UP, 0.02]),
    left_ear: madd([head, 1], [Rh, -0.075], [Fh, -0.01]),
    right_ear: madd([head, 1], [Rh, 0.075], [Fh, -0.01]),
    left_shoulder: SL,
    right_shoulder: SR,
    left_elbow: armL.mid,
    right_elbow: armR.mid,
    left_wrist: armL.end,
    right_wrist: armR.end,
    left_hip: hipL,
    right_hip: hipR,
    left_knee: kneeL,
    right_knee: kneeR,
    left_ankle: ankleL,
    right_ankle: ankleR,
    left_heel: heel(ankleL),
    right_heel: heel(ankleR),
    left_toe: toe(ankleL, -1),
    right_toe: toe(ankleR, 1),
  };
  return JOINTS.flatMap((n) => J[n].map((x) => Math.round(x * 1000) / 1000));
}

// ---------- 原始攝影機（給「原機位疊合」用）：放在近場左後方的高處 ----------
function demoCamera() {
  const W = 1280, H = 720, f = 930;
  const C = v(-2.3, 2.9, 11.4);
  const target = v(0.5, 0.1, -0.8);
  const fwd = norm(sub(target, C));
  const right = norm(cross(fwd, UP));
  const down = cross(fwd, right);
  const R = [right, down, fwd];
  const t = R.map((row) => -dot(row, C));
  return { width: W, height: H, K: [[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], R, t };
}

export function generateDemo() {
  const frameCount = Math.round(DURATION * FPS);
  const ball = buildBall();
  const paths = MOVES.map((keys, i) => {
    const all = [...keys];
    for (const s of SHOTS.filter((s) => s.hitter === i)) {
      const [x, z] = bodyForShot(s);
      const c = s.low ? 0.95 : s.volley ? 0.6 : s.stroke === 'smash' ? 0.1 : 0.45;
      for (let k = all.length - 1; k >= 0; k--) if (Math.abs(all[k][0] - s.t) < 0.35) all.splice(k, 1);
      all.push([s.t, x, z, c]);
    }
    return buildPath(all);
  });

  const players = PLAYERS.map((p, i) => ({
    id: `p${i + 1}`,
    name: p.name,
    color: PLAYER_COLORS[i],
    side: p.side,
    frames: [],
  }));
  const ballFrames = [];
  const gaits = [0, 0, 0, 0];
  const prev = paths.map((path) => path(0));

  for (let f = 0; f < frameCount; f++) {
    const t = f / FPS;
    const b = ball.at(t);
    ballFrames.push(b ? b.map((x) => Math.round(x * 1000) / 1000) : null);
    PLAYERS.forEach((pl, i) => {
      const [x, z, crouch] = paths[i](t);
      const vel = f === 0 ? v() : mul(v(x - prev[i][0], 0, z - prev[i][1]), FPS);
      prev[i] = [x, z];
      const speed = len(vel);
      gaits[i] += (2 * Math.PI * Math.max(1.4, 1.2 + 0.55 * speed) * Math.min(1, speed / 0.4)) / FPS;
      // 面向：基本朝球網，再稍微轉向球的左右位置
      let yaw = facingYaw(pl.side);
      if (b) {
        const dx = b[0] - x, dz = Math.abs(b[2] - z);
        yaw += (pl.side === 'near' ? -1 : 1) * clamp((0.35 * dx) / Math.max(2, dz), -0.35, 0.35);
      }
      const shots = SHOTS.filter((s) => s.hitter === i);
      const holdBall = i === SHOTS[0].hitter && t < ball.release ? ball.hold : null;
      players[i].frames.push(makePose({
        root: v(x, 0, z),
        yaw,
        crouch: clamp(crouch, 0, 1),
        speed,
        moveDir: speed > 0.05 ? norm(vel) : frameOf(yaw).F,
        gait: gaits[i],
        t,
        swing: swingState(t, shots),
        holdBall,
        lookAt: b,
      }));
    });
  }

  return {
    format: 'pickleball-3d',
    version: 1,
    title: '示範資料',
    fps: FPS,
    frameCount,
    joints: JOINTS,
    players,
    ball: { frames: ballFrames },
    camera: demoCamera(),
    // 用 tools/render-demo-video.mjs 從同一台虛擬攝影機畫出來的「合成示範畫面」
    video: {
      src: [
        { src: 'demo/demo.mp4', type: 'video/mp4; codecs="avc1.64001f"' },
        { src: 'demo/demo.webm', type: 'video/webm; codecs="vp9"' },
      ],
      offset: 0,
    },
  };
}

export const DEMO_INTERNALS = { SHOTS, COURT };
