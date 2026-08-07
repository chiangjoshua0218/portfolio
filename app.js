const VERSION = '3.5.6';
const IS_GITHUB_PAGES = location.hostname.endsWith('github.io');

// ─── 常數設定 ───────────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  tw_stock:    '台股',
  us_stock:    '美股',
  cash:        '現金',
  bond:        '債券',
  crypto:      '加密貨幣',
  real_estate: '房地產',
  debt:        '負債',
};

const CATEGORY_COLORS = {
  tw_stock:    '#5b8af0',
  us_stock:    '#3eba74',
  cash:        '#e8a830',
  bond:        '#a46ee8',
  crypto:      '#f07840',
  real_estate: '#c47a50',
  debt:        '#e85858',
};

const TARGET_CATS = ['tw_stock', 'us_stock', 'cash', 'bond', 'crypto', 'real_estate'];
const CATEGORY_ORDER = { tw_stock: 0, us_stock: 1, bond: 2, cash: 3, crypto: 4, real_estate: 5, debt: 6 };

const STOCK_TYPE_LABELS = {
  tw_etf:       '台股 ETF',
  tw_stock_ind: '台股個股',
  us_etf:       '美股 ETF',
  us_stock_ind: '美股個股',
};
const STOCK_TYPE_COLORS = {
  tw_etf:       '#5b8af0',
  tw_stock_ind: '#a3c0ff',
  us_etf:       '#3eba74',
  us_stock_ind: '#90dbb0',
};

// 台灣掛牌但底層資產為美股的 ETF（類別應設為「美股」，報價來源設為「台股」）
const TW_OVERSEAS_ETF_MAP = {
  '00757': 'us_stock',  // 統一FANG+
  '00662': 'us_stock',  // 富邦NASDAQ
  '00646': 'us_stock',  // 元大S&P500
  '00670L': 'us_stock', // 富邦NASDAQ正2
  '00671R': 'us_stock', // 富邦NASDAQ反1
  '00637L': 'us_stock', // 元大S&P500正2
  '00638R': 'us_stock', // 元大S&P500反1
  '00830': 'us_stock',  // 國泰費城半導體
  '00858': 'us_stock',  // 永豐美國500大
  '00893': 'us_stock',  // 國泰智能電動車
  '00887': 'us_stock',  // 國泰智慧電動車
};

// ─── 狀態 ────────────────────────────────────────────────────────────────────
let profiles              = []; // { id, name, holdings, targetAllocations, historicalRecords }
let activeProfileId       = 'overview';
let historicalRecords     = []; // overview 用（所有人合計）
let usdRate               = 32;
let fxRates               = {}; // 非 USD 幣別兌台幣匯率，如 { EUR: 35.2, AUD: 21.0, JPY: 0.22, GBP: 41.5 }
let rateSnapshot          = {}; // { date, usdRate, fxRates } — 每日第一次抓到新匯率前的快照，用於計算現金匯差
let chart                 = null;
let stockTypeChart        = null;
let historicalChart       = null;
let profileCharts             = {}; // { [pid]: Chart instance }
let profileStockTypeCharts    = {}; // { [pid]: Chart instance }
let profileHistoricalCharts   = {}; // { [pid]: Chart instance }
let holdingsSortBy        = {}; // { [profileId]: 'none'|'value' }
let holdingsEditMode      = {}; // { [profileId]: boolean }
let isRefreshing          = false;
const twMarketCache       = {}; // { [symbol]: 'tse'|'otc' } 快取已知市場
const hblockExpandedCats  = new Set(); // 手機版已展開的類別，格式 'pid_cat'
let fileHandle            = null;
let filePath              = null; // 顯示用完整路徑（儘可能取得）
const FILE_API_SUPPORTED = 'showOpenFilePicker' in window;
let gistToken      = localStorage.getItem('gist_token') || '';
let gistId         = localStorage.getItem('gist_id')    || '';
let gistSaveTimer  = null;
const GIST_FILE    = 'portfolio.json';
// 記錄哪些 profile 在這次 saveData 前被使用者修改過（用於 Gist merge）
const _dirtyPids   = new Set();
function markProfileDirty(pid) { _dirtyPids.add(pid); }

// ─── Profile helpers ──────────────────────────────────────────────────────────
function getProfile(id) {
  return profiles.find(p => p.id === id);
}
function getActiveProfile() {
  return getProfile(activeProfileId);
}

// ─── IndexedDB（儲存 file handle）────────────────────────────────────────────
async function dbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('portfolio-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('config');
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const req = db.transaction('config', 'readonly').objectStore('config').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('config', 'readwrite');
    tx.objectStore('config').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ─── File System Access ───────────────────────────────────────────────────────
async function captureFilePath(handle) {
  try {
    // 非標準屬性，部分 Chromium 環境支援
    const file = await handle.getFile();
    if (file.path) { filePath = file.path; await dbSet('filePath', filePath); return; }
  } catch {}
  // 嘗試讓使用者選取同一資料夾來組出路徑
  try {
    const dir = await window.showDirectoryPicker({ startIn: handle, mode: 'read' });
    const rel = await dir.resolve(handle);
    if (rel) filePath = dir.name + '/' + rel.join('/');
    else     filePath = dir.name + '/' + handle.name;
    await dbSet('filePath', filePath);
  } catch {
    // 使用者取消或不支援，就只顯示檔名
    filePath = null;
    await dbSet('filePath', null);
  }
}

async function readConfigFile(handle) {
  const file = await handle.getFile();
  const text = await file.text();
  return JSON.parse(text);
}

async function writeConfigFile(handle, data) {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(data, null, 2));
  await writable.close();
}

async function initFileSystem() {
  if (!FILE_API_SUPPORTED) return 'not-supported';
  try {
    const stored = await dbGet('fileHandle');
    if (!stored) return 'no-file';
    const perm = await stored.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') { fileHandle = stored; return 'ready'; }
    if (perm === 'prompt')  { fileHandle = stored; return 'needs-permission'; }
    return 'no-file';
  } catch {
    return 'no-file';
  }
}

