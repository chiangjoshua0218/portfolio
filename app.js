const VERSION = '2.9.1';
const IS_GITHUB_PAGES = location.hostname.endsWith('github.io');

// ─── 常數設定 ───────────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  tw_stock: '台股',
  us_stock: '美股',
  cash:     '現金',
  bond:     '債券',
  crypto:   '加密貨幣',
  debt:     '負債',
};

const CATEGORY_COLORS = {
  tw_stock: '#3b82f6',
  us_stock: '#22c55e',
  cash:     '#eab308',
  bond:     '#a855f7',
  crypto:   '#f97316',
  debt:     '#ef4444',
};

const TARGET_CATS = ['tw_stock', 'us_stock', 'cash', 'bond', 'crypto'];
const CATEGORY_ORDER = { tw_stock: 0, us_stock: 1, bond: 2, cash: 3, crypto: 4, debt: 5 };

// ─── 狀態 ────────────────────────────────────────────────────────────────────
let profiles              = []; // { id, name, holdings, targetAllocations, historicalRecords }
let activeProfileId       = 'overview';
let historicalRecords     = []; // overview 用（所有人合計）
let usdRate               = 32;
let chart                 = null;
let historicalChart       = null;
let profileCharts         = {}; // { [pid]: Chart instance }
let profileHistoricalCharts = {}; // { [pid]: Chart instance }
let holdingsSortBy        = {}; // { [profileId]: 'none'|'value' }
let holdingsEditMode      = {}; // { [profileId]: boolean }
let isRefreshing          = false;
const yahooSuffixCache    = {}; // { [symbol]: '.TW'|'.TWO' } 快取已知後綴
let fileHandle            = null;
const FILE_API_SUPPORTED = 'showOpenFilePicker' in window;

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

  if (fsStatus === 'ready') {
    try {
      applyConfig(await readConfigFile(fileHandle));
    } catch (e) {
      loadFromLocalStorage();
      console.warn('讀取設定檔失敗，使用 localStorage:', e);
    }
    renderAll();
  } else if (fsStatus === 'needs-permission') {
    loadFromLocalStorage();
    showPermissionBanner();
    renderAll();
  } else if (fsStatus === 'no-file') {
    loadFromLocalStorage();
    showSetupModal();
    renderAll();
  } else {
    loadFromLocalStorage();
    renderAll();
  }
}

function applyConfig(config) {
  if (config.version === 2) {
    profiles          = config.profiles || [];
    historicalRecords = config.historicalRecords || [];
    usdRate           = config.usdRate || 32;
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
    usdRate = config.usdRate || 32;
  }
  profiles.forEach(p => {
    holdingsSortBy[p.id] = holdingsSortBy[p.id] || 'none';
    if (!p.targetAllocations)   p.targetAllocations = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
    if (!p.historicalRecords)   p.historicalRecords = [];
    if (!p.scheduledPlans)      p.scheduledPlans = [];
  });
}

function renderAll() {
  renderTabs();
  renderOverview();
  renderProfilePanels();
  document.getElementById('usd-rate').value = usdRate;
  refreshAllPrices();
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
    const config = { version: 2, usdRate, historicalRecords, profiles };
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
  const config = { version: 2, usdRate, historicalRecords, profiles };
  localStorage.setItem('portfolio_v2', JSON.stringify(config));
  if (fileHandle) {
    writeConfigFile(fileHandle, config).catch(e => console.warn('寫入設定檔失敗:', e));
  }
}

function saveSettings() {
  usdRate = parseFloat(document.getElementById('usd-rate').value) || 32;
  saveData();
  renderOverview();
  renderAllProfilePanels();
}

