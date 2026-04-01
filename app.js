const VERSION = '2.2.1';
const IS_GITHUB_PAGES = location.hostname.endsWith('github.io');

// ─── 常數設定 ───────────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  tw_stock: '台股',
  us_stock: '美股',
  cash:     '現金',
  bond:     '債券',
  crypto:   '加密貨幣',
};

const CATEGORY_COLORS = {
  tw_stock: '#3b82f6',
  us_stock: '#22c55e',
  cash:     '#eab308',
  bond:     '#a855f7',
  crypto:   '#f97316',
};

const TARGET_CATS = ['tw_stock', 'us_stock', 'cash', 'bond', 'crypto'];
const CATEGORY_ORDER = { tw_stock: 0, us_stock: 1, bond: 2, cash: 3, crypto: 4 };

// ─── 狀態 ────────────────────────────────────────────────────────────────────
let profiles              = []; // { id, name, holdings, targetAllocations, historicalRecords }
let activeProfileId       = 'overview';
let historicalRecords     = []; // overview 用（所有人合計）
let usdRate               = 32;
let chart                 = null;
let historicalChart       = null;
let profileCharts         = {}; // { [pid]: Chart instance }
let profileHistoricalCharts = {}; // { [pid]: Chart instance }
let holdingsSortBy        = {}; // { [profileId]: 'none'|'category'|'value' }
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
  });
}

