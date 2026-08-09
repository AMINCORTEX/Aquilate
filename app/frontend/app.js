// ─── CONSTANTS ───
const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];
const THEME_KEY = 'aquilate_theme';
// Reserved catId for income that isn't covered by any category's allocation
// (categories sum to under 100%). Transactions with this catId are never
// silently discarded — they're shown as a distinct "Unallocated" bucket
// instead, so no dollar disappears without a visible trace.
const UNALLOC_ID = '__unallocated__';

// ─── DEFAULT EMPTY STATE ───
function defaultState() {
  const now = new Date();
  return {
    month: now.getMonth(),
    year: now.getFullYear(),
    incomes: [],
    categories: [],
    transactions: [],
    nextId: 1,
  };
}

// ─── PERSISTENCE (file-backed, via AquilatePersistence / Tauri fs) ───
// State now lives in a real file in the OS app-data folder (see
// persistence.js). saveState() is async and fires a rolling backup before
// every write. render() no longer awaits it inline (many call sites do
// `render(); pulseCards(...); showSuccessToast(...)` synchronously) — instead
// it kicks off the save and tracks it as `pendingSave`, a promise resolving
// to true/false, which showSuccessToast() awaits before deciding whether to
// tell the user their entry was saved.
let pendingSave = Promise.resolve(true);
let lastSaveOk = true;

async function saveState() {
  const result = await window.AquilatePersistence.saveStateToFile(state);
  lastSaveOk = result.ok;
  if (result.ok) {
    updateLastBackedUpLabel(result.lastBackedUpAt);
  }
  return result.ok;
}

// Called once at startup (see init() near the bottom of this file). Returns
// the loaded state, or null if this is a fresh install with nothing saved
// yet — the caller falls back to defaultState() in that case. If the file
// exists but is corrupted, this does NOT return a fallback state — it shows
// the recovery modal and never resolves the normal startup path, matching
// "stop and ask" rather than "silently reset."
async function loadState() {
  const result = await window.AquilatePersistence.loadStateFromFile();
  if (result.corrupted) {
    await showCorruptedFileRecovery(result.reason);
    // showCorruptedFileRecovery only returns once the user has restored a
    // backup (which rewrites the primary file), so re-read it now.
    return await loadState();
  }
  return result.state; // possibly null — caller supplies defaultState()
}

// ─── THEME ───
function loadTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return (t === 'dark' || t === 'light') ? t : 'light';
  } catch (e) { return 'light'; }
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}
function setTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); }
  catch (e) { console.warn('Theme save failed:', e); }
  // Refresh settings popup if open to reflect selection
  const popup = document.getElementById('settingsPopup');
  if (popup && popup.style.display === 'block') renderSettingsPopup();
}

// ─── STATE ───
// Populated asynchronously by init() at the bottom of this file, once the
// file-backed load (and any corrupted-file recovery) has completed. Nothing
// above this line touches `state`, and render()/all action handlers are
// only reachable after init() finishes, so this is safe to leave undefined
// until then.
let state;

// Track which category menu is open
let openMenuCatId = null;

// ─── HELPERS ───
function currentMonthKey() {
  return `${state.year}-${String(state.month).padStart(2,'0')}`;
}
function txnsForCurrentMonth() {
  return state.transactions.filter(t => t.monthKey === currentMonthKey());
}
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtMoney(n) {
  return '$' + Math.abs(n).toFixed(2);
}

/* ── Count-up animation for sidebar totals ── */
function parseMoneyText(s) {
  if (!s) return 0;
  const neg = s.trim().startsWith('-');
  const num = parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0;
  return neg ? -num : num;
}
function animateMoneyValue(el, toValue, signed) {
  if (!el) return;
  const fromValue = parseMoneyText(el.textContent);
  if (Math.abs(fromValue - toValue) < 0.005) {
    el.textContent = (signed && toValue < 0 ? '-' : '') + fmtMoney(toValue);
    return;
  }
  const duration = 320;
  const start = performance.now();
  function step(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const current = fromValue + (toValue - fromValue) * eased;
    el.textContent = (signed && current < 0 ? '-' : '') + fmtMoney(current);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = (signed && toValue < 0 ? '-' : '') + fmtMoney(toValue);
  }
  requestAnimationFrame(step);
}

/* ── Pulse feedback on the card(s) affected by the entry just logged ── */
function pulseCards(catIds) {
  const uniqueIds = Array.from(new Set(catIds));
  uniqueIds.forEach(id => {
    const domId = id === UNALLOC_ID ? 'card-unalloc' : 'card-' + id;
    const el = document.getElementById(domId);
    if (!el) return;
    el.classList.remove('just-logged');
    void el.offsetWidth;
    el.classList.add('just-logged');
    setTimeout(() => el.classList.remove('just-logged'), 650);
  });
}
function todayLabel() {
  return MONTHS[state.month].slice(0,3) + ' ' + new Date().getDate();
}

// Collect all known transaction descriptions (most recent first, de-duplicated)
function allDescriptions() {
  const seen = new Set();
  const out = [];
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const d = (state.transactions[i].desc || '').trim();
    if (d && !seen.has(d.toLowerCase())) {
      seen.add(d.toLowerCase());
      out.push(d);
    }
  }
  return out;
}

// Net balance a category has ever held — every income and expense logged
// against it, across all months, not just the one currently in view. This
// is the number shown against a category's target: spending from the
// category reduces it, same as it reduces the on-screen running balance.
function categoryTargetProgress(catId) {
  return state.transactions
    .filter(t => t.catId === catId)
    .reduce((s, t) => s + t.amount, 0);
}

// Find a pinned income whose name matches a typed description (case-insensitive)
function findPinnedIncomeByDesc(desc) {
  const norm = (desc || '').trim().toLowerCase();
  if (!norm) return null;
  return state.incomes.find(i => i.name.trim().toLowerCase() === norm) || null;
}

// ─── RENDER ───
function render() {
  const mk = MONTHS[state.month] + ' ' + state.year;
  document.getElementById('monthLabel').textContent = mk;
  document.getElementById('summaryMonthLabel').textContent =
    MONTHS[state.month].slice(0,3) + ' ' + state.year;
  renderIncomes();
  renderSummary();
  renderCatTotals();
  renderCategories();

  // Fire-and-track: saveState() is async (file + backup I/O). We don't
  // await it here since render() itself must stay synchronous for all the
  // existing `closeModal(); render(); pulseCards(...); showSuccessToast(...)`
  // call sites to keep working unmodified. showSuccessToast() awaits this
  // promise before deciding whether to claim the entry was saved.
  pendingSave = saveState().then(ok => {
    if (!ok) showSaveErrorBanner();
    else hideSaveErrorBanner();
    return ok;
  });
}

// Persistent (non-auto-hiding) banner shown when a write to localStorage
// fails, so the user is never left believing an entry was saved when it
// wasn't. Distinct from the toast, which is only for confirmed successes.
function showSaveErrorBanner() {
  let banner = document.getElementById('saveErrorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'saveErrorBanner';
    banner.className = 'save-error-banner';
    banner.innerHTML = `<span>⚠ Your last change couldn't be saved. Storage may be full or unavailable — free up space or export a backup before continuing.</span>`;
    document.body.appendChild(banner);
  }
  banner.classList.add('show');
}
function hideSaveErrorBanner() {
  const banner = document.getElementById('saveErrorBanner');
  if (banner) banner.classList.remove('show');
}

