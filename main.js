import './style.css';
import '@fontsource-variable/inter';
import '@fortawesome/fontawesome-free/css/all.min.css';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAN1bWeGMs1lzgyyx-RHWwB5vro3Gfri_Q",
  authDomain: "turntracker-1ab68.firebaseapp.com",
  projectId: "turntracker-1ab68",
  storageBucket: "turntracker-1ab68.appspot.com",
  messagingSenderId: "537033521288",
  appId: "1:537033521288:web:ed42fa5013efe85695073d"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
// Cache data on the device: the app opens instantly and keeps working through short Wi-Fi drops
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn('Offline cache not enabled:', err && err.code);
});
document.getElementById('sync-project').innerText = firebaseConfig.projectId;

const defaultTechs = [
  { id: 't1', name: 'Jenny', turns: 0, status: 'break', lastUpdated: 1000 },
  { id: 't2', name: 'Hannah', turns: 0, status: 'break', lastUpdated: 2000 },
  { id: 't3', name: 'Kevin', turns: 0, status: 'break', lastUpdated: 3000 },
  { id: 't4', name: 'Lisa', turns: 0, status: 'break', lastUpdated: 4000 }
];

const defaultServices = [
  { id: 's1', name: 'Basic Mani', turns: 0.5 },
  { id: 's2', name: 'Gel Mani', turns: 1.0 },
  { id: 's3', name: 'Full Set', turns: 1.0 },
  { id: 's4', name: 'Deluxe Pedi', turns: 1.0 },
  { id: 's5', name: 'Gel Pedi', turns: 1.5 },
  { id: 's6', name: 'Dip Powder', turns: 1.0 },
  { id: 's7', name: 'App', turns: 1.0 }
];

let techs = [];
let services = [];
let logs = [];

let selectedTechId = null;
let isEditingOrder = false;

document.addEventListener('DOMContentLoaded', () => {
  db.collection("nail_salon").doc("shared_state").onSnapshot((doc) => {
    if (doc.exists) {
      const data = doc.data();
      techs = normalizeTechs(data.techs || defaultTechs);
      services = data.services || defaultServices;
      logs = data.logs || [];
    } else {
      techs = normalizeTechs(defaultTechs);
      services = defaultServices;
      logs = [];
      saveState(['techs', 'services', 'logs']);
    }
    renderAll();
  }, (error) => {
    console.error("Firebase sync error:", error);
    document.getElementById('sync-status').classList.remove('bg-emerald-400');
    document.getElementById('sync-status').classList.add('bg-rose-500');
  });
});

const stateRef = () => db.collection("nail_salon").doc("shared_state");

function clean(v) {
  // Firestore rejects `undefined`; JSON round-trip strips it
  return JSON.parse(JSON.stringify(v));
}

function cloudErrorMessage(error) {
  const code = error && error.code ? error.code : '';
  if (code === 'permission-denied') return 'Firestore từ chối ghi dữ liệu (permission-denied). Kiểm tra Firestore Rules.';
  if (code === 'resource-exhausted' || code === 'invalid-argument') return 'Dữ liệu quá lớn hoặc không hợp lệ (' + code + '). Có thể mảng logs đã vượt 1MB.';
  if (code === 'unavailable' || code === 'failed-precondition') return 'Không kết nối được tới server. Kiểm tra internet.';
  return 'Lưu thất bại: ' + (error && error.message ? error.message : error);
}

function markSyncError(isError) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.classList.toggle('bg-rose-500', isError);
  el.classList.toggle('bg-emerald-400', !isError);
}

// Only writes the fields given (default: techs + logs). Services are written
// ONLY by saveServicesTransaction, so a stale tab can no longer overwrite them.
function saveState(fields = ['techs', 'logs']) {
  const payload = { lastUpdated: Date.now() };
  fields.forEach(f => {
    payload[f] = clean(f === 'techs' ? techs : f === 'services' ? services : logs);
  });
  return stateRef().set(payload, { merge: true }).then(() => markSyncError(false)).catch((error) => {
    console.error("Error saving state to cloud:", error);
    markSyncError(true);
    showToast(cloudErrorMessage(error));
  });
}