// ─── 匯出 / 匯入設定檔 ────────────────────────────────────────────────────────
function exportConfig() {
  const config = { version: 2, usdRate, historicalRecords, profiles };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'portfolio.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function importConfig(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const config = JSON.parse(e.target.result);
      let newProfiles = [];

      if (config.version === 2 && Array.isArray(config.profiles)) {
        newProfiles = config.profiles;
        if (usdRate === 32 && config.usdRate) usdRate = config.usdRate;
        if (historicalRecords.length === 0 && Array.isArray(config.historicalRecords)) {
          historicalRecords = config.historicalRecords;
        }
      } else {
        // v1 格式 → 以檔名作為帳戶名稱
        const name = file.name.replace(/\.json$/i, '');
        newProfiles = [{
          id:               'p' + Date.now(),
          name,
          holdings:         config.holdings || [],
          targetAllocations: config.targetAllocations || { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 },
        }];
        if (usdRate === 32 && config.usdRate) usdRate = config.usdRate;
        if (historicalRecords.length === 0 && Array.isArray(config.historicalRecords)) {
          historicalRecords = config.historicalRecords;
        }
      }

      // 避免 ID 衝突
      newProfiles.forEach(p => {
        while (!p.id || profiles.find(x => x.id === p.id)) p.id = 'p' + Date.now() + Math.floor(Math.random() * 1000);
        if (!p.targetAllocations) p.targetAllocations = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
        holdingsSortBy[p.id] = 'none';
        profiles.push(p);
      });

      saveData();
      renderAll();
      if (newProfiles.length > 0) switchTab(newProfiles[newProfiles.length - 1].id);
      alert(`已新增 ${newProfiles.length} 個帳戶`);
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
    scheduledPlans: [],
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
      <div class="chart-wrapper">
        <canvas id="profileChart-${pid}"></canvas>
      </div>
      <div id="profile-chart-legend-${pid}" class="chart-legend"></div>
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

  <!-- 定期定額 -->
  <div class="card">
    <div class="card-header">
      <h2>定期定額</h2>
      <button class="btn btn-primary" style="padding:0.25rem 0.75rem;font-size:0.8rem" onclick="openDcaModal('${pid}')">＋ 新增計畫</button>
      <button class="btn-collapse" onclick="toggleCard('body-dca-${pid}')">−</button>
    </div>
    <div class="card-body" id="body-dca-${pid}">
      <div id="dca-list-${pid}"></div>
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
  </div>`;
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
  renderProfileHistoricalChart(pid);
  renderProfileHistoricalRecordsList(pid);
  renderDcaList(pid);
}

// ─── Overview 渲染 ────────────────────────────────────────────────────────────
function renderOverview() {
  const allHoldings = profiles.flatMap(p => p.holdings);

  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0, debt: 0 };
  allHoldings.forEach(h => {
    totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h);
  });
  const total = Object.values(totals).reduce((a, b) => a + b, 0); // debt 已是負值，自動計算淨資產

  document.getElementById('total-value').textContent  = formatTWD(total);
  document.getElementById('tw-value').textContent     = formatTWD(totals.tw_stock);
  document.getElementById('us-value').textContent     = formatTWD(totals.us_stock);
  document.getElementById('cash-value').textContent   = formatTWD(totals.cash);
  document.getElementById('bond-value').textContent   = formatTWD(totals.bond);
  document.getElementById('crypto-value').textContent = formatTWD(totals.crypto);
  const debtEl = document.getElementById('debt-value');
  if (debtEl) debtEl.textContent = totals.debt < 0 ? formatTWD(totals.debt) : '—';

  // 今日各分類變化
  const catChanges   = { tw_stock: 0, us_stock: 0, bond: 0, crypto: 0 };
  const catHasChange = { tw_stock: false, us_stock: false, bond: false, crypto: false };
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

  renderProfileBreakdown();
  renderChart();
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
      <div class="pbd-profile-name">${p.name}</div>
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

  if (isNaN(qty) || qty < 0) return alert('請輸入有效數量');
  if (category !== 'cash' && category !== 'debt' && !symbol) return alert('請輸入代號');

  const holding = {
    id:           Date.now().toString(),
    category,
    symbol:       (category === 'cash' || category === 'debt') ? '' : symbol,
    name:         name || symbol || CATEGORY_LABELS[category],
    qty,
    currency,
    manualPrice,
    currentPrice: manualPrice || null,
    ...(fetchAs ? { fetchAs } : {}),
    ...(costPrice ? { costPrice } : {}),
  };

  p.holdings.push(holding);
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
      saveData();
      renderProfilePanel(profileId);
      renderOverview();
    });
  }
}

// ─── 定期定額 UI ──────────────────────────────────────────────────────────────
function renderDcaList(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const container = document.getElementById(`dca-list-${pid}`);
  if (!container) return;
  const plans = p.scheduledPlans || [];
  if (plans.length === 0) {
    container.innerHTML = '<div class="empty-state">尚無計畫</div>';
    return;
  }
  container.innerHTML = plans.map(plan => {
    const last = plan.log?.[plan.log.length - 1];
    let lastText, detailText;
    const p2 = getProfile(pid);
    const cashH2 = plan.sourceCashId ? p2?.holdings.find(h => h.id === plan.sourceCashId) : null;
    const cashLabel = cashH2 ? escHtml(cashH2.name) : plan.currency;

    if (plan.planType === 'debt_payment') {
      const debtH = p2?.holdings.find(h => h.id === plan.targetDebtId);
      const debtName = debtH ? escHtml(debtH.name) : '已刪除的負債';
      const remaining = debtH ? `${debtH.currency} ${debtH.qty.toLocaleString()}` : '—';
      detailText = `每月 ${plan.dayOfMonth} 日｜${cashLabel} ${Number(plan.amount).toLocaleString()} → ${debtName}（剩餘 ${remaining}）`;
      lastText = last ? `上次 ${last.date}：還款 ${last.currency} ${Number(last.amount).toLocaleString()}` : '尚未執行';
    } else {
      const targetH2 = plan.targetHoldingId ? p2?.holdings.find(h => h.id === plan.targetHoldingId) : null;
      const targetLabel = targetH2 ? escHtml(targetH2.name) : escHtml(plan.targetSymbol);
      detailText = `每月 ${plan.dayOfMonth} 日｜${cashLabel} ${Number(plan.amount).toLocaleString()} → ${targetLabel}`;
      lastText = last
        ? `上次 ${last.date}：+${Number(last.shares).toFixed(4)} 股 @ ${last.currency === 'USD' ? '$' : 'NT$'}${Number(last.price).toFixed(2)}`
        : '尚未執行';
    }
    return `<div class="dca-item">
      <div class="dca-info">
        <div class="dca-name">${escHtml(plan.name || plan.targetSymbol || '還款計畫')}</div>
        <div class="dca-detail">${detailText}</div>
        <div class="dca-last">${lastText}</div>
      </div>
      <div class="dca-actions">
        <button class="btn ${plan.enabled ? 'btn-primary' : 'btn-secondary'}" onclick="toggleDcaPlan('${pid}','${plan.id}')">${plan.enabled ? '啟用中' : '已停用'}</button>
        <button class="btn btn-danger" onclick="deleteDcaPlan('${pid}','${plan.id}')">刪除</button>
      </div>
    </div>`;
  }).join('');
}

function openDcaModal(pid) {
  document.getElementById('dca-modal-pid').value = pid;
  document.getElementById('dca-plan-type').value = 'invest';
  document.getElementById('dca-name').value    = '';
  document.getElementById('dca-day').value     = '5';
  document.getElementById('dca-amount').value  = '';
  document.getElementById('dca-symbol').value  = '';
  document.getElementById('dca-invest-fields').style.display = '';
  document.getElementById('dca-debt-fields').style.display   = 'none';
  document.getElementById('dca-target-holding-id').innerHTML = '<option value="">自動（第一筆相符或新增）</option>';

  const p = getProfile(pid);

  // 填入現金來源
  populateDcaCashOptions(p, 'TWD');

  // 填入負債下拉選單
  const debtSelect = document.getElementById('dca-debt-id');
  const debts = (p?.holdings || []).filter(h => h.category === 'debt');
  if (debts.length === 0) {
    debtSelect.innerHTML = '<option value="">（無負債項目）</option>';
  } else {
    debtSelect.innerHTML = debts.map(h =>
      `<option value="${h.id}">${escHtml(h.name)}（${h.currency} ${h.qty.toLocaleString()}）</option>`
    ).join('');
  }

  document.getElementById('dca-modal').style.display = 'flex';
}

function populateDcaCashOptions(p, currency) {
  const cashSelect = document.getElementById('dca-cash-id');
  const cashes = (p?.holdings || []).filter(h => h.category === 'cash' && h.currency === currency);
  if (cashes.length === 0) {
    cashSelect.innerHTML = `<option value="">（無 ${currency} 現金持股）</option>`;
  } else {
    cashSelect.innerHTML = cashes.map(h =>
      `<option value="${h.id}">${escHtml(h.name)}（${h.currency} ${h.qty.toLocaleString()}）</option>`
    ).join('');
  }
}

function onDcaCurrencyChange() {
  const pid      = document.getElementById('dca-modal-pid').value;
  const currency = document.getElementById('dca-currency').value;
  populateDcaCashOptions(getProfile(pid), currency);
}

function refreshDcaTargetHoldings() {
  const pid      = document.getElementById('dca-modal-pid').value;
  const symbol   = document.getElementById('dca-symbol').value.trim().toUpperCase();
  const category = document.getElementById('dca-category').value;
  const select   = document.getElementById('dca-target-holding-id');

  if (!symbol) { alert('請先輸入目標股票代號'); return; }

  const p = getProfile(pid);
  const matches = (p?.holdings || []).filter(h => h.symbol === symbol && h.category === category);

  if (matches.length === 0) {
    select.innerHTML = '<option value="">自動（找不到現有持股，將自動新增）</option>';
  } else {
    select.innerHTML = '<option value="">自動（第一筆相符或新增）</option>' +
      matches.map(h => `<option value="${h.id}">${escHtml(h.name)}（${h.qty.toLocaleString()} 股）</option>`).join('');
  }
}

function onDcaPlanTypeChange() {
  const type = document.getElementById('dca-plan-type').value;
  document.getElementById('dca-invest-fields').style.display = type === 'invest' ? '' : 'none';
  document.getElementById('dca-debt-fields').style.display   = type === 'debt_payment' ? '' : 'none';
}

function closeDcaModal() {
  document.getElementById('dca-modal').style.display = 'none';
}

function saveNewDcaPlan() {
  const pid      = document.getElementById('dca-modal-pid').value;
  const p        = getProfile(pid);
  if (!p) return;
  const planType = document.getElementById('dca-plan-type').value;
  const name     = document.getElementById('dca-name').value.trim();
  const day      = parseInt(document.getElementById('dca-day').value);
  const amount   = parseFloat(document.getElementById('dca-amount').value);
  const currency = document.getElementById('dca-currency').value;

  if (isNaN(amount) || amount <= 0) return alert('請輸入有效扣款金額');
  if (isNaN(day) || day < 1 || day > 28) return alert('請輸入 1~28 的日期');

  if (!p.scheduledPlans) p.scheduledPlans = [];

  const sourceCashId = document.getElementById('dca-cash-id').value || null;

  if (planType === 'debt_payment') {
    const targetDebtId = document.getElementById('dca-debt-id').value;
    if (!targetDebtId) return alert('請先新增負債項目，再建立還款計畫');
    const debtH = p.holdings.find(h => h.id === targetDebtId);
    p.scheduledPlans.push({
      id:            Date.now().toString(),
      planType:      'debt_payment',
      name:          name || `每月還 ${debtH?.name || '負債'}`,
      enabled:       true,
      dayOfMonth:    day,
      amount,
      currency,
      sourceCashId,
      targetDebtId,
      lastExecuted:  null,
      log:           [],
    });
  } else {
    const symbol          = document.getElementById('dca-symbol').value.trim().toUpperCase();
    const category        = document.getElementById('dca-category').value;
    const targetHoldingId = document.getElementById('dca-target-holding-id').value || null;
    if (!symbol) return alert('請輸入目標股票代號');
    p.scheduledPlans.push({
      id:           Date.now().toString(),
      planType:     'invest',
      name:         name || `每月買 ${symbol}`,
      enabled:      true,
      dayOfMonth:   day,
      amount,
      currency,
      sourceCashId,
      targetSymbol:   symbol,
      targetCategory: category,
      targetHoldingId,
      lastExecuted:   null,
      log:            [],
    });
  }

  saveData();
  closeDcaModal();
  renderDcaList(pid);
}

function toggleDcaPlan(pid, planId) {
  const p = getProfile(pid);
  if (!p) return;
  const plan = p.scheduledPlans?.find(x => x.id === planId);
  if (!plan) return;
  plan.enabled = !plan.enabled;
  saveData();
  renderDcaList(pid);
}

function deleteDcaPlan(pid, planId) {
  const p = getProfile(pid);
  if (!p) return;
  const plan = p.scheduledPlans?.find(x => x.id === planId);
  if (!confirm(`確定要刪除「${plan?.name || planId}」計畫？`)) return;
  p.scheduledPlans = p.scheduledPlans.filter(x => x.id !== planId);
  saveData();
  renderDcaList(pid);
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
    const qtyEl    = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="qty"]`);
    const priceEl  = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="price"]`);
    const costEl   = document.querySelector(`#holdings-list-${pid} [data-id="${h.id}"][data-field="cost"]`);
    if (nameVal) h.name = nameVal;
    if (qtyEl)   h.qty  = parseFloat(qtyEl.value) || h.qty;
    if (priceEl) {
      const mp = parseFloat(priceEl.value) || null;
      h.manualPrice = mp;
      if (mp) h.currentPrice = mp;
    }
    if (costEl) h.costPrice = parseFloat(costEl.value) || null;
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

  const showManual = h.category !== 'cash';
  document.getElementById('edit-manual-price-group').style.display = showManual ? '' : 'none';

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

  const costPrice   = parseFloat(document.getElementById('edit-cost-price').value) || null;

  h.category    = category;
  h.fetchAs     = fetchAsVal;
  h.qty         = qty;
  h.costPrice   = costPrice;
  h.name        = name || h.symbol || CATEGORY_LABELS[h.category];
  h.manualPrice = manualPrice;
  if (manualPrice) h.currentPrice = manualPrice;

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

  if (cat === 'cash' || cat === 'debt') {
    symbolGroup.style.display      = 'none';
    manualPriceGroup.style.display = 'none';
    currencyGroup.style.display    = '';
    qtyLabel.textContent           = cat === 'debt' ? '負債金額' : '金額';
    const currEl = document.getElementById(`holding-currency-${pid}`);
    if (currEl) currEl.value = 'TWD';
  } else if (cat === 'crypto') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = 'none';
    qtyLabel.textContent           = '數量（顆）';
    symbolHint.textContent         = '（如：BTC、ETH、SOL）';
  } else if (cat === 'us_stock') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = 'none';
    qtyLabel.textContent           = '數量（股）';
    symbolHint.textContent         = '（如：AAPL、TSLA、VOO）';
  } else if (cat === 'tw_stock') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = 'none';
    qtyLabel.textContent           = '數量（股）';
    symbolHint.textContent         = '（如：2330、0050、006208）';
  } else if (cat === 'bond') {
    symbolGroup.style.display      = '';
    manualPriceGroup.style.display = '';
    currencyGroup.style.display    = '';
    qtyLabel.textContent           = '數量（股/張）';
    symbolHint.textContent         = '（如：00679B、TLT）';
  }
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
        return `<div class="hblock-item hblock-item-edit">
          <button class="hblock-x-btn" onclick="deleteHoldingInEdit('${h.id}','${pid}')">×</button>
          <input class="hblock-edit-input" data-id="${h.id}" data-field="name" value="${escHtml(h.name)}" placeholder="名稱">
          <input class="hblock-edit-input" data-id="${h.id}" data-field="qty" type="number" value="${h.qty}" min="0" step="any" placeholder="數量">
          <input class="hblock-edit-input" data-id="${h.id}" data-field="price" type="number" value="${h.manualPrice || ''}" min="0" step="any" placeholder="手動單價（選填）">
          <input class="hblock-edit-input" data-id="${h.id}" data-field="cost" type="number" value="${h.costPrice || ''}" min="0" step="any" placeholder="買入均價（選填）">
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
        priceDetailHtml = `<div style="font-size:0.7rem;color:#64748b">${priceStr} × ${h.qty.toLocaleString()}</div>`;
      }
      // 損益
      let pnlHtml = '';
      const pnl = getHoldingPnL(h);
      if (pnl) {
        const sign  = pnl.pnlTWD >= 0 ? '+' : '';
        const color = pnl.pnlTWD > 0 ? '#22c55e' : pnl.pnlTWD < 0 ? '#ef4444' : '#94a3b8';
        pnlHtml = `<div class="hblock-pnl" style="color:${color}"><span class="hblock-label">報酬</span> ${sign}${pnl.pnlPct.toFixed(2)}% (${sign}${formatTWD(pnl.pnlTWD)})</div>`;
      }
      // 月線/季線乖離
      let maHtml = '';
      if (h.ma20 != null || h.ma60 != null) {
        const fmtV = v => h.currency === 'USD'
          ? `$${v.toFixed(2)}`
          : `NT$${Math.round(v).toLocaleString()}`;
        const biasPart = (bias) => {
          if (bias == null) return '';
          const s = bias >= 0 ? '+' : '';
          const c = Math.abs(bias) > 5
            ? (bias > 0 ? '#f59e0b' : '#38bdf8')
            : (bias >= 0 ? '#94a3b8' : '#94a3b8');
          return ` <span style="color:${c}">${s}${bias.toFixed(1)}%</span>`;
        };
        const parts = [];
        if (h.ma20 != null) parts.push(`<span class="hblock-label">月線</span> ${fmtV(h.ma20)}${biasPart(h.bias20)}`);
        if (h.ma60 != null) parts.push(`<span class="hblock-label">季線</span> ${fmtV(h.ma60)}${biasPart(h.bias60)}`);
        maHtml = `<div class="hblock-ma">${parts.join('<br>')}</div>`;
      }
      const displayValue = cat === 'debt'
        ? `<span style="color:#f87171">${formatTWD(valueTWD)}</span>` // 負值（如 -500,000）
        : noPrice ? '<span style="color:#475569;font-size:0.72rem">尚無價格</span>' : formatTWD(valueTWD);
      return `<div class="hblock-item">
        <div class="hblock-name">${escHtml(h.name)}${h.symbol && h.symbol !== h.name ? `<div class="holding-symbol">${escHtml(h.symbol)}</div>` : ''}</div>
        <div class="hblock-value">${displayValue}</div>
        ${priceDetailHtml}
        ${changeHtml}
        ${pnlHtml}
        ${maHtml}
      </div>`;
    }).join('');

    return `<div class="hblock">
      <div class="hblock-header">
        <span class="holding-badge badge-${cat}">${CATEGORY_LABELS[cat]}</span>
        ${catTotal > 0 ? `<span class="hblock-total">${formatTWD(catTotal)}</span>` : cat === 'debt' && catTotal < 0 ? `<span class="hblock-total" style="color:#f87171">${formatTWD(catTotal)}</span>` : ''}
        ${catPnlHtml}
      </div>
      ${holdings.length === 0 ? '<div class="hblock-empty">—</div>' : `<div class="hblock-items">${items}</div>`}
    </div>`;
  }).join('')}</div>`;
}