// ─── 初始化 ──────────────────────────────────────────────────────────────────
async function init() {
  const fsStatus = await initFileSystem();

  if (gistConfigured()) {
    const loaded = await loadFromGist();
    if (!loaded) loadFromLocalStorage();
  } else if (fsStatus === 'ready') {
    try {
      applyConfig(await readConfigFile(fileHandle));
    } catch (e) {
      loadFromLocalStorage();
      console.warn('讀取設定檔失敗，使用 localStorage:', e);
    }
  } else if (fsStatus === 'needs-permission') {
    loadFromLocalStorage();
    showPermissionBanner();
  } else if (fsStatus === 'no-file') {
    loadFromLocalStorage();
    showSetupModal();
  } else {
    loadFromLocalStorage();
  }

  renderAll();
  refreshAllPrices();

  // 有 Gist 時用 Gist 存的匯率；否則自動抓一次
  if (!gistConfigured()) fetchExchangeRate();

  // 離開頁面前確保 Gist 已儲存（keepalive 讓 fetch 在頁面卸載後仍能完成）
  window.addEventListener('beforeunload', () => {
    if (!gistToken || !gistId || gistSaveTimer === null) return;
    clearTimeout(gistSaveTimer);
    gistSaveTimer = null;
    const config = { version: 2, usdRate, fxRates, rateSnapshot, historicalRecords, profiles };
    fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH', keepalive: true,
      headers: { Authorization: `Bearer ${gistToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(config, null, 2) } } }),
    });
  });

  // 盤中每 90 秒自動更新股價
  setInterval(() => {
    if (isTWMisAvailable()) refreshAllPrices();
  }, 90 * 1000);

  // Gist 多人共用：切回頁面或每 3 分鐘自動拉取最新資料
  if (gistConfigured()) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pullFromGist();
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') pullFromGist();
    }, 3 * 60 * 1000);
  }

  // 手機：點擊類別 header 展開/收合，點擊個股展開細節
  document.addEventListener('click', e => {
    const hdr = e.target.closest('.hblock-header');
    if (hdr) {
      const block = hdr.closest('.hblock');
      if (!block) return;
      const list = block.closest('[id^="holdings-list-"]');
      const pid  = list?.id.replace('holdings-list-', '') || '';
      const cat  = block.dataset.cat || '';
      block.classList.toggle('expanded');
      const key = `${pid}_${cat}`;
      if (block.classList.contains('expanded')) hblockExpandedCats.add(key);
      else hblockExpandedCats.delete(key);
      return;
    }
    const item = e.target.closest('.hblock-item[data-expandable]:not(.hblock-item-edit)');
    if (item) item.classList.toggle('expanded');
  });
}

function applyConfig(config) {
  if (config.version === 2) {
    profiles          = config.profiles || [];
    historicalRecords = config.historicalRecords || [];
    usdRate           = config.usdRate || 32;
    fxRates           = config.fxRates || {};
    rateSnapshot      = config.rateSnapshot || {};
  } else {
    // v1 migration: wrap existing data into single profile
    const migratedHistory = (config.historicalRecords || []).map(r => {
      if (r.date) return r;
      if (typeof r.year === 'number') return { date: `${r.year}-12-31`, value: r.value };
      return r;
    }).sort((a, b) => a.date.localeCompare(b.date));
    profiles = [{
      id:               'p1',
      name:             '我的資產',
      holdings:         config.holdings || [],
      targetAllocations: config.targetAllocations || { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 },
      historicalRecords: migratedHistory,
    }];
    historicalRecords = migratedHistory;
    usdRate      = config.usdRate || 32;
    fxRates      = config.fxRates || {};
    rateSnapshot = config.rateSnapshot || {};
  }
  profiles.forEach(p => {
    holdingsSortBy[p.id] = holdingsSortBy[p.id] || 'none';
    if (!p.targetAllocations)   p.targetAllocations = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
    if (!p.historicalRecords)   p.historicalRecords = [];
  });
  migrateIsEtf();
}

// ─── Migration：自動標記已知 ETF ──────────────────────────────────────────────
// 只對尚未設定 isEtf 的持股執行（新加持股不受影響）
const US_ETF_SYMBOLS = new Set([
  'VT','VTI','VOO','VEA','VWO','VIG','VYM','VNQ','BND','BNDW',
  'SPY','IVV','IWM','QQQ','DIA','GLD','SLV','TLT','AGG',
  'IBIT','FBTC','ARKK','SCHD','JEPI','JEPQ','QYLD',
  '00757',
]);

function isTWEtfSymbol(symbol) {
  // 台灣 ETF：全數字、長度 4~6 碼、以 '0' 開頭（如 0050, 0056, 00878, 006208）
  return /^0\d{3,5}$/.test(symbol);
}

function migrateIsEtf() {
  let changed = false;
  profiles.forEach(p => {
    p.holdings.forEach(h => {
      if (h.isEtf !== undefined) return; // 已設定過，跳過
      const sym = (h.symbol || '').toUpperCase();
      if (h.category === 'tw_stock' && isTWEtfSymbol(sym)) {
        h.isEtf = true; changed = true;
      } else if (h.category === 'us_stock' && US_ETF_SYMBOLS.has(sym)) {
        h.isEtf = true; changed = true;
      } else if (h.category === 'tw_stock' || h.category === 'us_stock') {
        h.isEtf = false; changed = true;
      }
    });
  });
  if (changed) saveData();
}

function renderAll() {
  renderTabs();
  renderOverview();
  renderProfilePanels();
  updateRateDisplay();
  updateStorageInfo();
}

function updateRateDisplay() {
  const el = document.getElementById('usd-rate-tag');
  if (el) el.textContent = `1 USD = ${usdRate} TWD`;
}

function storageInfoHTML() {
  if (gistToken) {
    const idStr = gistId ? `<span style="color:#64748b;font-size:0.75rem"> · ${gistId.slice(0,8)}…</span>` : '';
    return `<div class="storage-info">☁️ 資料來源：GitHub Gist${idStr} <button class="btn-link" onclick="openGistModal()">設定</button></div>`;
  }
  if (fileHandle) {
    return `<div class="storage-info">💾 資料來源：本機檔案 <strong>${escHtml(fileHandle.name)}</strong> <button class="btn-link" onclick="openGistModal()">改用 Gist 同步</button></div>`;
  }
  return `<div class="storage-info">💾 資料來源：瀏覽器 localStorage <button class="btn-link" onclick="openGistModal()">設定 Gist 同步</button></div>`;
}

function updateStorageInfo() {
  // overview panel 是靜態 HTML，需手動更新；profile panels 每次重建所以不需要
  const overviewEl = document.querySelector('#panel-overview .storage-info');
  if (overviewEl) overviewEl.outerHTML = storageInfoHTML();
}

// ─── 使用者操作：首次設定檔 ───────────────────────────────────────────────────
async function onCreateNewFile() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'portfolio.json',
      types: [{ description: 'JSON 設定檔', accept: { 'application/json': ['.json'] } }],
    });
    fileHandle = handle;
    await dbSet('fileHandle', handle);
    const config = { version: 2, usdRate, fxRates, rateSnapshot, historicalRecords, profiles };
    await writeConfigFile(handle, config);
    hideSetupModal();
  } catch (e) {
    if (e.name !== 'AbortError') alert('建立設定檔失敗：' + e.message);
  }
}

async function onOpenExistingFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'JSON 設定檔', accept: { 'application/json': ['.json'] } }],
    });
    fileHandle = handle;
    await dbSet('fileHandle', handle);
    try {
      applyConfig(await readConfigFile(handle));
    } catch {
      // 空檔案或格式錯誤，沿用現有資料
    }
    hideSetupModal();
    renderAll();
    refreshAllPrices();
  } catch (e) {
    if (e.name !== 'AbortError') alert('開啟設定檔失敗：' + e.message);
  }
}

async function onRequestPermission() {
  try {
    const stored = await dbGet('fileHandle');
    if (!stored) { hidePermissionBanner(); showSetupModal(); return; }
    const perm = await stored.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      fileHandle = stored;
      try {
        applyConfig(await readConfigFile(fileHandle));
      } catch {}
      hidePermissionBanner();
      renderAll();
      refreshAllPrices();
    }
  } catch (e) {
    console.error(e);
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showSetupModal()      { document.getElementById('setup-modal').style.display      = 'flex'; }
function hideSetupModal()      { document.getElementById('setup-modal').style.display      = 'none'; }
function showPermissionBanner(){ document.getElementById('permission-banner').style.display = 'flex'; }
function hidePermissionBanner(){ document.getElementById('permission-banner').style.display = 'none'; }

// ─── localStorage ─────────────────────────────────────────────────────────────
function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem('portfolio_v2');
    if (raw) {
      applyConfig(JSON.parse(raw));
      return;
    }
    // 嘗試讀取 v1 格式
    const v1Holdings = localStorage.getItem('portfolio_holdings');
    if (v1Holdings) {
      const config = { holdings: JSON.parse(v1Holdings) };
      const rate    = localStorage.getItem('portfolio_usd_rate');
      if (rate) config.usdRate = parseFloat(rate);
      const targets = localStorage.getItem('portfolio_targets');
      if (targets) config.targetAllocations = JSON.parse(targets);
      const history = localStorage.getItem('portfolio_historical_records');
      if (history) config.historicalRecords = JSON.parse(history);
      applyConfig(config);
    }
  } catch {}
}

function saveData() {
  // 更新這次被使用者修改的 profile 時間戳，讓 Gist merge 時能判斷誰更新
  const now = Date.now();
  for (const pid of _dirtyPids) {
    const p = profiles.find(pr => pr.id === pid);
    if (p) p.lastModified = now;
  }
  _dirtyPids.clear();
  const config = { version: 2, usdRate, fxRates, rateSnapshot, historicalRecords, profiles };
  localStorage.setItem('portfolio_v2', JSON.stringify(config));
  if (fileHandle) {
    writeConfigFile(fileHandle, config).catch(e => console.warn('寫入設定檔失敗:', e));
  }
  if (gistToken) {
    clearTimeout(gistSaveTimer);
    gistSaveTimer = setTimeout(() => saveToGist(config), 0);
  }
}


// ─── GitHub Gist 同步 ─────────────────────────────────────────────────────────
function gistConfigured() { return !!gistToken; }

async function loadFromGist() {
  if (!gistToken) return false;
  const headers = { Authorization: `Bearer ${gistToken}`, Accept: 'application/vnd.github+json' };
  try {
    let id = gistId;
    if (!id) {
      // 嘗試搜尋已有的 portfolio gist
      const res = await fetch('https://api.github.com/gists', { headers });
      if (!res.ok) return false;
      const list = await res.json();
      const found = list.find(g => g.files?.[GIST_FILE]);
      if (found) { id = found.id; gistId = id; localStorage.setItem('gist_id', id); }
    }
    if (!id) return false;
    const remote = await fetchGistConfig(id);
    if (remote) { applyConfig(remote); return true; }
    return false;
  } catch (e) { console.warn('Gist 讀取失敗:', e); return false; }
}

// 單純拉取 Gist 原始 JSON，不 applyConfig
async function fetchGistConfig(id) {
  const targetId = id || gistId;
  if (!gistToken || !targetId) return null;
  const headers = { Authorization: `Bearer ${gistToken}`, Accept: 'application/vnd.github+json' };
  try {
    const res = await fetch(`https://api.github.com/gists/${targetId}?_=${Date.now()}`, { headers, cache: 'no-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.files?.[GIST_FILE]?.content;
    return content ? JSON.parse(content) : null;
  } catch { return null; }
}

async function saveToGist(config) {
  if (!gistToken) return;
  const headers = {
    Authorization: `Bearer ${gistToken}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  // 寫入前先拉 remote，做 per-profile merge（以 lastModified 判斷誰更新）
  // 避免 A 裝置存舊版 YU CHUN 資料，覆蓋掉 B 裝置剛更新的版本
  if (gistId) {
    const remote = await fetchGistConfig();
    if (remote?.profiles) {
      const remoteById = Object.fromEntries(remote.profiles.map(p => [p.id, p]));
      const localIds   = new Set(config.profiles.map(p => p.id));
      const merged     = config.profiles.map(local => {
        const rem = remoteById[local.id];
        if (!rem) return local; // 本地新增的 profile，直接保留
        // 以 lastModified 較大者為準
        return (rem.lastModified || 0) > (local.lastModified || 0) ? rem : local;
      });
      // 保留 remote 中本地沒有的 profile（其他人新增的）
      for (const rp of remote.profiles) {
        if (!localIds.has(rp.id)) merged.push(rp);
      }
      config = { ...config, profiles: merged };
    }
  }

  const body = { files: { [GIST_FILE]: { content: JSON.stringify(config, null, 2) } } };
  try {
    if (gistId) {
      await fetch(`https://api.github.com/gists/${gistId}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    } else {
      const res = await fetch('https://api.github.com/gists', {
        method: 'POST', headers,
        body: JSON.stringify({ ...body, description: '資產總覽設定檔', public: false }),
      });
      if (res.ok) { const d = await res.json(); gistId = d.id; localStorage.setItem('gist_id', gistId); updateStorageInfo(); }
    }
  } catch (e) { console.warn('Gist 寫入失敗:', e); }
}

function openGistModal() {
  document.getElementById('gist-token-input').value = gistToken;
  document.getElementById('gist-id-display').textContent = gistId || '（首次儲存後自動產生）';
  document.getElementById('gist-modal').style.display = 'flex';
}

function closeGistModal() { document.getElementById('gist-modal').style.display = 'none'; }

async function saveGistSettings() {
  const token = document.getElementById('gist-token-input').value.trim();
  gistToken = token;
  gistId = '';                         // 清掉舊 ID，讓 loadFromGist 重新搜尋
  localStorage.setItem('gist_token', token);
  localStorage.removeItem('gist_id');
  closeGistModal();
  updateStorageInfo();
  if (!token) return;
  const loaded = await loadFromGist();
  if (loaded) {
    renderAll(); refreshAllPrices();
  } else {
    // Gist 沒有舊資料，把現有資料推上去
    await saveToGist({ version: 2, usdRate, fxRates, rateSnapshot, historicalRecords, profiles });
  }
  updateStorageInfo();
}

function clearGistSettings() {
  gistToken = ''; gistId = '';
  localStorage.removeItem('gist_token');
  localStorage.removeItem('gist_id');
  closeGistModal();
  updateStorageInfo();
}

async function pullFromGist(manual = false) {
  if (!manual) {
    // 自動拉取：有 modal 開著或處於編輯模式時跳過，避免打斷操作
    const modalIds = ['edit-modal', 'add-holding-modal', 'hist-modal'];
    if (modalIds.some(id => document.getElementById(id)?.style.display === 'flex')) return;
    if (Object.values(holdingsEditMode).some(Boolean)) return;
    if (Object.values(targetEditMode).some(Boolean)) return;
  }
  const loaded = await loadFromGist();
  if (loaded) {
    renderAll();
    document.getElementById('last-updated').textContent = `Gist 同步：${new Date().toLocaleString('zh-TW')}`;
  } else if (manual) {
    alert('拉取失敗，請確認 Token 與 Gist ID 設定正確');
  }
  if (manual) closeGistModal();
}

// ─── 匯出 / 匯入設定檔 ────────────────────────────────────────────────────────
function exportConfig() {
  const config = { version: 2, usdRate, fxRates, rateSnapshot, historicalRecords, profiles };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'portfolio.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// 匯入設定：支援 File System Access API 時，直接設為新的儲存位置
async function onImportConfig() {
  if (FILE_API_SUPPORTED) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON 設定檔', accept: { 'application/json': ['.json'] } }],
      });
      fileHandle = handle;
      await dbSet('fileHandle', handle);
      try {
        applyConfig(await readConfigFile(handle));
      } catch {
        alert('設定檔格式錯誤，請確認是正確的 JSON 檔案');
        return;
      }
      saveData();
      renderAll();
      refreshAllPrices();
    } catch (e) {
      if (e.name !== 'AbortError') alert('開啟設定檔失敗：' + e.message);
    }
  } else {
    document.getElementById('import-file').click();
  }
}