// Read-modify-write the services array on the SERVER's latest copy.
function saveServicesTransaction(mutator) {
  const ref = stateRef();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists && Array.isArray(snap.data().services)
      ? snap.data().services
      : defaultServices;
    const next = clean(mutator(current.map(s => ({ ...s }))));
    tx.set(ref, { services: next, lastUpdated: Date.now() }, { merge: true });
    return next;
  });
}

// ---------- Helpers ----------
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function toInput(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function fromInput(v) {
  const d = new Date();
  if (!v) return d.getTime();
  const [h, m] = v.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
function shortenServiceName(name) {
  if (!name) return '';
  return name
    .replace(/Manicure/gi, 'Mani')
    .replace(/Pedicure/gi, 'Pedi')
    .replace(/Dipping Powder/gi, 'Dip');
}
function normalizeTechs(list) {
  return list.map((t, i) => ({ ...t, signIn: t.signIn != null ? t.signIn : (t.lastUpdated != null ? t.lastUpdated : Date.now() + i) }));
}

// ---------- QUEUE ALGORITHM ----------
function getSortedActiveTechs() {
  return techs
    .filter(t => t.status === 'active')
    .sort((a, b) => {
      const roundA = Math.floor(a.turns + 1e-9);
      const roundB = Math.floor(b.turns + 1e-9);
      if (roundA !== roundB) return roundA - roundB;
      if (a.signIn !== b.signIn) return a.signIn - b.signIn;
      return String(a.id).localeCompare(String(b.id));
    });
}

function toggleEditOrder() {
  isEditingOrder = !isEditingOrder;
  const btn = document.getElementById('edit-order-btn');
  const txt = document.getElementById('edit-order-text');
  if (isEditingOrder) {
    btn.classList.add('bg-indigo-600', 'text-white');
    btn.classList.remove('bg-slate-100', 'text-slate-700');
    txt.innerText = 'Done Ordering';
  } else {
    btn.classList.remove('bg-indigo-600', 'text-white');
    btn.classList.add('bg-slate-100', 'text-slate-700');
    txt.innerText = 'Edit Order';
  }
  renderQueue();
}

function moveQueueOrder(techId, direction) {
  const activeTechs = getSortedActiveTechs();
  const index = activeTechs.findIndex(t => t.id === techId);
  if (index === -1) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= activeTechs.length) return;

  const currentTech = activeTechs[index];
  const targetTech = activeTechs[targetIndex];

  const tempSignIn = currentTech.signIn;
  currentTech.signIn = targetTech.signIn;
  targetTech.signIn = tempSignIn;

  if (currentTech.signIn === targetTech.signIn) {
    if (direction < 0) {
      currentTech.signIn -= 1;
    } else {
      currentTech.signIn += 1;
    }
  }

  saveState();
  renderAll();
}

function updateSignIn(techId, value) {
  const tech = techs.find(t => t.id === techId);
  if (!tech || !value) return;
  tech.signIn = fromInput(value);
  saveState();
  renderAll();
  showToast(`${tech.name} check-in set to ${fmtTime(tech.signIn)}`);
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.getElementById(`sec-${tabId}`).classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('bg-indigo-600', 'text-white', 'shadow');
    btn.classList.add('text-slate-600');
  });
  const activeBtn = document.getElementById(`tab-${tabId}`);
  activeBtn.classList.add('bg-indigo-600', 'text-white', 'shadow');
  activeBtn.classList.remove('text-slate-600');
}

function renderAll() {
  renderQueue();
  renderServicePanel();
  renderTechMgmtTable();
  renderServiceMgmtTable();
  renderHistoryTable();
  updateLogFilterOptions();
}

function selectTechForAssignment(techId) {
  selectedTechId = techId;
  renderQueue();
  renderServicePanel();
}

function clearSelectedTech() {
  selectedTechId = null;
  renderQueue();
  renderServicePanel();
}

