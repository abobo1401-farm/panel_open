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

async function renderBoard(root, state, { clickable = false, onClick = null } = {}) {
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
    tile.dataset.index = i;
    tile.disabled = state.opened[i] || !clickable;
    if (clickable && !state.opened[i]) tile.addEventListener('click', () => onClick?.(i, tile));

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

function playFlipSound(volume = 0.55) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = playFlipSound.ctx || (playFlipSound.ctx = new AudioCtx());
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(Math.max(0, Math.min(1, volume)) * 0.28, now);
    master.connect(ctx.destination);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(780, now);
    osc.frequency.exponentialRampToValueAtTime(250, now + 0.11);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.9, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc.connect(gain).connect(master);
    osc.start(now); osc.stop(now + 0.15);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1050, now + 0.09);
    osc2.frequency.exponentialRampToValueAtTime(1350, now + 0.16);
    gain2.gain.setValueAtTime(0.0001, now);
    gain2.gain.setValueAtTime(0.0001, now + 0.08);
    gain2.gain.exponentialRampToValueAtTime(0.45, now + 0.10);
    gain2.gain.exponentialRampToValueAtTime(0.0001, now + 0.20);
    osc2.connect(gain2).connect(master);
    osc2.start(now + 0.08); osc2.stop(now + 0.21);
  } catch {}
}

window.PanelReveal = {
  PANEL_COUNT, DEFAULT_STATE, normalizeState, loadState, saveState, subscribeState,
  putImage, getImageUrl, removeImage, renderBoard, playFlipSound, sendMessage
};
