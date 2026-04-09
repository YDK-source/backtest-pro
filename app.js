/* ================================================================
   BACKTEST PRO — app.js
   ================================================================ */

// ===== CONFIG =====
const CONFIG = {
  // Twelve Data — free, 800 req/day, CORS-friendly
  twelveDataBase: 'https://api.twelvedata.com/time_series',
  twelveDataKey: 'demo',   // 'demo' works for SPY/AAPL/etc at low volume; replace with free key from twelvedata.com for higher limits
  // Yahoo Finance via CORS proxies (fallback)
  corsProxies: [
    url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://thingproxy.freeboard.io/fetch/${url}`,
  ],
  yahooBase: 'https://query1.finance.yahoo.com/v8/finance/chart',
  benchmarks: [
    { ticker: 'SPY', name: 'SPY — S&P 500',      color: '#ef4444' },
    { ticker: 'QQQ', name: 'QQQ — NASDAQ-100',   color: '#3b82f6' },
    { ticker: 'VTI', name: 'VTI — שוק כולל',      color: '#f59e0b' },
  ],
  riskFreeRate: 0.05 / 12,   // 5% annual → monthly
  chartColors: ['#6366f1','#ef4444','#10b981','#f59e0b','#3b82f6','#ec4899','#14b8a6','#f97316'],
};

// ===== STATE =====
const state = {
  portfolios: [],
  cache: {},          // ticker → [{date, price}]
  charts: {},         // chartId → Chart instance
  editingColor: '#6366f1',
  mode: 'local',      // 'local' | 'room'
};

// ===== STORAGE =====
function savePortfolios() {
  if (state.mode === 'room') return; // Firestore is source of truth in room mode
  localStorage.setItem('bp_portfolios', JSON.stringify(state.portfolios));
}