function renderQueue() {
  const activeTechs = getSortedActiveTechs();
  const nextUpCard = document.getElementById('next-up-card');
  const queueList = document.getElementById('queue-list');
  const inactiveTechsList = document.getElementById('inactive-techs-list');

  if (selectedTechId && !activeTechs.some(t => t.id === selectedTechId)) {
    selectedTechId = null;
  }

  const activeTargetTech = selectedTechId 
    ? activeTechs.find(t => t.id === selectedTechId) 
    : activeTechs[0];

  if (activeTechs.length > 0) {
    const nextTech = activeTechs[0];
    document.getElementById('next-tech-name').innerText = nextTech.name;
    document.getElementById('next-tech-turns').innerText = `${nextTech.turns} Turns`;
    document.getElementById('next-tech-signin').innerText = fmtTime(nextTech.signIn);
    nextUpCard.classList.remove('opacity-50');

    if (activeTargetTech) {
      document.getElementById('selected-tech-name-display').innerText = selectedTechId ? `${activeTargetTech.name} (Selected)` : `${nextTech.name} (#1 Auto)`;
      document.getElementById('target-tech-display').innerText = activeTargetTech.name;
    }
  } else {
    document.getElementById('next-tech-name').innerText = 'No Active Techs';
    document.getElementById('next-tech-turns').innerText = '0 Turns';
    document.getElementById('next-tech-signin').innerText = '--';
    document.getElementById('selected-tech-name-display').innerText = 'None';
    document.getElementById('target-tech-display').innerText = 'No active tech';
  }

  queueList.innerHTML = '';
  if (activeTechs.length === 0) {
    queueList.innerHTML = `<div class="p-8 text-center text-slate-400 font-medium bg-slate-50 rounded-3xl border border-dashed border-slate-200">No technicians currently in queue. Click "Add to Queue" on the right as techs arrive for the day.</div>`;
  } else {
    activeTechs.forEach((tech, index) => {
      const isNext = index === 0;
      const isSelected = selectedTechId === tech.id || (!selectedTechId && isNext);

      const card = document.createElement('div');
      card.onclick = (e) => {
        if (e.target.closest('button')) return;
        selectTechForAssignment(tech.id);
      };

      card.className = `p-4 rounded-2xl border transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
        isSelected 
          ? 'bg-indigo-50/80 border-indigo-500 ring-2 ring-indigo-500/30 shadow-md scale-[1.01]' 
          : 'bg-white border-slate-200/80 hover:bg-slate-50 hover:border-slate-300'
      }`;

      card.innerHTML = `
        <div class="flex items-center gap-3">
          <span class="w-8 h-8 rounded-xl flex items-center justify-center font-bold text-xs ${
            isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'
          }">${index + 1}</span>
          <div>
            <div class="font-bold text-slate-800 flex items-center gap-2">
              ${esc(tech.name)}
              ${isNext ? '<span class="bg-indigo-100 text-indigo-700 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full">#1 Next Up</span>' : ''}
              ${isSelected ? '<span class="bg-emerald-100 text-emerald-700 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full"><i class="fa-solid fa-check text-[9px]"></i> Selected</span>' : ''}
            </div>
            <div class="text-xs text-slate-500 font-medium flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
              <span>Check-in: <span class="text-slate-800 font-bold">${fmtTime(tech.signIn)}</span></span>
              <span>Total: <span class="text-slate-800 font-bold">${tech.turns} Turns</span></span>
              <span class="bg-slate-100 text-slate-600 px-1.5 py-0.2 rounded font-semibold">Round ${Math.floor(tech.turns + 1e-9)}</span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2 self-end sm:self-auto" onclick="event.stopPropagation()">
          ${isEditingOrder ? `
            <div class="flex items-center space-x-1 bg-slate-100 border border-slate-200 rounded-xl p-1">
              <button onclick="moveQueueOrder('${tech.id}', -1)" ${index === 0 ? 'disabled class="w-7 h-7 flex items-center justify-center text-slate-300 rounded-lg text-xs cursor-not-allowed"' : 'class="w-7 h-7 flex items-center justify-center hover:bg-white rounded-lg text-slate-700 font-bold text-xs transition cursor-pointer"'} title="Move Up">
                <i class="fa-solid fa-arrow-up"></i>
              </button>
              <button onclick="moveQueueOrder('${tech.id}', 1)" ${index === activeTechs.length - 1 ? 'disabled class="w-7 h-7 flex items-center justify-center text-slate-300 rounded-lg text-xs cursor-not-allowed"' : 'class="w-7 h-7 flex items-center justify-center hover:bg-white rounded-lg text-slate-700 font-bold text-xs transition cursor-pointer"'} title="Move Down">
                <i class="fa-solid fa-arrow-down"></i>
              </button>
            </div>
          ` : `
            <div class="flex items-center space-x-1 bg-slate-100 border border-slate-200 rounded-xl p-1">
              <button onclick="adjustTurns('${tech.id}', -0.5)" class="w-7 h-7 flex items-center justify-center hover:bg-white rounded-lg text-slate-700 font-bold text-xs transition cursor-pointer" title="Minus 0.5 turn">-0.5</button>
              <button onclick="adjustTurns('${tech.id}', 0.5)" class="w-7 h-7 flex items-center justify-center hover:bg-white rounded-lg text-slate-700 font-bold text-xs transition cursor-pointer" title="Add 0.5 turn">+0.5</button>
            </div>
            <button onclick="toggleTechStatus('${tech.id}')" class="text-xs bg-slate-100 hover:bg-amber-100 hover:text-amber-800 text-slate-600 p-2.5 rounded-xl font-semibold transition cursor-pointer" title="Put on Break">
              <i class="fa-solid fa-pause"></i>
            </button>
          `}
        </div>
      `;
      queueList.appendChild(card);
    });
  }

  const inactiveTechs = techs.filter(t => t.status === 'break');
  inactiveTechsList.innerHTML = inactiveTechs.length === 0 
    ? `<div class="text-xs text-slate-400 italic">All technicians are active in queue.</div>` 
    : inactiveTechs.map(t => `
        <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-200/60">
          <div>
            <div class="font-semibold text-slate-700 text-xs">${esc(t.name)}</div>
            <div class="text-[10px] text-slate-400">${t.turns} Turns Today · Last check-in ${fmtTime(t.signIn)}</div>
          </div>
          <button onclick="toggleTechStatus('${t.id}')" class="bg-emerald-100 hover:bg-emerald-200 text-emerald-700 text-xs font-semibold px-2.5 py-1 rounded-lg transition flex items-center gap-1 cursor-pointer">
            <i class="fa-solid fa-play text-[10px]"></i> Add to Queue
          </button>
        </div>
      `).join('');
}

