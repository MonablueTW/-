// 把 JSON 資料（pipeline 輸出或示範資料）整理成 viewer 內部用的結構。
// 資料格式說明請見 README 的「資料格式」一節。
import { PLAYER_COLORS } from './court.js';

export function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('資料不是 JSON 物件');
  const fps = Number(raw.fps);
  if (!(fps > 0)) throw new Error('缺少 fps');
  const joints = raw.joints;
  if (!Array.isArray(joints) || joints.length === 0) throw new Error('缺少 joints（關節名稱清單）');
  const J = joints.length;
  const players = Array.isArray(raw.players) ? raw.players : [];

  let frameCount = Number(raw.frameCount) || 0;
  for (const p of players) frameCount = Math.max(frameCount, p.frames?.length ?? 0);
  frameCount = Math.max(frameCount, raw.ball?.frames?.length ?? 0);
  if (frameCount === 0) throw new Error('資料裡沒有任何影格');

  const outPlayers = players.map((p, i) => {
    const pos = new Float32Array(frameCount * J * 3).fill(NaN);
    const valid = new Uint8Array(frameCount);
    const conf = new Float32Array(frameCount).fill(1);
    const frames = p.frames ?? [];
    for (let f = 0; f < frames.length; f++) {
      const a = frames[f];
      if (!a) continue;
      if (a.length !== J * 3) throw new Error(`球員 ${p.name ?? i} 第 ${f} 格的座標數量應為 ${J * 3}，實際是 ${a.length}`);
      for (let k = 0; k < J * 3; k++) pos[f * J * 3 + k] = a[k] ?? NaN;
      valid[f] = 1;
      if (Array.isArray(p.conf) && p.conf[f] != null) conf[f] = p.conf[f];
    }
    return {
      id: p.id ?? `p${i + 1}`,
      name: p.name ?? `球員 ${i + 1}`,
      color: p.color ?? PLAYER_COLORS[i % PLAYER_COLORS.length],
      side: p.side ?? null,
      pos,
      valid,
      conf,
      root: computeRoots(pos, valid, joints, frameCount),
    };
  });

  let ball = null;
  if (raw.ball?.frames) {
    const pos = new Float32Array(frameCount * 3).fill(NaN);
    const valid = new Uint8Array(frameCount);
    raw.ball.frames.forEach((b, f) => {
      if (!b) return;
      pos.set(b.slice(0, 3), f * 3);
      valid[f] = 1;
    });
    ball = { pos, valid };
  }

  let camera = null;
  if (raw.camera) {
    const { width, height, K, R, t } = raw.camera;
    if (!(width > 0 && height > 0 && K && R && t)) throw new Error('camera 需要 width、height、K、R、t');
    camera = { width, height, K, R, t };
  }

  return {
    sport: raw.sport ?? 'pickleball',
    title: raw.title ?? '',
    fps,
    frameCount,
    duration: frameCount / fps,
    joints,
    jointIndex: new Map(joints.map((name, i) => [name, i])),
    players: outPlayers,
    ball,
    camera,
    video: raw.video?.src?.length ? { src: raw.video.src, offset: Number(raw.video.offset) || 0 } : null,
  };
}

// 每一格的「站位點」：兩腳踝中點（沒有就用兩髖中點）投到地面，用來畫腳下光圈和移動軌跡。
function computeRoots(pos, valid, joints, frameCount) {
  const J = joints.length;
  const pick = (names) => names.map((n) => joints.indexOf(n)).filter((i) => i >= 0);
  const feet = pick(['left_ankle', 'right_ankle']);
  const hips = pick(['left_hip', 'right_hip']);
  const root = new Float32Array(frameCount * 3).fill(NaN);
  for (let f = 0; f < frameCount; f++) {
    if (!valid[f]) continue;
    for (const group of [feet, hips]) {
      let x = 0, z = 0, n = 0;
      for (const j of group) {
        const o = (f * J + j) * 3;
        if (Number.isFinite(pos[o]) && Number.isFinite(pos[o + 2])) {
          x += pos[o];
          z += pos[o + 2];
          n++;
        }
      }
      if (n) {
        root[f * 3] = x / n;
        root[f * 3 + 1] = 0;
        root[f * 3 + 2] = z / n;
        break;
      }
    }
  }
  return root;
}