// ── Sidebar: Pinned Incomes ──
function renderIncomes() {
  const el = document.getElementById('incomeList');
  if (state.incomes.length === 0) {
    el.innerHTML = '<div class="income-empty-hint">No sources pinned</div>';
    return;
  }
  el.innerHTML = state.incomes.map(inc => `
    <div class="income-row" onclick="openIncomeDistModal(${inc.id})">
      <div class="income-row-name">${escHtml(inc.name)}</div>
      <div class="income-row-amount">${fmtMoney(inc.amount)}</div>
      <button class="income-row-del" title="Remove"
        onclick="deleteIncome(event,${inc.id})">✕</button>
    </div>`).join('');
}

// ── Sidebar: Summary ──
function renderSummary() {
  const txns = txnsForCurrentMonth();
  const totalIn  = txns.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const totalOut = txns.filter(t=>t.type==='expense').reduce((s,t)=>s+Math.abs(t.amount),0);
  const bal = totalIn - totalOut;
  animateMoneyValue(document.getElementById('totalIncome'), totalIn, false);
  animateMoneyValue(document.getElementById('totalExpenses'), totalOut, false);
  animateMoneyValue(document.getElementById('currentBalance'), bal, true);
}

// ── Sidebar: Category totals ──
function renderCatTotals() {
  const el = document.getElementById('catTotalsList');
  const monthTxns = txnsForCurrentMonth();
  const totalPct = state.categories.reduce((s,c) => s + c.pct, 0);
  const unallocNet = monthTxns.filter(t=>t.catId===UNALLOC_ID).reduce((s,t)=>s+t.amount,0);

  let html = state.categories.map(cat => {
    const net = monthTxns.filter(t=>t.catId===cat.id).reduce((s,t)=>s+t.amount,0);
    return `
      <div class="cat-total-row">
        <span class="cat-total-name">${escHtml(cat.name)}</span>
        <span class="cat-total-pct">${cat.pct}%</span>
        <span class="cat-total-val">${fmtMoney(net)}</span>
      </div>`;
  }).join('');

  // Show Unallocated whenever categories exist but don't cover 100% (so the
  // gap is visible even before income is logged), or whenever money has
  // actually landed there. Don't show it just because no categories exist
  // yet — that's the normal pre-setup empty state, not a shortfall.
  if ((state.categories.length > 0 && totalPct < 100) || unallocNet !== 0) {
    html += `
      <div class="cat-total-row cat-total-unalloc" title="Income not covered by any category's allocation">
        <span class="cat-total-name">Unallocated</span>
        <span class="cat-total-pct">${100 - totalPct}%</span>
        <span class="cat-total-val">${fmtMoney(unallocNet)}</span>
      </div>`;
  }

  el.innerHTML = html;
}

// Determine the id of the last income transaction and last expense transaction
// for a given month, across ALL categories (used for end-of-month markers).
// Wait until next month appears before highlighting the past month's actions.
function endOfMonthMarkers(monthKey) {
  let lastIncomeId = null, lastExpenseId = null;

  // Only evaluate markers if the active screen's month is fully in the past
  const now = new Date();
  const realCurrentYear = now.getFullYear();
  const realCurrentMonth = now.getMonth();

  if (state.year < realCurrentYear || (state.year === realCurrentYear && state.month < realCurrentMonth)) {
    const txns = state.transactions.filter(t => t.monthKey === monthKey);
    for (let i = 0; i < txns.length; i++) {
      const t = txns[i];
      if (t.type === 'income')  lastIncomeId  = t.id;
      if (t.type === 'expense') lastExpenseId = t.id;
    }
  }

  return { lastIncomeId, lastExpenseId };
}

// Swaps category ordering slots
function moveCategory(fromIndex, toIndex) {
  if (toIndex < 0 || toIndex >= state.categories.length) return;
  const temp = state.categories[fromIndex];
  state.categories[fromIndex] = state.categories[toIndex];
  state.categories[toIndex] = temp;
  render();
}

// ── Main grid: Category cards ──
function renderCategories() {
  const grid = document.getElementById('categoriesGrid');

  const monthTxns = txnsForCurrentMonth();
  const totalPct = state.categories.reduce((s,c) => s + c.pct, 0);
  const hasUnallocTxns = state.transactions.some(t => t.catId === UNALLOC_ID);
  const showUnallocCard = (state.categories.length > 0 && totalPct < 100) || hasUnallocTxns;

  if (state.categories.length === 0 && !showUnallocCard) {
    grid.innerHTML = `<div class="grid-empty-hint">Add a category to begin</div>`;
    return;
  }

  const { lastIncomeId, lastExpenseId } = endOfMonthMarkers(currentMonthKey());

  let cardsHtml = state.categories.map((cat, i) => {
    const txns = monthTxns.filter(t => t.catId === cat.id);

    // Compute running balance rows
    let running = 0;
    const rows = txns.map(t => {
      running += t.amount;
      const changeClass = t.amount >= 0 ? 'pos' : 'neg';
      const changeStr   = (t.amount >= 0 ? '+' : '−') + fmtMoney(t.amount);
      const isMarker = (t.id === lastIncomeId) || (t.id === lastExpenseId);
      const markerClass = isMarker ? ' eom-marker' : '';
      const markerTitle = isMarker ? ' title="Final ' + (t.type === 'income' ? 'income' : 'expense') + ' of the month"' : '';
      const descCell = t.desc
        ? `<div class="td desc" title="${escHtml(t.desc)}">${escHtml(t.desc)}</div>`
        : `<div class="td desc"></div>`;
      return `
        <div class="tr${markerClass}"${markerTitle}>
          <div class="td date">${escHtml(t.date)}</div>
          ${descCell}
          <div class="td change ${changeClass}">${changeStr}</div>
          <div class="td balance">${fmtMoney(running)}</div>
          <div class="td del-cell">
            <button class="tr-del-btn" onclick="deleteTransaction(event,${t.id})">✕</button>
          </div>
        </div>`;
    }).join('');

    const disableLeft = (i === 0) ? 'disabled' : '';
    const disableRight = (i === state.categories.length - 1) ? 'disabled' : '';

    // Spend progress: how much of what landed in this category this month has been spent.
    const catIncome = txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const catSpent = txns.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(t.amount), 0);
    let spendBarHtml = '';
    if (catIncome > 0 || catSpent > 0) {
      const pctUsed = catIncome > 0 ? Math.min(100, (catSpent / catIncome) * 100) : 100;
      const overBudget = catSpent > catIncome;
      spendBarHtml = `
        <div class="cat-spend-bar-wrap" title="${fmtMoney(catSpent)} spent of ${fmtMoney(catIncome)} allocated this month">
          <div class="cat-spend-bar-fill${overBudget ? ' over' : ''}" style="width:${pctUsed}%"></div>
        </div>`;
    }

    const targetHtml = renderCategoryTarget(cat);

    return `
      <div class="cat-card" id="card-${cat.id}">
        <div class="cat-header">
          <div class="cat-header-left">
            <span class="cat-name">${escHtml(cat.name)}</span>
            <span class="cat-meta">${cat.pct}% allocation</span>
          </div>
          <div class="cat-header-right" style="position:relative">
            <button class="cat-move-btn" ${disableLeft} onclick="moveCategory(${i}, ${i - 1})" title="Move left">&lt;</button>
            <button class="cat-move-btn" ${disableRight} onclick="moveCategory(${i}, ${i + 1})" title="Move right">&gt;</button>
            <button class="cat-menu-btn"
              onclick="toggleCatMenu(event,'${cat.id}')"
              title="Options">⋮</button>
            <div class="cat-menu-popup" id="menu-${cat.id}" style="display:none">
              <button class="cat-menu-popup-item"
                onclick="openModal('edit-category','${cat.id}')">Edit name &amp; allocation</button>
              <div class="cat-menu-popup-sep"></div>
              <button class="cat-menu-popup-item danger"
                onclick="confirmDeleteCategory('${cat.id}')">Delete category</button>
            </div>
          </div>
        </div>
        ${spendBarHtml}
        ${targetHtml}

        <div class="cat-table">
          <div class="table-head-primary">
            <span class="th">Date</span>
            <span class="th">Desc</span>
            <span class="th">Amount</span>
            <span class="th right">Balance</span>
            <span class="th"></span>
          </div>
          <div class="table-head-secondary">
            <span class="th-sub">When</span>
            <span class="th-sub">Added / taken</span>
            <span class="th-sub right">Running total</span>
            <span class="th-sub"></span>
          </div>
          <div class="table-body" id="tbody-${cat.id}">${rows}</div>
        </div>

        <div class="cat-footer">
          <button class="cat-footer-btn"
            onclick="openModal('cat-income','${cat.id}')">+ Add income</button>
          <button class="cat-footer-btn"
            onclick="openModal('cat-expense','${cat.id}')">− Log expense</button>
        </div>
      </div>`;
  }).join('');

  if (showUnallocCard) {
    const unallocTxns = monthTxns.filter(t => t.catId === UNALLOC_ID);
    cardsHtml += renderUnallocCard(unallocTxns, lastIncomeId, lastExpenseId, totalPct);
  }

  grid.innerHTML = cardsHtml;

  // Scroll each table body to the latest entry
  document.querySelectorAll('.table-body').forEach(b => { b.scrollTop = b.scrollHeight; });
}