// ---------- RENDER COMPACT SERVICE PANEL ----------
function renderServicePanel() {
  const panel = document.getElementById('service-squares-panel');
  const clearBtn = document.getElementById('clear-sel-btn');

  if (selectedTechId) {
    clearBtn.classList.remove('hidden');
  } else {
    clearBtn.classList.add('hidden');
  }

  const sortedServices = [...services].sort((a, b) => a.turns - b.turns);

  panel.innerHTML = sortedServices.map(s => {
    const shortName = shortenServiceName(s.name);
    const isApp = s.name.toLowerCase() === 'app' || s.name.toLowerCase() === 'appointment';

    const boxClass = isApp
      ? "service-box bg-amber-50 hover:bg-amber-600 hover:text-white border border-amber-300 hover:border-amber-600 p-3 rounded-2xl flex flex-col justify-between items-center text-center transition-all duration-150 shadow-sm active:scale-95 cursor-pointer group"
      : "service-box bg-slate-50 hover:bg-indigo-600 hover:text-white border border-slate-200 hover:border-indigo-600 p-3 rounded-2xl flex flex-col justify-between items-center text-center transition-all duration-150 shadow-sm active:scale-95 cursor-pointer group";

    const badgeClass = isApp
      ? "text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 group-hover:bg-amber-500 group-hover:text-white transition"
      : "text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 group-hover:bg-indigo-500 group-hover:text-white transition";

    const textClass = isApp
      ? "text-sm font-bold leading-tight line-clamp-2 my-auto group-hover:text-white text-amber-900"
      : "text-sm font-bold leading-tight line-clamp-2 my-auto group-hover:text-white text-slate-800";

    return `
      <button onclick="assignSelectedService('${s.id}')" class="${boxClass}">
        <span class="${badgeClass}">
          +${s.turns} Turn${s.turns > 1 ? 's' : ''}
        </span>
        <span class="${textClass}">
          ${esc(shortName)}
        </span>
      </button>
    `;
  }).join('');
}

