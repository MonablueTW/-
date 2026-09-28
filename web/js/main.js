// 進入點：載入資料、控制播放、和對照影片同步、處理按鈕與快捷鍵。
import { CourtView, VIEWS } from './scene.js';
import { normalize } from './format.js';

const $ = (sel) => document.querySelector(sel);
const video = $('#video');
const view = new CourtView($('#canvas3d'), $('#view3d'), video);

const state = {
  data: null,
  playing: false,
  speed: 1,
  time: 0, // 秒（資料時間，0 = 第 0 格）
  frame: -1,
  hasVideo: false,
  offset: 0, // 資料第 0 格對應到影片的哪一秒
  objectUrls: [],
};

// ---------- 載入 ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  const list = await fetchJson('data/index.json').catch(() => null);
  const entries = Array.isArray(list) ? list.filter((e) => e && e.src) : [];
  setupDatasetSelect(entries);

  const src = params.get('data') ?? (entries[0] ? `data/${entries[0].src}` : null);
  try {
    if (src) await loadUrl(src);
    else await loadDemo();
  } catch (err) {
    console.error(err);
    showMessage(`載入失敗：${err.message}，改用示範資料。`, true);
    await loadDemo();
  }

  if (params.has('view')) selectView(params.get('view'), false);
  if (params.has('frame')) {
    setPlaying(false);
    seekFrame(Number(params.get('frame')) || 0);
  }
  if (params.get('paused') === '1') setPlaying(false);
  if (params.get('trails') === '0') toggleTrails(false);
  if (params.get('compare') === '0') toggleCompare(false);
  document.body.dataset.ready = '1';
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function loadUrl(url) {
  showMessage('載入中…');
  const raw = await fetchJson(url);
  const data = normalize(raw);
  setData(data, pickVideo(data.video, new URL(url, location.href)));
  hideMessage();
}

async function loadDemo() {
  const { generateDemo } = await import('./demo.js');
  const raw = generateDemo();
  const data = normalize(raw);
  setData(data, pickVideo(data.video, new URL(location.href)));
}

// video.src 可以是一個路徑，或 [{ src, type }, …]（挑第一個瀏覽器能播的格式）
function pickVideo(info, base) {
  if (!info) return null;
  const list = Array.isArray(info.src) ? info.src : [{ src: info.src }];
  const ok = list.find((s) => !s.type || video.canPlayType(s.type)) ?? list[list.length - 1];
  return new URL(ok.src, base).href;
}

function setData(data, videoUrl) {
  state.data = data;
  state.frame = -1;
  state.time = 0;
  view.setData(data);

  $('#datasetTag').textContent = data.title;
  $('#legend').innerHTML = data.players
    .map((p) => `<li><span class="dot" style="background:${escapeHtml(p.color)}"></span>${escapeHtml(p.name)}</li>`)
    .join('');
  const tl = $('#timeline');
  tl.max = String(data.frameCount - 1);

  setVideo(videoUrl, data.video?.offset ?? 0);
  toggleCompare(!!videoUrl); // 沒有影片就讓 3D 佔滿畫面
  updateViewButtons();
  seekFrame(0);
  setPlaying(true);
}

function setVideo(url, offset) {
  video.pause();
  pendingSeek = null;
  state.offset = offset;
  if (url) {
    state.hasVideo = true;
    video.src = url;
    video.playbackRate = state.speed;
    video.load();
  } else {
    state.hasVideo = false;
    video.removeAttribute('src');
    video.load();
  }
  $('#noVideo').hidden = !!url;
  view.videoChanged();
}