// ─── 價格抓取 ────────────────────────────────────────────────────────────────
function getEffectiveFetchCat(h) {
  return h.fetchAs || (h.category === 'bond' ? (h.currency === 'TWD' ? 'tw_stock' : 'us_stock') : h.category);
}

async function refreshAllPrices() {
  if (isRefreshing) return;
  isRefreshing = true;

  const allHoldings    = profiles.flatMap(p => p.holdings);
  const twHoldings     = allHoldings.filter(h => !h.manualPrice && getEffectiveFetchCat(h) === 'tw_stock');
  const usHoldings     = allHoldings.filter(h => !h.manualPrice && getEffectiveFetchCat(h) === 'us_stock');
  const cryptoHoldings = allHoldings.filter(h => !h.manualPrice && getEffectiveFetchCat(h) === 'crypto');

  for (const h of twHoldings) await fetchTWStockPrice(h);
  await fetchUSStocksBatch(usHoldings);
  await fetchCryptoBatch(cryptoHoldings);

  saveData();
  renderAll();

  document.getElementById('last-updated').textContent = `最後更新：${new Date().toLocaleString('zh-TW')}`;
  isRefreshing = false;
  checkAndExecuteScheduledPlans();
  refreshAllTechnicals(); // 非阻塞，背景計算技術指標
}