function assignSelectedService(serviceId) {
  const activeTechs = getSortedActiveTechs();
  if (activeTechs.length === 0) {
    showToast('No active technicians in queue!');
    return;
  }

  const targetTech = selectedTechId 
    ? activeTechs.find(t => t.id === selectedTechId) 
    : activeTechs[0];

  if (!targetTech) {
    showToast('Selected technician is no longer available');
    selectedTechId = null;
    renderAll();
    return;
  }

  executeServiceAssignment(targetTech.id, serviceId);
}

function executeServiceAssignment(techId, serviceId) {
  const tech = techs.find(t => t.id === techId);
  const service = services.find(s => s.id === serviceId);
  if (!tech || !service) return;

  tech.turns = parseFloat((tech.turns + service.turns).toFixed(1));

  logs.push({
    id: 'log_' + Date.now(),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    techId: tech.id,
    techName: tech.name,
    serviceName: service.name,
    turnsAdded: service.turns,
    undone: false
  });

  saveState();
  renderAll();
  showToast(`Assigned ${service.name} (+${service.turns} turn) to ${tech.name}`);
}

function adjustTurns(techId, amount) {
  const tech = techs.find(t => t.id === techId);
  if (!tech) return;

  tech.turns = Math.max(0, parseFloat((tech.turns + amount).toFixed(1)));

  saveState();
  renderAll();
  showToast(`Adjusted ${tech.name}'s turns by ${amount > 0 ? '+' + amount : amount}`);
}

function toggleTechStatus(techId) {
  const tech = techs.find(t => t.id === techId);
  if (!tech) return;

  tech.status = tech.status === 'active' ? 'break' : 'active';
  if (tech.status === 'active') {
    tech.signIn = Date.now();
  }

  saveState();
  renderAll();
  showToast(`${tech.name} is now ${tech.status === 'active' ? 'Active in queue' : 'Off Queue / On Break'}`);
}

function resetDailyTurns() {
  if (confirm('Are you sure you want to start a new day? This will reset all turns to 0, clear history logs, and clear the queue.')) {
    const now = Date.now();
    techs.forEach((t, index) => {
      t.turns = 0;
      t.status = 'break';
      t.signIn = now + index * 10;
    });
    logs = [];
    saveState();
    renderAll();
    showToast('New day started! Queue is empty. Click "Add to Queue" as techs arrive.');
  }
}

function renderTechMgmtTable() {
  const tbody = document.getElementById('tech-table-body');
  tbody.innerHTML = techs.map(t => `
    <tr class="hover:bg-slate-50/80 transition">
      <td class="p-4 font-semibold text-slate-800">${esc(t.name)}</td>
      <td class="p-4"><span class="bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg font-bold text-xs">${t.turns} Turns</span></td>
      <td class="p-4"><input type="time" value="${toInput(t.signIn)}" onchange="updateSignIn('${t.id}', this.value)" class="border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"></td>
      <td class="p-4">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
          t.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
        }">
          <span class="w-1.5 h-1.5 rounded-full ${t.status === 'active' ? 'bg-emerald-500' : 'bg-amber-500'}"></span>
          ${t.status === 'active' ? 'Active in Queue' : 'Off Queue / Break'}
        </span>
      </td>
      <td class="p-4 text-right space-x-2">
        <button onclick="toggleTechStatus('${t.id}')" class="text-amber-600 hover:text-amber-800 font-semibold text-xs cursor-pointer"><i class="fa-solid fa-right-left"></i> ${t.status === 'active' ? 'Break' : 'Check in'}</button>
        <button onclick="openTechModal('${t.id}')" class="text-indigo-600 hover:text-indigo-800 font-semibold text-xs cursor-pointer"><i class="fa-solid fa-pen"></i> Edit</button>
        <button onclick="deleteTech('${t.id}')" class="text-rose-600 hover:text-rose-800 font-semibold text-xs cursor-pointer"><i class="fa-solid fa-trash"></i> Delete</button>
      </td>
    </tr>
  `).join('');
}