// Formats a stored 'YYYY-MM' target date as e.g. "Dec 2026" for display.
// Purely informational — never used to judge progress against the target.
function fmtTargetDate(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return '';
  return MONTHS[m - 1].slice(0, 3) + ' ' + y;
}

// Renders a category's target progress: current all-time net balance vs.
// the target amount, as a plain "X / Y · Z%" line + bar. Nothing shows if
// no target is set — a category without a target renders exactly as it
// always has.
function renderCategoryTarget(cat) {
  if (cat.target == null || cat.target <= 0) return '';
  const progress = categoryTargetProgress(cat.id);
  const pct = Math.max(0, Math.min(100, (progress / cat.target) * 100));
  const reached = progress >= cat.target;
  const dateLabel = fmtTargetDate(cat.targetDate);
  return `
    <div class="cat-target-wrap">
      <div class="cat-target-row">
        <span class="cat-target-amounts">${fmtMoney(Math.max(0, progress))} / ${fmtMoney(cat.target)}</span>
        <span class="cat-target-pct${reached ? ' reached' : ''}">${Math.round(pct)}%</span>
      </div>
      <div class="cat-target-bar-wrap">
        <div class="cat-target-bar-fill${reached ? ' reached' : ''}" style="width:${pct}%"></div>
      </div>
      ${dateLabel ? `<div class="cat-target-date">Target date: ${dateLabel}</div>` : ''}
    </div>`;
}

// Renders the Unallocated bucket as its own card in the main grid — same
// transaction-row shape as a normal category card, but read-only (no
// reorder/edit/delete-category controls, since it isn't a real category).
function renderUnallocCard(txns, lastIncomeId, lastExpenseId, totalPct) {
  let running = 0;
  const rows = txns.map(t => {
    running += t.amount;
    const changeClass = t.amount >= 0 ? 'pos' : 'neg';
    const changeStr   = (t.amount >= 0 ? '+' : '−') + fmtMoney(t.amount);
    const isMarker = (t.id === lastIncomeId) || (t.id === lastExpenseId);
    const markerClass = isMarker ? ' eom-marker' : '';
    const markerTitle = isMarker ? ' title="Final ' + (t.type === 'income' ? 'income' : 'expense') + ' of the month"' : '';
    const descCell = t.desc
      ? `<div class="td desc" title="${escHtml(t.desc)}">${escHtml(t.desc)}</div>`
      : `<div class="td desc"></div>`;
    return `
      <div class="tr${markerClass}"${markerTitle}>
        <div class="td date">${escHtml(t.date)}</div>
        ${descCell}
        <div class="td change ${changeClass}">${changeStr}</div>
        <div class="td balance">${fmtMoney(running)}</div>
        <div class="td del-cell">
          <button class="tr-del-btn" onclick="deleteTransaction(event,${t.id})">✕</button>
        </div>
      </div>`;
  }).join('');

  const emptyHint = `<div class="grid-empty-hint" style="padding:20px 0">No income has landed here.</div>`;

  return `
    <div class="cat-card cat-card-unalloc" id="card-unalloc">
      <div class="cat-header">
        <div class="cat-header-left">
          <span class="cat-name">Unallocated</span>
          <span class="cat-meta">${100 - totalPct}% of income has no category</span>
        </div>
      </div>

      <div class="cat-table">
        <div class="table-head-primary">
          <span class="th">Date</span>
          <span class="th">Desc</span>
          <span class="th">Amount</span>
          <span class="th right">Balance</span>
          <span class="th"></span>
        </div>
        <div class="table-head-secondary">
          <span class="th-sub">When</span>
          <span class="th-sub">Added / taken</span>
          <span class="th-sub right">Running total</span>
          <span class="th-sub"></span>
        </div>
        <div class="table-body" id="tbody-unalloc">${rows || emptyHint}</div>
      </div>

      <div class="cat-footer">
        <span class="cat-footer-note">Add or expand categories to allocate this money — nothing here is lost.</span>
      </div>
    </div>`;
}

// ─── CATEGORY MENU ───
function toggleCatMenu(e, catId) {
  e.stopPropagation();
  const popup = document.getElementById('menu-' + catId);
  if (!popup) return;
  const isOpen = popup.style.display === 'block';
  closeAllMenus();
  if (!isOpen) {
    popup.style.display = 'block';
    openMenuCatId = catId;
  }
}
function closeAllMenus() {
  document.querySelectorAll('.cat-menu-popup').forEach(p => p.style.display = 'none');
  openMenuCatId = null;
  closeSettingsPopup();
  closeAllMonthYearPickers();
}
document.addEventListener('click', () => closeAllMenus());

// ─── MONTH NAV ───
function changeMonth(dir) {
  state.month += dir;
  if (state.month > 11) { state.month = 0; state.year++; }
  if (state.month < 0)  { state.month = 11; state.year--; }

  const grid = document.getElementById('categoriesGrid');
  if (grid) {
    grid.classList.add('grid-transitioning');
    setTimeout(() => {
      render();
      grid.classList.remove('grid-transitioning');
    }, 130);
  } else {
    render();
  }
}