// ─── 定期定額執行 ─────────────────────────────────────────────────────────────
async function checkAndExecuteScheduledPlans() {
  const today    = new Date();
  const yy       = today.getFullYear();
  const mm       = String(today.getMonth() + 1).padStart(2, '0');
  const currentYM  = `${yy}-${mm}`;
  const todayDay   = today.getDate();
  const todayStr   = today.toISOString().split('T')[0];

  // 6 個月前的日期（用於清除舊 log）
  const cutoffDate = new Date(today);
  cutoffDate.setMonth(cutoffDate.getMonth() - 6);
  const cutoff = cutoffDate.toISOString().split('T')[0];

  const results = [];

  for (const profile of profiles) {
    for (const plan of (profile.scheduledPlans || [])) {
      if (!plan.enabled) continue;
      if (plan.lastExecuted === currentYM) continue;
      if (todayDay < plan.dayOfMonth) continue;

      // 找現金（優先用指定來源，否則找第一筆幣別相符的）
      const cashH = plan.sourceCashId
        ? profile.holdings.find(h => h.id === plan.sourceCashId)
        : profile.holdings.find(h => h.category === 'cash' && h.currency === plan.currency);
      if (!cashH || cashH.qty < plan.amount) {
        results.push({ name: plan.name || plan.targetSymbol || plan.name, ok: false, reason: `${profile.name} 現金不足（需 ${plan.currency} ${plan.amount.toLocaleString()}）` });
        continue;
      }

      // 還款計畫
      if (plan.planType === 'debt_payment') {
        const debtH = profile.holdings.find(h => h.id === plan.targetDebtId);
        if (!debtH) {
          results.push({ name: plan.name, ok: false, reason: `找不到對應的負債項目` });
          continue;
        }
        cashH.qty -= plan.amount;
        const payInDebtCurrency = plan.currency === debtH.currency
          ? plan.amount
          : plan.currency === 'USD' ? plan.amount * usdRate : plan.amount / usdRate;
        debtH.qty = Math.max(0, debtH.qty - payInDebtCurrency);
        plan.lastExecuted = currentYM;
        if (!plan.log) plan.log = [];
        plan.log.push({ date: todayStr, amount: plan.amount, currency: plan.currency });
        plan.log = plan.log.filter(l => l.date >= cutoff);
        results.push({ name: plan.name, profile: profile.name, ok: true, debtPayment: true, amount: plan.amount, currency: plan.currency, debtName: debtH.name, remaining: debtH.qty });
        continue;
      }

      // 取得目標股票價格（優先用指定持股，否則找第一筆相符的）
      let targetH = plan.targetHoldingId
        ? profile.holdings.find(h => h.id === plan.targetHoldingId)
        : profile.holdings.find(h => h.symbol === plan.targetSymbol && h.category === plan.targetCategory);
      let price = targetH?.currentPrice;
      let holdingCurrency = targetH?.currency;

      if (!price) {
        const temp = { symbol: plan.targetSymbol, category: plan.targetCategory, currency: plan.targetCurrency || (plan.currency === 'TWD' ? 'TWD' : 'USD'), qty: 0 };
        await fetchPriceForHolding(temp);
        price = temp.currentPrice;
        holdingCurrency = temp.currency;
      }

      if (!price) {
        results.push({ name: plan.name || plan.targetSymbol, ok: false, reason: `無法取得 ${plan.targetSymbol} 股價` });
        continue;
      }

      // 換算：扣款金額轉成持股幣別的單價
      const amountInHoldingCurrency = plan.currency === holdingCurrency
        ? plan.amount
        : plan.currency === 'USD' ? plan.amount * usdRate : plan.amount / usdRate;
      const shares = amountInHoldingCurrency / price;

      // 執行扣款
      cashH.qty -= plan.amount;

      // 加股數
      if (targetH) {
        targetH.qty += shares;
      } else {
        profile.holdings.push({
          id: Date.now().toString() + Math.random().toString(36).slice(2),
          category: plan.targetCategory,
          symbol: plan.targetSymbol,
          name: plan.targetSymbol,
          qty: shares,
          currency: holdingCurrency || (plan.currency === 'TWD' ? 'TWD' : 'USD'),
          manualPrice: null,
          currentPrice: price,
        });
      }

      // 更新計畫狀態
      plan.lastExecuted = currentYM;
      if (!plan.log) plan.log = [];
      plan.log.push({ date: todayStr, amount: plan.amount, currency: plan.currency, price, shares });
      plan.log = plan.log.filter(l => l.date >= cutoff);

      results.push({ name: plan.name || plan.targetSymbol, profile: profile.name, ok: true, shares: shares.toFixed(4), price, currency: plan.currency, amount: plan.amount });
    }
  }

  if (results.length > 0) {
    saveData();
    renderAll();
    const msg = results.map(r => {
      if (!r.ok) return `❌ ${r.name}：${r.reason}`;
      if (r.debtPayment) return `✅ ${r.profile}｜${r.name}：還款 ${r.currency} ${r.amount.toLocaleString()} → ${r.debtName}（剩餘 ${r.currency} ${r.remaining.toLocaleString()}）`;
      return `✅ ${r.profile}｜${r.name}：買入 ${r.shares} 股 @ ${r.currency === 'USD' ? '$' : 'NT$'}${r.price.toFixed(2)}，扣款 ${r.currency} ${r.amount.toLocaleString()}`;
    }).join('\n');
    alert('📅 定期計畫執行結果\n\n' + msg);
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

// 台股：Cloudflare Worker（MIS 即時）→ Yahoo Finance → TWSE afterTrading
async function fetchTWStockPrice(holding) {
  const symbol = holding.symbol.replace(/\.TW$/i, '').replace(/\.TWO$/i, '').toUpperCase();

  // 策略0: Cloudflare Worker → MIS 即時 API（最準確）
  const knownSuffix = yahooSuffixCache[symbol];
  const marketHint  = knownSuffix === '.TWO' ? 'otc' : knownSuffix === '.TW' ? 'tse' : '';
  const workerUrl   = `${CF_WORKER_URL}/?symbol=${symbol}${marketHint ? `&market=${marketHint}` : ''}`;
  try {
    const res = await fetch(workerUrl);
    if (res.ok) {
      const data  = await res.json();
      const item  = data?.msgArray?.[0];
      const price = parsePrice(item?.z);
      const prev  = parsePrice(item?.y);
      if (price) {
        holding.currentPrice  = price;
        holding.currency      = 'TWD';
        if (prev) holding.previousClose = prev;
        yahooSuffixCache[symbol] = data._market === 'otc' ? '.TWO' : '.TW';
        return;
      }
    }
  } catch {}

  // 策略1: Yahoo Finance via proxy（備援，開盤前/後用昨收）
  if (knownSuffix) {
    await fetchViaYahoo(symbol + knownSuffix, holding, 'TWD');
  } else {
    await fetchViaYahoo(symbol + '.TW', holding, 'TWD');
    if (holding.currentPrice) { yahooSuffixCache[symbol] = '.TW'; }
    else {
      await fetchViaYahoo(symbol + '.TWO', holding, 'TWD');
      if (holding.currentPrice) yahooSuffixCache[symbol] = '.TWO';
    }
  }
  if (holding.currentPrice) return;

  try {
    const res  = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=${symbol}&response=json`);
    if (res.ok) {
      const json = await res.json();
      if (json.stat === 'OK' && Array.isArray(json.data) && json.data.length > 0) {
        const last   = json.data[json.data.length - 1];
        const price  = parsePrice(last[6]);
        const change = parseFloat((last[7] || '').replace(/,/g, '') || '0');
        if (price) {
          holding.currentPrice = price;
          holding.currency     = 'TWD';
          if (!isNaN(change)) {
            const prev = price - change;
            if (prev > 0) holding.previousClose = prev;
          }
          return;
        }
      }
    }
  } catch {}

  if (!IS_GITHUB_PAGES) {
    try {
      const res  = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');
      if (res.ok) {
        const data  = await res.json();
        const row   = data.find(d => d.SecuritiesCompanyCode === symbol);
        const price = row ? parsePrice(row.Close) : null;
        if (price) {
          holding.currentPrice = price;
          holding.currency     = 'TWD';
          const change = parseFloat((row.Change || '').replace(/,/g, '') || '0');
          if (!isNaN(change)) {
            const prev = price - change;
            if (prev > 0) holding.previousClose = prev;
          }
          return;
        }
      }
    } catch {}
  }
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

// Yahoo Finance chart API
async function fetchViaYahoo(symbol, holding, currency) {
  if (/^\d/.test(symbol) && !symbol.endsWith('.TW') && !symbol.endsWith('.TWO')) symbol = symbol + '.TW';
  const encoded   = encodeURIComponent(symbol);
  const yahooUrl  = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`;
  const isTW = symbol.endsWith('.TW') || symbol.endsWith('.TWO');

  // 所有股票優先走 CF Worker（server-side，無 CORS / cookie 問題）
  const urls = [];
  urls.push(`${CF_WORKER_URL}/?symbol=${encoded}&market=us`);
  if (IS_GITHUB_PAGES) {
    urls.push(`https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`);
    urls.push(`https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`);
  } else {
    urls.push(yahooUrl, `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`);
  }

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      let data;
      try { const w = JSON.parse(text); data = w.contents ? JSON.parse(w.contents) : w; }
      catch { continue; }
      const meta  = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice ?? meta?.chartPreviousClose;
      if (price) {
        holding.currentPrice = price;
        holding.currency     = currency;
        const prev = meta?.chartPreviousClose ?? meta?.previousClose;
        if (prev) holding.previousClose = prev;
        return;
      }
    } catch {}
  }
}

// ─── 技術指標（MA20/MA60/乖離率）────────────────────────────────────────────
function calcMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function fetchHistoryViaYahoo(symbol) {
  const encoded  = encodeURIComponent(symbol);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=4mo`;
  const urls = IS_GITHUB_PAGES
    ? [
        `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`,
      ]
    : [yahooUrl];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      let data;
      try { const w = JSON.parse(text); data = w.contents ? JSON.parse(w.contents) : w; }
      catch { continue; }
      const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
      if (closes?.length) return closes.filter(v => v != null);
    } catch {}
  }
  return null;
}

async function fetchTechnicalsForHolding(h) {
  const fetchCat = getEffectiveFetchCat(h);
  if (fetchCat === 'crypto' || h.category === 'cash') return;
  if (!h.currentPrice) return;

  let symbol = h.symbol;
  if (fetchCat === 'tw_stock') {
    symbol = symbol + (yahooSuffixCache[symbol] || '.TW');
  }

  const closes = await fetchHistoryViaYahoo(symbol);
  if (!closes || closes.length < 5) return;

  const ma20 = calcMA(closes, 20);
  const ma60 = calcMA(closes, 60);
  h.ma20   = ma20;
  h.ma60   = ma60;
  h.bias20 = (ma20 && h.currentPrice) ? (h.currentPrice - ma20) / ma20 * 100 : null;
  h.bias60 = (ma60 && h.currentPrice) ? (h.currentPrice - ma60) / ma60 * 100 : null;
}

async function refreshAllTechnicals() {
  const techHoldings = profiles.flatMap(p => p.holdings).filter(h =>
    !h.manualPrice && h.category !== 'cash' && getEffectiveFetchCat(h) !== 'crypto'
  );
  for (const h of techHoldings) await fetchTechnicalsForHolding(h);
  // 只更新顯示，不呼叫 renderAll()（避免觸發 refreshAllPrices 造成無限迴圈）
  renderOverview();
  renderProfilePanels();
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
  return map[symbol.toUpperCase()] || symbol.toLowerCase().replace(/\s+/g, '-');
}

// 自動取得匯率
async function fetchExchangeRate() {
  try {
    const url  = 'https://api.exchangerate-api.com/v4/latest/USD';
    const res  = await fetch(url);
    const json = await res.json();
    const rate = json?.rates?.TWD;
    if (rate) {
      usdRate = parseFloat(rate.toFixed(2));
      document.getElementById('usd-rate').value = usdRate;
      saveSettings();
      alert(`匯率已更新：1 USD = ${usdRate} TWD`);
    }
  } catch {
    alert('無法自動取得匯率，請手動輸入');
  }
}

// ─── 價值換算 ─────────────────────────────────────────────────────────────────
function toTWD(price, currency) {
  if (!price) return 0;
  return currency === 'USD' ? price * usdRate : price;
}

function getHoldingValueTWD(h) {
  if (h.category === 'cash') {
    return toTWD(h.qty, h.currency);
  }
  if (h.category === 'debt') {
    return -toTWD(h.qty, h.currency); // 負債為負值，減少淨資產
  }
  const price = h.currentPrice;
  if (!price) return 0;
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

  container.innerHTML = `<div class="tcard-grid">${cards}</div>${sumHtml}`;
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

function updateTargetTotalBar(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const sum = TARGET_CATS.reduce((s, c) => s + (p.targetAllocations[c] || 0), 0);
  const sumEl = document.getElementById(`target-sum-${pid}`);
  const barEl = document.getElementById(`target-total-bar-${pid}`);
  if (sumEl) sumEl.textContent = sum;
  if (barEl) barEl.className = 'target-total-bar' + (sum === 100 ? ' perfect' : sum > 100 ? ' over' : '');
}

function onTargetChange(pid) {
  const p = getProfile(pid);
  if (!p) return;
  TARGET_CATS.forEach(c => {
    p.targetAllocations[c] = parseFloat(document.getElementById(`target-${c}-${pid}`)?.value) || 0;
  });
  updateTargetTotalBar(pid);
  saveData();
  renderAllocationComparison(pid);
}

function renderAllocationComparison(pid) {
  const container = document.getElementById(`allocation-comparison-${pid}`);
  if (!container) return;
  const p = getProfile(pid);
  if (!p) return;

  const totals = Object.fromEntries(TARGET_CATS.map(c => [c, 0]));
  p.holdings.forEach(h => { totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h); });
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const targetSum  = TARGET_CATS.reduce((s, c) => s + (p.targetAllocations[c] || 0), 0);

  if (grandTotal === 0 || targetSum === 0) { container.innerHTML = ''; return; }

  const cats = TARGET_CATS.filter(c => totals[c] > 0 || (p.targetAllocations[c] || 0) > 0);
  if (!cats.length) { container.innerHTML = ''; return; }

  const header = `<div class="comparison-row comparison-header">
    <span>類別</span><span style="text-align:right">目前%</span><span>目標</span><span style="text-align:right">調整</span>
  </div>`;

  const rows = cats.map(c => {
    const cur    = totals[c];
    const curPct = grandTotal > 0 ? cur / grandTotal * 100 : 0;
    const tgtPct = p.targetAllocations[c] || 0;
    const diff   = grandTotal * tgtPct / 100 - cur;
    let adjHtml;
    if (Math.abs(diff) < 100) {
      adjHtml = `<span class="comparison-adjust zero">±0</span>`;
    } else if (diff > 0) {
      adjHtml = `<span class="comparison-adjust buy">+${formatTWD(diff)}</span>`;
    } else {
      adjHtml = `<span class="comparison-adjust sell">-${formatTWD(Math.abs(diff))}</span>`;
    }
    return `<div class="comparison-row">
      <span>${CATEGORY_LABELS[c]}</span>
      <span style="text-align:right;color:#94a3b8">${curPct.toFixed(1)}%</span>
      <span style="text-align:right;color:#94a3b8">${tgtPct}%</span>
      ${adjHtml}
    </div>`;
  }).join('');

  container.innerHTML = header + rows;
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
        borderColor:     '#1e2330',
        borderWidth:     3,
        hoverOffset:     8,
      }]
    },
    options: {
      responsive: true,
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
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

// ─── Per-profile 圓餅圖 ───────────────────────────────────────────────────────
function renderProfileChart(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const canvas = document.getElementById(`profileChart-${pid}`);
  if (!canvas) return;

  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
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
      datasets: [{ data: entries.map(([, v]) => v), backgroundColor: entries.map(([k]) => CATEGORY_COLORS[k]), borderColor: '#1e2330', borderWidth: 3, hoverOffset: 8 }]
    },
    options: {
      responsive: true, cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${formatTWD(ctx.raw)} (${total > 0 ? (ctx.raw / total * 100).toFixed(1) : 0}%)` } }
      }
    }
  });

  document.getElementById(`profile-chart-legend-${pid}`).innerHTML = entries.map(([k, v]) => `
    <div class="legend-item">
      <div class="legend-left"><div class="legend-dot" style="background:${CATEGORY_COLORS[k]}"></div><span>${CATEGORY_LABELS[k]}</span></div>
      <span class="legend-pct">${total > 0 ? (v / total * 100).toFixed(1) : '0.0'}%</span>
    </div>`).join('');
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
  saveData();
  renderProfileHistoricalRecordsList(pid);
  renderProfileHistoricalChart(pid);
}