// 影片還沒載入就要求跳到某一格時，先記下來，等 metadata 載入後再跳
let pendingSeek = null;
video.addEventListener('loadedmetadata', async () => {
  // 有些伺服器不支援 HTTP Range，影片就不能跳轉（seekable 只有 0 秒）→ 整個下載成 blob 再播
  const src = video.currentSrc || video.src;
  const s = video.seekable;
  if (src && !src.startsWith('blob:') && (s.length === 0 || s.end(s.length - 1) < video.duration - 0.5)) {
    try {
      pendingSeek ??= state.offset + Math.max(0, state.time);
      const blobUrl = URL.createObjectURL(await (await fetch(src)).blob());
      state.objectUrls.push(blobUrl);
      video.src = blobUrl;
      if (state.playing) video.play().catch(() => {});
      return;
    } catch (err) {
      console.warn('無法下載影片以支援跳轉', err);
    }
  }
  if (pendingSeek != null) {
    video.currentTime = pendingSeek;
    pendingSeek = null;
  }
});
video.addEventListener('loadeddata', () => {
  view.videoChanged();
  if (state.playing) video.play().catch(() => {});
});
video.addEventListener('seeked', () => view.videoFrameChanged());
video.addEventListener('error', () => {
  if (!video.getAttribute('src')) return;
  state.hasVideo = false;
  $('#noVideo').hidden = false;
  showMessage('影片無法播放（格式可能不支援）。建議轉成 H.264 編碼的 MP4。', true);
});

// requestVideoFrameCallback 可以拿到「目前畫面上那一格」的精確時間，讓 3D 和影片逐格對齊
let presentedTime = null;
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
  const onFrame = (_now, meta) => {
    presentedTime = meta.mediaTime;
    view.videoFrameChanged();
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

// ---------- 播放時鐘 ----------
const frameAt = (t) => Math.floor(t * state.data.fps + 1e-3);

function currentVideoTime() {
  if (!video.paused && presentedTime != null) return presentedTime;
  return video.currentTime;
}

let lastNow = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  const d = state.data;
  if (d) {
    if (state.hasVideo && video.readyState >= 1 && !video.seeking && pendingSeek == null) {
      state.time = currentVideoTime() - state.offset;
      if (state.playing && (state.time >= d.duration - 0.5 / d.fps || video.ended)) {
        seekFrame(0); // 播完從頭再來
        if (video.paused) video.play().catch(() => {});
      }
    } else if (state.playing) {
      state.time += dt * state.speed;
      if (state.time >= d.duration) state.time %= d.duration;
    }
    const f = Math.max(0, Math.min(d.frameCount - 1, frameAt(Math.max(0, state.time))));
    if (f !== state.frame) {
      state.frame = f;
      view.setFrame(f);
      updateTimeUI();
    }
  }
  view.render(state.hasVideo && !video.paused && view.viewName === 'overlay');
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function seekFrame(f) {
  const d = state.data;
  if (!d) return;
  f = Math.max(0, Math.min(d.frameCount - 1, Math.round(f)));
  state.time = (f + 0.5) / d.fps; // 對到該格的中間，避免四捨五入誤差
  presentedTime = null;
  if (state.hasVideo) {
    if (video.readyState >= 1) video.currentTime = state.offset + state.time;
    else pendingSeek = state.offset + state.time;
  }
  state.frame = f;
  view.setFrame(f);
  updateTimeUI();
}

function setPlaying(on) {
  state.playing = on;
  if (state.hasVideo) {
    if (on) {
      video.play().catch(() => {
        // 瀏覽器不允許自動播放時停在暫停狀態
        state.playing = false;
        updatePlayUI();
      });
    } else video.pause();
  }
  updatePlayUI();
}

function setSpeed(s) {
  state.speed = s;
  video.playbackRate = s;
  document.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === s));
}

// ---------- UI ----------
function updatePlayUI() {
  $('#btnPlay').textContent = state.playing ? '■ 暫停' : '▶ 播放';
}

