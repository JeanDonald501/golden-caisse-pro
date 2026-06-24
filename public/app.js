/* ==========================================================
   GOLDEN CAISSE PRO - FRONTEND APPLICATION SCRIPT
   ========================================================== */

// Base API URL (supports network-wide IP addresses automatically)
let API_BASE = localStorage.getItem('gcp_server_url') || window.location.origin;
if (API_BASE.startsWith('file://') || API_BASE === 'null' || !API_BASE) {
  API_BASE = 'http://localhost:8000';
}

// Fetch helper with timeout to prevent hanging on incorrect server URLs
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 3000 } = options;
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Application Global State
let state = {
  currentUser: null, // { id, username, name, role }
  company: {},
  cashStatus: {
    principale: { status: 'closed', balance: 0.0 },
    exploitation: { status: 'closed', balance: 0.0 }
  },
  todayCPTransactions: [],
  todayCETransactions: [],
  syncInterval: null,
  activeTab: 'tab-caisse-principale',
  lastSyncState: {
    last_transaction_id: 0,
    last_cash_day_id: 0,
    pending_reconciliations_count: 0,
    cash_status: { principale: 'closed', exploitation: 'closed' }
  }
};

// Standard Denominations for cash counts
const DENOMINATIONS = [10000, 5000, 2000, 1000, 500, 250, 200, 100, 50, 25, 10, 5, 2, 1];

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  setupEventHandlers();
});

// App Initialization
async function initApp() {
  // Show current server url in login screen
  const serverDisplay = document.getElementById('login-server-url-display');
  if (serverDisplay) serverDisplay.textContent = API_BASE;

  // Check if system setup is needed
  try {
    const res = await fetchWithTimeout(`${API_BASE}/api/auth/setup_needed`, { timeout: 3000 });
    const data = await res.json();
    
    // Save working server URL
    localStorage.setItem('gcp_server_url', API_BASE);

    if (data.setup_needed) {
      showScreen('setup-screen');
    } else {
      // Check local storage for session
      const savedUser = localStorage.getItem('gcp_user');
      if (savedUser) {
        state.currentUser = JSON.parse(savedUser);
        launchUserSession();
      } else {
        showScreen('login-screen');
      }
    }
    // Load company info
    loadCompanyInfo();
  } catch (err) {
    console.error("Erreur lors de l'initialisation de l'application", err);
    // Show connection error screen
    const urlInput = document.getElementById('server-url-input');
    if (urlInput) urlInput.value = API_BASE;
    
    // Reset connection button
    const btn = document.querySelector('#connection-config-form button[type="submit"]');
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Tenter la connexion";
    }
    
    showScreen('connection-error-screen');
  }
}

// Setup routing/screens helper
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(scr => scr.classList.add('hidden'));
  document.getElementById(screenId).classList.remove('hidden');
}

// Load company info
async function loadCompanyInfo() {
  try {
    const res = await fetch(`${API_BASE}/api/company`);
    state.company = await res.json();
    
    // Update headers and print elements
    const hNames = document.querySelectorAll('.header-hotel-name');
    hNames.forEach(h => h.textContent = state.company.name || "GOLDEN PALACE HÔTEL");
    
    document.getElementById('print-company-name').textContent = state.company.name || "GOLDEN PALACE HÔTEL";
    document.getElementById('print-company-address').textContent = state.company.address || "";
    document.getElementById('print-company-phone').textContent = "Tél: " + (state.company.phone || "");
    
    document.getElementById('print-report-company-name').textContent = state.company.name || "GOLDEN PALACE HÔTEL";
    document.getElementById('print-recon-company-name').textContent = state.company.name || "GOLDEN PALACE HÔTEL";

    // Prefill settings form
    if (state.currentUser && state.currentUser.role === 'raf') {
      document.getElementById('company-name').value = state.company.name || "";
      document.getElementById('company-address').value = state.company.address || "";
      document.getElementById('company-phone').value = state.company.phone || "";
      document.getElementById('company-email').value = state.company.email || "";
    }
  } catch (err) {
    console.error("Erreur chargement infos hôtel", err);
  }
}

// Session launch logic
function launchUserSession() {
  if (state.currentUser.role === 'raf') {
    // Show RAF workspace
    showScreen('raf-screen');
    document.getElementById('raf-user-name').textContent = state.currentUser.name;
    // Initial fetch of dashboard metrics
    refreshRafDashboard();
    refreshActiveUsers();
    // Default active tab for RAF
    switchRafTab('tab-raf-dashboard');
  } else {
    // Show Caissière workspace
    showScreen('cashier-screen');
    document.getElementById('cashier-user-name').textContent = state.currentUser.name;
    // Initial load
    refreshCashierWorkspace();
    // Default active tab for Caissière
    switchCaissiereTab('tab-caisse-principale');
  }

  // Setup data sync interval (runs every 3 seconds)
  if (state.syncInterval) clearInterval(state.syncInterval);
  state.syncInterval = setInterval(syncDataTick, 3000);
}

// Background sync worker
async function syncDataTick() {
  if (!state.currentUser) return;
  try {
    const username = encodeURIComponent(state.currentUser.username);
    const token = encodeURIComponent(state.currentUser.session_token || '');
    const res = await fetch(`${API_BASE}/api/sync?username=${username}&session_token=${token}`);
    
    if (res.status === 401) {
      clearInterval(state.syncInterval);
      state.currentUser = null;
      localStorage.removeItem('gcp_user');
      alert("Votre session a expiré ou a été déconnectée (connexion sur un autre poste ou compte désactivé).");
      showScreen('login-screen');
      return;
    }

    const currentSync = await res.json();
    
    // Check if anything changed
    const hasChanges = (
      currentSync.last_transaction_id !== state.lastSyncState.last_transaction_id ||
      currentSync.last_cash_day_id !== state.lastSyncState.last_cash_day_id ||
      currentSync.pending_reconciliations_count !== state.lastSyncState.pending_reconciliations_count ||
      currentSync.cash_status.principale !== state.lastSyncState.cash_status.principale ||
      currentSync.cash_status.exploitation !== state.lastSyncState.cash_status.exploitation
    );

    if (hasChanges) {
      console.log("Synchronisation détectée : mise à jour des données en cours...");
      state.lastSyncState = currentSync;
      
      // Update global states
      await fetchCashStatus();
      
      // Refresh current workspace views
      if (state.currentUser.role === 'raf') {
        refreshRafDashboard();
        // Update badge dynamically
        const badge = document.getElementById('badge-validation-count');
        const count = currentSync.pending_reconciliations_count;
        if (count > 0) {
          badge.textContent = count;
          badge.classList.remove('hidden');
        } else {
          badge.classList.add('hidden');
        }
        
        // Refresh active views
        const activePane = document.querySelector('#raf-screen .tab-pane.active');
        if (activePane.id === 'tab-raf-validation') {
          loadPendingReconciliations();
        } else if (activePane.id === 'tab-raf-history') {
          triggerRafHistorySearch('principale');
          triggerRafHistorySearch('exploitation');
        }
      } else {
        refreshCashierWorkspace();
      }
    }
  } catch (err) {
    console.warn("Échec de la synchronisation de l'arrière-plan", err);
  }
}