// ─── SETTINGS ───
function toggleSettings(e) {
  e.stopPropagation();
  const popup = document.getElementById('settingsPopup');
  if (!popup) return;
  const isOpen = popup.style.display === 'block';
  closeAllMenus();
  if (!isOpen) {
    renderSettingsPopup();
    popup.style.display = 'block';
  }
}
function closeSettingsPopup() {
  const popup = document.getElementById('settingsPopup');
  if (popup) popup.style.display = 'none';
}
function renderSettingsPopup() {
  const popup = document.getElementById('settingsPopup');
  if (!popup) return;
  const current = loadTheme();
  popup.innerHTML = `
    <div class="settings-popup-title">Appearance</div>
    <button class="settings-option ${current === 'light' ? 'active' : ''}"
      onclick="event.stopPropagation(); setTheme('light')">
      <span>Light theme</span>${current === 'light' ? '<span class="settings-check">✓</span>' : ''}
    </button>
    <button class="settings-option ${current === 'dark' ? 'active' : ''}"
      onclick="event.stopPropagation(); setTheme('dark')">
      <span>Dark theme</span>${current === 'dark' ? '<span class="settings-check">✓</span>' : ''}
    </button>
    <div class="settings-popup-title" style="margin-top:10px">Data</div>
    <div class="settings-popup-note">Your data is stored only on this device and never leaves it. Export a backup anytime.</div>
    <button class="settings-option" onclick="event.stopPropagation(); exportBackupJSON()">
      <span>Export backup (.json)</span>
    </button>
    <button class="settings-option" onclick="event.stopPropagation(); exportTransactionsCSV()">
      <span>Export transactions (.csv)</span>
    </button>
    <button class="settings-option" onclick="event.stopPropagation(); triggerImportBackup()">
      <span>Import backup…</span>
    </button>
    <input type="file" id="importFileInput" accept="application/json"
      style="display:none" onchange="importBackupJSON(event)" onclick="event.stopPropagation()" />`;
}

// ─── CORRUPTED FILE RECOVERY ───
// Shown at startup, before init() proceeds, if the primary data file exists
// but fails to parse/validate. Never falls back to an empty state on its
// own — the user must explicitly pick a backup (or, if they truly want a
// clean slate, that's a separate deliberate action, not this modal's job).
// Resolves once a backup has been restored and the primary file rewritten.
function showCorruptedFileRecovery(reason) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const content = document.getElementById('modalContent');

    const reasonText = reason === 'parse-error'
      ? "couldn't be read as valid JSON"
      : "doesn't look like a valid Aquilate save";

    window.AquilatePersistence.listBackups().then(backups => {
      const backupRows = backups.length
        ? backups.map(name => `
            <button class="settings-option" onclick="event.stopPropagation(); restoreRecoveryBackup('${name.replace(/'/g,"\\'")}')">
              <span>${escHtml(name)}</span>
            </button>`).join('')
        : `<div class="modal-note">No backups were found either — there's nothing to restore from yet.</div>`;

      content.innerHTML = `
        <div class="modal-title">Your data file ${reasonText}</div>
        <p style="color:var(--ink-2);font-size:11.9px;line-height:1.6;margin-bottom:10px">
          Aquilate stopped instead of silently starting over, since that file
          may still hold your real history. Pick a backup below to restore
          from — newest first.
        </p>
        <div class="dist-preview">${backupRows}</div>
      `;
      overlay.classList.add('open');
      window.__recoveryResolve = resolve;
    });
  });
}

async function restoreRecoveryBackup(filename) {
  try {
    const result = await window.AquilatePersistence.restoreFromBackup(filename);
    if (!result.ok) {
      alert("Restoring that backup failed: " + (result.error || 'unknown error') + ". Try a different backup.");
      return;
    }
    document.getElementById('modalOverlay').classList.remove('open');
    const resolve = window.__recoveryResolve;
    window.__recoveryResolve = null;
    if (resolve) resolve();
  } catch (e) {
    alert("Restoring that backup failed: " + String(e) + ". Try a different backup.");
  }
}

// ─── LAST BACKED UP INDICATOR ───
let lastBackedUpAtISO = null;
let lastBackedUpTimer = null;

function updateLastBackedUpLabel(iso) {
  lastBackedUpAtISO = iso || lastBackedUpAtISO;
  const el = document.getElementById('lastBackedUpLabel');
  if (!el) return;
  if (!lastBackedUpAtISO) { el.textContent = ''; return; }
  el.textContent = 'Backed up ' + relativeTimeFrom(lastBackedUpAtISO);
  el.title = new Date(lastBackedUpAtISO).toLocaleString();
}

function relativeTimeFrom(iso) {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hrs / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}

// Keep the relative-time text ("2 minutes ago") ticking even with no new
// saves happening.
function startLastBackedUpTicker() {
  if (lastBackedUpTimer) clearInterval(lastBackedUpTimer);
  lastBackedUpTimer = setInterval(() => updateLastBackedUpLabel(), 30000);
}

