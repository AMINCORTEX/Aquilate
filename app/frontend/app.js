// ─── CONSTANTS ───
const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];
const STORAGE_KEY = 'aquilate_state';
const THEME_KEY = 'aquilate_theme';

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

// ─── LOCAL STORAGE ───
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Save failed:', e); }
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.month === 'number' && Array.isArray(p.incomes) &&
          Array.isArray(p.categories) && Array.isArray(p.transactions)) return p;
    }
  } catch (e) { console.warn('Load failed, resetting:', e); }
  return defaultState();
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
let state = loadState();

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
  saveState();
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
  document.getElementById('totalIncome').textContent   = fmtMoney(totalIn);
  document.getElementById('totalExpenses').textContent = fmtMoney(totalOut);
  const balEl = document.getElementById('currentBalance');
  balEl.textContent = (bal < 0 ? '-' : '') + fmtMoney(bal);
}

// ── Sidebar: Category totals ──
function renderCatTotals() {
  const el = document.getElementById('catTotalsList');
  if (state.categories.length === 0) {
    el.innerHTML = '';
    return;
  }
  const monthTxns = txnsForCurrentMonth();
  el.innerHTML = state.categories.map(cat => {
    const net = monthTxns.filter(t=>t.catId===cat.id).reduce((s,t)=>s+t.amount,0);
    return `
      <div class="cat-total-row">
        <span class="cat-total-name">${escHtml(cat.name)}</span>
        <span class="cat-total-pct">${cat.pct}%</span>
        <span class="cat-total-val">${fmtMoney(net)}</span>
      </div>`;
  }).join('');
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

  if (state.categories.length === 0) {
    grid.innerHTML = `<div class="grid-empty-hint">Add a category to begin</div>`;
    return;
  }

  const monthTxns = txnsForCurrentMonth();
  const { lastIncomeId, lastExpenseId } = endOfMonthMarkers(currentMonthKey());

  grid.innerHTML = state.categories.map((cat, i) => {
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

  // Scroll each table body to the latest entry
  document.querySelectorAll('.table-body').forEach(b => { b.scrollTop = b.scrollHeight; });
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
}
document.addEventListener('click', () => closeAllMenus());

// ─── MONTH NAV ───
function changeMonth(dir) {
  state.month += dir;
  if (state.month > 11) { state.month = 0; state.year++; }
  if (state.month < 0)  { state.month = 11; state.year--; }
  render();
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
    </button>`;
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
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="addCategory()">Add</button>
      </div>`;

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
      <div class="modal-actions">
        <button class="btn-cancel" onclick="closeModal()">Cancel</button>
        <button class="btn-confirm" onclick="saveEditCategory('${cat.id}')">Save</button>
      </div>`;

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
  showToast(`"${name}" added`);
}

function deleteIncome(e, id) {
  e.stopPropagation();
  const src = state.incomes.find(i => i.id === id);
  if (!src) return;
  state.incomes = state.incomes.filter(i => i.id !== id);
  render();
  showToast(`"${src.name}" removed`);
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

  state.categories.forEach(cat => {
    const inp = document.getElementById('dist-amt-' + cat.id);
    const amt = inp ? parseFloat(inp.value) : NaN;
    if (!isNaN(amt) && amt !== 0) {
      state.transactions.push({
        id: state.nextId++, catId: cat.id, monthKey: mk,
        date, desc: label, amount: amt, type: 'income'
      });
      totalApplied += amt;
    }
  });

  if (totalApplied === 0) { showToast('Enter at least one amount.'); return; }

  closeModal(); render();
  showToast(`${fmtMoney(totalApplied)} distributed`);
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

  distributeIncome(amount, label, date);
  closeModal(); render();
  showToast(`${fmtMoney(amount)} distributed`);
}

function distributeIncome(amount, label, date) {
  const mk = currentMonthKey();
  state.categories.forEach(cat => {
    const share = parseFloat((amount * cat.pct / 100).toFixed(2));
    if (share > 0) {
      state.transactions.push({
        id: state.nextId++, catId: cat.id, monthKey: mk,
        date, desc: label, amount: share, type: 'income'
      });
    }
  });
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
  showToast(`+${fmtMoney(amount)} added`);
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
  showToast(`−${fmtMoney(amount)} logged`);
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
  showToast(`−${fmtMoney(amount)} logged`);
}

function deleteTransaction(e, id) {
  e.stopPropagation();
  state.transactions = state.transactions.filter(t => t.id !== id);
  render();
  showToast('Transaction removed');
}

// ─── CATEGORY ACTIONS ───
function addCategory() {
  const name = document.getElementById('mc-name').value.trim();
  const pct  = parseInt(document.getElementById('mc-pct').value);
  const used = state.categories.reduce((s,c) => s + c.pct, 0);
  if (!name) { showToast('Enter a name.'); return; }
  if (isNaN(pct) || pct < 1) { showToast('Enter a percentage (min 1%).'); return; }
  if (used + pct > 100) { showToast(`Only ${100-used}% remaining.`); return; }
  state.categories.push({ id: 'cat_' + state.nextId++, name, pct });
  closeModal(); render();
  showToast(`"${name}" added (${pct}%)`);
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
  cat.name = name;
  cat.pct  = pct;
  closeModal(); render();
  showToast(`Category updated`);
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
  showToast(`"${cat.name}" deleted`);
}

// ─── TOAST ───
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ─── INIT ───
applyTheme(loadTheme());
render();