function loadPortfolios() {
  if (state.mode === 'room') return; // onSnapshot handles this in room mode
  try {
    const raw = localStorage.getItem('bp_portfolios');
    state.portfolios = raw ? JSON.parse(raw) : [];
  } catch {
    state.portfolios = [];
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ===== API — DATA FETCHING (Twelve Data primary, Yahoo fallback) =====

async function fetchViaTwelveData(ticker) {
  const url = `${CONFIG.twelveDataBase}?symbol=${ticker}&interval=1month&outputsize=5000&apikey=${CONFIG.twelveDataKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('Twelve Data HTTP error');
  const data = await res.json();
  if (data.status === 'error' || !data.values?.length) throw new Error(data.message || 'No data');

  // Twelve Data returns newest-first, reverse to oldest-first
  const values = [...data.values].reverse();
  return values
    .map(v => ({ date: new Date(v.datetime), price: parseFloat(v.close) }))
    .filter(d => !isNaN(d.price));
}

async function fetchViaYahoo(ticker) {
  const url = `${CONFIG.yahooBase}/${ticker}?range=max&interval=1mo&includePrePost=false&events=div%2Csplit`;
  for (const makeUrl of CONFIG.corsProxies) {
    try {
      const res = await fetch(makeUrl(url), { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data?.chart?.result?.[0]) continue;

      const result = data.chart.result[0];
      const timestamps = result.timestamp || [];
      const adjClose = result.indicators?.adjclose?.[0]?.adjclose || [];
      const parsed = timestamps
        .map((ts, i) => ({ date: new Date(ts * 1000), price: adjClose[i] }))
        .filter(d => d.price !== null && d.price !== undefined && !isNaN(d.price));
      if (parsed.length > 0) return parsed;
    } catch {
      continue;
    }
  }
  throw new Error(`לא ניתן לטעון נתונים עבור ${ticker}`);
}

async function fetchTicker(ticker) {
  if (state.cache[ticker]) return state.cache[ticker];

  let parsed = null;

  // Try Twelve Data first
  try {
    parsed = await fetchViaTwelveData(ticker);
  } catch (e) {
    console.warn(`Twelve Data failed for ${ticker}:`, e.message, '— trying Yahoo...');
  }

  // Fallback to Yahoo via CORS proxies
  if (!parsed || parsed.length === 0) {
    parsed = await fetchViaYahoo(ticker);
  }

  if (!parsed || parsed.length === 0) {
    throw new Error(`לא ניתן לטעון נתונים עבור ${ticker}`);
  }

  state.cache[ticker] = parsed;
  return parsed;
}

// ===== PORTFOLIO CALCULATIONS =====
function calcPortfolioPerf(holdings, allData, startDate) {
  // Filter data from startDate onward
  const filtered = {};
  for (const h of holdings) {
    const raw = allData[h.ticker];
    if (!raw) return null;
    const items = raw.filter(d => d.date >= startDate);
    if (items.length < 2) return null;
    filtered[h.ticker] = items;
  }

  // Find common month-keys
  const toKey = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  let commonKeys = filtered[holdings[0].ticker].map(d => toKey(d.date));
  for (let i = 1; i < holdings.length; i++) {
    const set = new Set(filtered[holdings[i].ticker].map(d => toKey(d.date)));
    commonKeys = commonKeys.filter(k => set.has(k));
  }
  if (commonKeys.length < 2) return null;

  // Base prices at first common month
  const base = {};
  for (const h of holdings) {
    const entry = filtered[h.ticker].find(d => toKey(d.date) === commonKeys[0]);
    if (!entry) return null;
    base[h.ticker] = entry.price;
  }

  // Portfolio value at each common month
  return commonKeys.map(key => {
    let value = 0;
    let weightSum = 0;
    for (const h of holdings) {
      const entry = filtered[h.ticker].find(d => toKey(d.date) === key);
      if (entry && base[h.ticker]) {
        value += (h.weight / 100) * (entry.price / base[h.ticker]) * 100;
        weightSum += h.weight;
      }
    }
    // Normalize to handle partial weights
    if (weightSum > 0 && weightSum !== 100) value = (value / weightSum) * 100;
    return { key, value };
  });
}

function calcMetrics(perf) {
  if (!perf || perf.length < 3) return null;
  const values = perf.map(p => p.value);
  const start = values[0];
  const end = values[values.length - 1];
  const months = values.length - 1;

  const monthlyReturns = [];
  for (let i = 1; i < values.length; i++) {
    monthlyReturns.push((values[i] - values[i-1]) / values[i-1]);
  }

  const totalReturn = (end / start) - 1;
  const years = months / 12;
  const cagr = Math.pow(end / start, 1 / years) - 1;

  const meanR = monthlyReturns.reduce((a,b) => a+b, 0) / monthlyReturns.length;
  const variance = monthlyReturns.reduce((a,b) => a + Math.pow(b-meanR,2), 0) / monthlyReturns.length;
  const volatility = Math.sqrt(variance * 12);

  const rf = CONFIG.riskFreeRate;
  const excess = monthlyReturns.map(r => r - rf);
  const exMean = excess.reduce((a,b) => a+b, 0) / excess.length;
  const exVar = excess.reduce((a,b) => a + Math.pow(b-exMean,2), 0) / excess.length;
  const sharpe = exVar > 0 ? (exMean / Math.sqrt(exVar)) * Math.sqrt(12) : 0;

  let maxDrawdown = 0, peak = values[0];
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return { totalReturn, cagr, volatility, sharpe, maxDrawdown, months, years };
}

function getStartDate(rangeVal, customDate) {
  const now = new Date();
  switch(rangeVal) {
    case '1y':  { const d = new Date(now); d.setFullYear(d.getFullYear()-1); return d; }
    case '3y':  { const d = new Date(now); d.setFullYear(d.getFullYear()-3); return d; }
    case '5y':  { const d = new Date(now); d.setFullYear(d.getFullYear()-5); return d; }
    case '10y': { const d = new Date(now); d.setFullYear(d.getFullYear()-10); return d; }
    case 'custom': return customDate ? new Date(customDate) : new Date('2000-01-01');
    default: return new Date('1990-01-01'); // max
  }
}

// ===== CHART HELPERS =====
function destroyChart(id) {
  if (state.charts[id]) {
    state.charts[id].destroy();
    delete state.charts[id];
  }
}

function perfToChartData(perf, label, color) {
  return {
    label,
    data: perf.map(p => ({ x: p.key + '-01', y: Math.round(p.value * 100) / 100 })),
    borderColor: color,
    backgroundColor: color + '18',
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    tension: 0.3,
    fill: false,
  };
}

function makeLineChart(canvasId, datasets, title) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  state.charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: getComputedStyle(document.body).getPropertyValue('--text') || '#f1f5f9', font: { size: 12 } },
        },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}`,
          },
        },
        title: title ? { display: true, text: title, color: '#94a3b8' } : undefined,
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'year', tooltipFormat: 'MMM yyyy' },
          ticks: { color: '#94a3b8', maxTicksLimit: 10 },
          grid: { color: 'rgba(148,163,184,0.1)' },
        },
        y: {
          ticks: {
            color: '#94a3b8',
            callback: v => v.toFixed(0),
          },
          grid: { color: 'rgba(148,163,184,0.1)' },
        },
      },
    },
  });
}

// ===== TOAST =====
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ===== FORMAT HELPERS =====
const fmt = {
  pct:  v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%',
  pct2: v => (v * 100).toFixed(2) + '%',
  usd:  v => '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }),
  num:  v => v.toFixed(2),
};

// ===== NAVIGATE =====
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  const tabEl = document.querySelector(`.tab-btn[data-page="${page}"]`);
  if (tabEl) tabEl.classList.add('active');

  if (page === 'dashboard') renderDashboard();
  if (page === 'portfolios') renderPortfolios();
  if (page === 'backtest') renderBacktestPage();
  if (page === 'calculator') renderCalculator();
}

// ===== DASHBOARD =====
async function renderDashboard() {
  const empty = document.getElementById('dashboard-empty');
  const content = document.getElementById('dashboard-content');
  const badge = document.getElementById('dashboard-loading-badge');

  if (state.portfolios.length === 0) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  content.classList.remove('hidden');

  // Render portfolio summary cards
  const cardsEl = document.getElementById('portfolio-cards');
  cardsEl.innerHTML = state.portfolios.map(p => {
    const tickers = p.holdings.map(h => `<span class="ticker-chip">${h.ticker}</span>`).join('');
    return `
      <div class="portfolio-card" style="border-right-color:${p.color}" onclick="navigate('portfolios')">
        <div class="pc-header">
          <div class="pc-name">${escHtml(p.name)}</div>
          <div class="pc-count">${p.holdings.length} ניירות</div>
        </div>
        <div class="pc-tickers">${tickers}</div>
      </div>`;
  }).join('');

  // Load 1-year chart
  badge.textContent = 'טוען...';
  badge.classList.remove('hidden');
  try {
    const oneYearAgo = getStartDate('1y');
    const allTickers = [...new Set(state.portfolios.flatMap(p => p.holdings.map(h => h.ticker)), 'SPY', 'QQQ')];

    await Promise.allSettled(allTickers.map(t => fetchTicker(t)));

    const datasets = [];
    state.portfolios.forEach((p, i) => {
      const perf = calcPortfolioPerf(p.holdings, state.cache, oneYearAgo);
      if (perf) datasets.push(perfToChartData(perf, p.name, p.color || CONFIG.chartColors[i % CONFIG.chartColors.length]));
    });

    // Add SPY benchmark
    const spyPerf = calcPortfolioPerf([{ ticker: 'SPY', weight: 100 }], state.cache, oneYearAgo);
    if (spyPerf) datasets.push(perfToChartData(spyPerf, 'SPY', '#ef4444'));

    makeLineChart('dashboard-chart', datasets);
    badge.classList.add('hidden');
  } catch (e) {
    badge.textContent = 'שגיאה בטעינה';
  }
}

