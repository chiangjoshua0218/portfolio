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

// ─── 狀態 ────────────────────────────────────────────────────────────────────
let holdings          = [];
let historicalRecords = [];
let holdingsSortBy    = 'none'; // 'none' | 'category' | 'value'
let usdRate           = 32;
let targetAllocations = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
let chart             = null;
let historicalChart   = null;
let fileHandle        = null;
const FILE_API_SUPPORTED = 'showOpenFilePicker' in window;

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

// 啟動時檢查 IndexedDB 內是否有已存的 file handle
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
    // File System API 不支援 → 舊版 import/export 模式
    loadFromLocalStorage();
    renderAll();
  }
}

function applyConfig(config) {
  if (Array.isArray(config.holdings)) holdings = config.holdings;
  if (config.usdRate) usdRate = config.usdRate;
  if (config.targetAllocations) targetAllocations = { ...targetAllocations, ...config.targetAllocations };
  if (Array.isArray(config.historicalRecords)) historicalRecords = config.historicalRecords;
  document.getElementById('usd-rate').value = usdRate;
}

function renderAll() {
  renderHoldings();
  updateSummary();
  renderCharts();
  // 填入目標配置輸入框
  const cats = ['tw_stock', 'us_stock', 'cash', 'bond', 'crypto'];
  cats.forEach(c => {
    const el = document.getElementById(`target-${c}`);
    if (el) el.value = targetAllocations[c] || '';
  });
  updateTargetTotalBar();
  renderAllocationComparison();
  renderHistoricalRecordsList();
  renderHistoricalChart();
  updateGrowthRates();
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
    await writeConfigFile(handle, { usdRate, holdings });
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
function showSetupModal()     { document.getElementById('setup-modal').style.display      = 'flex'; }
function hideSetupModal()     { document.getElementById('setup-modal').style.display      = 'none'; }
function showPermissionBanner(){ document.getElementById('permission-banner').style.display = 'flex'; }
function hidePermissionBanner(){ document.getElementById('permission-banner').style.display = 'none'; }

// ─── localStorage（備用 / 舊版）──────────────────────────────────────────────
function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem('portfolio_holdings');
    if (raw) holdings = JSON.parse(raw);
  } catch {}
  const rate = localStorage.getItem('portfolio_usd_rate');
  if (rate) usdRate = parseFloat(rate);
  try {
    const targets = localStorage.getItem('portfolio_targets');
    if (targets) targetAllocations = { ...targetAllocations, ...JSON.parse(targets) };
  } catch {}
  try {
    const history = localStorage.getItem('portfolio_historical_records');
    if (history) historicalRecords = JSON.parse(history);
  } catch {}
}

function saveData() {
  localStorage.setItem('portfolio_holdings', JSON.stringify(holdings));
  localStorage.setItem('portfolio_usd_rate', usdRate.toString());
  localStorage.setItem('portfolio_targets', JSON.stringify(targetAllocations));
  localStorage.setItem('portfolio_historical_records', JSON.stringify(historicalRecords));
  if (fileHandle) {
    writeConfigFile(fileHandle, { usdRate, holdings, targetAllocations, historicalRecords }).catch(e =>
      console.warn('寫入設定檔失敗:', e)
    );
  }
}

function saveSettings() {
  usdRate = parseFloat(document.getElementById('usd-rate').value) || 32;
  saveData();
  updateSummary();
  renderCharts();
}

