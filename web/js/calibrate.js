// 球場校正點標記工具：在影片畫面上點出球場角點，匯出 points.json 給 pipeline/calibrate.py。
import { SPORTS, getSport } from './court.js';

let sport = getSport('tennis');
let KEYPOINTS = sport.keypoints;

const $ = (s) => document.querySelector(s);
const canvas = $('#stage');
const ctx = canvas.getContext('2d');
const video = $('#srcVideo');
const frame = document.createElement('canvas'); // 目前的畫面（原始解析度）
const fctx = frame.getContext('2d', { willReadFrequently: true });

const state = {
  loaded: false,
  source: '',
  time: 0,
  points: new Map(), // 名稱 → [u, v]（原始像素）
  active: KEYPOINTS[0][0],

  view: { scale: 1, ox: 0, oy: 0 }, // 畫面座標 = 影像座標 × scale + offset
  homography: null,
};

// ---------- 載入 ----------
$('#fileMedia').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.source = file.name;
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) {
    const img = new Image();
    img.onload = () => {
      setFrameSize(img.naturalWidth, img.naturalHeight);
      fctx.drawImage(img, 0, 0);
      $('#timeGroup').hidden = true;
      frameReady(true);
    };
    img.src = url;
  } else {
    video.src = url;
    await once(video, 'loadedmetadata');
    setFrameSize(video.videoWidth, video.videoHeight);
    const tl = $('#time');
    tl.max = String(video.duration);
    tl.value = String(Math.min(1, video.duration / 2));
    $('#timeGroup').hidden = false;
    await seekAndGrab(Number(tl.value));
    frameReady(true);
  }
});

$('#time').addEventListener('input', async (e) => {
  await seekAndGrab(Number(e.target.value));
  frameReady(false);
});

function once(el, ev) {
  return new Promise((resolve) => el.addEventListener(ev, resolve, { once: true }));
}

async function seekAndGrab(t) {
  state.time = t;
  $('#timeLabel').textContent = `${t.toFixed(2)} s`;
  if (Math.abs(video.currentTime - t) > 1e-3) {
    video.currentTime = t;
    await once(video, 'seeked');
  }
  fctx.drawImage(video, 0, 0, frame.width, frame.height);
}

function setFrameSize(w, h) {
  frame.width = w;
  frame.height = h;
}

function frameReady(fit) {
  state.loaded = true;
  $('#empty').hidden = true;
  $('#btnExport').disabled = false;
  if (fit) fitView();
  draw();
}

// 多個畫面取中位數：會動的人被去掉，只剩固定的球場（攝影機必須固定）
$('#btnMedian').addEventListener('click', async () => {
  const n = 15;
  const W = frame.width, H = frame.height;
  const samples = [];
  const keep = state.time;
  for (let i = 0; i < n; i++) {
    status(`取樣畫面 ${i + 1}/${n}…`);
    await seekAndGrab((video.duration * (i + 0.5)) / n);
    samples.push(fctx.getImageData(0, 0, W, H).data.slice());
  }
  status('計算中位數…');
  await new Promise((r) => setTimeout(r, 30));
  const out = fctx.createImageData(W, H);
  const vals = new Uint8Array(n);
  for (let p = 0; p < W * H * 4; p++) {
    if ((p & 3) === 3) { out.data[p] = 255; continue; }
    for (let i = 0; i < n; i++) vals[i] = samples[i][p];
    vals.sort();
    out.data[p] = vals[n >> 1];
  }
  fctx.putImageData(out, 0, 0);
  state.time = keep;
  status('已去除球員（中位數背景）', 2500);
  draw();
});

// ---------- 球種、點清單與示意圖 ----------
function setSport(id) {
  sport = getSport(id);
  KEYPOINTS = sport.keypoints;
  state.points = new Map(); // 不同球場的點位置都不一樣（名稱相同也是），換球種就重新標
  state.active = KEYPOINTS[0][0];
  $('#sportSelect').value = sport.id;
  buildList();
  refresh();
}

$('#sportSelect').innerHTML = Object.values(SPORTS).map((sp) => `<option value="${sp.id}">${sp.name}</option>`).join('');
$('#sportSelect').addEventListener('change', (e) => setSport(e.target.value));

