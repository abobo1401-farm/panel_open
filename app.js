const PANEL_COUNT = 16;
const STATE_KEY = 'panelRevealStateV020';
const DB_NAME = 'panelRevealDBV020';
const DB_VERSION = 1;
const STORE = 'images';
const CHANNEL_NAME = 'panel-reveal-v020';

const DEFAULT_STATE = {
  mode: 'one',
  title: '公開パネル',
  labels: Array(PANEL_COUNT).fill('？？？'),
  opened: Array(PANEL_COUNT).fill(false),
  hasCover: false,
  hasOneBack: false,
  hasIndividual: Array(PANEL_COUNT).fill(false),
  soundVolume: 0.55,
  updatedAt: Date.now()
};

let dbPromise = null;
let channel = null;
const objectUrls = new Map();

function normalizeState(raw) {
  const s = { ...DEFAULT_STATE, ...(raw || {}) };
  s.labels = Array.from({ length: PANEL_COUNT }, (_, i) => {
    const v = s.labels?.[i];
    return typeof v === 'string' ? v : '？？？';
  });
  s.opened = Array.from({ length: PANEL_COUNT }, (_, i) => !!s.opened?.[i]);
  s.hasIndividual = Array.from({ length: PANEL_COUNT }, (_, i) => !!s.hasIndividual?.[i]);
  s.soundVolume = Math.max(0, Math.min(1, Number(s.soundVolume ?? 0.55)));
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return normalizeState(raw ? JSON.parse(raw) : DEFAULT_STATE);
  } catch {
    return normalizeState(DEFAULT_STATE);
  }
}

function saveState(state, broadcast = true) {
  state.updatedAt = Date.now();
  localStorage.setItem(STATE_KEY, JSON.stringify(normalizeState(state)));
  if (broadcast) sendMessage({ type: 'state', state: normalizeState(state) });
}