// Fetch general cash statuses
async function fetchCashStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/cash/status`);
    state.cashStatus = await res.json();
    updateCashStatusCards();
  } catch (err) {
    console.error("Erreur récupération statuts caisses", err);
  }
}

// Update cash header cards on cashier view
function updateCashStatusCards() {
  const types = ['principale', 'exploitation'];
  types.forEach(type => {
    const info = state.cashStatus[type];
    const badge = document.getElementById(`${type === 'principale' ? 'cp' : 'ce'}-status-badge`);
    const balanceEl = document.getElementById(`${type === 'principale' ? 'cp' : 'ce'}-card-balance`);
    const infoEl = document.getElementById(`${type === 'principale' ? 'cp' : 'ce'}-card-info`);
    const cardEl = document.getElementById(`card-${type === 'principale' ? 'cp' : 'ce'}`);

    if (info.status === 'open') {
      badge.textContent = 'Ouverte';
      badge.className = 'badge badge-open';
      balanceEl.textContent = formatAmount(info.current_balance);
      infoEl.textContent = `Date : ${formatDateFR(info.date)} | Caissier: ${info.opened_by}`;
      cardEl.classList.remove('closed-card');
      
      // Reveal cashier buttons
      document.querySelectorAll(`.hidden-closed-${type === 'principale' ? 'cp' : 'ce'}`).forEach(b => b.classList.remove('hidden'));
      document.getElementById(`btn-${type === 'principale' ? 'cp' : 'ce'}-open`).classList.add('hidden');
    } else {
      badge.textContent = 'Fermée';
      badge.className = 'badge badge-closed';
      balanceEl.textContent = formatAmount(info.closing_balance || 0);
      infoEl.textContent = "Session clôturée.";
      cardEl.classList.add('closed-card');
      
      // Hide cashier buttons
      document.querySelectorAll(`.hidden-closed-${type === 'principale' ? 'cp' : 'ce'}`).forEach(b => b.classList.add('hidden'));
      document.getElementById(`btn-${type === 'principale' ? 'cp' : 'ce'}-open`).classList.remove('hidden');
    }
  });
}

// Refresh cashier workspace tables
async function refreshCashierWorkspace() {
  await fetchCashStatus();
  
  // Refresh today's operations lists
  loadTodayOperations('principale');
  loadTodayOperations('exploitation');

  // Load unjustified alerts
  loadUnjustifiedAlert();
}

// Load operations of the day
async function loadTodayOperations(caisseType) {
  try {
    const res = await fetch(`${API_BASE}/api/transactions/today?cash_type=${caisseType}`);
    const txs = await res.json();
    
    if (caisseType === 'principale') {
      state.todayCPTransactions = txs;
      renderTodayTable('cp-today-operations', txs, 'principale');
    } else {
      state.todayCETransactions = txs;
      renderTodayTable('ce-today-operations', txs, 'exploitation');
    }
  } catch (err) {
    console.error(`Erreur chargement opérations ${caisseType}`, err);
  }
}

// Render operations helper
function renderTodayTable(tbodyId, txs, caisseType) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = '';
  
  if (txs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${caisseType === 'principale' ? 10 : 9}" class="text-center">Aucune opération aujourd'hui.</td></tr>`;
    return;
  }
  
  txs.forEach(tx => {
    const isUnjust = tx.needs_justification === 1 && tx.is_justified === 0;
    const tr = document.createElement('tr');
    if (isUnjust) {
      tr.className = 'tr-unjustified';
    }

    const valEntree = tx.type === 'entree' ? formatAmount(tx.amount) : '-';
    const valSortie = tx.type === 'sortie' ? formatAmount(tx.amount) : '-';
    
    // Status text
    let statusText = '-';
    if (tx.needs_justification === 1) {
      statusText = tx.is_justified === 1 
        ? '<span class="badge-justified">Justifié</span>' 
        : '<span class="badge-unjustified">Non justifié</span>';
    }

    let actionsHtml = `<button class="btn btn-sm btn-secondary" onclick="printVoucher(${tx.id})">🖨️ Bon</button>`;

    if (caisseType === 'principale') {
      tr.innerHTML = `
        <td><b>CP-${String(tx.id).padStart(5, '0')}</b></td>
        <td>${formatDateTimeFR(tx.created_at)}</td>
        <td>${formatCategoryName(tx.category)}</td>
        <td>${tx.nature || '-'}</td>
        <td>${tx.object || '-'}</td>
        <td>${tx.beneficiary_name || '-'}</td>
        <td class="text-success font-bold">${valEntree}</td>
        <td class="text-danger font-bold">${valSortie}</td>
        <td>${statusText}</td>
        <td>${actionsHtml}</td>
      `;
    } else {
      tr.innerHTML = `
        <td><b>CE-${String(tx.id).padStart(5, '0')}</b></td>
        <td>${formatDateTimeFR(tx.created_at)}</td>
        <td>${formatCategoryName(tx.category)}</td>
        <td>${tx.nature || '-'}</td>
        <td>${tx.object || '-'}</td>
        <td>${tx.beneficiary_name || '-'}</td>
        <td class="text-success font-bold">${valEntree}</td>
        <td class="text-danger font-bold">${valSortie}</td>
        <td>${actionsHtml}</td>
      `;
    }
    
    tbody.appendChild(tr);
  });
}