// ─── EXPORT / IMPORT ───
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportBackupJSON() {
  const dateStamp = new Date().toISOString().slice(0,10);
  downloadFile(`aquilate-backup-${dateStamp}.json`, JSON.stringify(state, null, 2), 'application/json');
  closeAllMenus();
  showToast('Backup exported');
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportTransactionsCSV() {
  const catNameById = {};
  state.categories.forEach(c => { catNameById[c.id] = c.name; });
  catNameById[UNALLOC_ID] = 'Unallocated';

  const header = ['Date','Month','Category','Description','Type','Amount'];
  const rows = state.transactions.map(t => [
    t.date,
    t.monthKey,
    catNameById[t.catId] || t.catId,
    t.desc || '',
    t.type,
    t.amount
  ]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');

  const dateStamp = new Date().toISOString().slice(0,10);
  downloadFile(`aquilate-transactions-${dateStamp}.csv`, csv, 'text/csv');
  closeAllMenus();
  showToast('Transactions exported');
}

function triggerImportBackup() {
  const input = document.getElementById('importFileInput');
  if (input) input.click();
}

function importBackupJSON(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (e) {
      alert('That file isn\'t valid JSON — import cancelled.');
      return;
    }
    const looksValid = parsed && typeof parsed.month === 'number' &&
      Array.isArray(parsed.incomes) && Array.isArray(parsed.categories) &&
      Array.isArray(parsed.transactions);
    if (!looksValid) {
      alert('That file doesn\'t look like an Aquilate backup — import cancelled.');
      return;
    }
    if (!confirm('Importing will replace all current data in this workspace with the backup. This can\'t be undone. Continue?')) {
      return;
    }
    state = parsed;
    closeAllMenus();
    render();
    showSuccessToast('Backup imported');
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ─── MODALS ───
function openModal(type, data) {
  closeAllMenus();
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');

  // ── Add income source ──
  if (type === 'income') {
    content.innerHTML = `
      <div class="modal-title">Add Income Source</div>
      <div class="field"><label>Name</label>
        <input id="mi-name" placeholder="e.g. Monthly Salary" autofocus /></div>
      <div class="field"><label>Amount ($)</label>
        <input id="mi-amount" type="number" min="0" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Type</label>
        <select id="mi-type">
          <option value="Recurring">Recurring</option>
          <option value="Manual">Manual</option>
          <option value="One-time">One-time</option>
        </select></div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="addIncome()">Add</button>
      </div>`;

  // ── Income distribution preview (clicking a pinned income) ──
  } else if (type === 'income-dist') {
    const src = state.incomes.find(i => i.id === data);
    if (!src) return;
    const distRows = state.categories.map(cat => {
      const share = parseFloat((src.amount * cat.pct / 100).toFixed(2));
      return `<div class="dist-row">
        <span class="dist-row-name">${escHtml(cat.name)}</span>
        <span class="dist-row-pct">${cat.pct}%</span>
        <input class="dist-row-input" type="number" min="0" step="0.01"
          id="dist-amt-${cat.id}" value="${share}"
          oninput="refreshUnallocPreview(${src.id})" />
      </div>`;
    }).join('');
    content.innerHTML = `
      <div class="modal-title">Distribute ${escHtml(src.name)}</div>
      <div class="field"><label>Amount ($)</label>
        <input id="id-amount" type="number" min="0" step="0.01"
          value="${src.amount}" oninput="refreshDistPreview(${src.id})" /></div>
      <div class="field"><label>Date</label>
        <input id="id-date" placeholder="${todayLabel()}" /></div>
      <div class="modal-note" style="margin-top:0">Edit the amount per category if needed</div>
      <div class="dist-preview" id="distPreview">${distRows}</div>
      <div class="dist-unalloc" id="distUnalloc"></div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="applyIncomeDist(${src.id})">Apply</button>
      </div>`;
    refreshUnallocPreview(src.id);

  // ── Log income (manual entry, redesigned) ──
  } else if (type === 'income-entry') {
    if (state.categories.length === 0) {
      showToast('Add a category first.');
      return;
    }
    content.innerHTML = `
      <div class="modal-title">Log Income</div>
      <div class="field autocomplete-field"><label>Description</label>
        <input id="lie-desc" placeholder="e.g. Monthly Salary" autocomplete="off"
          oninput="updateDescSuggestions('lie-desc')"
          onfocus="updateDescSuggestions('lie-desc')" autofocus />
        <div class="ac-suggestions" id="lie-desc-suggestions"></div></div>
      <div class="field"><label>Amount ($)</label>
        <input id="lie-amount" type="number" min="0" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Date</label>
        <input id="lie-date" placeholder="${todayLabel()}" /></div>
      <div class="modal-note">If this matches a pinned income, it'll be split across categories using that source's allocation.</div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="logIncome()">Log</button>
      </div>`;

  // ── Log expense (global) ──
  } else if (type === 'expense') {
    if (state.categories.length === 0) {
      showToast('Add a category first.');
      return;
    }
    content.innerHTML = `
      <div class="modal-title">Log Expense</div>
      <div class="field"><label>Category</label>
        <select id="me-cat">
          ${state.categories.map(c=>`<option value="${c.id}">${escHtml(c.name)} (${c.pct}%)</option>`).join('')}
        </select></div>
      <div class="field autocomplete-field"><label>Description</label>
        <input id="me-desc" placeholder="e.g. Groceries" autocomplete="off"
          oninput="updateDescSuggestions('me-desc')"
          onfocus="updateDescSuggestions('me-desc')" autofocus />
        <div class="ac-suggestions" id="me-desc-suggestions"></div></div>
      <div class="field"><label>Amount ($)</label>
        <input id="me-amount" type="number" min="0" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Date</label>
        <input id="me-date" placeholder="${todayLabel()}" /></div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="addExpense()">Log</button>
      </div>`;

  // ── Add income to specific category ──
  } else if (type === 'cat-income') {
    const cat = state.categories.find(c => c.id === data);
    if (!cat) return;
    content.innerHTML = `
      <div class="modal-title">Add Income — ${escHtml(cat.name)}</div>
      <div class="field autocomplete-field"><label>Description</label>
        <input id="ci-desc" placeholder="e.g. Salary" autocomplete="off"
          oninput="updateDescSuggestions('ci-desc')"
          onfocus="updateDescSuggestions('ci-desc')" autofocus />
        <div class="ac-suggestions" id="ci-desc-suggestions"></div></div>
      <div class="field"><label>Amount ($)</label>
        <input id="ci-amount" type="number" min="0" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Date</label>
        <input id="ci-date" placeholder="${todayLabel()}" /></div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="addDirectIncome('${cat.id}')">Add</button>
      </div>`;

  // ── Log expense in specific category ──
  } else if (type === 'cat-expense') {
    const cat = state.categories.find(c => c.id === data);
    if (!cat) return;
    content.innerHTML = `
      <div class="modal-title">Log Expense — ${escHtml(cat.name)}</div>
      <div class="field autocomplete-field"><label>Description</label>
        <input id="ce-desc" placeholder="e.g. Groceries" autocomplete="off"
          oninput="updateDescSuggestions('ce-desc')"
          onfocus="updateDescSuggestions('ce-desc')" autofocus />
        <div class="ac-suggestions" id="ce-desc-suggestions"></div></div>
      <div class="field"><label>Amount ($)</label>
        <input id="ce-amount" type="number" min="0" step="0.01" placeholder="0.00" /></div>
      <div class="field"><label>Date</label>
        <input id="ce-date" placeholder="${todayLabel()}" /></div>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="addDirectExpense('${cat.id}')">Log</button>
      </div>`;

  // ── Add category ──
  } else if (type === 'category') {
    const used = state.categories.reduce((s,c) => s + c.pct, 0);
    const rem  = 100 - used;
    content.innerHTML = `
      <div class="modal-title">Add Category</div>
      <div class="field"><label>Name</label>
        <input id="mc-name" placeholder="e.g. Savings" autofocus /></div>
      <div class="field"><label>Allocation %</label>
        <input id="mc-pct" type="number" min="1" max="${rem}" placeholder="${rem}" /></div>
      <div class="modal-note" id="allocFeedback">${used}% allocated — ${rem}% remaining</div>
      ${targetSectionHtml('mc', null, null)}
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="addCategory()">Add</button>
      </div>`;
    initMonthYearPicker('mc', null);

  // ── Edit category (name + %) ──
  } else if (type === 'edit-category') {
    const cat = state.categories.find(c => c.id === data);
    if (!cat) return;
    const usedExcl = state.categories.filter(c=>c.id!==data).reduce((s,c)=>s+c.pct,0);
    const maxPct   = 100 - usedExcl;
    content.innerHTML = `
      <div class="modal-title">Edit Category</div>
      <div class="field"><label>Name</label>
        <input id="ec-name" value="${escHtml(cat.name)}" autofocus /></div>
      <div class="field"><label>Allocation %</label>
        <input id="ec-pct" type="number" min="1" max="${maxPct}" value="${cat.pct}" /></div>
      <div class="modal-note">Max available: ${maxPct}%</div>
      ${targetSectionHtml('ec', cat.target, cat.targetDate)}
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="saveEditCategory('${cat.id}')">Save</button>
      </div>`;
    initMonthYearPicker('ec', cat.targetDate || null);

  // ── Confirm delete category ──
  } else if (type === 'confirm-delete-category') {
    const cat = state.categories.find(c => c.id === data);
    if (!cat) return;
    const n = state.transactions.filter(t => t.catId === cat.id).length;
    content.innerHTML = `
      <div class="modal-title">Delete Category</div>
      <p style="color:var(--ink-2);font-size:11.9px;line-height:1.6;margin-bottom:3.4px">
        Delete <strong>${escHtml(cat.name)}</strong>?
        ${n > 0 ? `<br><span style="color:var(--red);font-size:11px">${n} transaction${n!==1?'s':''} will also be removed.</span>` : ''}
      </p>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-danger" onclick="deleteCategory('${cat.id}')">Delete</button>
      </div>`;
  }

  overlay.classList.add('open');
}

// ─── DESCRIPTION AUTOCOMPLETE ───
function updateDescSuggestions(inputId) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(inputId + '-suggestions');
  if (!input || !box) return;
  const val = input.value.trim().toLowerCase();
  if (!val) { box.innerHTML = ''; box.style.display = 'none'; return; }
  const matches = allDescriptions()
    .filter(d => d.toLowerCase().includes(val))
    .slice(0, 6);
  if (matches.length === 0) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.innerHTML = matches.map(m =>
    `<div class="ac-suggestion" onmousedown="selectDescSuggestion('${inputId}','${m.replace(/'/g,"\\'")}')">${escHtml(m)}</div>`
  ).join('');
  box.style.display = 'block';
}
function selectDescSuggestion(inputId, value) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(inputId + '-suggestions');
  if (input) input.value = value;
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }

  // Repeat-entry: pre-fill the amount from the last time this exact
  // description was logged, so a recurring entry is pick-then-confirm
  // instead of pick-then-retype. Pre-selected so overtyping it is one step.
  const amountEl = document.getElementById(inputId.replace('-desc', '-amount'));
  if (amountEl) {
    const last = lastAmountForDesc(value);
    if (last != null) {
      amountEl.value = last;
      amountEl.focus();
      amountEl.select();
    } else {
      amountEl.focus();
    }
  }
}