function getChannel() {
  if (!channel && 'BroadcastChannel' in window) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

function sendMessage(message) {
  try { getChannel()?.postMessage(message); } catch {}
}

function subscribeState(callback) {
  const ch = getChannel();
  if (ch) ch.addEventListener('message', e => {
    if (e.data?.type === 'state') callback(normalizeState(e.data.state));
    if (e.data?.type === 'images-changed') callback(loadState(), { imagesChanged: true });
  });
  window.addEventListener('storage', e => {
    if (e.key === STATE_KEY && e.newValue) {
      try { callback(normalizeState(JSON.parse(e.newValue))); } catch {}
    }
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function putImage(key, file) {
  if (!file) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(file, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  revokeCachedUrl(key);
  sendMessage({ type: 'images-changed', key });
}

async function getImageBlob(key) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function revokeCachedUrl(key) {
  const old = objectUrls.get(key);
  if (old) URL.revokeObjectURL(old);
  objectUrls.delete(key);
}

async function getImageUrl(key) {
  if (objectUrls.has(key)) return objectUrls.get(key);
  const blob = await getImageBlob(key);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

async function removeImage(key) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  revokeCachedUrl(key);
  sendMessage({ type: 'images-changed', key });
}

function bgPos(i) {
  const col = i % 4;
  const row = Math.floor(i / 4);
  return `${col * 100 / 3}% ${row * 100 / 3}%`;
}

async function renderBoard(root, state, { clickable = false, allowOpenedClick = false, onClick = null } = {}) {
  const renderToken = String(Date.now()) + Math.random();
  root.dataset.renderToken = renderToken;
  root.innerHTML = '';
  root.className = 'panel-preview';

  if (state.mode === 'one') {
    const back = document.createElement('div');
    back.className = 'backdrop-one';
    root.appendChild(back);
    if (state.hasOneBack) {
      const url = await getImageUrl('oneBack');
      if (root.dataset.renderToken !== renderToken) return;
      back.style.backgroundImage = url ? `url("${url}")` : '';
    }
  } else {
    const grid = document.createElement('div');
    grid.className = 'individual-back';
    root.appendChild(grid);
    for (let i = 0; i < PANEL_COUNT; i++) {
      const cell = document.createElement('div');
      cell.className = 'individual-cell';
      grid.appendChild(cell);
      if (state.hasIndividual[i]) {
        const url = await getImageUrl(`individual-${i}`);
        if (root.dataset.renderToken !== renderToken) return;
        if (url) {
          const img = new Image();
          img.src = url;
          img.alt = '';
          cell.appendChild(img);
        }
      }
    }
  }

  const coverUrl = state.hasCover ? await getImageUrl('cover') : '';
  if (root.dataset.renderToken !== renderToken) return;

  const grid = document.createElement('div');
  grid.className = 'grid4';
  root.appendChild(grid);

  for (let i = 0; i < PANEL_COUNT; i++) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile' + (state.opened[i] ? ' open' : '');
    if (state.opened[i] && allowOpenedClick) tile.classList.add('recloseable');
    tile.dataset.index = i;
    tile.disabled = !clickable || (state.opened[i] && !allowOpenedClick);
    if (clickable && (!state.opened[i] || allowOpenedClick)) tile.addEventListener('click', () => onClick?.(i, tile));

    const cover = document.createElement('div');
    cover.className = 'tile-cover';
    if (coverUrl) cover.style.backgroundImage = `url("${coverUrl}")`;
    cover.style.backgroundPosition = bgPos(i);
    tile.appendChild(cover);

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = state.labels[i] || '';
    tile.appendChild(label);
    grid.appendChild(tile);
  }
}

/* ============================================================
   効果音（v0.2.6）
   ・Web Audio API でwavを事前デコードして保持
   ・ページ表示時に無音を1回鳴らして出力経路を起動（プライミング）
   → 1回目のSEが遅れる／頭が切れる問題を防ぐ
   ============================================================ */

// flip.wav をノーマライズ済みの音源に差し替えた場合は 1.0 のまま。
// 元の小さいwavをそのまま使う場合は 3.0〜5.0 くらいに上げてください。
const FLIP_GAIN = 1.0;

let audioCtx = null;
let flipBuffer = null;
let flipLoading = null;

function flipUrl() {
  return new URL('flip.wav', window.location.href).href;
}

function ensureAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch { return null; }
  }
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function loadFlipBuffer() {
  if (flipBuffer) return Promise.resolve(flipBuffer);
  if (flipLoading) return flipLoading;
  const ctx = ensureAudioContext();
  if (!ctx) return Promise.resolve(null);
  flipLoading = fetch(flipUrl())
    .then(r => r.arrayBuffer())
    .then(buf => new Promise((res, rej) => {
      // Safari系の古い実装も通るようコールバック形式で呼ぶ
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && typeof p.then === 'function') p.then(res, rej);
    }))
    .then(b => { flipBuffer = b; return b; })
    .catch(() => { flipLoading = null; return null; });
  return flipLoading;
}

// ページ表示直後に呼ぶ。デコード＋無音再生でオーディオ経路を温める。
async function primeAudio() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  await loadFlipBuffer();
  try {
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.05)), ctx.sampleRate);
    s.connect(ctx.destination);
    s.start();
  } catch {}
}

function playFlipFallback(vol) {
  try {
    if (!playFlipFallback.pool) {
      playFlipFallback.pool = Array.from({ length: 4 }, () => {
        const a = new Audio(flipUrl());
        a.preload = 'auto';
        return a;
      });
      playFlipFallback.index = 0;
    }
    const pool = playFlipFallback.pool;
    const a = pool[playFlipFallback.index++ % pool.length];
    a.pause();
    a.currentTime = 0;
    a.volume = vol;
    const p = a.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

function playFlipSound(volume = 0.55) {
  const vol = Math.max(0, Math.min(1, Number(volume ?? 0.55)));
  const ctx = ensureAudioContext();
  if (ctx && flipBuffer) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = flipBuffer;
      const g = ctx.createGain();
      g.gain.value = Math.min(1, vol * FLIP_GAIN);
      src.connect(g);
      g.connect(ctx.destination);
      src.start();
      return;
    } catch {}
  }
  // まだデコードが終わっていない初回だけHTMLAudioで鳴らし、裏で読み込みを開始
  loadFlipBuffer();
  playFlipFallback(vol);
}

// 何か操作があったときにコンテキストが止まっていたら復帰させる
['click', 'pointerdown', 'keydown', 'visibilitychange'].forEach(ev => {
  window.addEventListener(ev, () => { if (audioCtx && audioCtx.state !== 'running') audioCtx.resume().catch(() => {}); }, { passive: true });
});

window.PanelReveal = {
  PANEL_COUNT, DEFAULT_STATE, normalizeState, loadState, saveState, subscribeState,
  putImage, getImageUrl, removeImage, renderBoard, playFlipSound, primeAudio, sendMessage
};