// Load daily unjustified alert list
async function loadUnjustifiedAlert() {
  try {
    const res = await fetch(`${API_BASE}/api/transactions/search?cash_type=principale&is_justified=false`);
    const txs = await res.json();
    
    // Filter to those requiring justification
    const unjustified = txs.filter(t => t.needs_justification === 1);
    
    const alertBox = document.getElementById('cp-unjustified-alert');
    const tbody = document.getElementById('cp-unjustified-list');
    
    if (unjustified.length > 0) {
      alertBox.classList.remove('hidden');
      tbody.innerHTML = '';
      unjustified.forEach(tx => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><b>CP-${String(tx.id).padStart(5, '0')}</b></td>
          <td>${tx.beneficiary_name} (${tx.beneficiary_type})</td>
          <td>${tx.nature} : ${tx.object}</td>
          <td class="text-danger font-bold">${formatAmount(tx.amount)}</td>
          <td>${formatDateTimeFR(tx.created_at)}</td>
          <td>
            <button class="btn btn-sm btn-success" onclick="justifyTransaction(${tx.id})">Justifier</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      alertBox.classList.add('hidden');
    }
  } catch (err) {
    console.error("Erreur de chargement des pièces non justifiées", err);
  }
}

// Justify a receipt
async function justifyTransaction(txId) {
  if (!confirm("Voulez-vous marquer cette pièce comme justifiée ? Elle sera retirée de l'alerte quotidienne.")) return;
  try {
    const res = await fetch(`${API_BASE}/api/transactions/justify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: txId })
    });
    const reply = await res.json();
    if (reply.success) {
      refreshCashierWorkspace();
    } else {
      alert(reply.error || "Erreur lors de la justification.");
    }
  } catch (err) {
    console.error("Erreur justification", err);
  }
}

// Setup Event Handlers
function setupEventHandlers() {
  // Connection Config Form
  const connForm = document.getElementById('connection-config-form');
  if (connForm) {
    connForm.addEventListener('submit', (e) => {
      e.preventDefault();
      let url = document.getElementById('server-url-input').value.trim();
      if (url.endsWith('/')) {
        url = url.slice(0, -1);
      }
      
      const btn = connForm.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Connexion en cours...";
      }

      API_BASE = url;
      initApp();
    });
  }

  // Change Server Link Click
  const changeLink = document.getElementById('change-server-link');
  if (changeLink) {
    changeLink.addEventListener('click', (e) => {
      e.preventDefault();
      const urlInput = document.getElementById('server-url-input');
      if (urlInput) urlInput.value = API_BASE;
      showScreen('connection-error-screen');
    });
  }

  // Login Form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      
      if (data.success) {
        state.currentUser = data.user;
        localStorage.setItem('gcp_user', JSON.stringify(data.user));
        
        // Clear login form
        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';
        
        launchUserSession();
      } else {
        alert(data.error || "Une erreur est survenue.");
      }
    } catch (err) {
      console.error(err);
      alert("Erreur de connexion avec le serveur.");
    }
  });

  // Setup Form
  document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('setup-admin-user').value;
    const password = document.getElementById('setup-admin-pass').value;
    const name = document.getElementById('setup-admin-name').value;
    const company_name = document.getElementById('setup-company-name').value;
    const company_address = document.getElementById('setup-company-address').value;
    const company_phone = document.getElementById('setup-company-phone').value;
    const company_email = document.getElementById('setup-company-email').value;

    try {
      const res = await fetch(`${API_BASE}/api/auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username, password, name,
          company_name, company_address, company_phone, company_email
        })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        showScreen('login-screen');
        loadCompanyInfo();
      } else {
        alert(data.error || "Erreur de configuration.");
      }
    } catch (err) {
      console.error(err);
      alert("Erreur réseau.");
    }
  });

  // Logout Buttons
  document.getElementById('cashier-logout').addEventListener('click', logout);
  document.getElementById('raf-logout').addEventListener('click', logout);

  // Tab switching for Caissière
  document.querySelectorAll('#cashier-screen .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchCaissiereTab(btn.dataset.tab);
    });
  });

  // Tab switching for RAF
  document.querySelectorAll('#raf-screen .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchRafTab(btn.dataset.tab);
    });
  });

  // Modals closing
  document.querySelectorAll('.modal-close, .modal-cancel').forEach(el => {
    el.addEventListener('click', () => {
      closeModals();
    });
  });

  // Open Cash Caisse Principale
  document.getElementById('btn-cp-open').addEventListener('click', () => {
    openOpenCashModal('principale');
  });
  // Open Cash Caisse d'Exploitation
  document.getElementById('btn-ce-open').addEventListener('click', () => {
    openOpenCashModal('exploitation');
  });

  // Form submission: Open Cash
  document.getElementById('open-cash-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('open-cash-type').value;
    const date = document.getElementById('open-cash-date').value;
    const balance = getNumericValue(document.getElementById('open-cash-balance').value);
    
    try {
      const res = await fetch(`${API_BASE}/api/cash/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cash_type: type,
          date: date,
          opening_balance: balance,
          opened_by: state.currentUser.name
        })
      });
      const data = await res.json();
      if (data.success) {
        closeModals();
        refreshCashierWorkspace();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur serveur.");
    }
  });

  // Close Cash Caisse Principale
  document.getElementById('btn-cp-close').addEventListener('click', () => {
    openCloseCashModal('principale');
  });
  // Close Cash Caisse d'Exploitation
  document.getElementById('btn-ce-close').addEventListener('click', () => {
    openCloseCashModal('exploitation');
  });

  // Form submission: Close Cash
  document.getElementById('close-cash-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('close-cash-type').value;
    const counted = getNumericValue(document.getElementById('close-counted-balance-display').textContent);
    
    // Read Billetage quantities
    const billetage = {};
    DENOMINATIONS.forEach(den => {
      const qty = parseInt(document.getElementById(`denom-qty-${den}`).value, 10) || 0;
      billetage[den] = qty;
    });

    try {
      const res = await fetch(`${API_BASE}/api/cash/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cash_type: type,
          closing_balance: counted,
          closed_by: state.currentUser.name,
          billetage: billetage
        })
      });
      const data = await res.json();
      if (data.success) {
        // Trigger report print automatically!
        if (confirm("Session de caisse fermée avec succès ! Souhaitez-vous imprimer le rapport de fermeture ?")) {
          await printClosingReport(type);
        }
        closeModals();
        refreshCashierWorkspace();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur.");
    }
  });

  // Saisir Entrée CP
  document.getElementById('btn-cp-in').addEventListener('click', () => {
    openAddInflowModal('principale');
  });
  // Saisir Entrée CE
  document.getElementById('btn-ce-in').addEventListener('click', () => {
    openAddInflowModal('exploitation');
  });

  // Form submission: Add Inflow
  document.getElementById('add-inflow-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cash_type = document.getElementById('inflow-cash-type').value;
    
    let category = '';
    if (cash_type === 'principale') {
      category = document.getElementById('inflow-category-cp').value;
    } else {
      category = document.getElementById('inflow-category-ce').value;
    }

    const nature = document.getElementById('inflow-nature').value;
    const object = document.getElementById('inflow-object').value;
    const beneficiary = document.getElementById('inflow-beneficiary').value;
    const amount = getNumericValue(document.getElementById('inflow-amount').value);

    try {
      const res = await fetch(`${API_BASE}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cash_type,
          type: 'entree',
          category,
          nature,
          object,
          amount,
          beneficiary_type: 'autre',
          beneficiary_name: beneficiary,
          needs_justification: false,
          created_by: state.currentUser.name
        })
      });
      const data = await res.json();
      if (data.success) {
        closeModals();
        refreshCashierWorkspace();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur.");
    }
  });

  // Saisir Sortie CP
  document.getElementById('btn-cp-out').addEventListener('click', () => {
    openAddOutflowCPModal();
  });

  // Form submission: Add Outflow CP
  document.getElementById('add-outflow-cp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const beneficiary_type = document.getElementById('outflow-cp-beneficiary-type').value;
    const beneficiary_name = document.getElementById('outflow-cp-beneficiary-name').value;
    const category = document.getElementById('outflow-cp-nature').value; // In CP outflow, nature is category
    const nature = category; // duplicate for simple retrieval
    const object = document.getElementById('outflow-cp-object').value;
    const amount = getNumericValue(document.getElementById('outflow-cp-amount').value);
    const needs_justification = document.getElementById('outflow-cp-needs-justification').checked;

    try {
      const res = await fetch(`${API_BASE}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cash_type: 'principale',
          type: 'sortie',
          category,
          nature,
          object,
          amount,
          beneficiary_type,
          beneficiary_name,
          needs_justification,
          created_by: state.currentUser.name
        })
      });
      const data = await res.json();
      if (data.success) {
        closeModals();
        refreshCashierWorkspace();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur.");
    }
  });

  // Saisir Sortie CE
  document.getElementById('btn-ce-out').addEventListener('click', () => {
    openAddOutflowCEModal();
  });

  // Form submission: Add Outflow CE
  document.getElementById('add-outflow-ce-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nature = document.getElementById('outflow-ce-nature').value;
    const object = document.getElementById('outflow-ce-object').value;
    const beneficiary = document.getElementById('outflow-ce-beneficiary').value;
    const amount = getNumericValue(document.getElementById('outflow-ce-amount').value);

    try {
      const res = await fetch(`${API_BASE}/api/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cash_type: 'exploitation',
          type: 'sortie',
          category: nature, // Same
          nature,
          object,
          amount,
          beneficiary_type: 'autre',
          beneficiary_name: beneficiary,
          needs_justification: false,
          created_by: state.currentUser.name
        })
      });
      const data = await res.json();
      if (data.success) {
        closeModals();
        refreshCashierWorkspace();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur.");
    }
  });

  // Transfer funds modal triggers
  document.getElementById('btn-cp-transfer').addEventListener('click', () => {
    openTransferModal('principale');
  });
  document.getElementById('btn-ce-transfer').addEventListener('click', () => {
    openTransferModal('exploitation');
  });

  // Form submission: Transfer
  document.getElementById('transfer-cash-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const source = document.getElementById('transfer-source').value;
    const target = document.getElementById('transfer-target').value;
    const amount = getNumericValue(document.getElementById('transfer-amount').value);

    try {
      const res = await fetch(`${API_BASE}/api/transactions/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_cash_type: source,
          target_cash_type: target,
          amount: amount,
          created_by: state.currentUser.name
        })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        closeModals();
        refreshCashierWorkspace();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur.");
    }
  });

  // Dynamic selector behavior in transfer
  document.getElementById('transfer-source').addEventListener('change', (e) => {
    const val = e.target.value;
    const target = document.getElementById('transfer-target');
    target.value = val === 'principale' ? 'exploitation' : 'principale';
  });

  // Reconciliations Load
  document.getElementById('btn-regul-load').addEventListener('click', loadReconciliationDraft);

  // Reconciliations Submit
  document.getElementById('btn-regul-submit').addEventListener('click', submitReconciliation);

  // Print Pre-reconciliation
  document.getElementById('btn-regul-print-pre').addEventListener('click', () => {
    printDraftReconciliation();
  });

  // Search History for Caissière
  document.getElementById('btn-hist-search').addEventListener('click', triggerHistorySearch);

  // Search History for RAF (Principale)
  document.getElementById('btn-raf-cp-search').addEventListener('click', () => {
    triggerRafHistorySearch('principale');
  });

  // Search History for RAF (Exploitation)
  document.getElementById('btn-raf-ce-search').addEventListener('click', () => {
    triggerRafHistorySearch('exploitation');
  });

  // Print histories
  document.getElementById('btn-cp-print-history').addEventListener('click', () => {
    printHistorySelection('principale');
  });
  document.getElementById('btn-ce-print-history').addEventListener('click', () => {
    printHistorySelection('exploitation');
  });

  // Company parameters update form
  document.getElementById('company-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('company-name').value;
    const address = document.getElementById('company-address').value;
    const phone = document.getElementById('company-phone').value;
    const email = document.getElementById('company-email').value;

    try {
      const res = await fetch(`${API_BASE}/api/company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, address, phone, email })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        loadCompanyInfo();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur.");
    }
  });

  // Create User agent form
  document.getElementById('create-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('new-user-name').value;
    const username = document.getElementById('new-user-username').value;
    const password = document.getElementById('new-user-password').value;
    const role = document.getElementById('new-user-role').value;

    try {
      const res = await fetch(`${API_BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, username, password, role })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        document.getElementById('new-user-name').value = '';
        document.getElementById('new-user-username').value = '';
        document.getElementById('new-user-password').value = '';
        refreshActiveUsers();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur.");
    }
  });

  // Edit User agent form
  document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-user-id').value;
    const name = document.getElementById('edit-user-name').value;
    const username = document.getElementById('edit-user-username').value;
    const password = document.getElementById('edit-user-password').value;
    const role = document.getElementById('edit-user-role').value;
    const is_active = document.getElementById('edit-user-active').value;

    try {
      const res = await fetch(`${API_BASE}/api/users/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, username, password, role, is_active })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        closeModals();
        refreshActiveUsers();
      } else {
        alert(data.error);
      }
    } catch (err) {
      alert("Erreur lors de la modification de l'agent.");
    }
  });

  // User Actions Event Delegation (Edit, Toggle Status, Delete)
  const tbody = document.getElementById('active-agents-list');
  if (tbody) {
    tbody.addEventListener('click', (e) => {
      const btnEdit = e.target.closest('.btn-edit-user');
      const btnToggle = e.target.closest('.btn-toggle-user');
      const btnDelete = e.target.closest('.btn-delete-user');
      
      if (btnEdit) {
        openEditUserModal(
          btnEdit.dataset.id,
          btnEdit.dataset.name,
          btnEdit.dataset.username,
          btnEdit.dataset.role,
          btnEdit.dataset.active
        );
      }
      if (btnToggle) {
        toggleUserStatus(btnToggle.dataset.id, btnToggle.dataset.active);
      }
      if (btnDelete) {
        deleteUser(btnDelete.dataset.id);
      }
    });
  }
}

// Log out user
async function logout() {
  if (state.currentUser) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: state.currentUser.username,
          session_token: state.currentUser.session_token
        })
      });
    } catch (err) {
      console.error("Error logging out from server", err);
    }
  }
  state.currentUser = null;
  localStorage.removeItem('gcp_user');
  if (state.syncInterval) clearInterval(state.syncInterval);
  showScreen('login-screen');
}

// Switch Caissière Tabs
function switchCaissiereTab(tabId) {
  document.querySelectorAll('#cashier-screen .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('#cashier-screen .tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === tabId);
  });
  
  state.activeTab = tabId;

  if (tabId === 'tab-regularisations') {
    loadReconciliationsHistory();
  } else if (tabId === 'tab-historique-caissiere') {
    triggerHistorySearch();
  }
}

// Switch RAF Tabs
function switchRafTab(tabId) {
  document.querySelectorAll('#raf-screen .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('#raf-screen .tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === tabId);
  });

  if (tabId === 'tab-raf-dashboard') {
    refreshRafDashboard();
  } else if (tabId === 'tab-raf-validation') {
    loadPendingReconciliations();
  } else if (tabId === 'tab-raf-history') {
    triggerRafHistorySearch('principale');
    triggerRafHistorySearch('exploitation');
  } else if (tabId === 'tab-raf-params') {
    refreshActiveUsers();
    loadCompanyInfo(); // ensure forms are updated
  }
}

// Close all modaux
function closeModals() {
  document.getElementById('modal-container').classList.add('hidden');
  document.querySelectorAll('.modal-box').forEach(box => box.classList.add('hidden'));
}

// Open modals helper
function openModal(modalId) {
  document.getElementById('modal-container').classList.remove('hidden');
  document.getElementById(modalId).classList.remove('hidden');
}

// Setup Open Cash modal values
function openOpenCashModal(caisseType) {
  document.getElementById('open-cash-type').value = caisseType;
  document.getElementById('open-cash-title').textContent = `Ouverture de la Caisse ${caisseType === 'principale' ? 'Principale' : "d'Exploitation"}`;
  
  // Set default current date
  const now = new Date();
  const dateStr = now.toISOString().substring(0, 10);
  document.getElementById('open-cash-date').value = dateStr;
  
  // Prefill starting balance with last closing balance if possible
  let lastBalance = 0;
  if (state.cashStatus && state.cashStatus[caisseType]) {
    lastBalance = state.cashStatus[caisseType].balance || 0;
  }
  document.getElementById('open-cash-balance').value = formatAmount(lastBalance);
  
  openModal('modal-open-cash');
}

// Setup Close Cash modal and calculate théorique
async function openCloseCashModal(caisseType) {
  document.getElementById('close-cash-type').value = caisseType;
  document.getElementById('close-cash-title').textContent = `Fermeture de la Caisse ${caisseType === 'principale' ? 'Principale' : "d'Exploitation"}`;

  const info = state.cashStatus[caisseType];
  const activeDayId = info.id;
  
  // Fetch summaries
  const initBal = info.opening_balance || 0;
  
  // Fetch transactions of today to sum
  let inflows = 0;
  let outflows = 0;
  
  const txs = caisseType === 'principale' ? state.todayCPTransactions : state.todayCETransactions;
  txs.forEach(t => {
    if (t.type === 'entree') inflows += t.amount;
    else if (t.type === 'sortie') outflows += t.amount;
  });

  const expected = initBal + inflows - outflows;

  document.getElementById('close-init-balance').textContent = formatAmount(initBal);
  document.getElementById('close-total-inflows').textContent = `+${formatAmount(inflows)}`;
  document.getElementById('close-total-outflows').textContent = `-${formatAmount(outflows)}`;
  document.getElementById('close-expected-balance').textContent = formatAmount(expected);
  
  // Reset Billetage Inputs
  const rows = document.getElementById('billetage-rows');
  rows.innerHTML = '';
  
  DENOMINATIONS.forEach(den => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${formatAmount(den)}</b></td>
      <td>
        <input type="number" id="denom-qty-${den}" min="0" value="0" oninput="calculateBilletageSum()">
      </td>
      <td><span id="denom-sub-${den}">0</span></td>
    `;
    rows.appendChild(tr);
  });

  calculateBilletageSum();
  openModal('modal-close-cash');
}