function lastAmountForDesc(desc) {
  const norm = (desc || '').trim().toLowerCase();
  if (!norm) return null;
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const t = state.transactions[i];
    if ((t.desc || '').trim().toLowerCase() === norm) return Math.abs(t.amount);
  }
  return null;
}

// Rebuild distribution preview as user edits the total amount field
function refreshDistPreview(srcId) {
  const amountEl = document.getElementById('id-amount');
  const amount = parseFloat(amountEl.value) || 0;
  state.categories.forEach(cat => {
    const share = parseFloat((amount * cat.pct / 100).toFixed(2));
    const inp = document.getElementById('dist-amt-' + cat.id);
    if (inp) inp.value = share;
  });
  refreshUnallocPreview(srcId);
}

// Recompute unallocated note based on the (possibly edited) per-category amounts
function refreshUnallocPreview(srcId) {
  const amountEl = document.getElementById('id-amount');
  const amount = parseFloat(amountEl.value) || 0;
  let allocated = 0;
  state.categories.forEach(cat => {
    const inp = document.getElementById('dist-amt-' + cat.id);
    const v = inp ? (parseFloat(inp.value) || 0) : 0;
    allocated += v;
  });
  const remainder = parseFloat((amount - allocated).toFixed(2));
  const note = document.getElementById('distUnalloc');
  if (!note) return;
  if (Math.abs(remainder) >= 0.01) {
    note.textContent = (remainder > 0 ? fmtMoney(remainder) + ' unallocated' : fmtMoney(remainder) + ' over-allocated');
  } else {
    note.textContent = '';
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}
function closeModalOnBg(e) {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
}

// ─── INCOME ACTIONS ───
function addIncome() {
  const name   = document.getElementById('mi-name').value.trim();
  const amount = parseFloat(document.getElementById('mi-amount').value);
  const type   = document.getElementById('mi-type').value;
  if (!name) { showToast('Enter a name.'); return; }
  if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount.'); return; }
  state.incomes.push({ id: state.nextId++, name, amount, type });
  closeModal(); render();
  showSuccessToast(`"${name}" added`);
}

function deleteIncome(e, id) {
  e.stopPropagation();
  const src = state.incomes.find(i => i.id === id);
  if (!src) return;
  state.incomes = state.incomes.filter(i => i.id !== id);
  render();
  showSuccessToast(`"${src.name}" removed`);
}

// Click on pinned income → open distribution preview modal (now editable)
function openIncomeDistModal(id) {
  if (state.categories.length === 0) {
    showToast('Add a category first.');
    return;
  }
  openModal('income-dist', id);
}

// Apply distribution after preview confirmation — uses the (possibly edited)
// per-category amounts entered in the modal.
function applyIncomeDist(srcId) {
  const dateInput = document.getElementById('id-date');
  const date = dateInput.value.trim() || todayLabel();
  const src  = state.incomes.find(i => i.id === srcId);
  const label = src ? src.name : 'Income';
  const mk = currentMonthKey();
  let totalApplied = 0;
  const touchedIds = [];

  state.categories.forEach(cat => {
    const inp = document.getElementById('dist-amt-' + cat.id);
    const amt = inp ? parseFloat(inp.value) : NaN;
    if (!isNaN(amt) && amt !== 0) {
      state.transactions.push({
        id: state.nextId++, catId: cat.id, monthKey: mk,
        date, desc: label, amount: amt, type: 'income'
      });
      totalApplied += amt;
      touchedIds.push(cat.id);
    }
  });

  if (totalApplied === 0) { showToast('Enter at least one amount.'); return; }

  const amountEl = document.getElementById('id-amount');
  const totalAmount = parseFloat(amountEl.value) || 0;
  const remainder = parseFloat((totalAmount - totalApplied).toFixed(2));
  if (remainder > 0.004) {
    state.transactions.push({
      id: state.nextId++, catId: UNALLOC_ID, monthKey: mk,
      date, desc: label, amount: remainder, type: 'income'
    });
    touchedIds.push(UNALLOC_ID);
  }

  closeModal(); render();
  pulseCards(touchedIds);
  showSuccessToast(`${fmtMoney(totalApplied)} distributed`);
}

// Manual Log Income (toolbar / sidebar button) — redesigned:
// user always types a description. If it matches a pinned income's name,
// that income's label is used (categories are split using their current
// percentage allocation, as before). Otherwise the typed description is
// used as the transaction label.
function logIncome() {
  const desc   = document.getElementById('lie-desc').value.trim();
  const amount = parseFloat(document.getElementById('lie-amount').value);
  const date   = document.getElementById('lie-date').value.trim() || todayLabel();
  if (!desc) { showToast('Enter a description.'); return; }
  if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount.'); return; }

  // If description matches a pinned income, use its configuration (its name
  // becomes the transaction label; allocation follows each category's pct,
  // same mechanism used for pinned-income distribution).
  const matched = findPinnedIncomeByDesc(desc);
  const label = matched ? matched.name : desc;

  const touchedIds = distributeIncome(amount, label, date);
  closeModal(); render();
  pulseCards(touchedIds);
  showSuccessToast(`${fmtMoney(amount)} distributed`);
}

function distributeIncome(amount, label, date) {
  const mk = currentMonthKey();
  let allocated = 0;
  const touchedIds = [];
  state.categories.forEach(cat => {
    const share = parseFloat((amount * cat.pct / 100).toFixed(2));
    if (share > 0) {
      state.transactions.push({
        id: state.nextId++, catId: cat.id, monthKey: mk,
        date, desc: label, amount: share, type: 'income'
      });
      allocated += share;
      touchedIds.push(cat.id);
    }
  });
  // Categories may sum to under 100% (or there may be no categories yet) —
  // whatever isn't covered goes into the visible Unallocated bucket rather
  // than vanishing.
  const remainder = parseFloat((amount - allocated).toFixed(2));
  if (remainder > 0) {
    state.transactions.push({
      id: state.nextId++, catId: UNALLOC_ID, monthKey: mk,
      date, desc: label, amount: remainder, type: 'income'
    });
    touchedIds.push(UNALLOC_ID);
  }
  return touchedIds;
}

// Direct income into a single category (footer + button)
function addDirectIncome(catId) {
  const desc   = document.getElementById('ci-desc').value.trim();
  const amount = parseFloat(document.getElementById('ci-amount').value);
  const date   = document.getElementById('ci-date').value.trim() || todayLabel();
  if (!desc) { showToast('Enter a description.'); return; }
  if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount.'); return; }
  state.transactions.push({
    id: state.nextId++, catId, monthKey: currentMonthKey(),
    date, desc, amount: amount, type: 'income'
  });
  closeModal(); render();
  pulseCards([catId]);
  showSuccessToast(`+${fmtMoney(amount)} added`);
}

// ─── EXPENSE ACTIONS ───
function addExpense() {
  const catId  = document.getElementById('me-cat').value;
  const desc   = document.getElementById('me-desc').value.trim();
  const amount = parseFloat(document.getElementById('me-amount').value);
  const date   = document.getElementById('me-date').value.trim() || todayLabel();
  if (!desc) { showToast('Enter a description.'); return; }
  if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount.'); return; }
  const cat = state.categories.find(c => c.id === catId);
  state.transactions.push({
    id: state.nextId++, catId, monthKey: currentMonthKey(),
    date, desc, amount: -amount, type: 'expense'
  });
  closeModal(); render();
  pulseCards([catId]);
  showSuccessToast(`−${fmtMoney(amount)} logged`);
}

// Direct expense from category footer button
function addDirectExpense(catId) {
  const desc   = document.getElementById('ce-desc').value.trim();
  const amount = parseFloat(document.getElementById('ce-amount').value);
  const date   = document.getElementById('ce-date').value.trim() || todayLabel();
  if (!desc) { showToast('Enter a description.'); return; }
  if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount.'); return; }
  state.transactions.push({
    id: state.nextId++, catId, monthKey: currentMonthKey(),
    date, desc, amount: -amount, type: 'expense'
  });
  closeModal(); render();
  pulseCards([catId]);
  showSuccessToast(`−${fmtMoney(amount)} logged`);
}

// Removing a transaction is destructive and one click away (no confirm
// dialog, by design — that would slow down every accidental miss-tap AND
// every deliberate delete). Instead, the delete happens immediately but is
// trivially reversible: we hang onto the removed row (and where it was)
// and offer an "Undo" action right on the confirmation toast.
let lastDeletedTransaction = null;

function deleteTransaction(e, id) {
  e.stopPropagation();
  const index = state.transactions.findIndex(t => t.id === id);
  if (index === -1) return;
  const [removed] = state.transactions.splice(index, 1);
  lastDeletedTransaction = { txn: removed, index };
  render();
  showSuccessUndoToast('Transaction removed', undoDeleteTransaction);
}

function undoDeleteTransaction() {
  if (!lastDeletedTransaction) return;
  const { txn, index } = lastDeletedTransaction;
  const insertAt = Math.min(index, state.transactions.length);
  state.transactions.splice(insertAt, 0, txn);
  lastDeletedTransaction = null;
  render();
  pulseCards([txn.catId]);
  showSuccessToast('Transaction restored');
}

// ─── OPTIONAL TARGET SECTION (markup) ───
// Builds the collapsible "savings target" box shared by the add- and
// edit-category modals. It renders closed by default — a category's
// target amount/date is entirely opt-in, so instead of a "(optional)"
// label bolted onto fields that otherwise look required, the fields live
// inside their own dashed-border box the user has to deliberately open.
// When editing a category that already has a target, the box starts open
// so the existing value isn't hidden from the user.
function targetSectionHtml(prefix, targetAmount, targetDate) {
  const hasTarget = targetAmount != null && targetAmount > 0;
  return `
    <div class="target-section${hasTarget ? ' open' : ''}" id="${prefix}-target-section">
      <button type="button" class="target-toggle" onclick="toggleTargetSection('${prefix}')">
        <span>${hasTarget ? 'Savings target' : '+ Add a savings target'}</span>
        <span class="target-toggle-caret">▾</span>
      </button>
      <div class="target-fields">
        <div class="field"><label>Target amount</label>
          <input id="${prefix}-target" type="number" min="0" step="0.01" placeholder="e.g. 5000"
            value="${targetAmount != null ? targetAmount : ''}" /></div>
        <div class="field"><label>Target date</label>
          <div class="my-picker">
            <button type="button" class="my-picker-trigger" id="${prefix}-target-date-trigger"
              onclick="toggleMonthYearPicker(event,'${prefix}')">
              <span class="my-picker-label placeholder" id="${prefix}-target-date-label">No date set</span>
              <span class="my-picker-caret">▾</span>
            </button>
            <input type="hidden" id="${prefix}-target-date" value="${targetDate || ''}" />
            <div class="my-picker-popup" id="${prefix}-target-date-popup" style="display:none" onclick="event.stopPropagation()">
              <div class="my-picker-cols">
                <div class="my-picker-col" id="${prefix}-target-date-months"></div>
                <div class="my-picker-col" id="${prefix}-target-date-years"></div>
              </div>
              <button type="button" class="my-picker-clear" onclick="clearMonthYear('${prefix}')">Clear date</button>
            </div>
          </div>
        </div>
        <div class="target-clear-row">
          <button type="button" class="target-clear-btn" onclick="clearTargetSection('${prefix}')">Remove target</button>
        </div>
      </div>
    </div>`;
}

function toggleTargetSection(prefix) {
  const wrap = document.getElementById(prefix + '-target-section');
  if (wrap) wrap.classList.toggle('open');
}

// Clears both the amount input and the picked date, and collapses the box
// back closed — a quick way to fully back out of setting a target.
function clearTargetSection(prefix) {
  const amountEl = document.getElementById(prefix + '-target');
  if (amountEl) amountEl.value = '';
  clearMonthYear(prefix);
  const wrap = document.getElementById(prefix + '-target-section');
  if (wrap) {
    wrap.classList.remove('open');
    const toggleLabel = wrap.querySelector('.target-toggle span');
    if (toggleLabel) toggleLabel.textContent = '+ Add a savings target';
  }
}

// ─── MONTH / YEAR PICKER (target date) ───
// Replaces the native <input type="month">: lets the user jump straight to
// any year (not just step one month at a time), can't be set to a month
// that's already passed, and is themed like the rest of the app instead of
// falling back to the OS's native (often light-only) date UI.
const myPickerState = {};

function fmtMonthYearShort(y, m) {
  return MONTHS[m - 1].slice(0, 3) + ' ' + y;
}

function initMonthYearPicker(prefix, initialYM) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth() + 1;
  if (initialYM) {
    const parts = initialYM.split('-').map(Number);
    if (parts[0] && parts[1]) { y = parts[0]; m = parts[1]; }
  }
  myPickerState[prefix] = { y, m, set: !!initialYM };
  renderMonthYearPicker(prefix);
  updateMonthYearLabel(prefix);
}