// 不支援 File System Access API 時的備援（input[type=file]）
function importConfig(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const config = JSON.parse(e.target.result);
      applyConfig(config);
      saveData();
      renderAll();
      refreshAllPrices();
    } catch {
      alert('設定檔格式錯誤，請確認是正確的 JSON 檔案');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ─── Tab 函式 ────────────────────────────────────────────────────────────────
function renderTabs() {
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = `
    <div class="tabs-scroll">
      <div class="tab ${activeProfileId === 'overview' ? 'active' : ''}" onclick="switchTab('overview')">總覽</div>
      ${profiles.map(p => `
        <div class="tab ${activeProfileId === p.id ? 'active' : ''}" onclick="switchTab('${p.id}')">
          <span class="tab-name" ondblclick="renameProfile('${p.id}')">${escHtml(p.name)}</span>
          <button class="tab-close" onclick="event.stopPropagation();deleteProfile('${p.id}')" title="刪除">×</button>
        </div>`).join('')}
      <button class="tab-add" onclick="addProfile()" title="新增">＋</button>
    </div>`;
}

function switchTab(id) {
  activeProfileId = id;
  window.scrollTo({ top: 0, behavior: 'instant' });
  renderTabs();
  const overviewPanel = document.getElementById('panel-overview');
  if (id === 'overview') {
    overviewPanel.style.display = '';
    document.querySelectorAll('.panel-profile').forEach(el => el.style.display = 'none');
  } else {
    overviewPanel.style.display = 'none';
    document.querySelectorAll('.panel-profile').forEach(el => el.style.display = 'none');
    const panel = document.getElementById(`panel-${id}`);
    if (panel) {
      panel.style.display = '';
      renderProfilePanel(id);
    }
  }
}

function addProfile() {
  const name = prompt('請輸入名稱：');
  if (!name?.trim()) return;
  const id = 'p' + Date.now();
  profiles.push({
    id,
    name: name.trim(),
    holdings: [],
    targetAllocations: { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 },
    historicalRecords: [],
    lastModified: Date.now(),
  });
  holdingsSortBy[id] = 'none';
  saveData();
  renderProfilePanels();
  switchTab(id);
}

function deleteProfile(id) {
  const p = getProfile(id);
  if (!p) return;
  if (!confirm(`確定要刪除「${p.name}」的所有資料？`)) return;
  profiles = profiles.filter(pr => pr.id !== id);
  delete holdingsSortBy[id];
  if (profileCharts[id]) { profileCharts[id].destroy(); delete profileCharts[id]; }
  if (profileStockTypeCharts[id]) { profileStockTypeCharts[id].destroy(); delete profileStockTypeCharts[id]; }
  if (profileHistoricalCharts[id]) { profileHistoricalCharts[id].destroy(); delete profileHistoricalCharts[id]; }
  const panel = document.getElementById(`panel-${id}`);
  if (panel) panel.remove();
  saveData();
  renderTabs();
  switchTab('overview');
}

function renameProfile(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const newName = prompt('新名稱：', p.name);
  if (!newName?.trim() || newName.trim() === p.name) return;
  p.name = newName.trim();
  markProfileDirty(pid);
  saveData();
  renderTabs();
}

// ─── Profile Panel HTML 生成 ──────────────────────────────────────────────────
function buildProfilePanelHTML(p) {
  const pid = p.id;
  return `
  <!-- Summary cards（與總覽相同版型）-->
  <div class="summary-cards overview-summary">
    <div class="card summary-card">
      <div class="card-label">${escHtml(p.name)}</div>
      <div class="card-value" id="subtotal-${pid}" style="color:#38bdf8">—</div>
      <div id="subtotal-change-${pid}" class="summary-change"></div>
    </div>
    ${TARGET_CATS.map(c => `
    <div class="card summary-card">
      <div class="card-label">${CATEGORY_LABELS[c]}</div>
      <div class="card-value" id="pcat-${c}-${pid}">—</div>
      ${c !== 'cash' ? `<div id="pcat-change-${c}-${pid}" class="summary-change"></div>` : ''}
    </div>`).join('')}
    <div class="card summary-card">
      <div class="card-label" style="color:#f87171">負債</div>
      <div class="card-value" id="pcat-debt-${pid}" style="color:#f87171">—</div>
    </div>
  </div>

  <!-- 圓餅圖 + 歷史紀錄（並排，與總覽相同）-->
  <div class="main-content">
    <div class="card chart-card">
      <h2>資產配置</h2>
      <div class="chart-tabs">
        <button id="pchart-tab-category-${pid}" class="chart-tab active" onclick="switchProfileChartTab('${pid}','category')">類別</button>
        <button id="pchart-tab-stocktype-${pid}" class="chart-tab" onclick="switchProfileChartTab('${pid}','stocktype')">股票類型</button>
      </div>
      <div id="pchart-view-category-${pid}">
        <div class="chart-wrapper">
          <canvas id="profileChart-${pid}"></canvas>
        </div>
        <div id="profile-chart-legend-${pid}" class="chart-legend"></div>
      </div>
      <div id="pchart-view-stocktype-${pid}" style="display:none">
        <div class="chart-wrapper">
          <canvas id="profileStockTypeChart-${pid}"></canvas>
        </div>
        <div id="profile-stocktype-legend-${pid}" class="chart-legend"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>歷史資產紀錄</h2>
        <button class="btn btn-primary" style="padding:0.25rem 0.75rem;font-size:0.8rem" onclick="openHistModal('${pid}')">＋ 新增紀錄</button>
        <button class="btn-collapse" onclick="toggleCard('body-phist-${pid}')">−</button>
      </div>
      <div class="card-body" id="body-phist-${pid}">
        <h3 style="margin-top:0">資產趨勢圖</h3>
        <div class="historical-chart-wrapper">
          <canvas id="profileHistChart-${pid}"></canvas>
        </div>
        <details class="records-details" style="margin-top:1.5rem">
          <summary>紀錄明細</summary>
          <div id="phist-list-${pid}" class="records-list"></div>
        </details>
      </div>
    </div>
  </div>

  <!-- 目標配置 -->
  <div class="card">
    <div class="card-header">
      <h2>目標配置</h2>
      <button id="target-edit-btn-${pid}" class="btn btn-secondary" style="padding:0.25rem 0.75rem;font-size:0.8rem" onclick="toggleTargetEdit('${pid}')">編輯</button>
      <button id="target-save-btn-${pid}" class="btn btn-primary" style="padding:0.25rem 0.75rem;font-size:0.8rem;display:none" onclick="saveTargetEdit('${pid}')">儲存</button>
      <button id="target-cancel-btn-${pid}" class="btn btn-secondary" style="padding:0.25rem 0.75rem;font-size:0.8rem;display:none" onclick="cancelTargetEdit('${pid}')">取消</button>
      <button class="btn-collapse" onclick="toggleCard('body-target-${pid}')">−</button>
    </div>
    <div class="card-body" id="body-target-${pid}">
      <div id="target-cards-${pid}"></div>
    </div>
  </div>

  <!-- 持股清單 -->
  <div class="card">
    <div class="card-header">
      <h2>持股清單</h2>
      <div class="sort-controls">
        <button id="sort-value-btn-${pid}" class="btn-sort" onclick="setSort('${pid}')">金額 ↕</button>
      </div>
      <button id="edit-mode-btn-${pid}" class="btn btn-secondary" style="padding:0.25rem 0.75rem;font-size:0.8rem" onclick="toggleHoldingsEdit('${pid}')">編輯</button>
      <button id="save-mode-btn-${pid}" class="btn btn-primary" style="padding:0.25rem 0.75rem;font-size:0.8rem;display:none" onclick="saveHoldingsEdit('${pid}')">儲存</button>
      <button id="cancel-mode-btn-${pid}" class="btn btn-secondary" style="padding:0.25rem 0.75rem;font-size:0.8rem;display:none" onclick="cancelHoldingsEdit('${pid}')">取消</button>
      <button class="btn btn-primary" style="padding:0.25rem 0.75rem;font-size:0.8rem" onclick="openAddModal('${pid}')">＋ 新增</button>
      <button class="btn-collapse" onclick="toggleCard('body-holdings-${pid}')">−</button>
    </div>
    <div class="card-body" id="body-holdings-${pid}">
      <div id="holdings-list-${pid}">
        <div class="empty-state">尚無持股，請新增資產</div>
      </div>
    </div>
  </div>
  ${storageInfoHTML()}`;
}

function renderProfilePanels() {
  const container = document.getElementById('profile-panels');
  // 清除舊的 panels
  container.innerHTML = '';

  profiles.forEach(p => {
    const div = document.createElement('div');
    div.id        = `panel-${p.id}`;
    div.className = 'panel-profile';
    div.style.display = 'none';
    div.innerHTML = buildProfilePanelHTML(p);
    container.appendChild(div);
    // 填入目標配置數值
    renderTargetCards(p.id);
  });

  // 顯示目前 active 的 panel
  if (activeProfileId !== 'overview') {
    const panel = document.getElementById(`panel-${activeProfileId}`);
    if (panel) {
      panel.style.display = '';
      renderProfilePanel(activeProfileId);
    } else {
      // profile 不存在，回到 overview
      activeProfileId = 'overview';
      document.getElementById('panel-overview').style.display = '';
    }
  }
}

function renderAllProfilePanels() {
  profiles.forEach(p => renderProfilePanel(p.id));
}

function renderProfilePanel(pid) {
  const p = getProfile(pid);
  if (!p) return;

  // 各類別加總
  const catTotals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0, debt: 0 };
  p.holdings.forEach(h => { catTotals[h.category] = (catTotals[h.category] || 0) + getHoldingValueTWD(h); });
  const subtotal = Object.values(catTotals).reduce((a, b) => a + b, 0); // debt 為負值，自動計算淨資產

  // 小計 card
  const subtotalEl = document.getElementById(`subtotal-${pid}`);
  if (subtotalEl) subtotalEl.textContent = formatTWD(subtotal);

  // 各類別 card
  TARGET_CATS.forEach(c => {
    const el = document.getElementById(`pcat-${c}-${pid}`);
    if (el) el.textContent = formatTWD(catTotals[c]);
  });
  const debtEl = document.getElementById(`pcat-debt-${pid}`);
  if (debtEl) debtEl.textContent = catTotals.debt < 0 ? formatTWD(catTotals.debt) : '—';

  // 今日各分類變化
  const catChanges   = { tw_stock: 0, us_stock: 0, bond: 0, crypto: 0 };
  const catHasChange = { tw_stock: false, us_stock: false, bond: false, crypto: false };
  let dayChange = 0, hasChange = false;
  p.holdings.forEach(h => {
    if (h.currentPrice && h.previousClose && h.category !== 'cash') {
      const delta = toTWD((h.currentPrice - h.previousClose) * h.qty, h.currency);
      dayChange += delta;
      hasChange = true;
      if (catChanges[h.category] !== undefined) {
        catChanges[h.category] += delta;
        catHasChange[h.category] = true;
      }
    }
  });

  const applyChange = (elId, change, base) => {
    const el = document.getElementById(elId);
    if (!el) return;
    const sign  = change >= 0 ? '+' : '';
    const pct   = base > 0 ? (change / (base - change) * 100).toFixed(2) : '0.00';
    el.style.color = change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#94a3b8';
    el.textContent = `${sign}${pct}% (${sign}${formatTWD(change)})`;
  };

  const changeEl = document.getElementById(`subtotal-change-${pid}`);
  if (changeEl) {
    if (hasChange) applyChange(`subtotal-change-${pid}`, dayChange, subtotal);
    else changeEl.textContent = '';
  }
  ['tw_stock', 'us_stock', 'bond', 'crypto'].forEach(c => {
    if (catHasChange[c]) applyChange(`pcat-change-${c}-${pid}`, catChanges[c], catTotals[c]);
  });

  // 目標配置
  renderTargetCards(pid);
  renderHoldings(pid);
  renderProfileChart(pid);
  renderProfileStockTypeChart(pid);
  renderProfileHistoricalChart(pid);
  renderProfileHistoricalRecordsList(pid);
}

// ─── Overview 渲染 ────────────────────────────────────────────────────────────
function renderOverview() {
  const allHoldings = profiles.flatMap(p => p.holdings);

  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0, real_estate: 0, debt: 0 };
  allHoldings.forEach(h => {
    totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h);
  });
  const total = Object.values(totals).reduce((a, b) => a + b, 0); // debt 已是負值，自動計算淨資產

  document.getElementById('total-value').textContent        = formatTWD(total);
  document.getElementById('tw-value').textContent           = formatTWD(totals.tw_stock);
  document.getElementById('us-value').textContent           = formatTWD(totals.us_stock);
  document.getElementById('cash-value').textContent         = formatTWD(totals.cash);
  document.getElementById('bond-value').textContent         = formatTWD(totals.bond);
  document.getElementById('crypto-value').textContent       = formatTWD(totals.crypto);
  document.getElementById('realestate-value').textContent   = formatTWD(totals.real_estate);
  const debtEl = document.getElementById('debt-value');
  if (debtEl) debtEl.textContent = totals.debt < 0 ? formatTWD(totals.debt) : '—';

  // 今日各分類變化
  const catChanges   = { tw_stock: 0, us_stock: 0, bond: 0, crypto: 0, cash: 0 };
  const catHasChange = { tw_stock: false, us_stock: false, bond: false, crypto: false, cash: false };
  let totalDayChange = 0, hasAnyChange = false;
  allHoldings.forEach(h => {
    if (h.currentPrice && h.previousClose && h.category !== 'cash') {
      const delta = toTWD((h.currentPrice - h.previousClose) * h.qty, h.currency);
      totalDayChange += delta;
      hasAnyChange = true;
      if (catChanges[h.category] !== undefined) {
        catChanges[h.category] += delta;
        catHasChange[h.category] = true;
      }
    }
  });

  // 外幣現金：利用匯率快照計算今日匯差
  if (rateSnapshot.date === new Date().toISOString().slice(0, 10)) {
    allHoldings.forEach(h => {
      if (h.category !== 'cash' || !h.currency || h.currency === 'TWD') return;
      const prevRate = h.currency === 'USD' ? rateSnapshot.usdRate : (rateSnapshot.fxRates?.[h.currency] ?? 0);
      const curRate  = h.currency === 'USD' ? usdRate : (fxRates[h.currency] ?? 0);
      if (!prevRate || !curRate) return;
      const delta = h.qty * (curRate - prevRate);
      catChanges.cash   += delta;
      catHasChange.cash  = true;
      totalDayChange    += delta;
      hasAnyChange       = true;
    });
  }

  const applyChange = (elId, change, base) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!change && change !== 0) { el.textContent = ''; return; }
    const sign  = change >= 0 ? '+' : '';
    const pct   = base > 0 ? (change / (base - change) * 100).toFixed(2) : '0.00';
    el.style.color = change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#94a3b8';
    el.textContent = `${sign}${pct}% (${sign}${formatTWD(change)})`;
  };

  if (hasAnyChange) applyChange('total-change', totalDayChange, total);
  else { const el = document.getElementById('total-change'); if (el) el.textContent = ''; }

  if (catHasChange.tw_stock) applyChange('tw-change',     catChanges.tw_stock, totals.tw_stock);
  if (catHasChange.us_stock) applyChange('us-change',     catChanges.us_stock, totals.us_stock);
  if (catHasChange.bond)     applyChange('bond-change',   catChanges.bond,     totals.bond);
  if (catHasChange.crypto)   applyChange('crypto-change', catChanges.crypto,   totals.crypto);
  if (catHasChange.cash)     applyChange('cash-change',   catChanges.cash,     totals.cash);

  renderProfileBreakdown();
  renderChart();
  renderStockTypeChart();
  renderHistoricalRecordsList();
  renderHistoricalChart();
}