// ===== PORTFOLIOS PAGE =====
function renderPortfolios() {
  const listEl = document.getElementById('portfolios-list');
  const emptyEl = document.getElementById('portfolios-empty');

  if (state.portfolios.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  listEl.innerHTML = state.portfolios.map((p, i) => {
    const totalWeight = p.holdings.reduce((s, h) => s + (h.weight || 0), 0);
    const rows = p.holdings.map(h => `
      <tr>
        <td><strong>${escHtml(h.ticker)}</strong></td>
        <td>${h.weight}%</td>
        <td>${h.purchaseDate || '—'}</td>
        <td>${h.purchasePrice ? '$' + h.purchasePrice : '—'}</td>
      </tr>`).join('');

    return `
      <div class="portfolio-item" style="border-right-color:${p.color}">
        <div class="portfolio-item-header" onclick="togglePortfolioBody(${i})">
          <div class="pi-info">
            <div class="pi-color" style="background:${p.color}"></div>
            <div>
              <div class="pi-name">${escHtml(p.name)}</div>
              <div class="pi-meta">${p.holdings.length} ניירות · משקל כולל: ${totalWeight}%</div>
            </div>
          </div>
          <div class="pi-actions" onclick="event.stopPropagation()">
            <button class="btn btn-sm btn-share" onclick="sharePortfolio(${i})" title="שתף קישור">🔗 שתף</button>
            <button class="btn btn-sm btn-secondary" onclick="openEditModal(${i})">✏️ ערוך</button>
            <button class="btn btn-sm btn-danger" onclick="deletePortfolio(${i})">🗑️ מחק</button>
          </div>
        </div>
        <div class="portfolio-item-body" id="portfolio-body-${i}">
          <table class="holdings-table">
            <thead>
              <tr>
                <th>טיקר</th><th>משקל</th><th>תאריך קנייה</th><th>מחיר קנייה</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

// ===== SHARING =====
function sharePortfolio(i) {
  const p = state.portfolios[i];
  // Encode only the essential data (not the internal id)
  const payload = {
    name: p.name,
    color: p.color,
    holdings: p.holdings,
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const url = `${location.origin}${location.pathname}#import=${encoded}`;

  navigator.clipboard.writeText(url).then(() => {
    toast(`קישור לתיק "${p.name}" הועתק ללוח! שלח אותו לחבר שלך.`, 'success', 5000);
  }).catch(() => {
    // Fallback: prompt
    prompt('העתק את הקישור הזה ושלח לחבר:', url);
  });
}

// ===== IMPORT FROM URL =====
let pendingImport = null;

function checkUrlImport() {
  const hash = location.hash;
  if (!hash.startsWith('#import=')) return;

  try {
    const encoded = hash.slice('#import='.length);
    const json = decodeURIComponent(escape(atob(encoded)));
    const data = JSON.parse(json);

    if (!data.name || !Array.isArray(data.holdings)) return;

    pendingImport = data;

    // Show banner
    document.getElementById('import-banner-name').textContent = data.name;
    document.getElementById('import-banner').classList.remove('hidden');

    // Clean URL without reloading
    history.replaceState(null, '', location.pathname);
  } catch (e) {
    console.warn('Invalid import URL', e);
  }
}

function confirmImport() {
  if (!pendingImport) return;

  const exists = state.portfolios.find(p => p.name === pendingImport.name);
  if (exists) {
    if (!confirm(`כבר קיים תיק בשם "${pendingImport.name}". להוסיף בכל זאת?`)) return;
  }

  const newPortfolio = {
    id: uid(),
    name: pendingImport.name,
    color: pendingImport.color || '#6366f1',
    holdings: pendingImport.holdings,
    createdAt: new Date().toISOString(),
  };
  state.portfolios.push(newPortfolio);

  if (state.mode === 'room') {
    window.syncPortfolioSave(newPortfolio);
  } else {
    savePortfolios();
    renderPortfolios();
  }
  const importedName = newPortfolio.name;
  pendingImport = null;
  dismissImport();
  toast(`התיק "${importedName}" יובא בהצלחה!`, 'success');
}

function dismissImport() {
  pendingImport = null;
  document.getElementById('import-banner').classList.add('hidden');
}

// ===== EXPORT ALL =====
function exportAll() {
  if (state.portfolios.length === 0) { toast('אין תיקים לייצוא', 'error'); return; }
  const json = JSON.stringify(state.portfolios, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backtest-pro-portfolios-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('הקובץ יוצא בהצלחה', 'success');
}

// ===== IMPORT FROM FILE =====
function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const portfolios = Array.isArray(data) ? data : [data];
      let imported = 0;
      for (const p of portfolios) {
        if (!p.name || !Array.isArray(p.holdings)) continue;
        // Avoid duplicates by name
        if (state.portfolios.find(x => x.name === p.name)) {
          if (!confirm(`תיק "${p.name}" כבר קיים. להחליף?`)) continue;
          const idx = state.portfolios.findIndex(x => x.name === p.name);
          state.portfolios[idx] = { ...p, id: state.portfolios[idx].id };
        } else {
          state.portfolios.push({ ...p, id: uid() });
        }
        imported++;
      }
      if (state.mode === 'room') {
        state.portfolios.slice(-imported).forEach(p => window.syncPortfolioSave(p));
      } else {
        savePortfolios();
        renderPortfolios();
      }
      toast(`${imported} תיקים יובאו בהצלחה`, 'success');
    } catch {
      toast('קובץ לא תקין', 'error');
    }
  };
  reader.readAsText(file);
}

function togglePortfolioBody(i) {
  const body = document.getElementById(`portfolio-body-${i}`);
  body.classList.toggle('open');
}

function deletePortfolio(i) {
  if (!confirm(`למחוק את התיק "${state.portfolios[i].name}"?`)) return;
  const portfolioId = state.portfolios[i].id;
  state.portfolios.splice(i, 1);
  if (state.mode === 'room') {
    window.syncPortfolioDelete(portfolioId); // Firestore write — onSnapshot will update UI
  } else {
    savePortfolios();
    renderPortfolios();
  }
  toast('התיק נמחק', 'info');
}

// ===== BACKTEST PAGE =====
function renderBacktestPage() {
  const noP = document.getElementById('bt-no-portfolios');
  if (state.portfolios.length === 0) {
    noP.classList.remove('hidden');
  } else {
    noP.classList.add('hidden');
  }
  document.getElementById('bt-results').classList.add('hidden');
}

async function runBacktest() {
  if (state.portfolios.length === 0) { toast('הוסף תיק לפחות אחד', 'error'); return; }

  const range = document.getElementById('bt-range').value;
  const customDate = document.getElementById('bt-custom-date').value;
  const startDate = getStartDate(range, customDate);

  const useSPY = document.getElementById('cb-spy').checked;
  const useQQQ = document.getElementById('cb-qqq').checked;
  const useVTI = document.getElementById('cb-vti').checked;

  // Collect all tickers
  const tickersNeeded = new Set(state.portfolios.flatMap(p => p.holdings.map(h => h.ticker)));
  if (useSPY) tickersNeeded.add('SPY');
  if (useQQQ) tickersNeeded.add('QQQ');
  if (useVTI) tickersNeeded.add('VTI');

  // Show loading
  document.getElementById('bt-loading').classList.remove('hidden');
  document.getElementById('bt-results').classList.add('hidden');
  document.getElementById('bt-no-portfolios').classList.add('hidden');

  const loadingTicker = document.getElementById('bt-loading-ticker');

  // Fetch data
  for (const ticker of tickersNeeded) {
    loadingTicker.textContent = `טוען ${ticker}...`;
    try { await fetchTicker(ticker); }
    catch (e) { toast(`שגיאה בטעינת ${ticker}: ${e.message}`, 'error'); }
  }

  document.getElementById('bt-loading').classList.add('hidden');

  // Build datasets + metrics
  const datasets = [];
  const metricsRows = [];

  const colorMap = {};
  state.portfolios.forEach((p, i) => {
    colorMap[p.name] = p.color || CONFIG.chartColors[i % CONFIG.chartColors.length];
  });

  // User portfolios
  state.portfolios.forEach(p => {
    const perf = calcPortfolioPerf(p.holdings, state.cache, startDate);
    if (!perf) { toast(`לא מספיק דאטה עבור "${p.name}"`, 'error'); return; }
    const metrics = calcMetrics(perf);
    datasets.push(perfToChartData(perf, p.name, p.color));
    if (metrics) metricsRows.push({ name: p.name, color: p.color, ...metrics });
  });

  // Benchmarks
  const activeBenchmarks = CONFIG.benchmarks.filter(b =>
    (b.ticker === 'SPY' && useSPY) ||
    (b.ticker === 'QQQ' && useQQQ) ||
    (b.ticker === 'VTI' && useVTI)
  );

  for (const b of activeBenchmarks) {
    if (!state.cache[b.ticker]) continue;
    const perf = calcPortfolioPerf([{ ticker: b.ticker, weight: 100 }], state.cache, startDate);
    if (!perf) continue;
    const metrics = calcMetrics(perf);
    datasets.push({ ...perfToChartData(perf, b.name, b.color), borderDash: [5, 3] });
    if (metrics) metricsRows.push({ name: b.name, color: b.color, ...metrics });
  }

  if (datasets.length === 0) {
    toast('לא נמצאו נתונים להצגה', 'error');
    return;
  }

  // Render chart
  makeLineChart('backtest-chart', datasets);

  // Render metrics table
  const tbody = document.getElementById('metrics-tbody');
  tbody.innerHTML = metricsRows.map(m => `
    <tr>
      <td><div class="metric-name"><span class="metric-dot" style="background:${m.color}"></span>${escHtml(m.name)}</div></td>
      <td class="${m.totalReturn >= 0 ? 'positive' : 'negative'}">${fmt.pct(m.totalReturn)}</td>
      <td class="${m.cagr >= 0 ? 'positive' : 'negative'}">${fmt.pct(m.cagr)}</td>
      <td class="${m.sharpe >= 1 ? 'positive' : m.sharpe >= 0 ? 'neutral' : 'negative'}">${m.sharpe.toFixed(2)}</td>
      <td class="negative">-${(m.maxDrawdown * 100).toFixed(1)}%</td>
      <td class="neutral">${(m.volatility * 100).toFixed(1)}%</td>
      <td class="neutral">${m.months}</td>
    </tr>`).join('');

  document.getElementById('bt-results').classList.remove('hidden');
}

// ===== MODAL =====
let holdingCount = 0;

function openAddModal() {
  document.getElementById('modal-title').textContent = 'תיק חדש';
  document.getElementById('edit-portfolio-id').value = '';
  document.getElementById('portfolio-name').value = '';
  document.getElementById('holdings-list').innerHTML = '';
  holdingCount = 0;
  state.editingColor = '#6366f1';
  updateColorPicker('#6366f1');
  updateWeightTotal();
  addHoldingRow();
  document.getElementById('portfolio-modal').classList.remove('hidden');
}

function openEditModal(i) {
  const p = state.portfolios[i];
  document.getElementById('modal-title').textContent = 'עריכת תיק';
  document.getElementById('edit-portfolio-id').value = i;
  document.getElementById('portfolio-name').value = p.name;
  document.getElementById('holdings-list').innerHTML = '';
  holdingCount = 0;
  state.editingColor = p.color || '#6366f1';
  updateColorPicker(p.color || '#6366f1');

  p.holdings.forEach(h => addHoldingRow(h));
  updateWeightTotal();
  document.getElementById('portfolio-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('portfolio-modal').classList.add('hidden');
}

function addHoldingRow(holding = {}) {
  const id = holdingCount++;
  const row = document.createElement('div');
  row.className = 'holding-row';
  row.id = `hr-${id}`;
  row.innerHTML = `
    <input type="text" placeholder="AAPL" value="${escHtml(holding.ticker || '')}" class="ticker-input" style="text-transform:uppercase">
    <input type="number" placeholder="%" value="${holding.weight || ''}" class="weight-input" min="0" max="100" step="0.1">
    <input type="date" value="${holding.purchaseDate || ''}" class="purchase-date-input">
    <input type="number" placeholder="0.00" value="${holding.purchasePrice || ''}" class="purchase-price-input" min="0" step="0.01">
    <button class="remove-holding-btn" onclick="removeHoldingRow('hr-${id}')">✕</button>`;

  row.querySelector('.ticker-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
  row.querySelector('.weight-input').addEventListener('input', updateWeightTotal);

  document.getElementById('holdings-list').appendChild(row);
  updateWeightTotal();
}

function removeHoldingRow(rowId) {
  document.getElementById(rowId)?.remove();
  updateWeightTotal();
}

function updateWeightTotal() {
  const inputs = document.querySelectorAll('.weight-input');
  const total = [...inputs].reduce((s, el) => s + (parseFloat(el.value) || 0), 0);
  document.getElementById('total-weight').textContent = total.toFixed(1) + '%';
  const warn = document.getElementById('weight-warning');
  if (Math.abs(total - 100) > 0.1 && inputs.length > 0) {
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}

function updateColorPicker(color) {
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === color);
  });
}

function savePortfolio() {
  const name = document.getElementById('portfolio-name').value.trim();
  if (!name) { toast('הכנס שם לתיק', 'error'); return; }

  const rows = document.querySelectorAll('.holding-row');
  const holdings = [];
  for (const row of rows) {
    const ticker = row.querySelector('.ticker-input').value.trim().toUpperCase();
    const weight = parseFloat(row.querySelector('.weight-input').value) || 0;
    const purchaseDate = row.querySelector('.purchase-date-input').value;
    const purchasePrice = parseFloat(row.querySelector('.purchase-price-input').value) || null;
    if (!ticker) continue;
    holdings.push({ ticker, weight, purchaseDate: purchaseDate || null, purchasePrice });
  }

  if (holdings.length === 0) { toast('הוסף לפחות נייר אחד', 'error'); return; }

  const totalWeight = holdings.reduce((s, h) => s + h.weight, 0);
  if (Math.abs(totalWeight - 100) > 0.1) {
    if (!confirm(`המשקל הכולל הוא ${totalWeight.toFixed(1)}% (לא 100%). להמשיך בכל זאת?`)) return;
  }

  const editIdxRaw = document.getElementById('edit-portfolio-id').value;
  const portfolio = {
    id: uid(),
    name,
    color: state.editingColor,
    holdings,
    createdAt: new Date().toISOString(),
  };

  if (editIdxRaw !== '') {
    const idx = parseInt(editIdxRaw);
    portfolio.id = state.portfolios[idx].id;
    portfolio.createdAt = state.portfolios[idx].createdAt;
    const oldTickers = state.portfolios[idx].holdings.map(h => h.ticker);
    const newTickers = holdings.map(h => h.ticker);
    [...oldTickers, ...newTickers].forEach(t => delete state.cache[t]);
    state.portfolios[idx] = portfolio;
    toast('התיק עודכן', 'success');
  } else {
    state.portfolios.push(portfolio);
    toast('התיק נשמר', 'success');
  }

  if (state.mode === 'room') {
    window.syncPortfolioSave(portfolio); // Firestore write — onSnapshot will re-render
  } else {
    savePortfolios();
    renderPortfolios();
  }
  closeModal();
}

// ===== CALCULATOR =====
function renderCalculator() {
  // Populate portfolio selects
  const options = [
    ...CONFIG.benchmarks.map(b => `<option value="${b.ticker}">${b.name}</option>`),
    ...state.portfolios.map((p, i) => `<option value="__p_${i}">${escHtml(p.name)}</option>`),
  ].join('');

  ['sim-target', 'dca-target'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = options;
  });
}