// ─── 匯出 / 匯入設定檔（手動備份）────────────────────────────────────────────
function exportConfig() {
  const config = { usdRate, holdings, targetAllocations, historicalRecords };
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
      applyConfig(config);
      saveData();
      renderAll();
      alert(`已載入 ${holdings.length} 筆資產`);
    } catch {
      alert('設定檔格式錯誤，請確認是正確的 portfolio.json');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ─── 新增持股 ────────────────────────────────────────────────────────────────
function addHolding(e) {
  e.preventDefault();
  const category    = document.getElementById('holding-category').value;
  const symbol      = document.getElementById('holding-symbol').value.trim().toUpperCase();
  const qty         = parseFloat(document.getElementById('holding-qty').value);
  const name        = document.getElementById('holding-name').value.trim();
  const currency    = document.getElementById('holding-currency').value;
  const manualPrice = parseFloat(document.getElementById('holding-manual-price').value) || null;

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

  holdings.push(holding);
  saveData();
  renderHoldings();
  updateSummary();
  renderCharts();

  // 清空表單
  e.target.reset();
  document.getElementById('holding-currency').value = 'TWD';
  onCategoryChange();

  // 若需要自動抓價，立即抓取這一筆
  if (!manualPrice && category !== 'cash') {
    fetchPriceForHolding(holding).then(() => {
      saveData();
      renderHoldings();
      updateSummary();
      renderChart();
    });
  }
}

// ─── 刪除持股 ────────────────────────────────────────────────────────────────
function deleteHolding(id) {
  if (!confirm('確定要刪除這筆資產？')) return;
  holdings = holdings.filter(h => h.id !== id);
  saveData();
  renderHoldings();
  updateSummary();
  renderCharts();
}

// ─── 編輯 Modal ──────────────────────────────────────────────────────────────
function openEdit(id) {
  const h = holdings.find(x => x.id === id);
  if (!h) return;
  document.getElementById('edit-id').value           = id;
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

function saveEdit() {
  const id          = document.getElementById('edit-id').value;
  const category    = document.getElementById('edit-category').value;
  const qty         = parseFloat(document.getElementById('edit-qty').value);
  const manualPrice = parseFloat(document.getElementById('edit-manual-price').value) || null;
  const name        = document.getElementById('edit-name').value.trim();

  const h = holdings.find(x => x.id === id);
  if (!h) return;
  h.category    = category;
  h.qty         = qty;
  h.name        = name || h.symbol || CATEGORY_LABELS[h.category];
  h.manualPrice = manualPrice;
  if (manualPrice) h.currentPrice = manualPrice;

  saveData();
  renderHoldings();
  updateSummary();
  renderCharts();
  closeModal();
}

// ─── 表單 UI 互動 ────────────────────────────────────────────────────────────
function onCategoryChange() {
  const cat = document.getElementById('holding-category').value;
  const symbolGroup      = document.getElementById('symbol-group');
  const manualPriceGroup = document.getElementById('manual-price-group');
  const currencyGroup    = document.getElementById('currency-group');
  const qtyLabel         = document.getElementById('qty-label');
  const symbolHint       = document.getElementById('symbol-hint');

  if (cat === 'cash') {
    symbolGroup.style.display      = 'none';
    manualPriceGroup.style.display = 'none';
    currencyGroup.style.display    = '';
    qtyLabel.textContent           = '金額';
    document.getElementById('holding-currency').value = 'TWD';
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

// ─── 價格抓取 ────────────────────────────────────────────────────────────────
async function refreshAllPrices() {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.classList.add('loading');

  // 依類別分組，減少 proxy 呼叫次數
  const twHoldings = holdings.filter(h =>
    !h.manualPrice && (h.category === 'tw_stock' || (h.category === 'bond' && h.currency === 'TWD'))
  );
  const usHoldings = holdings.filter(h =>
    !h.manualPrice && (h.category === 'us_stock' || (h.category === 'bond' && h.currency !== 'TWD'))
  );
  const cryptoHoldings = holdings.filter(h => !h.manualPrice && h.category === 'crypto');

  // 台股：逐一 TWSE（直接存取，不需 proxy）
  for (const h of twHoldings) await fetchTWStockPrice(h);

  // 美股/USD債：一次批次請求
  await fetchUSStocksBatch(usHoldings);

  // 加密貨幣：一次批次請求
  await fetchCryptoBatch(cryptoHoldings);

  saveData();
  renderHoldings();
  updateSummary();
  renderCharts();

  const now = new Date().toLocaleString('zh-TW');
  document.getElementById('last-updated').textContent = `最後更新：${now}`;

  btn.disabled = false;
  btn.classList.remove('loading');
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

// 解析價格字串，回傳有效正數或 null（處理 TWSE 的 "-" 等無效值）
function parsePrice(val) {
  const n = parseFloat(val);
  return (isFinite(n) && n > 0) ? n : null;
}

// 台股：優先用 TWSE / TPEX Open API（公開 API，有正確 CORS header）
async function fetchTWStockPrice(holding) {
  const symbol = holding.symbol.replace(/\.TW$/i, '').toUpperCase();

  // 1. TWSE Open API（上市）
  try {
    const res  = await fetch(`https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY?stockNo=${symbol}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const last  = data[data.length - 1];
        const price = parsePrice(last.ClosingPrice);
        if (price) {
          holding.currentPrice  = price;
          holding.currency      = 'TWD';
          // Change 欄位格式："+5.00" / "-3.50" / "0.00"
          const prev = price - parseFloat(last.Change || 0);
          if (prev > 0) holding.previousClose = prev;
          return;
        }
      }
    }
  } catch {}

  // 2. TPEX Open API（上櫃）
  try {
    const res  = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');
    if (res.ok) {
      const data = await res.json();
      const row  = data.find(d => d.SecuritiesCompanyCode === symbol);
      const price = row ? parsePrice(row.Close) : null;
      if (price) {
        holding.currentPrice = price;
        holding.currency     = 'TWD';
        const prev = price - parseFloat(row.Change || 0);
        if (prev > 0) holding.previousClose = prev;
        return;
      }
    }
  } catch {}

  // 3. Fallback：TWSE mis 即時 API（需要非 null origin）
  for (const market of ['tse', 'otc']) {
    try {
      const res  = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${market}_${symbol.toLowerCase()}.tw&json=1&delay=0`);
      const json = await res.json();
      const item = json?.msgArray?.[0];
      if (!item) continue;
      const price = parsePrice(item.z) ?? parsePrice(item.y) ?? parsePrice(item.b) ?? parsePrice(item.a);
      if (price) {
        holding.currentPrice  = price;
        holding.currency      = 'TWD';
        const prev = parsePrice(item.y);
        if (prev) holding.previousClose = prev;
        return;
      }
    } catch {}
  }

  // 4. 最後：Yahoo Finance proxy
  await fetchViaYahoo(`${symbol}.TW`, holding, 'TWD');
}

// 美股逐一抓取（v7 已失效，直接用 v8 chart API）
async function fetchUSStocksBatch(usHoldings) {
  if (!usHoldings.length) return;
  for (const h of usHoldings) {
    // 數字開頭 = 台股格式（如 00757），補 .TW 用台股路徑抓
    if (/^\d/.test(h.symbol)) {
      await fetchTWStockPrice(h);
    } else {
      await fetchViaYahoo(h.symbol, h, 'USD');
    }
  }
}

// Yahoo Finance chart API（單一股票 fallback 用）
async function fetchViaYahoo(symbol, holding, currency) {
  // 數字開頭的代號補 .TW（台股被手動歸類為其他類別時）
  if (/^\d/.test(symbol) && !symbol.endsWith('.TW')) symbol = symbol + '.TW';
  const encoded  = encodeURIComponent(symbol);
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`;
  const proxies  = [
    yahooUrl,  // 直連
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`,
    `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(yahooUrl)}`,
    `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`,
  ];
  for (const proxyUrl of proxies) {
    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) continue;
      const text = await res.text();
      let data;
      try { const w = JSON.parse(text); data = w.contents ? JSON.parse(w.contents) : w; }
      catch { continue; }
      const meta  = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice ?? meta?.previousClose;
      if (price) {
        holding.currentPrice = price;
        holding.currency     = currency;
        const prev = meta?.regularMarketPreviousClose ?? meta?.previousClose;
        if (prev && prev !== price) holding.previousClose = prev;
        return;
      }
    } catch {}
  }
}

// 加密貨幣批次：CoinGecko（一次請求取全部）
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

// CoinGecko 單一（新增持股時用）
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

// 自動取得匯率（Open Exchange Rates 免費端點）
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

// ─── 價值換算（統一換成 TWD）────────────────────────────────────────────────
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

// ─── 渲染：持股清單 ──────────────────────────────────────────────────────────
function renderHoldings() {
  const container = document.getElementById('holdings-list');
  if (holdings.length === 0) {
    container.innerHTML = '<div class="empty-state">尚無持股，請新增資產</div>';
    return;
  }

  container.innerHTML = getSortedHoldings().map(h => {
    const valueTWD = getHoldingValueTWD(h);
    const catLabel = CATEGORY_LABELS[h.category];

    // 計算今日漲跌
    let changeHtml = '';
    if (h.currentPrice && h.previousClose && h.category !== 'cash') {
      const priceDiff = h.currentPrice - h.previousClose;
      const pct       = (priceDiff / h.previousClose * 100).toFixed(2);
      const posDiff   = toTWD(priceDiff * h.qty, h.currency);
      const sign      = priceDiff >= 0 ? '+' : '';
      const color     = priceDiff > 0 ? '#22c55e' : priceDiff < 0 ? '#ef4444' : '#94a3b8';
      changeHtml = `<div class="holding-change" style="color:${color}">${sign}${pct}%&nbsp;(${sign}${formatTWD(posDiff)})</div>`;
    }

    let priceHtml = '';
    if (h.category === 'cash') {
      priceHtml = `<div class="holding-total">${formatTWD(valueTWD)}</div>
                   <div class="holding-detail">${h.currency}</div>`;
    } else if (!h.currentPrice) {
      priceHtml = `<div class="holding-price-loading">尚無價格</div>`;
    } else {
      const priceStr = h.currency === 'USD'
        ? `$${h.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
        : `NT$${h.currentPrice.toLocaleString('zh-TW')}`;
      priceHtml = `<div class="holding-total">${formatTWD(valueTWD)}</div>
                   <div class="holding-detail">${priceStr} × ${h.qty.toLocaleString()}</div>
                   ${changeHtml}`;
    }

    return `
      <div class="holding-item">
        <div class="holding-left">
          <span class="holding-badge badge-${h.category}">${catLabel}</span>
          <div>
            <div class="holding-name">${escHtml(h.name)}</div>
            ${h.symbol ? `<div class="holding-symbol">${escHtml(h.symbol)}</div>` : ''}
          </div>
        </div>
        <div class="holding-right">
          <div class="holding-price-info">${priceHtml}</div>
          <div class="holding-actions">
            <button class="btn btn-edit" onclick="openEdit('${h.id}')">編輯</button>
            <button class="btn btn-danger" onclick="deleteHolding('${h.id}')">刪除</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─── 渲染：總覽卡片 ──────────────────────────────────────────────────────────
function updateSummary() {
  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };

  holdings.forEach(h => {
    totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h);
  });

  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  document.getElementById('total-value').textContent  = formatTWD(total);
  document.getElementById('tw-value').textContent     = formatTWD(totals.tw_stock);
  document.getElementById('us-value').textContent     = formatTWD(totals.us_stock);
  document.getElementById('cash-value').textContent   = formatTWD(totals.cash);
  document.getElementById('bond-value').textContent   = formatTWD(totals.bond);
  document.getElementById('crypto-value').textContent = formatTWD(totals.crypto);
}

function renderCharts() {
  renderChart();
  renderAllocationComparison();
}

// ─── 目標配置 ─────────────────────────────────────────────────────────────────
const TARGET_CATS = ['tw_stock', 'us_stock', 'cash', 'bond', 'crypto'];

function updateTargetTotalBar() {
  const sum = TARGET_CATS.reduce((s, c) => s + (targetAllocations[c] || 0), 0);
  const sumEl = document.getElementById('target-sum');
  const barEl = document.getElementById('target-total-bar');
  if (sumEl) sumEl.textContent = sum;
  if (barEl) barEl.className = 'target-total-bar' + (sum === 100 ? ' perfect' : sum > 100 ? ' over' : '');
}

function onTargetChange() {
  TARGET_CATS.forEach(c => {
    targetAllocations[c] = parseFloat(document.getElementById(`target-${c}`)?.value) || 0;
  });
  updateTargetTotalBar();
  saveData();
  renderAllocationComparison();
}

function renderAllocationComparison() {
  const container = document.getElementById('allocation-comparison');
  if (!container) return;

  const totals = Object.fromEntries(TARGET_CATS.map(c => [c, 0]));
  holdings.forEach(h => { totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h); });
  const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
  const targetSum  = TARGET_CATS.reduce((s, c) => s + (targetAllocations[c] || 0), 0);

  if (grandTotal === 0 || targetSum === 0) { container.innerHTML = ''; return; }

  const cats = TARGET_CATS.filter(c => totals[c] > 0 || (targetAllocations[c] || 0) > 0);
  if (!cats.length) { container.innerHTML = ''; return; }

  const header = `<div class="comparison-row comparison-header">
    <span>類別</span><span style="text-align:right">目前%</span><span>目標</span><span style="text-align:right">調整</span>
  </div>`;

  const rows = cats.map(c => {
    const cur    = totals[c];
    const curPct = grandTotal > 0 ? cur / grandTotal * 100 : 0;
    const tgtPct = targetAllocations[c] || 0;
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

// ─── 渲染：資產配置圓餅圖 ─────────────────────────────────────────────────────
function renderChart() {
  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
  holdings.forEach(h => {
    totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h);
  });

  const total = Object.values(totals).reduce((a, b) => a + b, 0);

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

  // 自訂 legend
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

// ─── 工具函式 ────────────────────────────────────────────────────────────────
function formatTWD(value) {
  if (!value || isNaN(value)) return 'NT$0';
  if (value >= 1_000_000) {
    return `NT$${(value / 1_000_000).toFixed(2)}M`;
  }
  return `NT$${Math.round(value).toLocaleString('zh-TW')}`;
}

// ─── 排序 ────────────────────────────────────────────────────────────────────
const CATEGORY_ORDER = { tw_stock: 0, us_stock: 1, bond: 2, cash: 3, crypto: 4 };

function setSort(by) {
  holdingsSortBy = (holdingsSortBy === by) ? 'none' : by; // 再按一次取消排序
  document.getElementById('sort-category-btn').classList.toggle('active', holdingsSortBy === 'category');
  document.getElementById('sort-value-btn').classList.toggle('active',    holdingsSortBy === 'value');
  renderHoldings();
}

function getSortedHoldings() {
  const list = [...holdings];
  if (holdingsSortBy === 'category') {
    list.sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9));
  } else if (holdingsSortBy === 'value') {
    list.sort((a, b) => getHoldingValueTWD(b) - getHoldingValueTWD(a));
  }
  return list;
}

// ─── 卡片折疊 ────────────────────────────────────────────────────────────────
function toggleCard(bodyId) {
  const body = document.getElementById(bodyId);
  const btn  = body.previousElementSibling.querySelector('.btn-collapse');
  const collapsed = body.classList.toggle('collapsed');
  btn.textContent = collapsed ? '+' : '−';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── 歷史資產紀錄 ────────────────────────────────────────────────────────────
function addHistoricalRecord() {
  const year = parseInt(document.getElementById('historical-year').value);
  const value = parseFloat(document.getElementById('historical-value').value);

  if (!year || isNaN(value) || value < 0) {
    alert('請輸入有效的年度和資產總值');
    return;
  }

  // 檢查年度是否已存在，若有則更新
  const existing = historicalRecords.findIndex(r => r.year === year);
  if (existing >= 0) {
    if (!confirm(`${year} 年已有紀錄，是否覆蓋？`)) return;
    historicalRecords[existing].value = value;
  } else {
    historicalRecords.push({ year, value });
  }

  // 按年度排序
  historicalRecords.sort((a, b) => a.year - b.year);

  // 清空輸入欄
  document.getElementById('historical-year').value = '';
  document.getElementById('historical-value').value = '';

  saveData();
  renderHistoricalRecordsList();
  renderHistoricalChart();
  updateGrowthRates();
}

function getNowRecord() {
  const totals = { tw_stock: 0, us_stock: 0, cash: 0, bond: 0, crypto: 0 };
  holdings.forEach(h => {
    totals[h.category] = (totals[h.category] || 0) + getHoldingValueTWD(h);
  });
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  return { year: 'Now', value: total };
}

function renderHistoricalChart() {
  const canvas = document.getElementById('historicalAssetChart');
  if (!canvas) return;

  // 合併歷史紀錄和"Now"紀錄
  const allRecords = [...historicalRecords, getNowRecord()];

  if (allRecords.length < 2) {
    if (historicalChart) historicalChart.destroy();
    return;
  }

  const ctx = canvas.getContext('2d');
  const years = allRecords.map(r => r.year.toString());
  const values = allRecords.map(r => r.value);

  if (historicalChart) historicalChart.destroy();

  historicalChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: years,
      datasets: [{
        label: '資產總值 (TWD)',
        data: values,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 6,
        pointBackgroundColor: '#3b82f6',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointHoverRadius: 8,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${formatTWD(ctx.raw)}`
          }
        }
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: allRecords.length, color: '#94a3b8' },
          grid:  { color: '#2d3748' }
        },
        y: {
          beginAtZero: false,
          ticks: {
            stepSize: 10_000_000,
            color: '#94a3b8',
            callback: v => {
              if (Math.abs(v) >= 100_000_000) return (v / 100_000_000).toFixed(0) + '億';
              if (Math.abs(v) >= 10_000_000)  return (v / 10_000_000).toFixed(0) + '千萬';
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

  const allRecords = [...historicalRecords, getNowRecord()].sort((a, b) => {
    if (a.year === 'Now') return 1;
    if (b.year === 'Now') return -1;
    return a.year - b.year;
  });

  if (!allRecords.length) {
    container.innerHTML = '<p class="empty-state">尚無紀錄</p>';
    return;
  }

  container.innerHTML = allRecords.map((r, i) => {
    let growthHtml = '';
    if (i > 0) {
      const prev = allRecords[i - 1];
      const growth = prev.value > 0 ? ((r.value - prev.value) / prev.value * 100).toFixed(2) : 0;
      const delta  = r.value - prev.value;
      const sign   = growth > 0 ? '+' : '';
      const color  = growth > 0 ? '#22c55e' : growth < 0 ? '#ef4444' : '#94a3b8';
      growthHtml = `<span style="color:${color};font-size:0.85rem">${sign}${growth}%&nbsp;(${sign}${formatTWD(delta)})</span>`;
    }
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;padding:0.75rem;border-bottom:1px solid #2d3748">
        <span style="font-weight:600;min-width:50px">${r.year}</span>
        <span style="flex:1">${formatTWD(r.value)}</span>
        ${growthHtml}
        ${r.year !== 'Now' ? `<button class="btn btn-danger" onclick="deleteHistoricalRecord(${r.year})" style="padding:0.2rem 0.5rem;font-size:0.75rem">刪除</button>` : ''}
      </div>`;
  }).join('');
}

function updateGrowthRates() {} // 已合併至 renderHistoricalRecordsList

function deleteHistoricalRecord(year) {
  if (!confirm(`確定要刪除 ${year} 年的紀錄？`)) return;
  historicalRecords = historicalRecords.filter(r => r.year !== year);
  saveData();
  renderHistoricalRecordsList();
  renderHistoricalChart();
}

// ─── 啟動 ────────────────────────────────────────────────────────────────────
init();