function updateTimeUI() {
  const d = state.data;
  const t = Math.max(0, state.time);
  $('#timecode').textContent = `${t.toFixed(2)} s · #${state.frame}`;
  const tl = $('#timeline');
  tl.value = String(state.frame);
  const pct = d.frameCount > 1 ? (state.frame / (d.frameCount - 1)) * 100 : 0;
  tl.style.setProperty('--pct', `${pct}%`);
}

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function selectView(name, animate = true) {
  if (!VIEWS[name]) return;
  if (!view.setView(name, animate && !reducedMotion)) {
    showMessage('這份資料沒有相機校正（camera），無法使用原機位疊合。', true);
    return;
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#viewHint').textContent = VIEWS[name].hint;
}

function updateViewButtons() {
  const btn = document.querySelector('[data-view="overlay"]');
  btn.disabled = !view.hasOverlay();
  btn.title = view.hasOverlay() ? '用原始攝影機的位置看 3D，疊在影片上' : '需要相機校正資料';
  if (!view.hasOverlay() && view.viewName === 'overlay') selectView('orbit', false);
}

function toggleTrails(on = !$('#btnTrails').classList.contains('active')) {
  $('#btnTrails').classList.toggle('active', on);
  view.setTrails(on);
}

function toggleCompare(on = !$('#btnVideo').classList.contains('active')) {
  $('#btnVideo').classList.toggle('active', on);
  document.body.classList.toggle('no-compare', !on);
}

$('#btnPlay').addEventListener('click', () => setPlaying(!state.playing));
$('#btnPrev').addEventListener('click', () => { setPlaying(false); seekFrame(state.frame - 1); });
$('#btnNext').addEventListener('click', () => { setPlaying(false); seekFrame(state.frame + 1); });
$('#timeline').addEventListener('input', (e) => seekFrame(Number(e.target.value)));
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(Number(b.dataset.speed))));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => selectView(b.dataset.view)));
$('#btnTrails').addEventListener('click', () => toggleTrails());
$('#btnVideo').addEventListener('click', () => toggleCompare());
$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  loadFiles([...e.target.files]);
  e.target.value = '';
});

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const keyViews = { 1: 'orbit', 2: 'overlay', 3: 'top', 4: 'behind', 5: 'side' };
  if (e.key === ' ') { e.preventDefault(); setPlaying(!state.playing); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); seekFrame(state.frame - 1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); seekFrame(state.frame + 1); }
  else if (keyViews[e.key]) selectView(keyViews[e.key]);
  else if (e.key === 't' || e.key === 'T') toggleTrails();
  else if (e.key === 'v' || e.key === 'V') toggleCompare();
});

// ---------- 資料選單（data/index.json） ----------
function setupDatasetSelect(entries) {
  const sel = $('#datasetSelect');
  if (!entries.length) return;
  sel.innerHTML = entries
    .map((e) => `<option value="data/${escapeHtml(e.src)}">${escapeHtml(e.title ?? e.src)}</option>`)
    .join('') + '<option value="__demo__">示範（合成資料）</option>';
  sel.hidden = false;
  sel.addEventListener('change', async () => {
    try {
      if (sel.value === '__demo__') await loadDemo();
      else await loadUrl(sel.value);
    } catch (err) {
      showMessage(`載入失敗：${err.message}`, true);
    }
  });
}

// ---------- 開啟本機檔案（按鈕或拖放） ----------
async function loadFiles(files) {
  const jsonFile = files.find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
  const videoFile = files.find((f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(f.name));
  try {
    for (const u of state.objectUrls) URL.revokeObjectURL(u);
    state.objectUrls = [];
    const videoUrl = videoFile ? URL.createObjectURL(videoFile) : null;
    if (videoUrl) state.objectUrls.push(videoUrl);
    if (jsonFile) {
      const data = normalize(JSON.parse(await jsonFile.text()));
      setData(data, videoUrl);
      showMessage(`已載入 ${jsonFile.name}${videoFile ? ` ＋ ${videoFile.name}` : ''}`, false, 2500);
    } else if (videoFile && state.data) {
      setVideo(videoUrl, state.data.video?.offset ?? 0);
      seekFrame(0);
      setPlaying(true);
      showMessage(`已換成影片 ${videoFile.name}`, false, 2500);
    } else {
      showMessage('請選擇 pipeline 產生的 .json（可以連同影片一起選）。', true);
    }
  } catch (err) {
    console.error(err);
    showMessage(`無法讀取：${err.message}`, true);
  }
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropHint').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropHint').hidden = true;
  loadFiles([...e.dataTransfer.files]);
});

// ---------- 訊息 ----------
let messageTimer = 0;
function showMessage(text, isError = false, timeout = isError ? 6000 : 0) {
  const el = $('#message');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(messageTimer);
  if (timeout) messageTimer = setTimeout(hideMessage, timeout);
}
function hideMessage() {
  $('#message').hidden = true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 方便在瀏覽器主控台除錯：pickleball.view.camera、pickleball.state …
window.pickleball = { view, state };

boot();