async function getCalcData(targetValue) {
  if (targetValue.startsWith('__p_')) {
    const idx = parseInt(targetValue.slice(4));
    const p = state.portfolios[idx];
    // Fetch all tickers
    for (const h of p.holdings) await fetchTicker(h.ticker);
    return { type: 'portfolio', portfolio: p };
  } else {
    await fetchTicker(targetValue);
    return { type: 'ticker', ticker: targetValue };
  }
}

function getCalcPerf(source, startDate) {
  if (source.type === 'ticker') {
    return calcPortfolioPerf([{ ticker: source.ticker, weight: 100 }], state.cache, startDate);
  } else {
    return calcPortfolioPerf(source.portfolio.holdings, state.cache, startDate);
  }
}

async function runSimulator() {
  const amount = parseFloat(document.getElementById('sim-amount').value);
  const dateStr = document.getElementById('sim-date').value;
  const targetVal = document.getElementById('sim-target').value;

  if (!amount || !dateStr) { toast('מלא את כל השדות', 'error'); return; }

  try {
    const source = await getCalcData(targetVal);
    const startDate = new Date(dateStr);
    const perf = getCalcPerf(source, startDate);

    if (!perf || perf.length < 2) { toast('אין מספיק נתונים עבור תאריך זה', 'error'); return; }

    const ratio = perf[perf.length - 1].value / 100;
    const finalValue = amount * ratio;
    const pnl = finalValue - amount;
    const totalReturn = ratio - 1;
    const years = (perf.length - 1) / 12;
    const cagr = Math.pow(ratio, 1 / years) - 1;

    document.getElementById('sim-current').textContent = fmt.usd(finalValue);
    document.getElementById('sim-pnl').textContent = (pnl >= 0 ? '+' : '') + fmt.usd(pnl);
    document.getElementById('sim-pnl-card').style.borderTop = `3px solid ${pnl >= 0 ? 'var(--success)' : 'var(--danger)'}`;
    document.getElementById('sim-total-ret').textContent = fmt.pct(totalReturn);
    document.getElementById('sim-cagr').textContent = fmt.pct(cagr);

    // Chart: portfolio value over time
    const chartData = perf.map(p => ({
      x: p.key + '-01',
      y: Math.round(amount * (p.value / 100)),
    }));

    destroyChart('sim-chart');
    const ctx = document.getElementById('sim-chart');
    const label = source.type === 'ticker' ? source.ticker : source.portfolio.name;
    state.charts['sim-chart'] = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [{
          label: `שווי תיק — ${label}`,
          data: chartData,
          borderColor: '#6366f1',
          backgroundColor: '#6366f120',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.3,
        }, {
          label: 'השקעה מקורית',
          data: chartData.map(d => ({ x: d.x, y: amount })),
          borderColor: '#94a3b8',
          borderWidth: 1,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#94a3b8' } },
          tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmt.usd(c.parsed.y)}` } },
        },
        scales: {
          x: { type: 'time', time: { unit: 'year', tooltipFormat: 'MMM yyyy' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.1)' } },
          y: { ticks: { color: '#94a3b8', callback: v => fmt.usd(v) }, grid: { color: 'rgba(148,163,184,0.1)' } },
        },
      },
    });

    document.getElementById('sim-results').classList.remove('hidden');
  } catch (e) {
    toast('שגיאה: ' + e.message, 'error');
  }
}

async function runDCA() {
  const monthly = parseFloat(document.getElementById('dca-amount').value);
  const dateStr = document.getElementById('dca-date').value;
  const targetVal = document.getElementById('dca-target').value;

  if (!monthly || !dateStr) { toast('מלא את כל השדות', 'error'); return; }

  try {
    const source = await getCalcData(targetVal);
    const startDate = new Date(dateStr);
    const perf = getCalcPerf(source, startDate);

    if (!perf || perf.length < 2) { toast('אין מספיק נתונים עבור תאריך זה', 'error'); return; }

    // DCA: each month buy $monthly worth at current price
    // units[i] = monthly / perf[i].value * 100 (normalized price)
    let units = 0;
    let totalInvested = 0;
    const chartPortfolio = [];
    const chartInvested = [];

    perf.forEach(p => {
      units += monthly / (p.value); // perf normalized to 100
      totalInvested += monthly;
      const currentValue = units * p.value;
      chartPortfolio.push({ x: p.key + '-01', y: Math.round(currentValue) });
      chartInvested.push({ x: p.key + '-01', y: totalInvested });
    });

    const finalValue = units * perf[perf.length - 1].value;
    const pnl = finalValue - totalInvested;
    const roi = (finalValue / totalInvested) - 1;

    document.getElementById('dca-current').textContent = fmt.usd(finalValue);
    document.getElementById('dca-invested').textContent = fmt.usd(totalInvested);
    document.getElementById('dca-pnl').textContent = (pnl >= 0 ? '+' : '') + fmt.usd(pnl);
    document.getElementById('dca-pnl-card').style.borderTop = `3px solid ${pnl >= 0 ? 'var(--success)' : 'var(--danger)'}`;
    document.getElementById('dca-roi').textContent = fmt.pct(roi);

    destroyChart('dca-chart');
    const ctx = document.getElementById('dca-chart');
    const label = source.type === 'ticker' ? source.ticker : source.portfolio.name;
    state.charts['dca-chart'] = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: [
          { label: `שווי תיק — ${label}`, data: chartPortfolio, borderColor: '#6366f1', backgroundColor: '#6366f120', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
          { label: 'סה"כ הופקד', data: chartInvested, borderColor: '#10b981', borderWidth: 2, borderDash: [4,4], pointRadius: 0, fill: false },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#94a3b8' } },
          tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmt.usd(c.parsed.y)}` } },
        },
        scales: {
          x: { type: 'time', time: { unit: 'year', tooltipFormat: 'MMM yyyy' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.1)' } },
          y: { ticks: { color: '#94a3b8', callback: v => fmt.usd(v) }, grid: { color: 'rgba(148,163,184,0.1)' } },
        },
      },
    });

    document.getElementById('dca-results').classList.remove('hidden');
  } catch (e) {
    toast('שגיאה: ' + e.message, 'error');
  }
}