function renderAll() {
  renderTabs();
  renderOverview();
  renderProfilePanels();
  document.getElementById('usd-rate').value = usdRate;
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
    </div>`).join('')}
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
        <button class="btn-collapse" onclick="toggleCard('body-phist-${pid}')">−</button>
      </div>
      <div class="card-body" id="body-phist-${pid}">
        <div class="history-actions">
          <button class="btn btn-primary" onclick="saveProfileAssets('${pid}')">📌 記錄今日資產</button>
        </div>
        <div class="form-row" style="margin-top:12px">
          <div class="form-group">
            <label>日期</label>
            <input type="date" id="phist-date-${pid}" />
          </div>
          <div class="form-group">
            <label>資產總值 (TWD)</label>
            <input type="number" id="phist-value-${pid}" placeholder="1000000" min="0" step="any" />
          </div>
        </div>
        <button class="btn btn-secondary" onclick="addProfileHistoricalRecord('${pid}')">手動新增</button>
        <h3 style="margin-top:1.5rem">資產趨勢圖</h3>
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
      <button class="btn-collapse" onclick="toggleCard('body-target-${pid}')">−</button>
    </div>
    <div class="card-body" id="body-target-${pid}">
      <div class="target-allocation">
        <div class="target-inputs">
          ${TARGET_CATS.map(c => `
          <div class="target-row">
            <label>${CATEGORY_LABELS[c]}</label>
            <div class="target-pct-input">
              <input type="number" id="target-${c}-${pid}" min="0" max="100" step="1" placeholder="0" oninput="onTargetChange('${pid}')">
              <span>%</span>
            </div>
          </div>`).join('')}
        </div>
        <div class="target-total-bar" id="target-total-bar-${pid}">合計：<span id="target-sum-${pid}">0</span>%</div>
      </div>
      <div id="allocation-comparison-${pid}" class="allocation-comparison"></div>
    </div>
  </div>

  <!-- 持股清單 -->
  <div class="card">
    <div class="card-header">
      <h2>持股清單</h2>
      <div class="sort-controls">
        <button id="sort-category-btn-${pid}" class="btn-sort" onclick="setSort('${pid}','category')">分類</button>
        <button id="sort-value-btn-${pid}" class="btn-sort" onclick="setSort('${pid}','value')">金額</button>
      </div>
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
    TARGET_CATS.forEach(c => {
      const el = document.getElementById(`target-${c}-${p.id}`);
      if (el) el.value = p.targetAllocations[c] || '';
    });
    updateTargetTotalBar(p.id);
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
  const catTotals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
  p.holdings.forEach(h => { catTotals[h.category] = (catTotals[h.category] || 0) + getHoldingValueTWD(h); });
  const subtotal = Object.values(catTotals).reduce((a, b) => a + b, 0);

  // 小計 card
  const subtotalEl = document.getElementById(`subtotal-${pid}`);
  if (subtotalEl) subtotalEl.textContent = formatTWD(subtotal);

  // 各類別 card
  TARGET_CATS.forEach(c => {
    const el = document.getElementById(`pcat-${c}-${pid}`);
    if (el) el.textContent = formatTWD(catTotals[c]);
  });

  // 今日變化
  let dayChange = 0, hasChange = false;
  p.holdings.forEach(h => {
    if (h.currentPrice && h.previousClose && h.category !== 'cash') {
      dayChange += toTWD((h.currentPrice - h.previousClose) * h.qty, h.currency);
      hasChange = true;
    }
  });
  const changeEl = document.getElementById(`subtotal-change-${pid}`);
  if (changeEl) {
    if (hasChange) {
      const sign  = dayChange >= 0 ? '+' : '';
      const pct   = subtotal > 0 ? (dayChange / (subtotal - dayChange) * 100).toFixed(2) : '0.00';
      const color = dayChange > 0 ? '#22c55e' : dayChange < 0 ? '#ef4444' : '#94a3b8';
      changeEl.style.color = color;
      changeEl.textContent = `今日 ${sign}${pct}% (${sign}${formatTWD(dayChange)})`;
    } else {
      changeEl.textContent = '';
    }
  }

  // 目標配置
  TARGET_CATS.forEach(c => {
    const el = document.getElementById(`target-${c}-${pid}`);
    if (el) el.value = p.targetAllocations[c] || '';
  });
  updateTargetTotalBar(pid);
  renderAllocationComparison(pid);
  renderHoldings(pid);
  renderProfileChart(pid);
  renderProfileHistoricalChart(pid);
  renderProfileHistoricalRecordsList(pid);
}

// ─── Overview 渲染 ────────────────────────────────────────────────────────────
function renderOverview() {
  const allHoldings = profiles.flatMap(p => p.holdings);

  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
  allHoldings.forEach(h => {
    totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h);
  });
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  document.getElementById('total-value').textContent  = formatTWD(total);
  document.getElementById('tw-value').textContent     = formatTWD(totals.tw_stock);
  document.getElementById('us-value').textContent     = formatTWD(totals.us_stock);
  document.getElementById('cash-value').textContent   = formatTWD(totals.cash);
  document.getElementById('bond-value').textContent   = formatTWD(totals.bond);
  document.getElementById('crypto-value').textContent = formatTWD(totals.crypto);

  // 今日總變化
  let totalDayChange = 0, hasAnyChange = false;
  allHoldings.forEach(h => {
    if (h.currentPrice && h.previousClose && h.category !== 'cash') {
      totalDayChange += toTWD((h.currentPrice - h.previousClose) * h.qty, h.currency);
      hasAnyChange = true;
    }
  });
  const changeEl = document.getElementById('total-change');
  if (changeEl) {
    if (hasAnyChange) {
      const sign  = totalDayChange >= 0 ? '+' : '';
      const pct   = total > 0 ? (totalDayChange / (total - totalDayChange) * 100).toFixed(2) : '0.00';
      const color = totalDayChange > 0 ? '#22c55e' : totalDayChange < 0 ? '#ef4444' : '#94a3b8';
      changeEl.style.color = color;
      changeEl.textContent = `今日 ${sign}${pct}% (${sign}${formatTWD(totalDayChange)})`;
    } else {
      changeEl.textContent = '';
    }
  }

  renderChart();
  renderHistoricalRecordsList();
  renderHistoricalChart();
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

  if (isNaN(qty) || qty < 0) return alert('請輸入有效數量');
  if (category !== 'cash' && !symbol) return alert('請輸入代號');

  const holding = {
    id:           Date.now().toString(),
    category,
    symbol:       category === 'cash' ? '' : symbol,
    name:         name || symbol || CATEGORY_LABELS[category],
    qty,
    currency,
    manualPrice,
    currentPrice: manualPrice || null,
  };

  p.holdings.push(holding);
  saveData();
  renderProfilePanel(pid);
  renderOverview();

  // 清空表單
  e.target.reset();
  const currEl = document.getElementById(`holding-currency-${fs}`);
  if (currEl) currEl.value = 'TWD';
  onCategoryChange(fs);
  if (formSuffix) closeAddModal();

  // 若需要自動抓價，立即抓取這一筆
  if (!manualPrice && category !== 'cash') {
    fetchPriceForHolding(holding).then(() => {
      saveData();
      renderProfilePanel(pid);
      renderOverview();
    });
  }
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
  document.getElementById('edit-qty').value          = h.qty;
  document.getElementById('edit-manual-price').value = h.manualPrice || '';
  document.getElementById('edit-name').value         = h.name;

  const showManual = h.category !== 'cash';
  document.getElementById('edit-manual-price-group').style.display = showManual ? '' : 'none';

  document.getElementById('edit-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('edit-modal').style.display = 'none';
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
  const category   = document.getElementById('edit-category').value;
  const qty        = parseFloat(document.getElementById('edit-qty').value);
  const manualPrice = parseFloat(document.getElementById('edit-manual-price').value) || null;
  const name       = document.getElementById('edit-name').value.trim();

  const p = getProfile(profileId);
  if (!p) return;
  const h = p.holdings.find(x => x.id === holdingId);
  if (!h) return;

  h.category    = category;
  h.qty         = qty;
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

  if (cat === 'cash') {
    symbolGroup.style.display      = 'none';
    manualPriceGroup.style.display = 'none';
    currencyGroup.style.display    = '';
    qtyLabel.textContent           = '金額';
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
function setSort(pid, by) {
  holdingsSortBy[pid] = (holdingsSortBy[pid] === by) ? 'none' : by;
  document.getElementById(`sort-category-btn-${pid}`)?.classList.toggle('active', holdingsSortBy[pid] === 'category');
  document.getElementById(`sort-value-btn-${pid}`)?.classList.toggle('active',    holdingsSortBy[pid] === 'value');
  renderHoldings(pid);
}

function getSortedHoldings(holdings, pid) {
  const list = [...holdings];
  const sortBy = holdingsSortBy[pid] || 'none';
  if (sortBy === 'category') {
    list.sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9));
  } else if (sortBy === 'value') {
    list.sort((a, b) => getHoldingValueTWD(b) - getHoldingValueTWD(a));
  }
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
  const groups = {};
  TARGET_CATS.forEach(c => { groups[c] = []; });
  p.holdings.forEach(h => { if (groups[h.category]) groups[h.category].push(h); });

  container.innerHTML = `<div class="holdings-grid">${TARGET_CATS.map(cat => {
    const holdings = groups[cat];
    const catTotal = holdings.reduce((s, h) => s + getHoldingValueTWD(h), 0);

    const items = holdings.map(h => {
      const valueTWD = getHoldingValueTWD(h);
      let changeHtml = '';
      if (h.currentPrice && h.previousClose && cat !== 'cash') {
        const priceDiff = h.currentPrice - h.previousClose;
        const pct       = (priceDiff / h.previousClose * 100).toFixed(2);
        const sign      = priceDiff >= 0 ? '+' : '';
        const color     = priceDiff > 0 ? '#22c55e' : priceDiff < 0 ? '#ef4444' : '#94a3b8';
        changeHtml = `<div class="hblock-change" style="color:${color}">${sign}${pct}%</div>`;
      }
      const noPrice = cat !== 'cash' && !h.currentPrice;
      return `<div class="hblock-item">
        <div class="hblock-name">${escHtml(h.name)}${h.symbol && h.symbol !== h.name ? `<div class="holding-symbol">${escHtml(h.symbol)}</div>` : ''}</div>
        <div class="hblock-value">${noPrice ? '<span style="color:#475569;font-size:0.72rem">尚無價格</span>' : formatTWD(valueTWD)}</div>
        ${changeHtml}
        <div class="hblock-actions">
          <button class="btn btn-edit" onclick="openEdit('${h.id}','${pid}')">編輯</button>
          <button class="btn btn-danger" onclick="deleteHolding('${h.id}','${pid}')">刪除</button>
        </div>
      </div>`;
    }).join('');

    return `<div class="hblock">
      <div class="hblock-header">
        <span class="holding-badge badge-${cat}">${CATEGORY_LABELS[cat]}</span>
        ${catTotal > 0 ? `<span class="hblock-total">${formatTWD(catTotal)}</span>` : ''}
      </div>
      ${holdings.length === 0 ? '<div class="hblock-empty">—</div>' : `<div class="hblock-items">${items}</div>`}
    </div>`;
  }).join('')}</div>`;
}

// ─── 價格抓取 ────────────────────────────────────────────────────────────────
async function refreshAllPrices() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true; btn.classList.add('loading');

  const allHoldings    = profiles.flatMap(p => p.holdings);
  const twHoldings     = allHoldings.filter(h => !h.manualPrice && (h.category === 'tw_stock' || (h.category === 'bond' && h.currency === 'TWD')));
  const usHoldings     = allHoldings.filter(h => !h.manualPrice && (h.category === 'us_stock' || (h.category === 'bond' && h.currency !== 'TWD')));
  const cryptoHoldings = allHoldings.filter(h => !h.manualPrice && h.category === 'crypto');

  for (const h of twHoldings) await fetchTWStockPrice(h);
  await fetchUSStocksBatch(usHoldings);
  await fetchCryptoBatch(cryptoHoldings);

  saveData();
  renderAll();

  document.getElementById('last-updated').textContent = `最後更新：${new Date().toLocaleString('zh-TW')}`;
  btn.disabled = false; btn.classList.remove('loading');
}

// 新增單筆時立即抓價
async function fetchPriceForHolding(holding) {
  try {
    if (holding.category === 'crypto') {
      await fetchCryptoPrice(holding);
    } else if (holding.category === 'tw_stock' || (holding.category === 'bond' && holding.currency === 'TWD')) {
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

// 台股：Yahoo Finance → MIS 即時 → TWSE afterTrading → TPEX
async function fetchTWStockPrice(holding) {
  const symbol = holding.symbol.replace(/\.TW$/i, '').toUpperCase();

  // 策略0: Yahoo Finance（上市試 .TW，上櫃試 .TWO）
  await fetchViaYahoo(symbol + '.TW', holding, 'TWD');
  if (!holding.currentPrice) await fetchViaYahoo(symbol + '.TWO', holding, 'TWD');
  if (holding.currentPrice) return;

  if (!IS_GITHUB_PAGES) {
    for (const market of ['tse', 'otc']) {
      try {
        const res  = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${market}_${symbol.toLowerCase()}.tw&json=1&delay=0`);
        if (!res.ok) continue;
        const json = await res.json();
        const item = json?.msgArray?.[0];
        if (!item) continue;
        const price = parsePrice(item.z);
        const prev  = parsePrice(item.y);
        if (price) {
          holding.currentPrice  = price;
          holding.currency      = 'TWD';
          if (prev) holding.previousClose = prev;
          return;
        }
      } catch {}
    }
  }

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
  const urls = IS_GITHUB_PAGES
    ? [`https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`]
    : [yahooUrl, `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`];

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
  const price = h.currentPrice;
  if (!price) return 0;
  return toTWD(price * h.qty, h.currency);
}

// ─── 目標配置 ─────────────────────────────────────────────────────────────────
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
          ticks: { stepSize: 1_000_000, color: '#94a3b8', callback: v => {
            if (Math.abs(v) >= 100_000_000) return (v / 100_000_000).toFixed(0) + '億';
            if (Math.abs(v) >= 10_000_000)  return (v / 10_000_000).toFixed(0) + '千萬';
            if (Math.abs(v) >= 1_000_000)   return (v / 1_000_000).toFixed(0) + 'M';
            if (Math.abs(v) >= 10_000)       return (v / 10_000).toFixed(0) + '萬';
            return v;
          }},
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
            callback: v => {
              if (Math.abs(v) >= 100_000_000) return (v / 100_000_000).toFixed(0) + '億';
              if (Math.abs(v) >= 10_000_000)  return (v / 10_000_000).toFixed(0) + '千萬';
              if (Math.abs(v) >= 1_000_000)   return (v / 1_000_000).toFixed(0) + 'M';
              if (Math.abs(v) >= 10_000)       return (v / 10_000).toFixed(0) + '萬';
              return v;
            }
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