function renderMonthYearPicker(prefix) {
  const st = myPickerState[prefix];
  if (!st) return;
  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth() + 1;

  const monthsCol = document.getElementById(prefix + '-target-date-months');
  const yearsCol  = document.getElementById(prefix + '-target-date-years');
  if (!monthsCol || !yearsCol) return;

  monthsCol.innerHTML = MONTHS.map((name, idx) => {
    const mNum = idx + 1;
    const disabled = (st.y === curY && mNum < curM);
    const active = st.set && st.m === mNum;
    return `<button type="button" class="my-picker-item${active ? ' active' : ''}" ${disabled ? 'disabled' : ''}
      onclick="pickMonthYear('${prefix}','m',${mNum})">${name.slice(0, 3)}</button>`;
  }).join('');

  const years = [];
  for (let yy = curY; yy <= curY + 20; yy++) years.push(yy);
  yearsCol.innerHTML = years.map(yy => {
    const active = st.set && st.y === yy;
    return `<button type="button" class="my-picker-item${active ? ' active' : ''}"
      onclick="pickMonthYear('${prefix}','y',${yy})">${yy}</button>`;
  }).join('');
}

function pickMonthYear(prefix, kind, value) {
  const st = myPickerState[prefix];
  if (!st) return;
  if (kind === 'm') st.m = value; else st.y = value;
  st.set = true;
  // Never allow landing back in the past: if the newly-picked year makes
  // the currently-picked month already gone by, bump the month forward.
  const now = new Date();
  const curY = now.getFullYear(), curM = now.getMonth() + 1;
  if (st.y === curY && st.m < curM) st.m = curM;
  renderMonthYearPicker(prefix);
  updateMonthYearLabel(prefix);
}