// Calculate billetage on the fly
function calculateBilletageSum() {
  let totalCounted = 0;
  
  DENOMINATIONS.forEach(den => {
    const qtyInput = document.getElementById(`denom-qty-${den}`);
    const subSpan = document.getElementById(`denom-sub-${den}`);
    
    if (qtyInput) {
      const qty = parseInt(qtyInput.value, 10) || 0;
      const sub = qty * den;
      subSpan.textContent = formatAmount(sub);
      totalCounted += sub;
    }
  });

  document.getElementById('close-counted-balance-display').textContent = formatAmount(totalCounted);
  
  // Compute difference
  const expected = getNumericValue(document.getElementById('close-expected-balance').textContent);
  const gap = totalCounted - expected;
  
  const diffEl = document.getElementById('close-diff-balance');
  diffEl.textContent = formatAmount(gap);
  if (gap === 0) {
    diffEl.className = 'text-success font-bold';
    diffEl.textContent = "Équilibre (0)";
  } else if (gap > 0) {
    diffEl.className = 'text-success font-bold';
    diffEl.textContent = `Excédent (+${formatAmount(gap)})`;
  } else {
    diffEl.className = 'text-danger font-bold';
    diffEl.textContent = `Déficit (${formatAmount(gap)})`;
  }
}

// Open Saisie Entrée modal
function openAddInflowModal(caisseType) {
  document.getElementById('inflow-cash-type').value = caisseType;
  document.getElementById('inflow-nature').value = '';
  document.getElementById('inflow-object').value = '';
  document.getElementById('inflow-beneficiary').value = '';
  document.getElementById('inflow-amount').value = '';

  if (caisseType === 'principale') {
    document.getElementById('group-inflow-cat-cp').classList.remove('hidden');
    document.getElementById('group-inflow-cat-ce').classList.add('hidden');
    document.getElementById('add-inflow-title').textContent = "Bon d'Entrée - Caisse Principale";
  } else {
    document.getElementById('group-inflow-cat-cp').classList.add('hidden');
    document.getElementById('group-inflow-cat-ce').classList.remove('hidden');
    document.getElementById('add-inflow-title').textContent = "Bon d'Entrée - Caisse d'Exploitation";
  }

  openModal('modal-add-inflow');
}

// Open Saisie Sortie Caisse Principale
function openAddOutflowCPModal() {
  document.getElementById('outflow-cp-beneficiary-type').value = '';
  document.getElementById('outflow-cp-beneficiary-name').value = '';
  document.getElementById('outflow-cp-nature').value = 'dépenses d’exploitation';
  document.getElementById('outflow-cp-object').value = '';
  document.getElementById('outflow-cp-amount').value = '';
  document.getElementById('outflow-cp-needs-justification').checked = false;

  openModal('modal-add-outflow-cp');
}

// Open Saisie Sortie Caisse d'Exploitation
function openAddOutflowCEModal() {
  document.getElementById('outflow-ce-nature').value = 'remise de fonds au DAF';
  document.getElementById('outflow-ce-object').value = '';
  document.getElementById('outflow-ce-beneficiary').value = '';
  document.getElementById('outflow-ce-amount').value = '';

  openModal('modal-add-outflow-ce');
}

// Open Transfer Funds Modal
function openTransferModal(sourceType) {
  const srcSelect = document.getElementById('transfer-source');
  const tgtSelect = document.getElementById('transfer-target');
  
  srcSelect.value = sourceType;
  tgtSelect.value = sourceType === 'principale' ? 'exploitation' : 'principale';
  document.getElementById('transfer-amount').value = '';
  
  openModal('modal-transfer-cash');
}

// Load draft reconciliation items
async function loadReconciliationDraft() {
  const start = document.getElementById('regul-date-start').value;
  const end = document.getElementById('regul-date-end').value;
  
  if (!start || !end) {
    alert("Veuillez sélectionner les dates de début et de fin.");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/reconciliations/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_start: start, date_end: end })
    });
    const txs = await res.json();
    
    const container = document.getElementById('regul-items-container');
    const tbody = document.getElementById('regul-items-list');
    
    if (txs.length === 0) {
      alert("Aucune dépense acheteuse non régularisée trouvée sur cette période.");
      container.classList.add('hidden');
      document.getElementById('btn-regul-print-pre').classList.add('hidden');
      return;
    }

    container.classList.remove('hidden');
    document.getElementById('btn-regul-print-pre').classList.remove('hidden');
    tbody.innerHTML = '';
    
    txs.forEach(tx => {
      const tr = document.createElement('tr');
      tr.id = `regul-row-${tx.id}`;
      tr.dataset.amount = tx.amount;
      tr.innerHTML = `
        <td>${formatDateFR(tx.cash_date)}</td>
        <td><b>CP-${String(tx.id).padStart(5, '0')}</b><br><small>${tx.nature} : ${tx.object}</small></td>
        <td class="font-bold">${formatAmount(tx.amount)}</td>
        <td>
          <input type="text" id="regul-spent-${tx.id}" class="amount-format" style="width:120px;text-align:right;" value="${formatAmount(tx.amount)}" oninput="calculateReconciliationGaps()">
        </td>
        <td><span id="regul-gap-${tx.id}" class="font-bold text-success">0</span></td>
      `;
      tbody.appendChild(tr);
    });

    calculateReconciliationGaps();
  } catch (err) {
    alert("Erreur de chargement.");
  }
}