function renderProfileBreakdown() {
  const el = document.getElementById('profile-breakdown-content');
  if (!el) return;

  el.innerHTML = profiles.map(p => {
    const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
    const catChanges = { tw_stock: 0, us_stock: 0, bond: 0, crypto: 0 };
    const catHasChange = { tw_stock: false, us_stock: false, bond: false, crypto: false };
    totals.debt = 0;
    let total = 0, totalDayChange = 0, hasAnyChange = false;

    p.holdings.forEach(h => {
      const val = getHoldingValueTWD(h);
      totals[h.category] = (totals[h.category] || 0) + val;
      total += val;
      if (h.currentPrice && h.previousClose && h.category !== 'cash') {
        const delta = toTWD((h.currentPrice - h.previousClose) * h.qty, h.currency);
        totalDayChange += delta;
        hasAnyChange = true;
        if (catChanges[h.category] !== undefined) {
          catChanges[h.category] += delta;
          catHasChange[h.category] = true;
        }
      }
    });

    const changeSpan = (change, base) => {
      const sign = change >= 0 ? '+' : '';
      const pct = base > 0 ? (change / (base - change) * 100).toFixed(2) : '0.00';
      const color = change > 0 ? '#22c55e' : change < 0 ? '#ef4444' : '#94a3b8';
      return `<span style="color:${color}">${sign}${pct}% (${sign}${formatTWD(change)})</span>`;
    };

    const totalChangeHtml = hasAnyChange ? changeSpan(totalDayChange, total) : '';

    const catCard = (label, cat) => {
      if (!totals[cat]) return '';
      const chgHtml = catHasChange[cat] ? `<div class="pbd-cat-change">${changeSpan(catChanges[cat], totals[cat])}</div>` : '';
      return `<div class="pbd-cat">
        <div class="pbd-cat-label">${label}</div>
        <div class="pbd-cat-value">${formatTWD(totals[cat])}</div>
        ${chgHtml}
      </div>`;
    };

    return `<div class="pbd-row">
      <div class="pbd-profile-name">${escHtml(p.name)}</div>
      <div class="pbd-total">
        <div class="pbd-total-value">${formatTWD(total)}</div>
        ${totalChangeHtml ? `<div class="pbd-total-change">${totalChangeHtml}</div>` : ''}
      </div>
      <div class="pbd-cats">
        ${catCard('台股', 'tw_stock')}
        ${catCard('美股', 'us_stock')}
        ${catCard('現金', 'cash')}
        ${catCard('債券', 'bond')}
        ${catCard('加密', 'crypto')}
        ${totals.debt < 0 ? `<div class="pbd-cat"><div class="pbd-cat-label" style="color:#f87171">負債</div><div class="pbd-cat-value" style="color:#f87171">${formatTWD(totals.debt)}</div></div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── 新增持股 ────────────────────────────────────────────────────────────────
function addHolding(e, profileId, formSuffix) {
  e.preventDefault();
  const p = getProfile(profileId);
  if (!p) return;

  const fs          = formSuffix || profileId;
  const category    = document.getElementById(`holding-category-${fs}`).value;
  const symbol      = document.getElementById(`holding-symbol-${fs}`).value.trim().toUpperCase();
  const qty         = parseFloat(document.getElementById(`holding-qty-${fs}`).value);
  const name        = document.getElementById(`holding-name-${fs}`).value.trim();
  const currencyEl  = document.getElementById(`holding-currency-${fs}`);
  const currency    = currencyEl ? currencyEl.value : 'TWD';
  const manualPriceEl = document.getElementById(`holding-manual-price-${fs}`);
  const manualPrice = manualPriceEl ? (parseFloat(manualPriceEl.value) || null) : null;
  const fetchAsEl   = document.getElementById(`holding-fetch-as-${fs}`);
  const fetchAs     = fetchAsEl ? (fetchAsEl.value || null) : null;
  const costPriceEl = document.getElementById(`holding-cost-price-${fs}`);
  const costPrice   = costPriceEl ? (parseFloat(costPriceEl.value) || null) : null;
  const isEtfEl     = document.getElementById(`holding-is-etf-${fs}`);
  const isEtf       = isEtfEl ? isEtfEl.checked : false;

  if (isNaN(qty) || qty < 0) return alert('請輸入有效數量');
  if (!['cash', 'debt', 'bond', 'real_estate'].includes(category) && !symbol) return alert('請輸入代號');

  const holding = {
    id:           Date.now().toString(),
    category,
    symbol:       (category === 'cash' || category === 'debt' || category === 'real_estate' || (category === 'bond' && !symbol)) ? '' : symbol,
    name:         name || symbol || CATEGORY_LABELS[category],
    qty,
    currency,
    manualPrice,
    currentPrice: manualPrice || null,
    ...(fetchAs ? { fetchAs } : {}),
    ...(costPrice ? { costPrice } : {}),
    ...((category === 'tw_stock' || category === 'us_stock') ? { isEtf } : {}),
  };

  p.holdings.push(holding);
  markProfileDirty(profileId);
  saveData();
  renderProfilePanel(profileId);
  renderOverview();

  // 清空表單
  e.target.reset();
  const currEl = document.getElementById(`holding-currency-${fs}`);
  if (currEl) currEl.value = 'TWD';
  onCategoryChange(fs);
  if (formSuffix) closeAddModal();

  // 若需要自動抓價，立即抓取這一筆
  if (!manualPrice && category !== 'cash' && category !== 'debt') {
    fetchPriceForHolding(holding).then(() => {
      markProfileDirty(profileId);
      saveData();
      renderProfilePanel(profileId);
      renderOverview();
    });
  }
}

// ─── 持股編輯模式 ────────────────────────────────────────────────────────────
function toggleHoldingsEdit(pid) {
  holdingsEditMode[pid] = true;
  document.getElementById(`edit-mode-btn-${pid}`).style.display   = 'none';
  document.getElementById(`save-mode-btn-${pid}`).style.display   = '';
  document.getElementById(`cancel-mode-btn-${pid}`).style.display = '';
  renderHoldings(pid);
}

function cancelHoldingsEdit(pid) {
  holdingsEditMode[pid] = false;
  document.getElementById(`edit-mode-btn-${pid}`).style.display   = '';
  document.getElementById(`save-mode-btn-${pid}`).style.display   = 'none';
  document.getElementById(`cancel-mode-btn-${pid}`).style.display = 'none';
  renderHoldings(pid);
}

function saveHoldingsEdit(pid) {
  const p = getProfile(pid);
  if (!p) return;
  document.querySelectorAll(`#holdings-list-${pid} [data-field="name"]`).forEach(input => {
    const h = p.holdings.find(x => x.id === input.dataset.id);
    if (!h) return;
    const nameVal  = input.value.trim();
    const catEl    = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="category"]`);
    const qtyEl    = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="qty"]`);
    const priceEl  = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="price"]`);
    const costEl   = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="cost"]`);
    const isEtfEl  = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="isEtf"]`);
    if (nameVal) h.name = nameVal;
    if (catEl)   h.category = catEl.value;
    if (qtyEl)   h.qty  = parseFloat(qtyEl.value) || h.qty;
    if (priceEl) {
      const mp = parseFloat(priceEl.value) || null;
      h.manualPrice = mp;
      if (mp) h.currentPrice = mp;
    }
    if (costEl) h.costPrice = parseFloat(costEl.value) || null;
    if (isEtfEl && (h.category === 'tw_stock' || h.category === 'us_stock')) h.isEtf = isEtfEl.checked;
  });
  saveData();
  cancelHoldingsEdit(pid);
  renderOverview();
}

function deleteHoldingInEdit(holdingId, pid) {
  if (!confirm('確定要刪除這筆資產？')) return;
  const p = getProfile(pid);
  if (!p) return;
  p.holdings = p.holdings.filter(h => h.id !== holdingId);
  markProfileDirty(pid);
  saveData();
  renderHoldings(pid);
  renderOverview();
}

// ─── 刪除持股 ────────────────────────────────────────────────────────────────
function deleteHolding(holdingId, profileId) {
  if (!confirm('確定要刪除這筆資產？')) return;
  const p = getProfile(profileId);
  if (!p) return;
  p.holdings = p.holdings.filter(h => h.id !== holdingId);
  markProfileDirty(profileId);
  saveData();
  renderProfilePanel(profileId);
  renderOverview();
}

// ─── 編輯 Modal ──────────────────────────────────────────────────────────────
function openEdit(holdingId, profileId) {
  const p = getProfile(profileId);
  if (!p) return;
  const h = p.holdings.find(x => x.id === holdingId);
  if (!h) return;

  document.getElementById('edit-id').value           = holdingId;
  document.getElementById('edit-profile-id').value   = profileId;
  document.getElementById('edit-category').value     = h.category;
  document.getElementById('edit-fetch-as').value     = h.fetchAs || '';
  document.getElementById('edit-qty').value          = h.qty;
  document.getElementById('edit-manual-price').value = h.manualPrice || '';
  document.getElementById('edit-cost-price').value   = h.costPrice || '';
  document.getElementById('edit-name').value         = h.name;
  document.getElementById('edit-currency').value     = h.currency || 'TWD';

  const showManual   = h.category !== 'cash';
  const showCurrency = h.category === 'bond' || h.category === 'cash' || h.category === 'debt';
  document.getElementById('edit-manual-price-group').style.display = showManual   ? '' : 'none';
  document.getElementById('edit-currency-group').style.display     = showCurrency ? '' : 'none';

  document.getElementById('edit-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('edit-modal').style.display = 'none';
}

function openHistModal(pid) {
  document.getElementById('hist-modal-pid').value = pid;
  document.getElementById('hist-modal-date').value = '';
  document.getElementById('hist-modal-value').value = '';
  document.getElementById('hist-modal').style.display = 'flex';
}

function closeHistModal() {
  document.getElementById('hist-modal').style.display = 'none';
}

function histModalSaveToday() {
  const pid = document.getElementById('hist-modal-pid').value;
  if (pid === 'overview') {
    saveCurrentAssets();
  } else {
    saveProfileAssets(pid);
  }
  closeHistModal();
}

function histModalAddManual() {
  const pid     = document.getElementById('hist-modal-pid').value;
  const dateVal = document.getElementById('hist-modal-date').value;
  const value   = parseFloat(document.getElementById('hist-modal-value').value);
  if (!dateVal || isNaN(value) || value < 0) { alert('請輸入有效的日期和資產總值'); return; }

  if (pid === 'overview') {
    const existing = historicalRecords.findIndex(r => r.date === dateVal);
    if (existing >= 0) {
      if (!confirm(`${dateVal} 已有紀錄，是否覆蓋？`)) return;
      historicalRecords[existing].value = value;
    } else {
      historicalRecords.push({ date: dateVal, value });
    }
    historicalRecords.sort((a, b) => a.date.localeCompare(b.date));
    saveData();
    renderHistoricalRecordsList();
    renderHistoricalChart();
  } else {
    const p = getProfile(pid);
    if (!p) return;
    const existing = p.historicalRecords.findIndex(r => r.date === dateVal);
    if (existing >= 0) {
      if (!confirm(`${dateVal} 已有紀錄，是否覆蓋？`)) return;
      p.historicalRecords[existing].value = value;
    } else {
      p.historicalRecords.push({ date: dateVal, value });
    }
    p.historicalRecords.sort((a, b) => a.date.localeCompare(b.date));
    markProfileDirty(pid);
    saveData();
    renderProfileHistoricalRecordsList(pid);
    renderProfileHistoricalChart(pid);
  }
  closeHistModal();
}

function openAddModal(pid) {
  document.getElementById('add-modal-pid').value = pid;
  document.getElementById('add-holding-form-add').reset();
  document.getElementById('holding-currency-add').value = 'TWD';
  onCategoryChange('add');
  document.getElementById('add-holding-modal').style.display = 'flex';
}

function closeAddModal() {
  document.getElementById('add-holding-modal').style.display = 'none';
}

function saveEdit() {
  const holdingId  = document.getElementById('edit-id').value;
  const profileId  = document.getElementById('edit-profile-id').value;
  const category    = document.getElementById('edit-category').value;
  const fetchAsVal  = document.getElementById('edit-fetch-as').value || null;
  const qty         = parseFloat(document.getElementById('edit-qty').value);
  const manualPrice = parseFloat(document.getElementById('edit-manual-price').value) || null;
  const name        = document.getElementById('edit-name').value.trim();

  const p = getProfile(profileId);
  if (!p) return;
  const h = p.holdings.find(x => x.id === holdingId);
  if (!h) return;

  if (isNaN(qty) || qty < 0) { alert('請輸入有效數量'); return; }

  const costPrice   = parseFloat(document.getElementById('edit-cost-price').value) || null;

  const editCurrencyEl = document.getElementById('edit-currency');
  const currency = editCurrencyEl ? editCurrencyEl.value : (h.currency || 'TWD');

  h.category    = category;
  h.fetchAs     = fetchAsVal;
  h.qty         = qty;
  h.currency    = currency;
  h.costPrice   = costPrice;
  h.name        = name || h.symbol || CATEGORY_LABELS[h.category];
  h.manualPrice = manualPrice;
  if (manualPrice) h.currentPrice = manualPrice;

  markProfileDirty(profileId);
  saveData();
  renderProfilePanel(profileId);
  renderOverview();
  closeModal();
}

// ─── 表單 UI 互動 ────────────────────────────────────────────────────────────
function onCategoryChange(pid) {
  const cat = document.getElementById(`holding-category-${pid}`).value;
  const symbolGroup      = document.getElementById(`symbol-group-${pid}`);
  const manualPriceGroup = document.getElementById(`manual-price-group-${pid}`);
  const currencyGroup    = document.getElementById(`currency-group-${pid}`);
  const qtyLabel         = document.getElementById(`qty-label-${pid}`);
  const symbolHint       = document.getElementById(`symbol-hint-${pid}`);
  const etfGroup         = document.getElementById(`etf-group-${pid}`);

  if (cat === 'cash' || cat === 'debt' || cat === 'real_estate') {
    symbolGroup.style.display      = 'none';
    manualPriceGroup.style.display = 'none';
    currencyGroup.style.display    = '';
    if (etfGroup) etfGroup.style.display = 'none';
    qtyLabel.textContent           = cat === 'debt' ? '負債金額' : cat === 'real_estate' ? '市值金額' : '金額';
    const currEl = document.getElementById(`holding-currency-${pid}`);
    if (currEl && cat !== 'real_estate') currEl.value = 'TWD';
  } else if (cat === 'crypto') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = 'none';
    if (etfGroup) etfGroup.style.display = 'none';
    qtyLabel.textContent           = '數量（顆）';
    symbolHint.textContent         = '（如：BTC、ETH、SOL）';
  } else if (cat === 'us_stock') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = 'none';
    if (etfGroup) etfGroup.style.display = '';
    qtyLabel.textContent           = '數量（股）';
    symbolHint.textContent         = '（如：AAPL、TSLA、VOO）';
  } else if (cat === 'tw_stock') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = 'none';
    if (etfGroup) etfGroup.style.display = '';
    qtyLabel.textContent           = '數量（股）';
    symbolHint.textContent         = '（如：2330、0050、006208）';
    onSymbolInput(pid);
  } else if (cat === 'bond') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = '';
    if (etfGroup) etfGroup.style.display = 'none';
    qtyLabel.textContent           = '本金金額 / 數量（股/張）';
    symbolHint.textContent         = '（如：00679B、TLT；直購/定存債請留空）';
  }
}

// ─── 台掛牌境外 ETF 提示 ─────────────────────────────────────────────────────
function onSymbolInput(suffix) {
  const catEl  = document.getElementById(`holding-category-${suffix}`);
  const symEl  = document.getElementById(`holding-symbol-${suffix}`);
  const hintEl = document.getElementById(`symbol-hint-${suffix}`);
  if (!catEl || !symEl || !hintEl) return;
  if (catEl.value !== 'tw_stock') return;
  const sym    = symEl.value.trim().toUpperCase();
  const market = TW_OVERSEAS_ETF_MAP[sym];
  if (market) {
    hintEl.innerHTML = `台掛牌境外 ETF，<button type="button" class="btn-link" onclick="applyOverseasEtfSuggestion('${suffix}','${market}')">建議改為「美股」類別</button>`;
  }
}

function applyOverseasEtfSuggestion(suffix, market) {
  const catEl   = document.getElementById(`holding-category-${suffix}`);
  const fetchEl = document.getElementById(`holding-fetch-as-${suffix}`);
  if (catEl)   catEl.value   = market;
  if (fetchEl) fetchEl.value = 'tw_stock';
  onCategoryChange(suffix);
  const hintEl = document.getElementById(`symbol-hint-${suffix}`);
  if (hintEl) hintEl.textContent = '✓ 已設為美股、報價從台股市場抓取';
}

// ─── 排序 ────────────────────────────────────────────────────────────────────
const SORT_CYCLE = { 'none': 'desc', 'desc': 'asc', 'asc': 'none' };
const SORT_ICON  = { 'none': '↕', 'desc': '↓', 'asc': '↑' };

function setSort(pid) {
  const cur = holdingsSortBy[pid] || 'none';
  holdingsSortBy[pid] = SORT_CYCLE[cur];
  const btn = document.getElementById(`sort-value-btn-${pid}`);
  if (btn) {
    btn.textContent = `金額 ${SORT_ICON[holdingsSortBy[pid]]}`;
    btn.classList.toggle('active', holdingsSortBy[pid] !== 'none');
  }
  renderHoldings(pid);
}

function getSortedHoldings(holdings, pid) {
  const list = [...holdings];
  const s = holdingsSortBy[pid] || 'none';
  if (s === 'desc') list.sort((a, b) => getHoldingValueTWD(b) - getHoldingValueTWD(a));
  if (s === 'asc')  list.sort((a, b) => getHoldingValueTWD(a) - getHoldingValueTWD(b));
  return list;
}

// ─── 渲染：持股清單 ──────────────────────────────────────────────────────────
function renderHoldings(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const container = document.getElementById(`holdings-list-${pid}`);
  if (!container) return;

  if (p.holdings.length === 0) {
    container.innerHTML = '<div class="empty-state">尚無持股，請新增資產</div>';
    return;
  }

  // 按類別分組
  const ALL_CATS = [...TARGET_CATS, 'debt'];
  const groups = {};
  ALL_CATS.forEach(c => { groups[c] = []; });
  p.holdings.forEach(h => { if (groups[h.category]) groups[h.category].push(h); });

  const editMode = !!holdingsEditMode[pid];

  container.innerHTML = `<div class="holdings-grid">${ALL_CATS.map(cat => {
    const holdings = getSortedHoldings(groups[cat], pid);
    const catTotal = holdings.reduce((s, h) => s + getHoldingValueTWD(h), 0);

    const catPnlTWD  = holdings.reduce((s, h) => { const p = getHoldingPnL(h); return s + (p ? p.pnlTWD : 0); }, 0);
    const catHasPnl  = holdings.some(h => getHoldingPnL(h));
    const catPnlHtml = catHasPnl ? (() => {
      const sign  = catPnlTWD >= 0 ? '+' : '';
      const color = catPnlTWD > 0 ? '#22c55e' : catPnlTWD < 0 ? '#ef4444' : '#94a3b8';
      return `<span class="hblock-cat-pnl" style="color:${color}">${sign}${formatTWD(catPnlTWD)}</span>`;
    })() : '';

    const items = holdings.map(h => {
      if (editMode) {
        const catOptions = Object.entries(CATEGORY_LABELS).map(([v, l]) =>
          `<option value="${v}"${h.category === v ? ' selected' : ''}>${l}</option>`
        ).join('');
        const showEtf = cat === 'tw_stock' || cat === 'us_stock';
        return `<div class="hblock-item hblock-item-edit">
          <button class="hblock-x-btn" onclick="deleteHoldingInEdit('${h.id}','${pid}')">×</button>
          <select class="hblock-edit-input" data-id="${h.id}" data-field="category">${catOptions}</select>
          <input class="hblock-edit-input" data-id="${h.id}" data-field="name" value="${escHtml(h.name)}" placeholder="名稱">
          <input class="hblock-edit-input" data-id="${h.id}" data-field="qty" type="number" value="${h.qty}" min="0" step="any" placeholder="數量">
          <input class="hblock-edit-input" data-id="${h.id}" data-field="price" type="number" value="${h.manualPrice || ''}" min="0" step="any" placeholder="手動單價（選填）">
          <input class="hblock-edit-input" data-id="${h.id}" data-field="cost" type="number" value="${h.costPrice || ''}" min="0" step="any" placeholder="買入均價（選填）">
          ${showEtf ? `<label class="hblock-edit-etf-label"><input type="checkbox" class="hblock-edit-input" data-id="${h.id}" data-field="isEtf"${h.isEtf ? ' checked' : ''}> ETF</label>` : ''}
        </div>`;
      }
      const valueTWD = getHoldingValueTWD(h);
      let changeHtml = '';
      if (h.currentPrice && h.previousClose && cat !== 'cash' && cat !== 'debt') {
        const priceDiff  = h.currentPrice - h.previousClose;
        const changeTWD  = toTWD(priceDiff * h.qty, h.currency);
        const pct        = (priceDiff / h.previousClose * 100).toFixed(2);
        const sign       = priceDiff >= 0 ? '+' : '';
        const color      = priceDiff > 0 ? '#22c55e' : priceDiff < 0 ? '#ef4444' : '#94a3b8';
        changeHtml = `<div class="hblock-change" style="color:${color}"><span class="hblock-label">今日</span> ${sign}${pct}% (${sign}${formatTWD(changeTWD)})</div>`;
      }
      const noPrice = cat !== 'cash' && cat !== 'debt' && !h.currentPrice;
      let priceDetailHtml = '';
      if (!noPrice && cat !== 'cash' && cat !== 'debt' && h.currentPrice) {
        const priceStr = h.currency === 'USD'
          ? `$${h.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
          : `NT$${h.currentPrice.toLocaleString('zh-TW')}`;
        priceDetailHtml = `<div class="hblock-price-detail">${priceStr} × ${h.qty.toLocaleString()}</div>`;
      }
      // 損益
      let pnlHtml = '';
      const pnl = getHoldingPnL(h);
      if (pnl) {
        const sign  = pnl.pnlTWD >= 0 ? '+' : '';
        const color = pnl.pnlTWD > 0 ? '#22c55e' : pnl.pnlTWD < 0 ? '#ef4444' : '#94a3b8';
        pnlHtml = `<div class="hblock-pnl" style="color:${color}"><span class="hblock-label">報酬</span> ${sign}${pnl.pnlPct.toFixed(2)}% (${sign}${formatTWD(pnl.pnlTWD)})</div>`;
      }
      const displayValue = cat === 'debt'
        ? `<span style="color:#f87171">${formatTWD(valueTWD)}</span>` // 負值（如 -500,000）
        : noPrice ? '<span style="color:#475569;font-size:0.72rem">尚無價格</span>' : formatTWD(valueTWD);
      const hasDetail = !!pnlHtml;
      return `<div class="hblock-item"${hasDetail ? ' data-expandable' : ''}>
        <div class="hblock-name">${escHtml(h.name)}${h.symbol && h.symbol !== h.name ? `<div class="holding-symbol">${escHtml(h.symbol)}</div>` : ''}</div>
        <div class="hblock-value">${displayValue}</div>
        ${priceDetailHtml}
        ${changeHtml}
        ${pnlHtml}
      </div>`;
    }).join('');

    return `<div class="hblock" data-cat="${cat}">
      <div class="hblock-header">
        <span class="holding-badge badge-${cat}">${CATEGORY_LABELS[cat]}</span>
        ${catTotal > 0 ? `<span class="hblock-total">${formatTWD(catTotal)}</span>` : cat === 'debt' && catTotal < 0 ? `<span class="hblock-total" style="color:#f87171">${formatTWD(catTotal)}</span>` : ''}
        ${catPnlHtml}
      </div>
      ${holdings.length === 0 ? '<div class="hblock-empty">—</div>' : `<div class="hblock-items">${items}</div>`}
    </div>`;
  }).join('')}</div>`;

  // 手機：還原已展開的類別
  hblockExpandedCats.forEach(key => {
    if (!key.startsWith(pid + '_')) return;
    const cat = key.slice(pid.length + 1);
    const block = container.querySelector(`.hblock[data-cat="${cat}"]`);
    if (block) block.classList.add('expanded');
  });
}

// ─── 價格抓取 ────────────────────────────────────────────────────────────────
function getEffectiveFetchCat(h) {
  if (h.category === 'bond' && !h.symbol) return null; // 直購債，無代號，不抓報價
  if (h.category === 'real_estate') return null; // 房地產，手動輸入市值，不抓報價
  return h.fetchAs || (h.category === 'bond' ? (h.currency === 'TWD' ? 'tw_stock' : 'us_stock') : h.category);
}

async function refreshAllPrices() {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const allHoldings    = profiles.flatMap(p => p.holdings);
    const twHoldings     = allHoldings.filter(h => !h.manualPrice && getEffectiveFetchCat(h) === 'tw_stock');
    const usHoldings     = allHoldings.filter(h => !h.manualPrice && getEffectiveFetchCat(h) === 'us_stock');
    const cryptoHoldings = allHoldings.filter(h => !h.manualPrice && getEffectiveFetchCat(h) === 'crypto');

    for (const h of twHoldings) {
      await fetchTWStockPrice(h);
      await new Promise(r => setTimeout(r, 200)); // 避免連續請求被 Yahoo Finance 限速
    }
    await fetchUSStocksBatch(usHoldings);
    await fetchCryptoBatch(cryptoHoldings);

    // 加密貨幣 fallback：不在 CoinGecko map 的 symbol（如 IBIT 等 ETF），改抓美股報價
    const cryptoFallback = cryptoHoldings.filter(h => !getCoinId(h.symbol));
    for (const h of cryptoFallback) {
      await fetchViaYahoo(h.symbol, h, 'USD');
    }

    saveData();
    renderAll();

    document.getElementById('last-updated').textContent = `最後更新：${new Date().toLocaleString('zh-TW')}`;
  } finally {
    isRefreshing = false;
  }
}

// 新增單筆時立即抓價
async function fetchPriceForHolding(holding) {
  try {
    const fetchCat = getEffectiveFetchCat(holding);
    if (fetchCat === 'crypto') {
      await fetchCryptoPrice(holding);
    } else if (fetchCat === 'tw_stock') {
      await fetchTWStockPrice(holding);
    } else {
      await fetchViaYahoo(holding.symbol, holding, 'USD');
    }
  } catch (err) {
    console.warn(`無法取得 ${holding.symbol} 價格:`, err);
  }
}

// 解析價格字串
function parsePrice(val) {
  if (typeof val === 'string') val = val.replace(/,/g, '').trim();
  const n = parseFloat(val);
  return (isFinite(n) && n > 0) ? n : null;
}

const CF_WORKER_URL = 'https://tw-stock-prox.chiangjoshua0218.workers.dev';

// 台股 MIS API 可用時段：週一~五 08:30~20:00
function isTWMisAvailable() {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = tw.getDay();
  if (day === 0 || day === 6) return false;
  const mins = tw.getHours() * 60 + tw.getMinutes();
  return mins >= 8 * 60 + 30 && mins <= 20 * 60;
}

// 台股：MIS → TWSE afterTrading → Yahoo Finance
async function fetchTWStockPrice(holding) {
  const symbol = holding.symbol.replace(/\.TWO?$/i, '').toUpperCase();
  const knownMarket = twMarketCache[symbol]; // 'tse' | 'otc' | undefined

  // 主要策略：TWSE MIS API
  if (isTWMisAvailable()) {
    const markets = knownMarket ? [knownMarket] : ['tse', 'otc'];
    for (const mkt of markets) {
      try {
        const res = await fetch(`${CF_WORKER_URL}/?symbol=${symbol}&market=${mkt}`);
        if (!res.ok) continue;
        const data  = await res.json();
        const item  = data?.msgArray?.[0];
        // z='-' 時（兩筆成交之間）：用 bid/ask 中間價，再 fallback 開盤價
        // 委買/委賣第一檔可能是市價單（0.0000），取第一個非零價格
        const bid   = parsePrice(item?.b?.split('_').find(v => parseFloat(v) > 0));
        const ask   = parsePrice(item?.a?.split('_').find(v => parseFloat(v) > 0));
        const midPrice = (bid && ask) ? (bid + ask) / 2 : (bid || ask || null);
        const price = parsePrice(item?.z) || midPrice || parsePrice(item?.o);
        const prev  = parsePrice(item?.y);
        if (price) {
          holding.currentPrice  = price;
          holding.currency      = 'TWD';
          if (prev) holding.previousClose = prev;
          twMarketCache[symbol] = mkt;
          return;
        }
      } catch {}
    }
  }

  // 備援策略：TWSE afterTrading API（TSE 股收盤後或週末）
  try {
    const res = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${symbol}&response=json`);
    if (res.ok) {
      const json = await res.json();
      if (json.stat === 'OK' && json.data?.length) {
        const last  = json.data[json.data.length - 1];
        const price = parsePrice(last[6]);
        if (price) {
          holding.currentPrice = price;
          holding.currency     = 'TWD';
          const change = parseFloat((last[7] || '').replace(/,/g, '') || '0');
          if (!isNaN(change) && price - change > 0) holding.previousClose = price - change;
          if (!twMarketCache[symbol]) twMarketCache[symbol] = 'tse';
          return;
        }
      }
    }
  } catch {}

  // 最後備援：Yahoo Finance（適用 OTC 股票週末/盤後）
  const prevPrice = holding.currentPrice;
  holding.currentPrice = null;
  const suffix = knownMarket === 'otc' ? '.TWO' : '.TW';
  await fetchViaYahoo(symbol + suffix, holding, 'TWD');
  if (holding.currentPrice) return;

  if (!knownMarket) {
    await fetchViaYahoo(symbol + '.TWO', holding, 'TWD');
    if (holding.currentPrice) { twMarketCache[symbol] = 'otc'; return; }
  }

  holding.currentPrice = prevPrice;
}

// 美股抓取
async function fetchUSStocksBatch(usHoldings) {
  if (!usHoldings.length) return;
  for (const h of usHoldings) {
    if (/^\d/.test(h.symbol)) {
      await fetchTWStockPrice(h);
    } else {
      await fetchViaYahoo(h.symbol, h, 'USD');
    }
  }
}

// Yahoo Finance via CF Worker（美股 / OTC 台股備援）
async function fetchViaYahoo(symbol, holding, currency) {
  const encoded = encodeURIComponent(symbol);
  try {
    let res = await fetch(`${CF_WORKER_URL}/?symbol=${encoded}&market=us`);
    if (res.status === 502 || res.status === 520) {
      await new Promise(r => setTimeout(r, 1500));
      res = await fetch(`${CF_WORKER_URL}/?symbol=${encoded}&market=us`);
    }
    if (!res.ok) return;
    const data  = await res.json();
    const meta  = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.chartPreviousClose;
    if (price) {
      holding.currentPrice = price;
      holding.currency     = currency;
      const prev = meta?.chartPreviousClose ?? meta?.previousClose;
      if (prev) holding.previousClose = prev;
    }
  } catch {}
}

// 加密貨幣批次：CoinGecko
async function fetchCryptoBatch(cryptoHoldings) {
  if (!cryptoHoldings.length) return;
  const idMap = Object.fromEntries(
    cryptoHoldings.map(h => [getCoinId(h.symbol), h]).filter(([id]) => id)
  );
  const ids = Object.keys(idMap);
  if (!ids.length) return;
  try {
    const res  = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`);
    const json = await res.json();
    for (const [coinId, h] of Object.entries(idMap)) {
      const usd = json?.[coinId]?.usd;
      if (usd) {
        h.currentPrice = usd;
        h.currency     = 'USD';
        const pct = json[coinId]?.usd_24h_change;
        if (pct != null) h.previousClose = usd / (1 + pct / 100);
      }
    }
  } catch {
    for (const h of cryptoHoldings) await fetchCryptoPrice(h);
  }
}

// CoinGecko 單一
async function fetchCryptoPrice(holding) {
  const coinId = getCoinId(holding.symbol);
  if (!coinId) { console.warn(`找不到幣種 ID：${holding.symbol}`); return; }
  const res  = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`);
  const json = await res.json();
  const usd  = json?.[coinId]?.usd;
  if (usd) { holding.currentPrice = usd; holding.currency = 'USD'; }
}

function getCoinId(symbol) {
  const map = {
    BTC:  'bitcoin',
    ETH:  'ethereum',
    SOL:  'solana',
    BNB:  'binancecoin',
    XRP:  'ripple',
    ADA:  'cardano',
    DOGE: 'dogecoin',
    AVAX: 'avalanche-2',
    DOT:  'polkadot',
    MATIC:'matic-network',
    LINK: 'chainlink',
    UNI:  'uniswap',
    ATOM: 'cosmos',
    LTC:  'litecoin',
    NEAR: 'near',
    APT:  'aptos',
    ARB:  'arbitrum',
    OP:   'optimism',
    SUI:  'sui',
    PEPE: 'pepe',
  };
  return map[symbol.toUpperCase()] || null;
}

// 自動取得匯率（多來源備援），同時抓 EUR/AUD/JPY/GBP
const FX_EXTRA = ['eur', 'aud', 'jpy', 'gbp'];

async function fetchExchangeRate() {
  const sources = [
    async () => {
      const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json');
      const j = await r.json();
      const twd = j?.usd?.twd;
      if (twd) {
        for (const c of FX_EXTRA) {
          const usdPer = j?.usd?.[c];
          if (usdPer) fxRates[c.toUpperCase()] = parseFloat((twd / usdPer).toFixed(4));
        }
      }
      return twd ?? null;
    },
    async () => {
      const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      const j = await r.json();
      const twd = j?.rates?.TWD;
      if (twd) {
        for (const c of FX_EXTRA) {
          const usdPer = j?.rates?.[c.toUpperCase()];
          if (usdPer) fxRates[c.toUpperCase()] = parseFloat((twd / usdPer).toFixed(4));
        }
      }
      return twd ?? null;
    },
    async () => {
      const r = await fetch('https://open.er-api.com/v6/latest/USD');
      const j = await r.json();
      const twd = j?.rates?.TWD;
      if (twd) {
        for (const c of FX_EXTRA) {
          const usdPer = j?.rates?.[c.toUpperCase()];
          if (usdPer) fxRates[c.toUpperCase()] = parseFloat((twd / usdPer).toFixed(4));
        }
      }
      return twd ?? null;
    },
  ];

  for (const source of sources) {
    try {
      const rate = await source();
      if (rate && rate > 1) {
        const today = new Date().toISOString().slice(0, 10);
        if (rateSnapshot.date !== today) {
          rateSnapshot = { date: today, usdRate, fxRates: { ...fxRates } };
        }
        usdRate = parseFloat(parseFloat(rate).toFixed(2));
        updateRateDisplay();
        saveData();
        renderOverview();
        renderAllProfilePanels();
        return;
      }
    } catch {}
  }
  // 所有來源失敗，保留舊匯率
}

// ─── 價值換算 ─────────────────────────────────────────────────────────────────
function toTWD(price, currency) {
  if (!price) return 0;
  if (!currency || currency === 'TWD') return price;
  if (currency === 'USD') return price * usdRate;
  return fxRates[currency] ? price * fxRates[currency] : price; // 匯率未知時視為台幣
}

function getHoldingValueTWD(h) {
  if (h.category === 'cash' || h.category === 'real_estate') {
    return toTWD(h.qty, h.currency);
  }
  if (h.category === 'debt') {
    return -toTWD(h.qty, h.currency); // 負債為負值，減少淨資產
  }
  if (h.category === 'bond' && !h.symbol) {
    return toTWD(h.qty, h.currency); // 直購債：qty = 本金金額
  }
  const price = h.currentPrice;
  if (!price) {
    // 債券抓不到價格時，qty 視為本金面額，以持有幣別（預設 USD）換算
    if (h.category === 'bond') return toTWD(h.qty, h.currency || 'USD');
    return 0;
  }
  return toTWD(price * h.qty, h.currency);
}

function getHoldingPnL(h) {
  if (!h.costPrice || !h.currentPrice || h.category === 'cash') return null;
  const pnlNative = (h.currentPrice - h.costPrice) * h.qty;
  const pnlTWD    = toTWD(pnlNative, h.currency);
  const pnlPct    = (h.currentPrice - h.costPrice) / h.costPrice * 100;
  return { pnlTWD, pnlPct };
}

// ─── 目標配置 ─────────────────────────────────────────────────────────────────
let targetEditMode = {};

function renderTargetCards(pid) {
  const container = document.getElementById(`target-cards-${pid}`);
  if (!container) return;
  const p = getProfile(pid);
  if (!p) return;

  const totals = Object.fromEntries(TARGET_CATS.map(c => [c, 0]));
  p.holdings.forEach(h => { totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h); });
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const isEdit = !!targetEditMode[pid];

  const cards = TARGET_CATS.map(c => {
    const tgtPct = p.targetAllocations[c] || 0;
    const curPct = grandTotal > 0 ? totals[c] / grandTotal * 100 : 0;
    const diff   = grandTotal * tgtPct / 100 - totals[c];

    let adjHtml;
    if (grandTotal === 0 || (tgtPct === 0 && totals[c] === 0)) {
      adjHtml = `<span class="tcard-adj zero">—</span>`;
    } else if (Math.abs(diff) < 100) {
      adjHtml = `<span class="tcard-adj zero">±0</span>`;
    } else if (diff > 0) {
      adjHtml = `<span class="tcard-adj buy">+${formatTWD(diff)}</span>`;
    } else {
      adjHtml = `<span class="tcard-adj sell">${formatTWD(diff)}</span>`;
    }

    const targetHtml = isEdit
      ? `<span class="tcard-edit-wrap"><input type="number" class="tcard-input" id="target-edit-${c}-${pid}" value="${tgtPct}" min="0" max="100" step="1" oninput="onTargetEditChange('${pid}')">%</span>`
      : `<span>${tgtPct}%</span>`;

    return `<div class="tcard">
      <div class="tcard-label">${CATEGORY_LABELS[c]}</div>
      <div class="tcard-row"><span class="tcard-key">目標</span><span class="tcard-target">${targetHtml}</span></div>
      <div class="tcard-row"><span class="tcard-key">目前</span><span class="tcard-current">${curPct.toFixed(1)}%</span></div>
      <div class="tcard-row"><span class="tcard-key">調整</span>${adjHtml}</div>
    </div>`;
  }).join('');

  const tSum = TARGET_CATS.reduce((s, c) => s + (p.targetAllocations[c] || 0), 0);
  const sumHtml = isEdit
    ? `<div class="tcard-sum${tSum === 100 ? ' perfect' : tSum > 100 ? ' over' : ''}" id="target-sum-bar-${pid}">合計：<span id="target-sum-${pid}">${tSum}</span>%</div>`
    : '';

  const mobileHeader = `<div class="tcard-table-header"><span>類別</span><span>目標</span><span>目前</span><span>調整</span></div>`;
  container.innerHTML = `${mobileHeader}<div class="tcard-grid">${cards}</div>${sumHtml}`;
}

function toggleTargetEdit(pid) {
  targetEditMode[pid] = true;
  document.getElementById(`target-edit-btn-${pid}`).style.display = 'none';
  document.getElementById(`target-save-btn-${pid}`).style.display = '';
  document.getElementById(`target-cancel-btn-${pid}`).style.display = '';
  renderTargetCards(pid);
}

function cancelTargetEdit(pid) {
  targetEditMode[pid] = false;
  document.getElementById(`target-edit-btn-${pid}`).style.display = '';
  document.getElementById(`target-save-btn-${pid}`).style.display = 'none';
  document.getElementById(`target-cancel-btn-${pid}`).style.display = 'none';
  renderTargetCards(pid);
}

function saveTargetEdit(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const sum = TARGET_CATS.reduce((s, c) => {
    const el = document.getElementById(`target-edit-${c}-${pid}`);
    return s + (el ? parseFloat(el.value) || 0 : 0);
  }, 0);
  if (sum !== 100) { alert(`合計必須為 100%（目前 ${sum}%）`); return; }
  TARGET_CATS.forEach(c => {
    const el = document.getElementById(`target-edit-${c}-${pid}`);
    p.targetAllocations[c] = el ? parseFloat(el.value) || 0 : 0;
  });
  markProfileDirty(pid);
  saveData();
  cancelTargetEdit(pid);
}

function onTargetEditChange(pid) {
  const sum = TARGET_CATS.reduce((s, c) => {
    const el = document.getElementById(`target-edit-${c}-${pid}`);
    return s + (el ? parseFloat(el.value) || 0 : 0);
  }, 0);
  const sumEl  = document.getElementById(`target-sum-${pid}`);
  const barEl  = document.getElementById(`target-sum-bar-${pid}`);
  if (sumEl) sumEl.textContent = sum;
  if (barEl) barEl.className = 'tcard-sum' + (sum === 100 ? ' perfect' : sum > 100 ? ' over' : '');
}

// ─── 渲染：資產配置圓餅圖（aggregate ALL profiles）──────────────────────────
function renderChart() {
  const allHoldings = profiles.flatMap(p => p.holdings);
  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
  allHoldings.forEach(h => {
    totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h);
  });

  const total   = Object.values(totals).reduce((a, b) => a + b, 0);
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  const labels  = entries.map(([k]) => CATEGORY_LABELS[k]);
  const data    = entries.map(([, v]) => v);
  const colors  = entries.map(([k]) => CATEGORY_COLORS[k]);

  const ctx = document.getElementById('allocationChart').getContext('2d');
  if (chart) chart.destroy();

  if (entries.length === 0) {
    document.getElementById('chart-legend').innerHTML = '';
    return;
  }

  chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors,
        borderColor:     '#f3f1ee',
        borderWidth:     3,
        hoverOffset:     6,
      }]
    },
    options: {
      responsive: true,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(28,28,30,0.85)',
          titleColor: '#fff',
          bodyColor: '#e5e5ea',
          cornerRadius: 8,
          padding: 10,
          callbacks: {
            label: ctx => {
              const pct = total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0;
              return ` ${formatTWD(ctx.raw)} (${pct}%)`;
            }
          }
        }
      }
    }
  });

  const legendHtml = entries.map(([k, v]) => {
    const pct = total > 0 ? (v / total * 100).toFixed(1) : '0.0';
    return `
      <div class="legend-item">
        <div class="legend-left">
          <div class="legend-dot" style="background:${CATEGORY_COLORS[k]}"></div>
          <span>${CATEGORY_LABELS[k]}</span>
        </div>
        <span class="legend-pct">${pct}%</span>
      </div>`;
  }).join('');
  document.getElementById('chart-legend').innerHTML = legendHtml;
}

// ─── 渲染：股票類型圓餅圖（ETF vs 個股）─────────────────────────────────────
function renderStockTypeChart() {
  const allHoldings = profiles.flatMap(p => p.holdings);
  const totals = { tw_etf: 0, tw_stock_ind: 0, us_etf: 0, us_stock_ind: 0 };
  allHoldings.forEach(h => {
    if (h.category === 'tw_stock') {
      if (h.isEtf) totals.tw_etf += getHoldingValueTWD(h);
      else totals.tw_stock_ind += getHoldingValueTWD(h);
    } else if (h.category === 'us_stock') {
      if (h.isEtf) totals.us_etf += getHoldingValueTWD(h);
      else totals.us_stock_ind += getHoldingValueTWD(h);
    }
  });

  const total   = Object.values(totals).reduce((a, b) => a + b, 0);
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  const legendEl = document.getElementById('stock-type-legend');

  const ctx = document.getElementById('stockTypeChart')?.getContext('2d');
  if (!ctx) return;
  if (stockTypeChart) stockTypeChart.destroy();

  if (entries.length === 0) {
    if (legendEl) legendEl.innerHTML = '<div style="color:#94a3b8;font-size:0.85rem;text-align:center;padding:1rem">台股/美股尚無資料</div>';
    return;
  }

  stockTypeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => STOCK_TYPE_LABELS[k]),
      datasets: [{
        data:            entries.map(([, v]) => v),
        backgroundColor: entries.map(([k]) => STOCK_TYPE_COLORS[k]),
        borderColor:     '#f3f1ee',
        borderWidth:     3,
        hoverOffset:     6,
      }]
    },
    options: {
      responsive: true,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(28,28,30,0.85)',
          titleColor: '#fff',
          bodyColor: '#e5e5ea',
          cornerRadius: 8,
          padding: 10,
          callbacks: {
            label: ctx => {
              const pct = total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0;
              return ` ${formatTWD(ctx.raw)} (${pct}%)`;
            }
          }
        }
      }
    }
  });

  if (legendEl) {
    legendEl.innerHTML = entries.map(([k, v]) => {
      const pct = total > 0 ? (v / total * 100).toFixed(1) : '0.0';
      return `
        <div class="legend-item">
          <div class="legend-left">
            <div class="legend-dot" style="background:${STOCK_TYPE_COLORS[k]}"></div>
            <span>${STOCK_TYPE_LABELS[k]}</span>
          </div>
          <span class="legend-pct">${pct}%</span>
        </div>`;
    }).join('');
  }
}

function switchChartTab(tab) {
  document.getElementById('chart-view-category').style.display  = tab === 'category'  ? '' : 'none';
  document.getElementById('chart-view-stocktype').style.display = tab === 'stocktype' ? '' : 'none';
  document.getElementById('chart-tab-category').classList.toggle('active',  tab === 'category');
  document.getElementById('chart-tab-stocktype').classList.toggle('active', tab === 'stocktype');
  if (tab === 'category'  && chart)          chart.resize();
  if (tab === 'stocktype' && stockTypeChart) stockTypeChart.resize();
}

// ─── Per-profile 圓餅圖 ───────────────────────────────────────────────────────
function renderProfileChart(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const canvas = document.getElementById(`profileChart-${pid}`);
  if (!canvas) return;

  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0, real_estate: 0 };
  p.holdings.forEach(h => { totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h); });
  const total   = Object.values(totals).reduce((a, b) => a + b, 0);
  const entries = Object.entries(totals).filter(([, v]) => v > 0);

  if (profileCharts[pid]) { profileCharts[pid].destroy(); }

  if (entries.length === 0) {
    document.getElementById(`profile-chart-legend-${pid}`).innerHTML = '';
    return;
  }

  profileCharts[pid] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels:   entries.map(([k]) => CATEGORY_LABELS[k]),
      datasets: [{ data: entries.map(([, v]) => v), backgroundColor: entries.map(([k]) => CATEGORY_COLORS[k]), borderColor: '#f3f1ee', borderWidth: 3, hoverOffset: 6 }]
    },
    options: {
      responsive: true, cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(28,28,30,0.85)',
          titleColor: '#fff',
          bodyColor: '#e5e5ea',
          cornerRadius: 8,
          padding: 10,
          callbacks: { label: ctx => ` ${formatTWD(ctx.raw)} (${total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0}%)` }
        }
      }
    }
  });

  document.getElementById(`profile-chart-legend-${pid}`).innerHTML = entries.map(([k, v]) => `
    <div class="legend-item">
      <div class="legend-left"><div class="legend-dot" style="background:${CATEGORY_COLORS[k]}"></div><span>${CATEGORY_LABELS[k]}</span></div>
      <span class="legend-pct">${total > 0 ? (v / total * 100).toFixed(1) : '0.0'}%</span>
    </div>`).join('');
}

// ─── Per-profile 股票類型圓餅圖 ───────────────────────────────────────────────
function renderProfileStockTypeChart(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const canvas = document.getElementById(`profileStockTypeChart-${pid}`);
  if (!canvas) return;

  const totals = { tw_etf: 0, tw_stock_ind: 0, us_etf: 0, us_stock_ind: 0 };
  p.holdings.forEach(h => {
    if (h.category === 'tw_stock') {
      if (h.isEtf) totals.tw_etf += getHoldingValueTWD(h);
      else totals.tw_stock_ind += getHoldingValueTWD(h);
    } else if (h.category === 'us_stock') {
      if (h.isEtf) totals.us_etf += getHoldingValueTWD(h);
      else totals.us_stock_ind += getHoldingValueTWD(h);
    }
  });

  const total   = Object.values(totals).reduce((a, b) => a + b, 0);
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  const legendEl = document.getElementById(`profile-stocktype-legend-${pid}`);

  if (profileStockTypeCharts[pid]) profileStockTypeCharts[pid].destroy();

  if (entries.length === 0) {
    if (legendEl) legendEl.innerHTML = '<div style="color:#94a3b8;font-size:0.85rem;text-align:center;padding:1rem">台股/美股尚無資料</div>';
    return;
  }

  profileStockTypeCharts[pid] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => STOCK_TYPE_LABELS[k]),
      datasets: [{
        data:            entries.map(([, v]) => v),
        backgroundColor: entries.map(([k]) => STOCK_TYPE_COLORS[k]),
        borderColor:     '#f3f1ee',
        borderWidth:     3,
        hoverOffset:     6,
      }]
    },
    options: {
      responsive: true,
      cutout: '66%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(28,28,30,0.85)',
          titleColor: '#fff',
          bodyColor: '#e5e5ea',
          cornerRadius: 8,
          padding: 10,
          callbacks: { label: ctx => ` ${formatTWD(ctx.raw)} (${total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0}%)` }
        }
      }
    }
  });

  if (legendEl) {
    legendEl.innerHTML = entries.map(([k, v]) => `
      <div class="legend-item">
        <div class="legend-left"><div class="legend-dot" style="background:${STOCK_TYPE_COLORS[k]}"></div><span>${STOCK_TYPE_LABELS[k]}</span></div>
        <span class="legend-pct">${total > 0 ? (v / total * 100).toFixed(1) : '0.0'}%</span>
      </div>`).join('');
  }
}

function switchProfileChartTab(pid, tab) {
  document.getElementById(`pchart-view-category-${pid}`).style.display  = tab === 'category'  ? '' : 'none';
  document.getElementById(`pchart-view-stocktype-${pid}`).style.display = tab === 'stocktype' ? '' : 'none';
  document.getElementById(`pchart-tab-category-${pid}`).classList.toggle('active',  tab === 'category');
  document.getElementById(`pchart-tab-stocktype-${pid}`).classList.toggle('active', tab === 'stocktype');
  if (tab === 'category'  && profileCharts[pid])          profileCharts[pid].resize();
  if (tab === 'stocktype' && profileStockTypeCharts[pid]) profileStockTypeCharts[pid].resize();
}

// ─── Per-profile 歷史紀錄 ─────────────────────────────────────────────────────
function getProfileSubtotal(pid) {
  const p = getProfile(pid);
  return p ? p.holdings.reduce((s, h) => s + getHoldingValueTWD(h), 0) : 0;
}

function saveProfileAssets(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const total = getProfileSubtotal(pid);
  if (total === 0) { alert('目前沒有資產數據，請先更新股價後再記錄'); return; }
  const today    = new Date().toISOString().split('T')[0];
  const existing = p.historicalRecords.findIndex(r => r.date === today);
  if (existing >= 0) {
    if (!confirm(`${today} 已有紀錄（${formatTWD(p.historicalRecords[existing].value)}），是否覆蓋？`)) return;
    p.historicalRecords[existing].value = total;
  } else {
    p.historicalRecords.push({ date: today, value: total });
  }
  p.historicalRecords.sort((a, b) => a.date.localeCompare(b.date));
  markProfileDirty(pid);
  saveData();
  renderProfileHistoricalRecordsList(pid);
  renderProfileHistoricalChart(pid);
}

function deleteProfileHistoricalRecord(pid, date) {
  const p = getProfile(pid);
  if (!p) return;
  if (!confirm(`確定要刪除 ${date} 的紀錄？`)) return;
  p.historicalRecords = p.historicalRecords.filter(r => r.date !== date);
  markProfileDirty(pid);
  saveData();
  renderProfileHistoricalRecordsList(pid);
  renderProfileHistoricalChart(pid);
}

function renderProfileHistoricalChart(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const canvas = document.getElementById(`profileHistChart-${pid}`);
  if (!canvas) return;

  const today  = new Date().toISOString().split('T')[0];
  const nowRec = { date: today, value: getProfileSubtotal(pid), isNow: true };
  const allRecords = [...p.historicalRecords, nowRec]
    .filter((r, i, arr) => arr.findIndex(x => x.date === r.date) === i)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (profileHistoricalCharts[pid]) { profileHistoricalCharts[pid].destroy(); profileHistoricalCharts[pid] = null; }
  if (allRecords.length < 2) return;

  const dataPoints = allRecords.map(r => ({ x: new Date(r.date + 'T00:00:00').getTime(), y: r.value }));
  const minYear = new Date(allRecords[0].date).getFullYear();
  const maxYear = new Date(allRecords[allRecords.length - 1].date).getFullYear();
  const yearTickValues = [];
  for (let y = minYear; y <= maxYear; y++) yearTickValues.push(new Date(`${y}-01-01T00:00:00`).getTime());

  profileHistoricalCharts[pid] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [{
        label: '資產總值', data: dataPoints,
        borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3,
        pointRadius: allRecords.map(r => r.isNow ? 8 : 5),
        pointBackgroundColor: allRecords.map(r => r.isNow ? '#f97316' : '#3b82f6'),
        pointBorderColor: '#fff', pointBorderWidth: 2, pointHoverRadius: 10,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: {
          title: items => new Date(items[0].parsed.x).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          label: ctx => ` ${formatTWD(ctx.parsed.y)}`,
        }}
      },
      scales: {
        x: {
          type: 'linear',
          afterBuildTicks: axis => { axis.ticks = yearTickValues.map(v => ({ value: v })); },
          ticks: { color: '#94a3b8', maxRotation: 0, callback: v => new Date(v).getFullYear().toString() },
          grid: { display: false }
        },
        y: {
          beginAtZero: false,
          ticks: { stepSize: 10_000_000, color: '#94a3b8', callback: v => (v / 1_000_000).toFixed(1) + 'M' },
          grid: { display: false }
        }
      }
    }
  });
}

function renderProfileHistoricalRecordsList(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const container = document.getElementById(`phist-list-${pid}`);
  if (!container) return;

  const today  = new Date().toISOString().split('T')[0];
  const nowRec = { date: today, value: getProfileSubtotal(pid), isNow: true };
  const allRecords = [...p.historicalRecords, nowRec]
    .filter((r, i, arr) => arr.findIndex(x => x.date === r.date) === i)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!allRecords.length) { container.innerHTML = '<p class="empty-state">尚無紀錄</p>'; return; }

  container.innerHTML = allRecords.map((r, i) => {
    let growthHtml = '';
    if (i > 0) {
      const prev   = allRecords[i - 1];
      const growth = prev.value > 0 ? ((r.value - prev.value) / prev.value * 100).toFixed(2) : 0;
      const delta  = r.value - prev.value;
      const sign   = growth > 0 ? '+' : '';
      const color  = growth > 0 ? '#22c55e' : growth < 0 ? '#ef4444' : '#94a3b8';
      growthHtml = `<span style="color:${color};font-size:0.82rem;white-space:nowrap">${sign}${growth}%&nbsp;(${sign}${formatTWD(delta)})</span>`;
    }
    const label = r.isNow ? `${r.date} 現在` : r.date;
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;padding:0.6rem 0.75rem;border-bottom:1px solid #2d3748;flex-wrap:wrap">
        <span style="font-weight:600;min-width:90px;font-size:0.82rem;color:${r.isNow ? '#f97316' : '#e2e8f0'}">${label}</span>
        <span style="min-width:90px;font-size:0.9rem">${formatTWD(r.value)}</span>
        <span style="flex:1">${growthHtml}</span>
        ${!r.isNow ? `<button class="btn btn-danger" onclick="deleteProfileHistoricalRecord('${pid}','${r.date}')" style="padding:0.2rem 0.5rem;font-size:0.72rem">刪除</button>` : ''}
      </div>`;
  }).join('');
}

// ─── 工具函式 ────────────────────────────────────────────────────────────────
function formatTWD(value) {
  if (!value || isNaN(value)) return 'NT$0';
  if (value >= 1_000_000) {
    return `NT$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `NT$${Math.round(value).toLocaleString('zh-TW')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── 卡片折疊 ────────────────────────────────────────────────────────────────
function toggleCard(bodyId) {
  const body = document.getElementById(bodyId);
  const btn  = body.previousElementSibling.querySelector('.btn-collapse');
  const collapsed = body.classList.toggle('collapsed');
  btn.textContent = collapsed ? '+' : '−';
}

// ─── 歷史資產紀錄 ────────────────────────────────────────────────────────────
function getCurrentTotal() {
  return profiles.flatMap(p => p.holdings).reduce((sum, h) => sum + getHoldingValueTWD(h), 0);
}

function saveCurrentAssets() {
  const total = getCurrentTotal();
  if (total === 0) {
    alert('目前沒有資產數據，請先更新股價後再記錄');
    return;
  }
  const today    = new Date().toISOString().split('T')[0];
  const existing = historicalRecords.findIndex(r => r.date === today);
  if (existing >= 0) {
    if (!confirm(`${today} 已有紀錄（${formatTWD(historicalRecords[existing].value)}），是否覆蓋為目前的 ${formatTWD(total)}？`)) return;
    historicalRecords[existing].value = total;
  } else {
    historicalRecords.push({ date: today, value: total });
  }
  historicalRecords.sort((a, b) => a.date.localeCompare(b.date));
  saveData();
  renderHistoricalRecordsList();
  renderHistoricalChart();
}

function getNowRecord() {
  const today = new Date().toISOString().split('T')[0];
  return { date: today, value: getCurrentTotal(), isNow: true };
}

function renderHistoricalChart() {
  const canvas = document.getElementById('historicalAssetChart');
  if (!canvas) return;

  const nowRec     = getNowRecord();
  const allRecords = [...historicalRecords, nowRec]
    .filter((r, i, arr) => arr.findIndex(x => x.date === r.date) === i)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (allRecords.length < 2) {
    if (historicalChart) { historicalChart.destroy(); historicalChart = null; }
    return;
  }

  const ctx = canvas.getContext('2d');

  const dataPoints = allRecords.map(r => ({
    x: new Date(r.date + 'T00:00:00').getTime(),
    y: r.value,
  }));

  const minYear = new Date(allRecords[0].date).getFullYear();
  const maxYear = new Date(allRecords[allRecords.length - 1].date).getFullYear();
  const yearTickValues = [];
  for (let y = minYear; y <= maxYear; y++) {
    yearTickValues.push(new Date(`${y}-01-01T00:00:00`).getTime());
  }

  if (historicalChart) historicalChart.destroy();

  historicalChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: '資產總值',
        data: dataPoints,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: allRecords.map(r => r.isNow ? 8 : 5),
        pointBackgroundColor: allRecords.map(r => r.isNow ? '#f97316' : '#3b82f6'),
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointHoverRadius: 10,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => new Date(items[0].parsed.x).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }),
            label: ctx  => ` ${formatTWD(ctx.parsed.y)}`,
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          afterBuildTicks: axis => {
            axis.ticks = yearTickValues.map(v => ({ value: v }));
          },
          ticks: {
            color: '#94a3b8',
            maxRotation: 0,
            callback: v => new Date(v).getFullYear().toString(),
          },
          grid: { display: false }
        },
        y: {
          beginAtZero: false,
          ticks: {
            stepSize: 10_000_000,
            color: '#94a3b8',
            callback: v => (v / 1_000_000).toFixed(1) + 'M'
          },
          grid: { display: false }
        }
      }
    }
  });
}