function clearMonthYear(prefix) {
  const st = myPickerState[prefix];
  if (!st) return;
  st.set = false;
  renderMonthYearPicker(prefix);
  updateMonthYearLabel(prefix);
}

function updateMonthYearLabel(prefix) {
  const st = myPickerState[prefix];
  const labelEl  = document.getElementById(prefix + '-target-date-label');
  const hiddenEl = document.getElementById(prefix + '-target-date');
  if (!st || !labelEl || !hiddenEl) return;
  if (st.set) {
    labelEl.textContent = fmtMonthYearShort(st.y, st.m);
    labelEl.classList.remove('placeholder');
    hiddenEl.value = st.y + '-' + String(st.m).padStart(2, '0');
  } else {
    labelEl.textContent = 'No date set';
    labelEl.classList.add('placeholder');
    hiddenEl.value = '';
  }
}

function toggleMonthYearPicker(e, prefix) {
  e.stopPropagation();
  const popup   = document.getElementById(prefix + '-target-date-popup');
  const trigger = document.getElementById(prefix + '-target-date-trigger');
  if (!popup) return;
  const isOpen = popup.style.display === 'block';
  closeAllMonthYearPickers();
  if (!isOpen) {
    popup.style.display = 'block';
    if (trigger) trigger.classList.add('open');
    const activeEl = popup.querySelector('.my-picker-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'center' });
  }
}
function closeAllMonthYearPickers() {
  document.querySelectorAll('.my-picker-popup').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.my-picker-trigger.open').forEach(t => t.classList.remove('open'));
}

// ─── CATEGORY ACTIONS ───
// Reads and validates the optional target amount + target date inputs for
// a given field-id prefix (e.g. 'mc' or 'ec'). Both are optional — leaving
// either blank means "no target," same as a category has always behaved.
// Returns null on invalid (non-blank but bad) input so the caller can bail
// out with a toast, same pattern as the other field validations here.
function readOptionalTarget(prefix) {
  const amountEl = document.getElementById(prefix + '-target');
  const dateEl   = document.getElementById(prefix + '-target-date');
  const amountRaw = amountEl ? amountEl.value.trim() : '';
  const dateRaw   = dateEl ? dateEl.value.trim() : '';

  let target = null;
  if (amountRaw !== '') {
    const n = parseFloat(amountRaw);
    if (isNaN(n) || n <= 0) return { error: 'Enter a valid target amount.' };
    target = n;
  }
  const targetDate = dateRaw !== '' ? dateRaw : null; // 'YYYY-MM' from <input type=month>, informational only
  return { target, targetDate };
}

function addCategory() {
  const name = document.getElementById('mc-name').value.trim();
  const pct  = parseInt(document.getElementById('mc-pct').value);
  const used = state.categories.reduce((s,c) => s + c.pct, 0);
  if (!name) { showToast('Enter a name.'); return; }
  if (isNaN(pct) || pct < 1) { showToast('Enter a percentage (min 1%).'); return; }
  if (used + pct > 100) { showToast(`Only ${100-used}% remaining.`); return; }
  const t = readOptionalTarget('mc');
  if (t.error) { showToast(t.error); return; }
  state.categories.push({ id: 'cat_' + state.nextId++, name, pct, target: t.target, targetDate: t.targetDate });
  closeModal(); render();
  showSuccessToast(`"${name}" added (${pct}%)`);
}

function saveEditCategory(catId) {
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  const name = document.getElementById('ec-name').value.trim();
  const pct  = parseInt(document.getElementById('ec-pct').value);
  const usedExcl = state.categories.filter(c=>c.id!==catId).reduce((s,c)=>s+c.pct,0);
  if (!name) { showToast('Enter a name.'); return; }
  if (isNaN(pct) || pct < 1) { showToast('Enter a valid percentage.'); return; }
  if (usedExcl + pct > 100) { showToast(`Max ${100-usedExcl}% for this category.`); return; }
  const t = readOptionalTarget('ec');
  if (t.error) { showToast(t.error); return; }
  cat.name = name;
  cat.pct  = pct;
  cat.target = t.target;
  cat.targetDate = t.targetDate;
  closeModal(); render();
  showSuccessToast(`Category updated`);
}

function confirmDeleteCategory(catId) {
  closeAllMenus();
  openModal('confirm-delete-category', catId);
}

function deleteCategory(catId) {
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  state.categories    = state.categories.filter(c => c.id !== catId);
  state.transactions  = state.transactions.filter(t => t.catId !== catId);
  closeModal(); render();
  showSuccessToast(`"${cat.name}" deleted`);
}

// ─── TOAST ───
let toastTimer = null;
let pendingUndoAction = null;

function showToast(msg) {
  pendingUndoAction = null;
  const t = document.getElementById('toast');
  t.innerHTML = `<span class="toast-msg">${escHtml(msg)}</span>`;
  t.classList.remove('with-action');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// Same as showToast, but with a clickable "Undo" action attached. Only one
// undo-able toast is tracked at a time — a new one (of either kind)
// replaces it, same as the old toast just replacing its text.
function showUndoToast(msg, undoFn) {
  pendingUndoAction = undoFn;
  const t = document.getElementById('toast');
  t.innerHTML = `<span class="toast-msg">${escHtml(msg)}</span>
    <button class="toast-undo" onclick="event.stopPropagation(); runPendingUndo()">Undo</button>`;
  t.classList.add('show', 'with-action');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show', 'with-action');
    pendingUndoAction = null;
  }, 6000);
}

function runPendingUndo() {
  const fn = pendingUndoAction;
  pendingUndoAction = null;
  const t = document.getElementById('toast');
  clearTimeout(toastTimer);
  t.classList.remove('show', 'with-action');
  if (fn) fn();
}

// Use this (instead of showToast) for messages that confirm data was saved.
// Call this AFTER render(). It awaits the save that render() just kicked
// off, so the toast only ever appears once the write actually completed. If
// the write failed, the persistent error banner is already showing, and we
// must not additionally tell the user it worked. Callers don't need to
// await this — it's fire-and-forget by design, same as the old version.
async function showSuccessToast(msg) {
  const ok = await pendingSave;
  if (ok) showToast(msg);
}

// Same await-then-show contract as showSuccessToast, but shows the
// undo-able variant.
async function showSuccessUndoToast(msg, undoFn) {
  const ok = await pendingSave;
  if (ok) showUndoToast(msg, undoFn);
}

// ─── INIT ───
applyTheme(loadTheme());

async function init() {
  const loaded = await loadState();     // null on fresh install; recovery modal handled internally
  state = loaded || defaultState();

  const existingBackedUpAt = await window.AquilatePersistence.getLastBackedUpAt();
  if (existingBackedUpAt) updateLastBackedUpLabel(existingBackedUpAt);
  startLastBackedUpTicker();

  render();
}
init();