function renderServiceMgmtTable() {
  const tbody = document.getElementById('service-table-body');
  tbody.innerHTML = services.map(s => `
    <tr class="hover:bg-slate-50/80 transition">
      <td class="p-4 font-semibold text-slate-800">${esc(s.name)}</td>
      <td class="p-4"><span class="bg-slate-100 text-slate-800 px-2.5 py-1 rounded-lg font-bold text-xs">${s.turns} Turn${s.turns > 1 ? 's' : ''}</span></td>
      <td class="p-4 text-right space-x-2">
        <button onclick="openServiceModal('${s.id}')" class="text-indigo-600 hover:text-indigo-800 font-semibold text-xs cursor-pointer"><i class="fa-solid fa-pen"></i> Edit</button>
        <button onclick="deleteService('${s.id}')" class="text-rose-600 hover:text-rose-800 font-semibold text-xs cursor-pointer"><i class="fa-solid fa-trash"></i> Delete</button>
      </td>
    </tr>
  `).join('');
}

function updateLogFilterOptions() {
  const filterSelect = document.getElementById('log-tech-filter');
  const selectedVal = filterSelect.value || 'ALL';
  filterSelect.innerHTML = `<option value="ALL">All Technicians</option>` +
    techs.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  filterSelect.value = selectedVal;
}

function renderHistoryTable() {
  const tbody = document.getElementById('history-table-body');
  const selectedTechIdFilter = document.getElementById('log-tech-filter')?.value || 'ALL';

  let displayLogs = logs.slice().reverse();
  if (selectedTechIdFilter !== 'ALL') {
    displayLogs = displayLogs.filter(l => l.techId === selectedTechIdFilter);
  }

  if (displayLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-slate-400 font-medium">No services recorded for this selection.</td></tr>`;
    return;
  }

  tbody.innerHTML = displayLogs.map(log => `
    <tr class="hover:bg-slate-50/80 transition">
      <td class="p-4 text-xs font-medium text-slate-500">${log.time}</td>
      <td class="p-4 font-semibold text-slate-800">${esc(log.techName)}</td>
      <td class="p-4 text-slate-700">${esc(log.serviceName)}</td>
      <td class="p-4"><span class="bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-lg font-bold text-xs">+${log.turnsAdded}</span></td>
      <td class="p-4 text-right">
        ${log.undone
          ? `<span class="text-xs text-slate-400 italic">Reverted</span>`
          : `<button onclick="undoLog('${log.id}')" class="text-rose-600 hover:text-rose-800 font-semibold text-xs px-2.5 py-1 bg-rose-50 rounded-lg hover:bg-rose-100 transition cursor-pointer"><i class="fa-solid fa-rotate-left"></i> Undo</button>`
        }
      </td>
    </tr>
  `).join('');
}

function undoLog(logId) {
  const log = logs.find(l => l.id === logId);
  if (!log || log.undone) return;
  const tech = techs.find(t => t.id === log.techId);
  if (tech) {
    tech.turns = Math.max(0, parseFloat((tech.turns - log.turnsAdded).toFixed(1)));
  }

  log.undone = true;
  saveState();
  renderAll();
  showToast(`Undid ${log.serviceName} for ${log.techName}`);
}

function clearHistoryLog() {
  if (confirm('Clear history logs for today?')) {
    logs = [];
    saveState();
    renderHistoryTable();
    showToast('History log cleared.');
  }
}

function openTechModal(techId = null) {
  const modal = document.getElementById('tech-modal');
  const title = document.getElementById('tech-modal-title');
  const idInput = document.getElementById('tech-modal-id');
  const nameInput = document.getElementById('tech-modal-name');
  const turnsInput = document.getElementById('tech-modal-turns');
  if (techId) {
    const tech = techs.find(t => t.id === techId);
    title.innerText = 'Edit Technician';
    idInput.value = tech.id;
    nameInput.value = tech.name;
    turnsInput.value = tech.turns;
    document.getElementById('tech-modal-signin').value = toInput(tech.signIn);
  } else {
    title.innerText = 'Add New Technician';
    idInput.value = '';
    nameInput.value = '';
    turnsInput.value = '0';
    document.getElementById('tech-modal-signin').value = toInput(Date.now());
  }
  modal.classList.remove('hidden');
}

function closeTechModal() {
  document.getElementById('tech-modal').classList.add('hidden');
}