// Compute individual and global gaps in reconciliation on the fly
function calculateReconciliationGaps() {
  let totalOutflow = 0;
  let totalSpent = 0;
  
  const tbody = document.getElementById('regul-items-list');
  const rows = tbody.querySelectorAll('tr');
  
  rows.forEach(tr => {
    const txId = tr.id.replace('regul-row-', '');
    const outflow = parseFloat(tr.dataset.amount) || 0;
    
    const inputVal = document.getElementById(`regul-spent-${txId}`).value;
    const spent = getNumericValue(inputVal);
    
    const gap = outflow - spent;
    
    totalOutflow += outflow;
    totalSpent += spent;
    
    const gapSpan = document.getElementById(`regul-gap-${txId}`);
    gapSpan.textContent = formatAmount(gap);
    
    if (gap === 0) {
      gapSpan.className = 'font-bold';
      gapSpan.textContent = '0';
    } else if (gap > 0) {
      gapSpan.className = 'font-bold text-success'; // buyer returns cash
    } else {
      gapSpan.className = 'font-bold text-danger'; // complementary outflow
    }
  });

  const overallGap = totalOutflow - totalSpent;
  document.getElementById('regul-total-outflow').textContent = formatAmount(totalOutflow);
  document.getElementById('regul-total-spent').textContent = formatAmount(totalSpent);
  
  const totalGapEl = document.getElementById('regul-total-gap');
  totalGapEl.textContent = formatAmount(overallGap);
  if (overallGap === 0) totalGapEl.className = 'font-bold';
  else if (overallGap > 0) totalGapEl.className = 'font-bold text-success';
  else totalGapEl.className = 'font-bold text-danger';
}

// Submit Reconciliation Draft to RAF validation
async function submitReconciliation() {
  const start = document.getElementById('regul-date-start').value;
  const end = document.getElementById('regul-date-end').value;
  
  const tbody = document.getElementById('regul-items-list');
  const rows = tbody.querySelectorAll('tr');
  
  const items = [];
  rows.forEach(tr => {
    const txId = parseInt(tr.id.replace('regul-row-', ''), 10);
    const inputVal = document.getElementById(`regul-spent-${txId}`).value;
    const spent = getNumericValue(inputVal);
    items.push({
      transaction_id: txId,
      spent_amount: spent
    });
  });

  if (items.length === 0) return;

  if (!confirm("Voulez-vous soumettre cet état de régularisation pour visa du RAF ?")) return;

  try {
    const res = await fetch(`${API_BASE}/api/reconciliations/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date_start: start,
        date_end: end,
        created_by: state.currentUser.name,
        items: items
      })
    });
    const reply = await res.json();
    if (reply.success) {
      alert("L'état a bien été transmis. En attente de validation par le RAF.");
      document.getElementById('regul-items-container').classList.add('hidden');
      document.getElementById('btn-regul-print-pre').classList.add('hidden');
      switchCaissiereTab('tab-regularisations');
    } else {
      alert(reply.error);
    }
  } catch (err) {
    alert("Erreur.");
  }
}

// Load reconciliations history
async function loadReconciliationsHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/reconciliations/status`);
    const recs = await res.json();
    
    const tbody = document.getElementById('regul-history-list');
    tbody.innerHTML = '';
    
    if (recs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">Aucune régularisation transmise.</td></tr>';
      return;
    }

    recs.forEach(rec => {
      const tr = document.createElement('tr');
      
      let badgeClass = 'badge-unjustified';
      let badgeText = 'En attente RAF';
      if (rec.status === 'validated_raf') {
        badgeClass = 'badge-justified';
        badgeText = 'Validé (RAF)';
      } else if (rec.status === 'finalized') {
        badgeClass = 'badge-open';
        badgeText = 'Finalisé';
      }

      const statusBadge = `<span class="badge ${badgeClass}">${badgeText}</span>`;
      
      let actionBtn = '';
      if (rec.status === 'validated_raf') {
        actionBtn = `<button class="btn btn-sm btn-success" onclick="finalizeReconciliation(${rec.id})">Finaliser</button>`;
      }
      
      actionBtn += ` <button class="btn btn-sm btn-secondary" onclick="printReconciliationReport(${rec.id})">🖨️ État</button>`;

      tr.innerHTML = `
        <td><b>REG-${String(rec.id).padStart(4, '0')}</b></td>
        <td>Du ${formatDateFR(rec.date_start)}<br>Au ${formatDateFR(rec.date_end)}</td>
        <td>${formatDateTimeFR(rec.created_at)}</td>
        <td class="font-bold">${formatAmount(rec.gap)}</td>
        <td>${statusBadge}</td>
        <td>${actionBtn}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Erreur historique régul", err);
  }
}

// Finalize Approved Reconciliation
async function finalizeReconciliation(recId) {
  if (!confirm("Voulez-vous finaliser cette régularisation ? Un flux d'écart (retour ou complément) sera enregistré en caisse principale.")) return;
  try {
    const res = await fetch(`${API_BASE}/api/reconciliations/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reconciliation_id: recId,
        created_by: state.currentUser.name
      })
    });
    const reply = await res.json();
    if (reply.success) {
      alert("Régularisation finalisée !");
      refreshCashierWorkspace();
      loadReconciliationsHistory();
    } else {
      alert(reply.error);
    }
  } catch (err) {
    alert("Erreur de finalisation.");
  }
}