$('#pointList').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  if (e.target.classList.contains('del')) state.points.delete(li.dataset.name);
  state.active = li.dataset.name;
  refresh();
});
$('#diagram').addEventListener('click', (e) => {
  const name = e.target.dataset?.name;
  if (name) { state.active = name; refresh(); }
});

function buildList() {
  $('#pointList').innerHTML = KEYPOINTS.map(([name, label]) =>
    `<li data-name="${name}"><span class="dot"></span><span>${label}</span><span class="xy"></span><button class="del" type="button" title="刪除">✕</button></li>`).join('');
  // 示意圖：俯視，近場（攝影機）在下
  const { halfWidth: hw, halfLength: hl, postX } = sport;
  const mx = hw + 1.4, mz = hl + 1.4;
  const rect = ([x0, z0, x1, z1], fill) => `<rect x="${x0}" y="${z0}" width="${x1 - x0}" height="${z1 - z0}" fill="${fill}" />`;
  const r = hl / 6.7; // 圓點大小跟著球場比例
  const dots = KEYPOINTS.map(([name, , x, y, z]) => {
    const dy = y > 0 ? -0.45 * r : 0; // 網柱頂稍微往上畫，和網柱底分開
    return `<circle data-name="${name}" cx="${x}" cy="${z + dy}" r="${0.26 * r}" />`;
  }).join('');
  const svg = $('#diagram');
  svg.setAttribute('viewBox', `${-mx} ${-mz} ${2 * mx} ${2 * mz}`);
  svg.innerHTML = `
    <rect x="${-mx}" y="${-mz}" width="${2 * mx}" height="${2 * mz}" fill="#216b5c" />
    ${sport.surfaces.map((s) => rect(s, '#2a5bb0')).join('')}
    ${sport.lines.map((s) => rect(s, '#ffffff')).join('')}
    <line x1="${-postX}" y1="0" x2="${postX}" y2="0" stroke="#111" stroke-width="${0.14 * r}" />
    <g class="kp">${dots}</g>`;
}

function refresh() {
  document.querySelectorAll('#pointList li').forEach((li) => {
    const p = state.points.get(li.dataset.name);
    li.classList.toggle('set', !!p);
    li.classList.toggle('active', li.dataset.name === state.active);
    li.querySelector('.xy').textContent = p ? `${p[0].toFixed(1)}, ${p[1].toFixed(1)}` : '';
  });
  document.querySelectorAll('#diagram circle').forEach((c) => {
    const n = c.dataset.name;
    c.setAttribute('fill', n === state.active ? '#f6c90e' : state.points.has(n) ? '#3ddc84' : '#0d1117');
    c.setAttribute('stroke', n === state.active ? '#fff' : '#9aa1ad');
    c.setAttribute('stroke-width', '0.06');
  });
  state.homography = computeHomography();
  draw();
}

function nextActive() {
  const i = KEYPOINTS.findIndex(([n]) => n === state.active);
  for (let k = 1; k <= KEYPOINTS.length; k++) {
    const n = KEYPOINTS[(i + k) % KEYPOINTS.length][0];
    if (!state.points.has(n)) { state.active = n; return; }
  }
}

// ---------- Homography（地面 x,z → 影像 u,v），用來畫預覽線 ----------
function computeHomography() {
  const pairs = KEYPOINTS.filter(([n, , , y]) => y === 0 && state.points.has(n))
    .map(([n, , x, , z]) => [[x, z], state.points.get(n)]);
  if (pairs.length < 4) return null;
  const norm = (pts) => {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
    const s = Math.SQRT2 / d;
    return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], f: (p) => [s * (p[0] - cx), s * (p[1] - cy)] };
  };
  const A = norm(pairs.map((p) => p[0]));
  const B = norm(pairs.map((p) => p[1]));
  // 解 h33 = 1 的 8 個未知數（最小平方：正規方程式）
  const M = Array.from({ length: 8 }, () => new Array(9).fill(0));
  for (const [w, im] of pairs) {
    const [x, y] = A.f(w);
    const [u, v] = B.f(im);
    for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]]) {
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) M[i][j] += row[i] * row[j];
        M[i][8] += row[i] * rhs;
      }
    }
  }
  const h = gauss(M);
  if (!h) return null;
  const Hn = [...h, 1];
  // H = B⁻¹ · Hn · A
  return mat3mul(mat3mul(inv3(B.T), Hn), A.T);
}