function addProfileHistoricalRecord(pid) {
  const p = getProfile(pid);
  if (!p) return;
  const dateVal = document.getElementById(`phist-date-${pid}`).value;
  const value   = parseFloat(document.getElementById(`phist-value-${pid}`).value);
  if (!dateVal || isNaN(value) || value < 0) { alert('請輸入有效的日期和資產總值'); return; }
  const existing = p.historicalRecords.findIndex(r => r.date === dateVal);
  if (existing >= 0) {
    if (!confirm(`${dateVal} 已有紀錄，是否覆蓋？`)) return;
    p.historicalRecords[existing].value = value;
  } else {
    p.historicalRecords.push({ date: dateVal, value });
  }
  p.historicalRecords.sort((a, b) => a.date.localeCompare(b.date));
  document.getElementById(`phist-date-${pid}`).value  = '';
  document.getElementById(`phist-value-${pid}`).value = '';
  saveData();
  renderProfileHistoricalRecordsList(pid);
  renderProfileHistoricalChart(pid);
}

function deleteProfileHistoricalRecord(pid, date) {
  const p = getProfile(pid);
  if (!p) return;
  if (!confirm(`確定要刪除 ${date} 的紀錄？`)) return;
  p.historicalRecords = p.historicalRecords.filter(r => r.date !== date);
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
          grid: { color: '#2d3748' }
        },
        y: {
          beginAtZero: false,
          ticks: { stepSize: 10_000_000, color: '#94a3b8', callback: v => (v / 1_000_000).toFixed(1) + 'M' },
          grid: { color: '#2d3748' }
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

function addHistoricalRecord() {
  const dateVal = document.getElementById('historical-date').value;
  const value   = parseFloat(document.getElementById('historical-value').value);

  if (!dateVal || isNaN(value) || value < 0) {
    alert('請輸入有效的日期和資產總值');
    return;
  }

  const existing = historicalRecords.findIndex(r => r.date === dateVal);
  if (existing >= 0) {
    if (!confirm(`${dateVal} 已有紀錄，是否覆蓋？`)) return;
    historicalRecords[existing].value = value;
  } else {
    historicalRecords.push({ date: dateVal, value });
  }

  historicalRecords.sort((a, b) => a.date.localeCompare(b.date));
  document.getElementById('historical-date').value  = '';
  document.getElementById('historical-value').value = '';

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
          grid: { color: '#2d3748' }
        },
        y: {
          beginAtZero: false,
          ticks: {
            stepSize: 10_000_000,
            color: '#94a3b8',
            callback: v => (v / 1_000_000).toFixed(1) + 'M'
          },
          grid: { color: '#2d3748' }
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

function updateGrowthRates() {} // 已合併至 renderHistoricalRecordsList

function deleteHistoricalRecord(date) {
  if (!confirm(`確定要刪除 ${date} 的紀錄？`)) return;
  historicalRecords = historicalRecords.filter(r => r.date !== date);
  saveData();
  renderHistoricalRecordsList();
  renderHistoricalChart();
}

// ─── 啟動 ────────────────────────────────────────────────────────────────────
init();