function renderHistoricalRecordsList() {
  const container = document.getElementById('historical-records-list');
  if (!container) return;

  const nowRec     = getNowRecord();
  const allRecords = [...historicalRecords, nowRec]
    .filter((r, i, arr) => arr.findIndex(x => x.date === r.date) === i)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!allRecords.length) {
    container.innerHTML = '<p class="empty-state">尚無紀錄</p>';
    return;
  }

  container.innerHTML = allRecords.map((r, i) => {
    let growthHtml = '';
    if (i > 0) {
      const prev   = allRecords[i - 1];
      const growth = prev.value > 0 ? ((r.value - prev.value) / prev.value * 100).toFixed(2) : 0;
      const delta  = r.value - prev.value;
      const sign   = growth > 0 ? '+' : '';
      const color  = growth > 0 ? '#22c55e' : growth < 0 ? '#ef4444' : '#94a3b8';
      growthHtml = `<span style="color:${color};font-size:0.82rem;white-space:nowrap">${sign}${growth}%&nbsp;(${sign}${formatTWD(delta)})</span>`;
    }
    const label = r.isNow ? `${r.date} 現在` : r.date;
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;padding:0.6rem 0.75rem;border-bottom:1px solid #2d3748;flex-wrap:wrap">
        <span style="font-weight:600;min-width:90px;font-size:0.82rem;color:${r.isNow ? '#f97316' : '#e2e8f0'}">${label}</span>
        <span style="min-width:90px;font-size:0.9rem">${formatTWD(r.value)}</span>
        <span style="flex:1">${growthHtml}</span>
        ${!r.isNow ? `<button class="btn btn-danger" onclick="deleteHistoricalRecord('${r.date}')" style="padding:0.2rem 0.5rem;font-size:0.72rem">刪除</button>` : ''}
      </div>`;
  }).join('');
}

function deleteHistoricalRecord(date) {
  if (!confirm(`確定要刪除 ${date} 的紀錄？`)) return;
  historicalRecords = historicalRecords.filter(r => r.date !== date);
  saveData();
  renderHistoricalRecordsList();
  renderHistoricalChart();
}

// ─── 啟動 ────────────────────────────────────────────────────────────────────
init();