function runGoal() {
  const target = parseFloat(document.getElementById('goal-target').value);
  const initial = parseFloat(document.getElementById('goal-initial').value) || 0;
  const monthly = parseFloat(document.getElementById('goal-monthly').value) || 0;
  const annualRate = parseFloat(document.getElementById('goal-rate').value) / 100;

  if (!target || annualRate <= 0) { toast('מלא את כל השדות', 'error'); return; }

  const monthlyRate = annualRate / 12;
  let value = initial;
  let totalInvested = initial;
  const chartValues = [{ x: 0, y: initial }];
  const chartInvested = [{ x: 0, y: initial }];

  let months = 0;
  const maxMonths = 600; // 50 years cap

  while (value < target && months < maxMonths) {
    months++;
    value = value * (1 + monthlyRate) + monthly;
    totalInvested += monthly;
    if (months % 12 === 0 || value >= target) {
      const year = new Date().getFullYear() + months / 12;
      chartValues.push({ x: year, y: Math.round(value) });
      chartInvested.push({ x: year, y: Math.round(totalInvested) });
    }
  }

  const years = months / 12;
  const targetYear = new Date().getFullYear() + Math.ceil(years);
  const earnings = value - totalInvested;

  document.getElementById('goal-years').textContent =
    years < 1 ? `${months} חודשים` : `${years.toFixed(1)} שנים`;
  document.getElementById('goal-year').textContent = targetYear;
  document.getElementById('goal-total-invested').textContent = fmt.usd(totalInvested);
  document.getElementById('goal-earnings').textContent = fmt.usd(earnings);

  destroyChart('goal-chart');
  const ctx = document.getElementById('goal-chart');
  state.charts['goal-chart'] = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'שווי צפוי',
          data: chartValues.map(d => ({ x: `${d.x}-01-01`, y: d.y })),
          borderColor: '#6366f1', backgroundColor: '#6366f120', borderWidth: 2, pointRadius: 0, fill: true, tension: 0.4,
        },
        {
          label: 'סה"כ הפקדות',
          data: chartInvested.map(d => ({ x: `${d.x}-01-01`, y: d.y })),
          borderColor: '#10b981', borderWidth: 2, borderDash: [4,4], pointRadius: 0, fill: false,
        },
        {
          label: 'יעד',
          data: [{ x: `${new Date().getFullYear()}-01-01`, y: target }, { x: `${targetYear + 1}-01-01`, y: target }],
          borderColor: '#f59e0b', borderWidth: 1.5, borderDash: [6,3], pointRadius: 0, fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#94a3b8' } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${fmt.usd(c.parsed.y)}` } },
      },
      scales: {
        x: { type: 'time', time: { unit: 'year', tooltipFormat: 'yyyy' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(148,163,184,0.1)' } },
        y: { ticks: { color: '#94a3b8', callback: v => '$' + (v/1000).toFixed(0) + 'K' }, grid: { color: 'rgba(148,163,184,0.1)' } },
      },
    },
  });

  document.getElementById('goal-results').classList.remove('hidden');
}