// Caissière History Search
async function triggerHistorySearch() {
  const caisse = document.getElementById('hist-caisse').value;
  const type = document.getElementById('hist-type').value;
  const start = document.getElementById('hist-start-date').value;
  const end = document.getElementById('hist-end-date').value;
  const query = document.getElementById('hist-query').value;

  try {
    const url = new URL(`${API_BASE}/api/transactions/search`);
    if (caisse) url.searchParams.append('cash_type', caisse);
    if (type) url.searchParams.append('type', type);
    if (start) url.searchParams.append('date_start', start);
    if (end) url.searchParams.append('date_end', end);
    if (query) url.searchParams.append('query', query);

    const res = await fetch(url);
    const data = await res.json();
    
    const tbody = document.getElementById('hist-results-table');
    tbody.innerHTML = '';
    
    if (data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" class="text-center">Aucune transaction trouvée.</td></tr>';
      return;
    }

    data.forEach(tx => {
      const tr = document.createElement('tr');
      const prefix = tx.cash_type === 'principale' ? 'CP' : 'CE';
      
      let justifBadge = '-';
      if (tx.needs_justification === 1) {
        justifBadge = tx.is_justified === 1 
          ? '<span class="badge-justified">Justifié</span>'
          : '<span class="badge-unjustified">Non justifié</span>';
      }

      tr.innerHTML = `
        <td><b>${prefix}-${String(tx.id).padStart(5, '0')}</b></td>
        <td>Caisse ${tx.cash_type === 'principale' ? 'Principale' : "d'Exploit."}</td>
        <td>${formatDateFR(tx.cash_date)}</td>
        <td>${tx.type === 'entree' ? '📥 Entrée' : '📤 Sortie'}</td>
        <td>${formatCategoryName(tx.category)}</td>
        <td><b>${tx.nature || '-'}</b><br><small>${tx.object || '-'}</small></td>
        <td>${tx.beneficiary_name || '-'}</td>
        <td class="font-bold ${tx.type === 'entree' ? 'text-success' : 'text-danger'}">${formatAmount(tx.amount)}</td>
        <td>${justifBadge}</td>
        <td>${tx.created_by}</td>
        <td><button class="btn btn-sm btn-secondary" onclick="printVoucher(${tx.id})">🖨️ Bon</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    alert("Erreur de recherche.");
  }
}

// RAF Dashboard KPI reload
async function refreshRafDashboard() {
  try {
    const res = await fetch(`${API_BASE}/api/dashboard`);
    const metrics = await res.json();
    
    document.getElementById('kpi-cp-balance').textContent = formatAmount(metrics.caisse_principale.balance);
    document.getElementById('kpi-cp-in').textContent = formatAmount(metrics.caisse_principale.today_inflows);
    document.getElementById('kpi-cp-out').textContent = formatAmount(metrics.caisse_principale.today_outflows);
    
    const cpBadge = document.getElementById('kpi-cp-status');
    cpBadge.textContent = metrics.caisse_principale.status === 'open' ? 'Ouverte' : 'Fermée';
    cpBadge.className = `badge ${metrics.caisse_principale.status === 'open' ? 'badge-open' : 'badge-closed'}`;

    document.getElementById('kpi-ce-balance').textContent = formatAmount(metrics.caisse_exploitation.balance);
    document.getElementById('kpi-ce-in').textContent = formatAmount(metrics.caisse_exploitation.today_inflows);
    document.getElementById('kpi-ce-out').textContent = formatAmount(metrics.caisse_exploitation.today_outflows);
    
    const ceBadge = document.getElementById('kpi-ce-status');
    ceBadge.textContent = metrics.caisse_exploitation.status === 'open' ? 'Ouverte' : 'Fermée';
    ceBadge.className = `badge ${metrics.caisse_exploitation.status === 'open' ? 'badge-open' : 'badge-closed'}`;

    document.getElementById('kpi-unjust-count').textContent = metrics.unjustified.count;
    document.getElementById('kpi-unjust-amount').textContent = formatAmount(metrics.unjustified.total_amount);

    document.getElementById('kpi-pending-recs').textContent = metrics.pending_reconciliations_count;
    
    // Update badge dynamically on validation tab
    const badge = document.getElementById('badge-validation-count');
    if (metrics.pending_reconciliations_count > 0) {
      badge.textContent = metrics.pending_reconciliations_count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Sessions details
    const cpDetails = document.getElementById('raf-cp-session-details');
    if (metrics.caisse_principale.status === 'open') {
      cpDetails.innerHTML = `
        <div class="session-detail-line"><span>Statut session :</span><span class="text-success font-bold">OUVERTE</span></div>
        <div class="session-detail-line"><span>Date de caisse :</span><span>${formatDateFR(metrics.caisse_principale.date)}</span></div>
        <div class="session-detail-line"><span>Ouverte par :</span><span>${metrics.caisse_principale.opened_by}</span></div>
      `;
    } else {
      cpDetails.innerHTML = `<p class="text-muted">Aucune session active en cours sur la Caisse Principale.</p>`;
    }

    const ceDetails = document.getElementById('raf-ce-session-details');
    if (metrics.caisse_exploitation.status === 'open') {
      ceDetails.innerHTML = `
        <div class="session-detail-line"><span>Statut session :</span><span class="text-success font-bold">OUVERTE</span></div>
        <div class="session-detail-line"><span>Date de caisse :</span><span>${formatDateFR(metrics.caisse_exploitation.date)}</span></div>
        <div class="session-detail-line"><span>Ouverte par :</span><span>${metrics.caisse_exploitation.opened_by}</span></div>
      `;
    } else {
      ceDetails.innerHTML = `<p class="text-muted">Aucune session active en cours sur la Caisse d'Exploitation.</p>`;
    }

  } catch (err) {
    console.error("Erreur RAF dashboard stats", err);
  }
}

// Load pending reconciliations for RAF Validation
async function loadPendingReconciliations() {
  try {
    const res = await fetch(`${API_BASE}/api/reconciliations/pending`);
    const recs = await res.json();
    
    const container = document.getElementById('raf-pending-reconciliations');
    container.innerHTML = '';
    
    if (recs.length === 0) {
      container.innerHTML = '<p class="text-center text-muted">Aucune régularisation en attente de validation.</p>';
      return;
    }

    recs.forEach(rec => {
      const card = document.createElement('div');
      card.className = 'regul-validation-card margin-bottom-lg';
      
      let rowsHtml = '';
      rec.items.forEach(item => {
        rowsHtml += `
          <tr>
            <td>${formatDateTimeFR(item.tx_date)}</td>
            <td><b>CP-${String(item.transaction_id).padStart(5, '0')}</b> : ${item.nature}</td>
            <td>${formatAmount(item.outflow_amount)}</td>
            <td>${formatAmount(item.spent_amount)}</td>
            <td class="font-bold ${item.gap > 0 ? 'text-success' : 'text-danger'}">${formatAmount(item.gap)}</td>
          </tr>
        `;
      });

      card.innerHTML = `
        <div class="regul-validation-header">
          <h4>Demande N° REG-${String(rec.id).padStart(4, '0')}</h4>
          <span>Transmis par <b>${rec.created_by}</b> le ${formatDateTimeFR(rec.created_at)}</span>
        </div>
        <p class="margin-bottom-lg">
          Période du <b>${formatDateFR(rec.date_start)}</b> au <b>${formatDateFR(rec.date_end)}</b>.
          Avances globales : <b>${formatAmount(rec.total_outflow)}</b> | Dépensé réel : <b>${formatAmount(rec.total_spent)}</b> | Écart global : <b class="${rec.gap > 0 ? 'text-success' : 'text-danger'}">${formatAmount(rec.gap)}</b>.
        </p>
        <div class="table-responsive margin-bottom-lg">
          <table class="data-table compact">
            <thead>
              <tr>
                <th>Date / Heure</th>
                <th>Dépense Initiale</th>
                <th>Montant Avance</th>
                <th>Dépensé Réel</th>
                <th>Écart</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
        <div class="text-right">
          <button class="btn btn-secondary" onclick="printReconciliationReport(${rec.id})">🖨️ Aperçu État</button>
          <button class="btn btn-success" onclick="validateReconciliation(${rec.id})">✔️ Valider la Régularisation (Visa RAF)</button>
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    console.error("Erreur validation recs", err);
  }
}

// Validate a reconciliation (RAF Visa)
async function validateReconciliation(recId) {
  if (!confirm("Voulez-vous valider cette régularisation et y apposer votre visa ?")) return;
  try {
    const res = await fetch(`${API_BASE}/api/reconciliations/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reconciliation_id: recId,
        validated_by: state.currentUser.name
      })
    });
    const reply = await res.json();
    if (reply.success) {
      alert("Régularisation validée ! Elle est désormais finalisable par la caissière.");
      loadPendingReconciliations();
      refreshRafDashboard();
    } else {
      alert(reply.error);
    }
  } catch (err) {
    alert("Erreur.");
  }
}

// RAF Histories Column Search
async function triggerRafHistorySearch(caisseType) {
  const start = document.getElementById(`raf-${caisseType === 'principale' ? 'cp' : 'ce'}-hist-start`).value;
  const end = document.getElementById(`raf-${caisseType === 'principale' ? 'cp' : 'ce'}-hist-end`).value;
  const query = document.getElementById(`raf-${caisseType === 'principale' ? 'cp' : 'ce'}-hist-query`).value;

  try {
    const url = new URL(`${API_BASE}/api/transactions/search`);
    url.searchParams.append('cash_type', caisseType);
    if (start) url.searchParams.append('date_start', start);
    if (end) url.searchParams.append('date_end', end);
    if (query) url.searchParams.append('query', query);

    const res = await fetch(url);
    const data = await res.json();
    
    const tbody = document.getElementById(`raf-${caisseType === 'principale' ? 'cp' : 'ce'}-history-rows`);
    tbody.innerHTML = '';
    
    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Aucune écriture trouvée.</td></tr>`;
      return;
    }

    data.forEach(tx => {
      const tr = document.createElement('tr');
      
      const valEntree = tx.type === 'entree' ? formatAmount(tx.amount) : '-';
      const valSortie = tx.type === 'sortie' ? formatAmount(tx.amount) : '-';
      
      let statusText = '-';
      if (tx.needs_justification === 1) {
        statusText = tx.is_justified === 1 
          ? '<span class="badge-justified">Justifié</span>' 
          : '<span class="badge-unjustified">En attente</span>';
      }

      if (caisseType === 'principale') {
        tr.innerHTML = `
          <td><small>${formatDateFR(tx.cash_date)}</small></td>
          <td><b>${tx.beneficiary_name}</b><br><small>${tx.beneficiary_type}</small></td>
          <td><small>${tx.nature}</small><br><small class="text-muted">${tx.object}</small></td>
          <td class="text-success font-bold">${valEntree}</td>
          <td class="text-danger font-bold">${valSortie}</td>
          <td>${statusText}</td>
        `;
      } else {
        tr.innerHTML = `
          <td><small>${formatDateFR(tx.cash_date)}</small></td>
          <td><b>${tx.beneficiary_name}</b></td>
          <td><small>${tx.nature}</small><br><small class="text-muted">${tx.object}</small></td>
          <td class="text-success font-bold">${valEntree}</td>
          <td class="text-danger font-bold">${valSortie}</td>
        `;
      }
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error("Erreur recherche historique RAF " + caisseType, err);
  }
}

// Refresh active agents list for RAF parameters view
async function refreshActiveUsers() {
  try {
    const res = await fetch(`${API_BASE}/api/users`);
    const users = await res.json();
    
    const tbody = document.getElementById('active-agents-list');
    tbody.innerHTML = '';
    
    users.forEach(u => {
      const tr = document.createElement('tr');
      
      const roleText = u.role === 'raf' ? 'RAF' : 'Caissière';
      const roleBadge = u.role === 'raf' ? 'badge-raf' : '';
      
      const statusText = u.is_active === 1 ? 'Actif' : 'Inactif';
      const statusBadge = u.is_active === 1 ? 'badge-open' : 'badge-closed';
      
      tr.innerHTML = `
        <td><b>${u.name}</b></td>
        <td><code>${u.username}</code></td>
        <td><span class="user-role-badge ${roleBadge}">${roleText}</span></td>
        <td><span class="badge ${statusBadge}">${statusText}</span></td>
        <td class="text-right">
          <button class="btn btn-sm btn-secondary btn-edit-user" data-id="${u.id}" data-name="${u.name}" data-username="${u.username}" data-role="${u.role}" data-active="${u.is_active}">Modifier</button>
          <button class="btn btn-sm ${u.is_active === 1 ? 'btn-warning' : 'btn-success'} btn-toggle-user" data-id="${u.id}" data-active="${u.is_active}">${u.is_active === 1 ? 'Désactiver' : 'Activer'}</button>
          <button class="btn btn-sm btn-danger btn-delete-user" data-id="${u.id}">Supprimer</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
  }
}