function gauss(M) {
  const n = M.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
const mat3mul = (a, b) => Array.from({ length: 9 }, (_, i) =>
  a[Math.floor(i / 3) * 3] * b[i % 3] + a[Math.floor(i / 3) * 3 + 1] * b[3 + (i % 3)] + a[Math.floor(i / 3) * 3 + 2] * b[6 + (i % 3)]);
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
    .map((v) => v / det);
}
function applyH(H, x, z) {
  const w = H[6] * x + H[7] * z + H[8];
  return [(H[0] * x + H[1] * z + H[2]) / w, (H[3] * x + H[4] * z + H[5]) / w];
}

// ---------- 繪製 ----------
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function fitView() {
  const r = canvas.getBoundingClientRect();
  const s = Math.min(r.width / frame.width, r.height / frame.height);
  state.view = { scale: s, ox: (r.width - frame.width * s) / 2, oy: (r.height - frame.height * s) / 2 };
}

const toScreen = ([u, v]) => [u * state.view.scale + state.view.ox, v * state.view.scale + state.view.oy];
const toImage = ([x, y]) => [(x - state.view.ox) / state.view.scale, (y - state.view.oy) / state.view.scale];

function draw() {
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (!state.loaded) return;
  const { scale, ox, oy } = state.view;
  ctx.imageSmoothingEnabled = scale < 3;
  ctx.drawImage(frame, ox, oy, frame.width * scale, frame.height * scale);

  // 推算的球場線（至少 4 個地面點）
  if (state.homography) {
    const H = state.homography;
    const segs = sport.lines.map(([x0, z0, x1, z1]) =>
      (x1 - x0 >= z1 - z0 ? [x0, (z0 + z1) / 2, x1, (z0 + z1) / 2] : [(x0 + x1) / 2, z0, (x0 + x1) / 2, z1]));
    ctx.strokeStyle = 'rgba(255, 214, 0, .85)';
    ctx.lineWidth = 1.5;
    for (const [x1, z1, x2, z2] of segs) {
      ctx.beginPath();
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const p = toScreen(applyH(H, x1 + (x2 - x1) * t, z1 + (z2 - z1) * t));
        i ? ctx.lineTo(...p) : ctx.moveTo(...p);
      }
      ctx.stroke();
    }
  }

  // 已標的點
  ctx.font = '12px system-ui, sans-serif';
  for (const [name, label] of KEYPOINTS) {
    const p = state.points.get(name);
    if (!p) continue;
    const [x, y] = toScreen(p);
    const active = name === state.active;
    ctx.strokeStyle = active ? '#f6c90e' : '#3ddc84';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.moveTo(x - 11, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 11);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    const w = ctx.measureText(label).width;
    ctx.fillRect(x + 10, y - 22, w + 8, 17);
    ctx.fillStyle = active ? '#f6c90e' : '#fff';
    ctx.fillText(label, x + 14, y - 9);
  }
}