// ===== THEME =====
function toggleTheme() {
  document.body.classList.toggle('light');
  const isDark = !document.body.classList.contains('light');
  document.getElementById('themeToggle').textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('bp_theme', isDark ? 'dark' : 'light');
}

// ===== ESCAPE HTML =====
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ===== LOBBY & ROOM MANAGEMENT =====
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function updateRoomBadge(roomId) {
  document.getElementById('room-code-display').textContent = roomId;
  document.getElementById('room-badge').classList.remove('hidden');
}

function enterLocalMode() {
  state.mode = 'local';
  localStorage.removeItem('bp_room');
  document.getElementById('lobby-overlay').classList.add('hidden');
  document.getElementById('room-badge').classList.add('hidden');
  loadPortfolios();
  navigate('dashboard');
}

function enterRoomMode(roomId) {
  state.mode = 'room';
  document.getElementById('lobby-overlay').classList.add('hidden');
  updateRoomBadge(roomId);
  // joinRoom is defined in firebase-sync.js; it sets up onSnapshot which calls navigate() after first sync
  window.joinRoom(roomId);
}

function leaveRoomMode() {
  window.leaveRoom();
  state.mode = 'local';
  state.portfolios = [];
  localStorage.removeItem('bp_room');
  document.getElementById('room-badge').classList.add('hidden');
  document.getElementById('lobby-overlay').classList.remove('hidden');
  // Reset room input
  document.getElementById('roomCodeInput').value = '';
}