// Open user editing modal
function openEditUserModal(id, name, username, role, is_active) {
  document.getElementById('edit-user-id').value = id;
  document.getElementById('edit-user-name').value = name;
  document.getElementById('edit-user-username').value = username;
  document.getElementById('edit-user-password').value = '';
  document.getElementById('edit-user-role').value = role;
  document.getElementById('edit-user-active').value = is_active;
  openModal('modal-edit-user');
}

// Toggle user status
async function toggleUserStatus(id, currentActive) {
  const newActive = currentActive === '1' ? 0 : 1;
  const actionText = newActive === 1 ? "activer" : "désactiver";
  if (!confirm(`Voulez-vous vraiment ${actionText} cet agent ?`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/users`);
    const users = await res.json();
    const user = users.find(u => u.id == id);
    if (!user) return;

    const updateRes = await fetch(`${API_BASE}/api/users/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        is_active: newActive
      })
    });
    const updateData = await updateRes.json();
    if (updateData.success) {
      alert(updateData.message);
      refreshActiveUsers();
    } else {
      alert(updateData.error);
    }
  } catch (err) {
    console.error(err);
    alert("Erreur lors de la modification du statut.");
  }
}

// Delete user agent
async function deleteUser(id) {
  if (!confirm("Voulez-vous vraiment supprimer définitivement cet agent ? Cette action est irréversible.")) return;

  try {
    const res = await fetch(`${API_BASE}/api/users/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.success) {
      alert(data.message);
      refreshActiveUsers();
    } else {
      alert(data.error);
    }
  } catch (err) {
    console.error(err);
    alert("Erreur lors de la suppression de l'agent.");
  }
}

// Print Voucher (Bon)
async function printVoucher(txId) {
  try {
    const res = await fetch(`${API_BASE}/api/transactions`);
    const all = await res.json();
    const tx = all.find(t => t.id === txId);
    
    if (!tx) return;

    // Populating printed container
    const isCP = tx.cash_type === 'principale';
    const prefix = isCP ? 'CP' : 'CE';
    
    document.getElementById('print-voucher-number').textContent = `${prefix}-${String(tx.id).padStart(5, '0')}`;
    document.getElementById('print-voucher-caisse').textContent = isCP ? 'Principale' : "d'Exploitation";
    document.getElementById('print-voucher-title').textContent = tx.type === 'entree' ? "BON D'ENTRÉE DE CAISSE" : "BON DE SORTIE DE CAISSE";
    document.getElementById('print-date-time').textContent = formatDateTimeFR(tx.created_at);
    document.getElementById('print-beneficiary').textContent = `${tx.beneficiary_name || ''} ${isCP && tx.beneficiary_type ? '(' + tx.beneficiary_type + ')' : ''}`;
    
    if (isCP && tx.type === 'sortie') {
      document.getElementById('print-row-nature').classList.remove('hidden');
      document.getElementById('print-nature').textContent = tx.nature || '';
      document.getElementById('print-row-object').classList.remove('hidden');
      document.getElementById('print-object').textContent = tx.object || '';
    } else {
      // For entry or ce checkout
      document.getElementById('print-row-nature').classList.remove('hidden');
      document.getElementById('print-nature').textContent = tx.nature || '';
      document.getElementById('print-row-object').classList.remove('hidden');
      document.getElementById('print-object').textContent = tx.object || '';
    }

    document.getElementById('print-amount-num').textContent = formatAmount(tx.amount);
    document.getElementById('print-amount-words').textContent = numberToWordsFrench(tx.amount);
    
    // Check justification status visible on printed voucher
    const justifRow = document.getElementById('print-row-justification');
    if (tx.needs_justification === 1 && tx.is_justified === 0) {
      justifRow.classList.remove('hidden');
    } else {
      justifRow.classList.add('hidden');
    }

    document.getElementById('print-sign-caissiere').textContent = tx.created_by;
    document.getElementById('print-sign-beneficiary').textContent = tx.beneficiary_name || 'Bénéficiaire';

    window.print();
  } catch (err) {
    console.error(err);
  }
}

// Print Closing Report
async function printClosingReport(caisseType) {
  try {
    const res = await fetch(`${API_BASE}/api/cash/status`);
    const status = await res.json();
    const info = status[caisseType];
    
    if (!info || info.status !== 'closed') {
      alert("Le rapport de fermeture ne peut être imprimé que sur une session clôturée.");
      return;
    }

    document.getElementById('print-report-caisse').textContent = caisseType === 'principale' ? 'Principale' : "d'Exploitation";
    document.getElementById('print-report-date').textContent = formatDateFR(info.date);
    document.getElementById('print-report-opened-by').textContent = info.opened_by;
    document.getElementById('print-report-closed-by').textContent = info.closed_by;
    document.getElementById('print-report-opened-at').textContent = formatDateTimeFR(info.opened_at);
    document.getElementById('print-report-closed-at').textContent = formatDateTimeFR(info.closed_at);
    
    // Summaries
    const initBal = info.opening_balance || 0;
    
    // We need to fetch transactions linked to this cash day
    // For printing we fetch all, then filters in frontend to match this day id
    const resTxs = await fetch(`${API_BASE}/api/transactions`);
    const allTxs = await resTxs.json();
    const dayTxs = allTxs.filter(t => t.cash_day_id === info.id);

    let inflows = 0;
    let outflows = 0;
    dayTxs.forEach(t => {
      if (t.type === 'entree') inflows += t.amount;
      else if (t.type === 'sortie') outflows += t.amount;
    });

    const expected = initBal + inflows - outflows;
    const counted = info.closing_balance || 0;
    const gap = counted - expected;

    document.getElementById('print-report-init-bal').textContent = formatAmount(initBal);
    document.getElementById('print-report-inflows').textContent = formatAmount(inflows);
    document.getElementById('print-report-outflows').textContent = formatAmount(outflows);
    document.getElementById('print-report-expected-bal').textContent = formatAmount(expected);
    document.getElementById('print-report-counted-bal').textContent = formatAmount(counted);
    
    const gapEl = document.getElementById('print-report-gap');
    gapEl.textContent = formatAmount(gap);
    gapEl.className = gap === 0 ? '' : (gap > 0 ? 'text-success font-bold' : 'text-danger font-bold');

    // Parse billetage
    let billetage = {};
    try {
      billetage = JSON.parse(info.billetage);
    } catch(e) {
      console.error(e);
    }

    const t1 = document.getElementById('print-report-billetage-rows-1');
    const t2 = document.getElementById('print-report-billetage-rows-2');
    t1.innerHTML = '';
    t2.innerHTML = '';

    // split denoms into two columns
    const d1 = DENOMINATIONS.slice(0, 7);
    const d2 = DENOMINATIONS.slice(7);

    const renderBRows = (el, list) => {
      list.forEach(den => {
        const qty = billetage[den] || 0;
        const total = qty * den;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><b>${formatAmount(den)}</b></td>
          <td>${qty}</td>
          <td>${formatAmount(total)}</td>
        `;
        el.appendChild(tr);
      });
    };

    renderBRows(t1, d1);
    renderBRows(t2, d2);

    window.print();
  } catch (err) {
    console.error(err);
  }
}