// ---------- 操作：點擊放點、拖曳點、拖曳平移、滾輪／雙指縮放 ----------
const pointers = new Map();
let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  if (!state.loaded) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (pointers.size === 2) {
    drag = { type: 'pinch', ...pinchInfo() };
    return;
  }
  const hit = [...state.points].find(([, p]) => Math.hypot(...sub(toScreen(p), [e.offsetX, e.offsetY])) < 12);
  drag = hit
    ? { type: 'point', name: hit[0], start: [e.offsetX, e.offsetY], moved: false }
    : { type: 'maybe', start: [e.offsetX, e.offsetY], view: { ...state.view } };
  if (hit) { state.active = hit[0]; refresh(); }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, [e.offsetX, e.offsetY]);
  if (!drag) return;
  if (drag.type === 'pinch' && pointers.size === 2) {
    const now = pinchInfo();
    const s = Math.max(0.05, Math.min(40, drag.scale * (now.dist / drag.dist)));
    const [ix, iy] = drag.imagePoint;
    state.view = { scale: s, ox: now.center[0] - ix * s, oy: now.center[1] - iy * s };
    draw();
  } else if (drag.type === 'point') {
    state.points.set(drag.name, toImage([e.offsetX, e.offsetY]));
    drag.moved = true;
    refresh();
  } else if (drag.type === 'maybe' || drag.type === 'pan') {
    const dx = e.offsetX - drag.start[0], dy = e.offsetY - drag.start[1];
    if (drag.type === 'maybe' && Math.hypot(dx, dy) > 5) drag.type = 'pan';
    if (drag.type === 'pan') {
      state.view = { ...drag.view, ox: drag.view.ox + dx, oy: drag.view.oy + dy };
      draw();
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  pointers.delete(e.pointerId);
  if (drag?.type === 'maybe') {
    state.points.set(state.active, toImage([e.offsetX, e.offsetY]));
    nextActive();
    refresh();
  }
  if (pointers.size === 0) drag = null;
});
canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); drag = null; });

function pinchInfo() {
  const [a, b] = [...pointers.values()];
  const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, center, scale: state.view.scale, imagePoint: toImage(center) };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

canvas.addEventListener('wheel', (e) => {
  if (!state.loaded) return;
  e.preventDefault();
  zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY / 400));
}, { passive: false });

function zoomAt(x, y, factor) {
  const [ix, iy] = toImage([x, y]);
  const s = Math.max(0.05, Math.min(40, state.view.scale * factor));
  state.view = { scale: s, ox: x - ix * s, oy: y - iy * s };
  draw();
}

window.addEventListener('keydown', (e) => {
  if (!state.loaded || e.target.closest?.('input')) return;
  const p = state.points.get(state.active);
  const step = e.shiftKey ? 2 : 0.5;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (nudge && p) {
    e.preventDefault();
    state.points.set(state.active, [p[0] + nudge[0], p[1] + nudge[1]]);
    refresh();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    state.points.delete(state.active);
    refresh();
  } else if (e.key === '+' || e.key === '=') {
    const r = canvas.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1.25);
  } else if (e.key === '-') {
    const r = canvas.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 0.8);
  } else if (e.key === '0') {
    fitView();
    draw();
  }
});

// ---------- 匯出／匯入 ----------
$('#btnExport').addEventListener('click', () => {
  const ground = KEYPOINTS.filter(([n, , , y]) => y === 0 && state.points.has(n)).length;
  if (ground < 4 && !confirm(`目前只有 ${ground} 個地面點（至少要 4 個）。仍要下載嗎？`)) return;
  const out = {
    sport: sport.id,
    width: frame.width,
    height: frame.height,
    video: state.source,
    time: Number(state.time.toFixed(3)),
    points: Object.fromEntries([...state.points].map(([n, [u, v]]) => [n, [round1(u), round1(v)]])),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 'points.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
const round1 = (x) => Math.round(x * 10) / 10;

$('#filePoints').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.sport && data.sport !== sport.id) setSport(data.sport);
    const sx = state.loaded && data.width ? frame.width / data.width : 1;
    const sy = state.loaded && data.height ? frame.height / data.height : 1;
    state.points = new Map(Object.entries(data.points ?? {}).map(([n, [u, v]]) => [n, [u * sx, v * sy]]));
    if (data.time != null && !$('#timeGroup').hidden) {
      $('#time').value = String(data.time);
      await seekAndGrab(Number(data.time));
    }
    refresh();
    status(`已載入 ${state.points.size} 個點`, 2000);
  } catch (err) {
    status(`無法讀取：${err.message}`, 4000);
  }
  e.target.value = '';
});

let statusTimer = 0;
function status(text, timeout = 0) {
  const el = $('#status');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(statusTimer);
  if (timeout) statusTimer = setTimeout(() => { el.hidden = true; }, timeout);
}

// 方便在主控台除錯
window.calib = { state, toScreen };

new ResizeObserver(resizeCanvas).observe($('#stageWrap'));
setSport(location.hash === '#pickleball' ? 'pickleball' : 'tennis');