function initLobby() {
  const firebaseReady = window.firebaseReady === true;

  if (!firebaseReady) {
    // Show warning and disable room form
    document.getElementById('lobby-no-firebase').classList.remove('hidden');
    document.getElementById('lobby-firebase-form').style.opacity = '0.4';
    document.getElementById('lobby-firebase-form').style.pointerEvents = 'none';
    // Auto-enter local mode silently
    enterLocalMode();
    return;
  }

  // Resume previous room session automatically
  const savedRoom = localStorage.getItem('bp_room');
  if (savedRoom) {
    enterRoomMode(savedRoom);
    return;
  }

  // Show lobby for fresh start
  document.getElementById('createRoomBtn').addEventListener('click', () => {
    const roomId = generateRoomCode();

    // Check if there's existing local data to migrate
    let localPortfolios = [];
    try {
      const raw = localStorage.getItem('bp_portfolios');
      localPortfolios = raw ? JSON.parse(raw) : [];
    } catch { localPortfolios = []; }

    enterRoomMode(roomId);

    // After a short delay (so Firestore listener is set up), migrate local data
    if (localPortfolios.length > 0) {
      setTimeout(() => {
        localPortfolios.forEach(p => window.syncPortfolioSave(p));
        toast(`✅ ${localPortfolios.length} תיקים הועברו לחדר`, 'success', 5000);
        setTimeout(() => {
          toast(`קוד החדר: ${roomId} — שתף עם החבר שלך 📋`, 'success', 8000);
        }, 1000);
      }, 1500);
    } else {
      setTimeout(() => {
        toast(`קוד החדר: ${roomId} — שתף עם החבר שלך 📋`, 'success', 8000);
      }, 600);
    }
  });

  document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const raw = document.getElementById('roomCodeInput').value.trim().toUpperCase();
    if (raw.length !== 6) { toast('קוד חדר חייב להיות 6 תווים', 'error'); return; }
    enterRoomMode(raw);
  });

  document.getElementById('roomCodeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('joinRoomBtn').click();
    // Auto-uppercase
    setTimeout(() => {
      e.target.value = e.target.value.toUpperCase();
    }, 0);
  });

  document.getElementById('lobbyLocalBtn').addEventListener('click', enterLocalMode);
}