// Print Reconciliation Report (Pre or Post)
async function printReconciliationReport(recId) {
  try {
    const res = await fetch(`${API_BASE}/api/reconciliations/status`);
    const all = await res.json();
    const rec = all.find(r => r.id === recId);
    
    if (!rec) return;

    document.getElementById('print-recon-id').textContent = String(rec.id).padStart(4, '0');
    document.getElementById('print-recon-period').textContent = `Du ${formatDateFR(rec.date_start)} Au ${formatDateFR(rec.date_end)}`;
    document.getElementById('print-recon-created-at').textContent = formatDateTimeFR(rec.created_at);
    document.getElementById('print-recon-created-by').textContent = rec.created_by;
    
    let statusText = 'En attente de validation';
    if (rec.status === 'validated_raf') statusText = 'Validé (RAF)';
    else if (rec.status === 'finalized') statusText = 'Finalisé et équilibré';
    document.getElementById('print-recon-status').textContent = statusText;
    document.getElementById('print-recon-validated-by').textContent = rec.validated_by || 'Non visé';

    const tbody = document.getElementById('print-recon-rows');
    tbody.innerHTML = '';
    
    rec.items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${formatDateTimeFR(item.tx_date)}</td>
        <td>${item.beneficiary_name || 'Acheteuse'}</td>
        <td><b>CP-${String(item.transaction_id).padStart(5, '0')}</b> : ${item.nature || ''} (${item.object || ''})</td>
        <td>${formatAmount(item.outflow_amount)}</td>
        <td>${formatAmount(item.spent_amount)}</td>
        <td class="font-bold ${item.gap > 0 ? 'text-success' : (item.gap < 0 ? 'text-danger' : '')}">${formatAmount(item.gap)}</td>
      `;
      tbody.appendChild(tr);
    });

    document.getElementById('print-recon-total-outflow').textContent = formatAmount(rec.total_outflow);
    document.getElementById('print-recon-total-spent').textContent = formatAmount(rec.total_spent);
    document.getElementById('print-recon-total-gap').textContent = formatAmount(rec.gap);

    const conclText = document.getElementById('print-recon-conclusion-text');
    const gap = rec.gap;
    
    if (rec.status === 'finalized') {
      if (gap > 0) {
        conclText.textContent = `La régularisation a été finalisée. L'acheteuse a effectué un retour physique de fonds en caisse principale d'un montant de ${formatAmount(gap)} FCFA (Bon d'entrée associé).`;
      } else if (gap < 0) {
        conclText.textContent = `La régularisation a été finalisée. Un décaissement complémentaire d'un montant de ${formatAmount(Math.abs(gap))} FCFA a été octroyé à l'acheteuse (Bon de sortie associé).`;
      } else {
        conclText.textContent = `La régularisation a été finalisée. Les dépenses correspondent exactement aux avances octroyées (Aucun écart).`;
      }
    } else {
      if (gap > 0) {
        conclText.textContent = `Écart positif détecté. L'acheteuse devra restituer la somme de ${formatAmount(gap)} FCFA en caisse après validation du RAF.`;
      } else if (gap < 0) {
        conclText.textContent = `Écart négatif détecté. La caisse devra verser un complément de ${formatAmount(Math.abs(gap))} FCFA à l'acheteuse après validation du RAF.`;
      } else {
        conclText.textContent = `Équilibre parfait. Aucun ajustement financier nécessaire après validation.`;
      }
    }

    window.print();
  } catch (err) {
    console.error(err);
  }
}

// Print draft pre-reconciliation state from cashier screen
function printDraftReconciliation() {
  const start = document.getElementById('regul-date-start').value;
  const end = document.getElementById('regul-date-end').value;
  
  document.getElementById('print-recon-id').textContent = 'BROUILLON';
  document.getElementById('print-recon-period').textContent = `Du ${formatDateFR(start)} Au ${formatDateFR(end)}`;
  document.getElementById('print-recon-created-at').textContent = formatDateTimeFR(new Date().toISOString());
  document.getElementById('print-recon-created-by').textContent = state.currentUser.name;
  document.getElementById('print-recon-status').textContent = 'BROUILLON AVANT TRANSMISSION';
  document.getElementById('print-recon-validated-by').textContent = 'Non visé';

  const draftBody = document.getElementById('print-recon-rows');
  draftBody.innerHTML = '';

  const tbody = document.getElementById('regul-items-list');
  const rows = tbody.querySelectorAll('tr');
  
  rows.forEach(tr => {
    const txId = tr.id.replace('regul-row-', '');
    const amount = parseFloat(tr.dataset.amount) || 0;
    const spent = getNumericValue(document.getElementById(`regul-spent-${txId}`).value);
    const gap = amount - spent;

    const trPrint = document.createElement('tr');
    trPrint.innerHTML = `
      <td>-</td>
      <td>Acheteuse</td>
      <td><b>CP-${String(txId).padStart(5, '0')}</b> (Brouillon)</td>
      <td>${formatAmount(amount)}</td>
      <td>${formatAmount(spent)}</td>
      <td class="font-bold">${formatAmount(gap)}</td>
    `;
    draftBody.appendChild(trPrint);
  });

  document.getElementById('print-recon-total-outflow').textContent = document.getElementById('regul-total-outflow').textContent;
  document.getElementById('print-recon-total-spent').textContent = document.getElementById('regul-total-spent').textContent;
  document.getElementById('print-recon-total-gap').textContent = document.getElementById('regul-total-gap').textContent;

  const gap = getNumericValue(document.getElementById('regul-total-gap').textContent);
  const conclText = document.getElementById('print-recon-conclusion-text');
  conclText.textContent = `ÉTAT PRÉVISIONNEL NON TRANSMIS. Écart prévisionnel : ${formatAmount(gap)} FCFA.`;

  window.print();
}

// Print selection from history
async function printHistorySelection(caisseType) {
  // Simple print of the history table elements visible on screen
  window.print();
}

// Helper formatting utilities
function formatAmount(val) {
  if (val === undefined || val === null) return '0';
  const parsed = parseFloat(val);
  if (isNaN(parsed)) return '0';
  
  // Format with space thousands separator
  return parsed.toLocaleString('fr-FR', { maximumFractionDigits: 0 }).replace(/,/g, ' ');
}

function formatDateFR(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

function formatDateTimeFR(dateTimeStr) {
  if (!dateTimeStr) return '';
  try {
    const date = new Date(dateTimeStr.replace(' ', 'T'));
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch(e) {
    return dateTimeStr;
  }
}

function formatCategoryName(cat) {
  const dict = {
    'appro_raf': 'Approvisionnement RAF',
    'recettes_boutique': 'Recette Boutique Hall',
    'reception': 'Réception',
    'restaurant': 'Restaurant',
    'bar_hall': 'Bar HALL',
    'piscine': 'Piscine',
    'regularisation': 'Régularisation Acheteuse',
    'transfert_sortant': 'Transfert (Sortie)',
    'transfert_entrant': 'Transfert (Entrée)',
    'dépenses d’exploitation': 'Dépense d\'exploitation',
    'règlements des fournisseurs': 'Règlement Fournisseur',
    'versements en banque': 'Versement Banque',
    'remise de fonds au DAF': 'Remise au DAF',
    'paiement de commissions': 'Paiement Commission',
    'autres': 'Autres'
  };
  return dict[cat] || cat || '-';
}

function formatAmountString(value) {
  let clean = value.replace(/[^\d]/g, '');
  if (clean === '') return '';
  return parseInt(clean, 10).toLocaleString('fr-FR').replace(/,/g, ' ');
}

function getNumericValue(str) {
  if (!str) return 0;
  return parseFloat(str.toString().replace(/\s/g, '')) || 0;
}

// Convert numbers to words in French (useful for vouchers)
function numberToWordsFrench(amount) {
  const integerPart = Math.floor(Math.abs(amount));
  if (integerPart === 0) return "zéro francs CFA";

  const units = ["", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"];
  const teens = ["dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
  const tens = ["", "dix", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante-dix", "quatre-vingts", "quatre-vingt-dix"];

  function convertLessThanThousand(n) {
    if (n === 0) return "";
    let res = "";

    // Hundreds
    let h = Math.floor(n / 100);
    let rem = n % 100;
    if (h > 0) {
      if (h === 1) {
        res += "cent ";
      } else {
        res += units[h] + " cent" + (rem === 0 ? "s " : " ");
      }
    }

    // Tens and Units
    if (rem > 0) {
      if (rem < 10) {
        res += units[rem];
      } else if (rem >= 10 && rem < 20) {
        res += teens[rem - 10];
      } else {
        let t = Math.floor(rem / 10);
        let u = rem % 10;

        if (t === 7) {
          res += "soixante-" + (u === 1 ? "et-onze" : teens[u]);
        } else if (t === 9) {
          res += "quatre-vingt-" + teens[u];
        } else {
          res += tens[t];
          if (u > 0) {
            res += (u === 1 ? " et " : "-") + units[u];
          }
        }
      }
    }
    return res.trim();
  }

  let words = "";
  let temp = integerPart;

  // Millions
  let millions = Math.floor(temp / 1000000);
  temp %= 1000000;
  if (millions > 0) {
    words += convertLessThanThousand(millions) + " million" + (millions > 1 ? "s " : " ");
  }

  // Thousands
  let thousands = Math.floor(temp / 1000);
  temp %= 1000;
  if (thousands > 0) {
    if (thousands === 1) {
      words += "mille ";
    } else {
      words += convertLessThanThousand(thousands) + " mille ";
    }
  }

  // Hundreds, Tens, Units
  if (temp > 0) {
    words += convertLessThanThousand(temp);
  }

  return (amount < 0 ? "moins " : "") + words.trim() + " francs CFA";
}

// Setup real-time input separator behavior
document.addEventListener('input', function(e) {
  if (e.target.classList.contains('amount-format')) {
    let cursorPosition = e.target.selectionStart;
    let originalLength = e.target.value.length;
    let formatted = formatAmountString(e.target.value);
    e.target.value = formatted;

    // Adjust cursor position
    let newLength = formatted.length;
    e.target.selectionEnd = cursorPosition + (newLength - originalLength);
  }
});