function saveTechModal() {
  const id = document.getElementById('tech-modal-id').value;
  const name = document.getElementById('tech-modal-name').value.trim();
  const turns = parseFloat(document.getElementById('tech-modal-turns').value) || 0;
  const signIn = fromInput(document.getElementById('tech-modal-signin').value);
  if (!name) {
    alert('Please enter a technician name');
    return;
  }
  if (id) {
    const tech = techs.find(t => t.id === id);
    if (tech) {
      tech.name = name;
      tech.turns = turns;
      tech.signIn = signIn;
    }
  } else {
    techs.push({
      id: 't_' + Date.now(),
      signIn: signIn,
      name: name,
      turns: turns,
      status: 'break',
      lastUpdated: Date.now()
    });
  }
  saveState();
  renderAll();
  closeTechModal();
  showToast('Technician saved successfully');
}

function deleteTech(techId) {
  if (confirm('Delete this technician permanently?')) {
    techs = techs.filter(t => t.id !== techId);
    saveState();
    renderAll();
    showToast('Technician removed');
  }
}

function openServiceModal(serviceId = null) {
  const modal = document.getElementById('service-modal');
  const title = document.getElementById('service-modal-title');
  const idInput = document.getElementById('service-modal-id');
  const nameInput = document.getElementById('service-modal-name');
  const turnsInput = document.getElementById('service-modal-turns');
  if (serviceId) {
    const service = services.find(s => s.id === serviceId);
    title.innerText = 'Edit Service';
    idInput.value = service.id;
    nameInput.value = service.name;
    turnsInput.value = service.turns.toString();
  } else {
    title.innerText = 'Add New Service';
    idInput.value = '';
    nameInput.value = '';
    turnsInput.value = '1.0';
  }
  modal.classList.remove('hidden');
}

function closeServiceModal() {
  document.getElementById('service-modal').classList.add('hidden');
}

async function saveServiceModal() {
  const id = document.getElementById('service-modal-id').value;
  const name = document.getElementById('service-modal-name').value.trim();
  const turns = Math.round(parseFloat(document.getElementById('service-modal-turns').value) * 2) / 2;
  if (!(turns > 0)) {
    alert('Turn value must be 0.5 or higher');
    return;
  }
  if (!name) {
    alert('Please enter a service name');
    return;
  }
  try {
    await saveServicesTransaction((list) => {
      if (id) {
        const svc = list.find(s => s.id === id);
        if (svc) {
          svc.name = name;
          svc.turns = turns;
        } else {
          list.push({ id: id, name: name, turns: turns });
        }
      } else {
        list.push({ id: 's_' + Date.now(), name: name, turns: turns });
      }
      return list;
    });
    markSyncError(false);
    closeServiceModal();
    showToast('Service saved successfully');
  } catch (error) {
    console.error('Service save failed:', error);
    markSyncError(true);
    alert(cloudErrorMessage(error));   // modal stays open so nothing typed is lost
  }
}

async function deleteService(serviceId) {
  if (!confirm('Delete this service rate?')) return;
  try {
    await saveServicesTransaction(list => list.filter(s => s.id !== serviceId));
    markSyncError(false);
    showToast('Service removed');
  } catch (error) {
    console.error('Service delete failed:', error);
    markSyncError(true);
    alert(cloudErrorMessage(error));
  }
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toast-message').innerText = message;
  toast.classList.remove('opacity-0', 'translate-y-4', 'pointer-events-none');
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-4', 'pointer-events-none');
  }, 3000);
}

// The HTML uses inline onclick="..." handlers, so expose the functions to the page.
Object.assign(window, {
  adjustTurns,
  assignSelectedService,
  clean,
  clearHistoryLog,
  clearSelectedTech,
  closeServiceModal,
  closeTechModal,
  cloudErrorMessage,
  deleteService,
  deleteTech,
  esc,
  executeServiceAssignment,
  fmtTime,
  fromInput,
  getSortedActiveTechs,
  markSyncError,
  moveQueueOrder,
  normalizeTechs,
  openServiceModal,
  openTechModal,
  renderAll,
  renderHistoryTable,
  renderQueue,
  renderServiceMgmtTable,
  renderServicePanel,
  renderTechMgmtTable,
  resetDailyTurns,
  saveServiceModal,
  saveServicesTransaction,
  saveState,
  saveTechModal,
  selectTechForAssignment,
  shortenServiceName,
  showToast,
  switchTab,
  toInput,
  toggleEditOrder,
  toggleTechStatus,
  undoLog,
  updateLogFilterOptions,
  updateSignIn
});