// ===== EVENT LISTENERS =====
document.addEventListener('DOMContentLoaded', () => {
  // Apply saved theme
  const savedTheme = localStorage.getItem('bp_theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light');
    document.getElementById('themeToggle').textContent = '☀️';
  }

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.page));
  });

  // Theme toggle
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);

  // Room badge actions
  document.getElementById('leaveRoomBtn').addEventListener('click', leaveRoomMode);
  document.getElementById('copyRoomCodeBtn').addEventListener('click', () => {
    const code = document.getElementById('room-code-display').textContent;
    navigator.clipboard.writeText(code).then(() => toast(`קוד "${code}" הועתק!`, 'success'));
  });

  // URL import check
  checkUrlImport();

  // Import banner
  document.getElementById('confirmImportBtn').addEventListener('click', confirmImport);
  document.getElementById('dismissImportBtn').addEventListener('click', dismissImport);

  // Export / Import file
  document.getElementById('exportAllBtn').addEventListener('click', exportAll);
  document.getElementById('importFileBtn').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', e => {
    if (e.target.files[0]) importFromFile(e.target.files[0]);
    e.target.value = '';
  });

  // Portfolio modal
  document.getElementById('addPortfolioBtn').addEventListener('click', openAddModal);
  document.getElementById('closeModal').addEventListener('click', closeModal);
  document.getElementById('cancelModal').addEventListener('click', closeModal);
  document.getElementById('savePortfolioBtn').addEventListener('click', savePortfolio);
  document.getElementById('addHoldingBtn').addEventListener('click', () => addHoldingRow());

  document.getElementById('portfolio-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('portfolio-modal')) closeModal();
  });

  // Color picker
  document.getElementById('color-picker').addEventListener('click', e => {
    const btn = e.target.closest('.color-btn');
    if (!btn) return;
    state.editingColor = btn.dataset.color;
    updateColorPicker(btn.dataset.color);
  });

  // Backtest range
  document.getElementById('bt-range').addEventListener('change', e => {
    document.getElementById('bt-custom-group').style.display =
      e.target.value === 'custom' ? 'flex' : 'none';
  });

  document.getElementById('runBacktestBtn').addEventListener('click', runBacktest);

  // Calculator tabs
  document.querySelectorAll('.calc-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.calc-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.calc-section').forEach(s => s.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`calc-${btn.dataset.calc}`).classList.remove('hidden');
    });
  });

  // Calculator buttons
  document.getElementById('runSimBtn').addEventListener('click', runSimulator);
  document.getElementById('runDcaBtn').addEventListener('click', runDCA);
  document.getElementById('runGoalBtn').addEventListener('click', runGoal);

  // Init lobby (firebase-sync.js has already run by now and set window.firebaseReady)
  initLobby();
});
