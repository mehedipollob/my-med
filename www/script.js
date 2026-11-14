/* ============================================================
   MyMed — Personal Medicine Manager
   Vanilla JS · IndexedDB · Capacitor 7 Local Notifications
   ============================================================ */
'use strict';

/* ------------------------------------------------------------
   CONSTANTS
   ------------------------------------------------------------ */
const DB_NAME    = 'mymed-db';
const DB_VERSION = 1;
const STORE = {
  MEDICINES: 'medicines',
  SCHEDULES: 'schedules',
  DOSES:     'doseLogs',
  INVENTORY: 'inventory',
  SETTINGS:  'settings'
};

const MISS_GRACE_MS       = 2 * 60 * 60 * 1000;   // 2h past dose time => missed
const NOTIF_HORIZON_DAYS  = 7;                    // how far ahead to schedule
const NOTIF_MAX           = 240;                  // safety cap (Android allows 500)
const CHANNEL_ID          = 'mymed-meds';
const ACTION_TYPE_ID      = 'MYMED_DOSE';

/* ------------------------------------------------------------
   UTILITIES
   ------------------------------------------------------------ */
const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => dateStr(new Date());

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}
function fmtTime(t) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function fmtDate(s) {
  if (!s) return '—';
  return parseDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateShort(s) {
  return parseDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
function startOfWeek(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());   // Sunday
  return x;
}
function daysBetween(a, b) {
  const MS = 86400000;
  return Math.round((parseDate(b) - parseDate(a)) / MS);
}
function periodOf(time) {
  const h = parseInt(time.split(':')[0], 10);
  if (h < 12) return 'Morning';
  if (h < 17) return 'Afternoon';
  if (h < 21) return 'Evening';
  return 'Night';
}
function foodLabel(f) {
  return ({ before: 'Before food', after: 'After food', with: 'With food', none: 'No food rule' })[f] || '';
}
function foodShort(f) {
  return ({ before: 'Before food', after: 'After food', with: 'With food', none: '' })[f] || '';
}

function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

async function sha256(str) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    // Fallback for non-secure contexts (should not occur in Capacitor)
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return 'fb' + (h >>> 0).toString(16);
  }
}

function hashId(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483646 + 1;
}

/* ------------------------------------------------------------
   INDEXEDDB LAYER
   ------------------------------------------------------------ */
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;

      if (!d.objectStoreNames.contains(STORE.MEDICINES)) {
        const s = d.createObjectStore(STORE.MEDICINES, { keyPath: 'id' });
        s.createIndex('name', 'name', { unique: false });
        s.createIndex('paused', 'paused', { unique: false });
      }
      if (!d.objectStoreNames.contains(STORE.SCHEDULES)) {
        const s = d.createObjectStore(STORE.SCHEDULES, { keyPath: 'id' });
        s.createIndex('medicineId', 'medicineId', { unique: true });
      }
      if (!d.objectStoreNames.contains(STORE.DOSES)) {
        const s = d.createObjectStore(STORE.DOSES, { keyPath: 'id' });
        s.createIndex('medicineId', 'medicineId', { unique: false });
        s.createIndex('date', 'date', { unique: false });
      }
      if (!d.objectStoreNames.contains(STORE.INVENTORY)) {
        const s = d.createObjectStore(STORE.INVENTORY, { keyPath: 'medicineId' });
        s.createIndex('medicineId', 'medicineId', { unique: true });
      }
      if (!d.objectStoreNames.contains(STORE.SETTINGS)) {
        d.createObjectStore(STORE.SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked by another tab'));
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    t.objectStore(storeName).put(value);
    t.oncomplete = () => resolve(true);
    t.onerror    = () => reject(t.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    t.objectStore(storeName).delete(key);
    t.oncomplete = () => resolve(true);
    t.onerror    = () => reject(t.error);
  });
}

function dbClear(storeName) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    t.objectStore(storeName).clear();
    t.oncomplete = () => resolve(true);
    t.onerror    = () => reject(t.error);
  });
}

/* ------------------------------------------------------------
   APP STATE
   ------------------------------------------------------------ */
const state = {
  medicines: [],
  schedules: [],
  inventory: [],
  doseLogs: new Map(),        // id -> log
  settings: {},
  screen: 'home',
  formId: null,
  formTimes: ['08:00'],
  formDays: [0, 1, 2, 3, 4, 5, 6],
  formFood: 'after',
  formImage: '',
  medFilter: 'all',
  medSearch: '',
  timetableDay: new Date().getDay(),
  calendarMonth: new Date().getMonth(),
  calendarYear: new Date().getFullYear(),
  calendarSelected: todayStr(),
  reportPeriod: 'daily',
  notifSupported: false,
  notifPermission: false,
  exactAlarm: null,
  biometricAvailable: false
};

async function loadAll() {
  state.medicines = (await dbGetAll(STORE.MEDICINES))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  state.schedules = await dbGetAll(STORE.SCHEDULES);
  state.inventory = await dbGetAll(STORE.INVENTORY);

  const logs = await dbGetAll(STORE.DOSES);
  state.doseLogs = new Map(logs.map(l => [l.id, l]));

  const settingsRows = await dbGetAll(STORE.SETTINGS);
  state.settings = {};
  settingsRows.forEach(r => { state.settings[r.key] = r.value; });
}

async function setSetting(key, value) {
  await dbPut(STORE.SETTINGS, { key, value });
  state.settings[key] = value;
}

/* ------------------------------------------------------------
   DOSE COMPUTATION
   ------------------------------------------------------------ */
function scheduleFor(medicineId) {
  return state.schedules.find(s => s.medicineId === medicineId && s.active !== false) || null;
}

function dosesForDate(ds) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return [];
  const dow = parseDate(ds).getDay();
  const out = [];

  for (const med of state.medicines) {
    if (med.paused) continue;
    if (med.startDate && ds < med.startDate) continue;
    if (med.endDate && ds > med.endDate) continue;

    const sched = scheduleFor(med.id);
    if (!sched) continue;
    if (!Array.isArray(sched.days) || !sched.days.includes(dow)) continue;
    if (!Array.isArray(sched.times)) continue;

    for (const t of sched.times) {
      out.push({
        key: `${med.id}|${ds}|${t}`,
        medicineId: med.id,
        date: ds,
        time: t,
        med
      });
    }
  }

  return out.sort((a, b) => a.time.localeCompare(b.time));
}

function doseStatus(dose) {
  const log = state.doseLogs.get(dose.key);
  if (log && (log.status === 'taken' || log.status === 'skipped')) return log.status;

  const dt = new Date(`${dose.date}T${dose.time}:00`);
  if (Date.now() - dt.getTime() > MISS_GRACE_MS) return 'missed';
  return 'pending';
}

function inventoryFor(medicineId) {
  return state.inventory.find(i => i.medicineId === medicineId) || null;
}

/* ------------------------------------------------------------
   DOSE MUTATIONS
   ------------------------------------------------------------ */
async function setDoseStatus(medicineId, date, time, status) {
  const id = `${medicineId}|${date}|${time}`;
  const existing = state.doseLogs.get(id) || null;

  if (existing && existing.status === status) return;   // duplicate prevention

  const record = {
    id,
    medicineId,
    date,
    time,
    status,
    takenAt: status === 'taken' ? Date.now() : null,
    stockDeducted: existing ? !!existing.stockDeducted : false,
    updatedAt: Date.now()
  };

  // Stock: deduct once when first marked taken; restore if un-taken
  const inv = inventoryFor(medicineId);
  if (inv) {
    if (status === 'taken' && !record.stockDeducted) {
      record.stockDeducted = true;
      await adjustStock(medicineId, -1);
    } else if (status !== 'taken' && record.stockDeducted) {
      record.stockDeducted = false;
      await adjustStock(medicineId, +1);
    }
  }

  await dbPut(STORE.DOSES, record);
  state.doseLogs.set(id, record);

  await rescheduleAllNotifications();
  return record;
}

async function adjustStock(medicineId, delta) {
  const inv = inventoryFor(medicineId);
  if (!inv) return;

  inv.remaining = Math.max(0, (inv.remaining || 0) + delta);
  inv.updatedAt = Date.now();

  if (inv.remaining > inv.threshold) inv.lowNotified = false;

  await dbPut(STORE.INVENTORY, inv);

  if (delta < 0 && inv.remaining <= inv.threshold && !inv.lowNotified) {
    inv.lowNotified = true;
    await dbPut(STORE.INVENTORY, inv);
    await notifyLowStock(inv);
  }
}

async function notifyLowStock(inv) {
  const med = state.medicines.find(m => m.id === inv.medicineId);
  if (!med) return;
  const msg = `${med.name} is running low — ${inv.remaining} left`;

  const LN = getLN();
  if (LN && state.notifPermission) {
    try {
      await LN.schedule({
        notifications: [{
          id: hashId('stock|' + med.id + '|' + Date.now()),
          title: 'Low stock alert',
          body: msg,
          schedule: { at: new Date(Date.now() + 1500), allowWhileIdle: true },
          channelId: CHANNEL_ID,
          extra: { mymed: true, type: 'stock', medicineId: med.id }
        }]
      });
    } catch (e) { /* ignore */ }
  }
  toast(msg);
}

/* ------------------------------------------------------------
   LOCAL NOTIFICATIONS
   ------------------------------------------------------------ */
function getLN() {
  try {
    if (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) {
      return Capacitor.Plugins.LocalNotifications;
    }
  } catch (e) { /* noop */ }
  return null;
}

async function initNotifications() {
  const LN = getLN();
  if (!LN) {
    state.notifSupported = false;
    return;
  }
  state.notifSupported = true;

  try {
    await LN.createChannel({
      id: CHANNEL_ID,
      name: 'Medicine reminders',
      description: 'Dose reminders from MyMed',
      importance: 5,
      visibility: 1,
      sound: 'default',
      vibration: true,
      lights: true,
      lightColor: '#0ea5a4'
    });
  } catch (e) { /* channel may already exist */ }

  try {
    await LN.registerActionTypes({
      types: [{
        id: ACTION_TYPE_ID,
        actions: [
          { id: 'taken',    title: 'Taken' },
          { id: 'snooze5',  title: 'Snooze 5m' },
          { id: 'snooze10', title: 'Snooze 10m' },
          { id: 'snooze15', title: 'Snooze 15m' }
        ]
      }]
    });
  } catch (e) { /* ignore */ }

  try {
    LN.addListener('localNotificationActionPerformed', onNotificationAction);
    LN.addListener('localNotificationReceived', () => { /* foreground receipt */ });
  } catch (e) { /* ignore */ }

  await refreshNotificationPermission(false);
  await checkExactAlarm();
}

async function refreshNotificationPermission(ask) {
  const LN = getLN();
  if (!LN) { state.notifPermission = false; return false; }
  try {
    let perm = await LN.checkPermissions();
    if (perm.display !== 'granted' && ask) {
      perm = await LN.requestPermissions();
    }
    state.notifPermission = perm.display === 'granted';
    return state.notifPermission;
  } catch (e) {
    state.notifPermission = false;
    return false;
  }
}

async function checkExactAlarm() {
  const LN = getLN();
  if (!LN || typeof LN.checkExactNotificationSetting !== 'function') {
    state.exactAlarm = null;
    return;
  }
  try {
    const res = await LN.checkExactNotificationSetting();
    state.exactAlarm = res && res.exact_alarm === 'granted';
  } catch (e) {
    state.exactAlarm = null;
  }
}

async function requestExactAlarm() {
  const LN = getLN();
  if (!LN || typeof LN.changeExactNotificationSetting !== 'function') {
    toast('Exact alarms not supported on this device');
    return;
  }
  try {
    await LN.changeExactNotificationSetting();
    await checkExactAlarm();
    toast('Exact alarm setting updated');
  } catch (e) {
    toast('Open system settings › Alarms & reminders');
  }
}

/**
 * Cancels all MyMed notifications and reschedules the horizon window.
 * Deterministic IDs prevent duplicate notifications.
 */
const rescheduleAllNotifications = debounce(async function () {
  const LN = getLN();
  if (!LN) return;

  // 1. Cancel everything we own
  try {
    const pending = await LN.getPending();
    const mine = (pending.notifications || [])
      .filter(n => !n.extra || n.extra.mymed)
      .map(n => ({ id: n.id }));
    if (mine.length) await LN.cancel({ notifications: mine });
  } catch (e) { /* ignore */ }

  if (!state.notifPermission) return;

  // 2. Build future notifications
  const list = [];
  const now = Date.now();

  outer:
  for (let i = 0; i < NOTIF_HORIZON_DAYS; i++) {
    const ds = dateStr(addDays(new Date(), i));
    const doses = dosesForDate(ds);

    for (const dose of doses) {
      if (state.doseLogs.has(dose.key)) continue;

      const at = new Date(`${ds}T${dose.time}:00`);
      if (at.getTime() <= now + 5000) continue;

      const med = dose.med;
      list.push({
        id: hashId(dose.key),
        title: med.strength ? `${med.name} · ${med.strength}` : med.name,
        body: `${med.dosage || '1 dose'}${med.food && med.food !== 'none' ? ' · ' + foodLabel(med.food) : ''}`,
        largeBody: med.notes || '',
        summaryText: 'MyMed reminder',
        schedule: { at, allowWhileIdle: true },
        channelId: CHANNEL_ID,
        actionTypeId: ACTION_TYPE_ID,
        autoCancel: true,
        extra: { mymed: true, doseKey: dose.key, medicineId: med.id }
      });

      if (list.length >= NOTIF_MAX) break outer;
    }
  }

  if (!list.length) return;

  try {
    await LN.schedule({ notifications: list });
  } catch (e) {
    console.warn('Notification scheduling failed:', e);
  }
}, 400);

async function onNotificationAction(ev) {
  const notification = ev.notification || {};
  const extra = notification.extra || {};
  const actionId = ev.actionId;
  const key = extra.doseKey;

  if (!key) return;   // stock alerts etc.

  const parts = key.split('|');
  if (parts.length !== 3) return;
  const [medicineId, date, time] = parts;

  try {
    if (actionId === 'taken') {
      await setDoseStatus(medicineId, date, time, 'taken');
      toast('Marked as taken');
    } else if (actionId && actionId.indexOf('snooze') === 0) {
      const mins = parseInt(actionId.replace('snooze', ''), 10) || 5;
      await scheduleSnooze(medicineId, date, time, mins);
    }
  } catch (e) {
    console.warn('Action handling failed', e);
  }

  await loadAll();
  renderCurrent();
}

async function scheduleSnooze(medicineId, date, time, mins) {
  const LN = getLN();
  if (!LN) return;
  const med = state.medicines.find(m => m.id === medicineId);
  const key = `${medicineId}|${date}|${time}`;
  const at = new Date(Date.now() + mins * 60000);

  try {
    await LN.schedule({
      notifications: [{
        id: hashId(key + ':snooze:' + at.getTime()),
        title: med ? `Reminder: ${med.name}` : 'Medicine reminder',
        body: `Snoozed for ${mins} minutes`,
        schedule: { at, allowWhileIdle: true },
        channelId: CHANNEL_ID,
        actionTypeId: ACTION_TYPE_ID,
        autoCancel: true,
        extra: { mymed: true, doseKey: key, medicineId }
      }]
    });
    toast(`Snoozed for ${mins} minutes`);
  } catch (e) {
    toast('Unable to snooze');
  }
}

/* ------------------------------------------------------------
   TOAST / MODAL HELPERS
   ------------------------------------------------------------ */
let toastTimer = null;
function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function openModal(innerHTML, onMount) {
  const root = $('modalRoot');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${innerHTML}</div></div>`;
  root.classList.add('show');
  if (onMount) onMount(root.querySelector('.modal'), root);
  return root;
}

function closeModal() {
  const root = $('modalRoot');
  root.classList.remove('show');
  root.innerHTML = '';
}

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const root = openModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-a="0">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-a="1">${esc(confirmText)}</button>
      </div>
    `, (box, rootEl) => {
      rootEl.querySelectorAll('[data-a]').forEach(btn => {
        btn.addEventListener('click', () => {
          const ok = btn.dataset.a === '1';
          closeModal();
          resolve(ok);
        });
      });
    });
    root.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) { closeModal(); resolve(false); }
    }, { once: true });
  });
}

function promptDialog({ title, message, value = '', type = 'text', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    const root = openModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      <input type="${type}" value="${esc(value)}" id="modalInput" ${type === 'number' ? 'inputmode="numeric"' : ''} />
      <div class="modal-actions">
        <button class="btn ghost" data-a="0">Cancel</button>
        <button class="btn primary" data-a="1">${esc(confirmText)}</button>
      </div>
    `, (box, rootEl) => {
      const input = rootEl.querySelector('#modalInput');
      setTimeout(() => input.focus(), 60);
      rootEl.querySelectorAll('[data-a]').forEach(btn => {
        btn.addEventListener('click', () => {
          const ok = btn.dataset.a === '1';
          const val = input.value;
          closeModal();
          resolve(ok ? val : null);
        });
      });
    });
    root.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) { closeModal(); resolve(null); }
    }, { once: true });
  });
}

/* ------------------------------------------------------------
   NAVIGATION
   ------------------------------------------------------------ */
const SCREEN_META = {
  'home':            { title: 'MyMed',       sub: 'Personal medicine manager', back: false },
  'medicines':       { title: 'Medicines',   sub: '', back: false },
  'medicine-form':   { title: 'Medicine',    sub: '', back: true  },
  'medicine-detail': { title: 'Details',     sub: '', back: true  },
  'timetable':       { title: 'Timetable',   sub: '', back: false },
  'calendar':        { title: 'Calendar',    sub: '', back: true  },
  'reports':         { title: 'Reports',     sub: '', back: false },
  'stock':           { title: 'Stock',       sub: '', back: true  },
  'settings':        { title: 'Settings',    sub: '', back: false }
};

function showScreen(name, params = {}) {
  if (!SCREEN_META[name]) return;

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $('screen-' + name);
  if (!el) return;
  el.classList.add('active');

  state.screen = name;
  $('main').scrollTop = 0;

  updateChrome(name, params);
  renderScreen(name, params);
}

function updateChrome(name, params) {
  const meta = SCREEN_META[name];
  $('headerTitle').textContent = meta.title;
  $('headerSub').textContent = meta.sub || '';
  $('backBtn').classList.toggle('hidden', !meta.back);

  if (name === 'medicine-form') {
    $('headerTitle').textContent = params.id ? 'Edit medicine' : 'New medicine';
  }
  if (name === 'medicine-detail' && params.med) {
    $('headerTitle').textContent = params.med.name;
    $('headerSub').textContent = [params.med.strength, params.med.type].filter(Boolean).join(' · ');
  }

  $$('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === name);
  });

  const showFab = ['home', 'medicines', 'timetable', 'reports'].includes(name);
  $('fab').classList.toggle('hidden', !showFab);
}

function renderScreen(name, params = {}) {
  switch (name) {
    case 'home':            renderHome(); break;
    case 'medicines':       renderMedicines(); break;
    case 'medicine-form':   prepareForm(params.id || null); break;
    case 'medicine-detail': renderMedicineDetail(params.id); break;
    case 'timetable':       renderTimetable(); break;
    case 'calendar':        renderCalendar(); break;
    case 'reports':         renderReports(); break;
    case 'stock':           renderStock(); break;
    case 'settings':        renderSettings(); break;
  }
}

function renderCurrent() {
  const name = state.screen;
  if (name === 'medicine-detail') {
    const id = state.currentDetailId;
    if (id && state.medicines.some(m => m.id === id)) {
      renderMedicineDetail(id);
      return;
    }
    showScreen('medicines');
    return;
  }
  renderScreen(name, {});
}

/* ------------------------------------------------------------
   SCREEN: HOME
   ------------------------------------------------------------ */
function renderHome() {
  const now = new Date();
  const ds = todayStr();

  $('homeDate').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  const doses = dosesForDate(ds).map(d => ({ ...d, status: doseStatus(d) }));
  const total   = doses.length;
  const taken   = doses.filter(d => d.status === 'taken').length;
  const missed  = doses.filter(d => d.status === 'missed').length;
  const pending = doses.filter(d => d.status === 'pending').length;

  $('statScheduled').textContent = total;
  $('statTaken').textContent = taken;
  $('statUpcoming').textContent = pending;
  $('statMissed').textContent = missed;

  const pct = total ? Math.round((taken / total) * 100) : 0;
  $('ringFg').setAttribute('stroke-dasharray', `${pct},100`);
  $('ringLabel').textContent = pct + '%';

  // Next reminder
  const upcoming = doses
    .filter(d => d.status === 'pending')
    .map(d => ({ ...d, at: new Date(`${d.date}T${d.time}:00`) }))
    .filter(d => d.at.getTime() > Date.now())
    .sort((a, b) => a.at - b.at);

  if (upcoming.length) {
    const next = upcoming[0];
    $('nextTitle').textContent = `${next.med.name}${next.med.strength ? ' · ' + next.med.strength : ''}`;
    $('nextSub').textContent = `${fmtTime(next.time)} · ${next.med.dosage || '1 dose'}`;
  } else if (total === 0) {
    $('nextTitle').textContent = 'No doses scheduled today';
    $('nextSub').textContent = 'Add a medicine to get started';
  } else {
    $('nextTitle').textContent = 'All done for today';
    $('nextSub').textContent = 'No more reminders scheduled';
  }

  // Today list
  const listEl = $('todayList');
  if (!doses.length) {
    listEl.innerHTML = emptyState('pill', 'No doses today', 'Your medicine schedule is clear.');
  } else {
    listEl.innerHTML = doses.map(d => doseCardHTML(d)).join('');
  }
}

function emptyState(icon, title, text) {
  return `<div class="empty">
    <svg class="ic"><use href="#i-${icon}"/></svg>
    <strong>${esc(title)}</strong>
    <p>${esc(text)}</p>
  </div>`;
}

function doseCardHTML(dose) {
  const med = dose.med || state.medicines.find(m => m.id === dose.medicineId) || {};
  const status = dose.status || doseStatus(dose);
  const statusLabel = {
    taken: 'Taken', skipped: 'Skipped', missed: 'Missed', pending: 'Pending'
  }[status];

  const badgeClass = { taken: 'ok', skipped: 'warn', missed: 'bad', pending: 'info' }[status];

  const canAct = status !== 'taken';
  const actions = canAct ? `
    <div class="dose-actions">
      <button class="mini-btn take" data-action="dose-taken" data-key="${esc(dose.key)}">
        <svg class="ic"><use href="#i-check"/></svg> Taken
      </button>
      <button class="mini-btn skip" data-action="dose-skip" data-key="${esc(dose.key)}">
        <svg class="ic"><use href="#i-x"/></svg> Skip
      </button>
    </div>` : `
    <div class="dose-actions">
      <button class="mini-btn" data-action="dose-undo" data-key="${esc(dose.key)}">
        <svg class="ic"><use href="#i-refresh"/></svg> Undo
      </button>
    </div>`;

  return `
  <article class="dose-item st-${status}">
    <div class="dose-time">
      <strong>${esc(fmtTime(dose.time))}</strong>
      <span>${esc(periodOf(dose.time))}</span>
    </div>
    <div class="dose-main">
      <div class="dose-name">${esc(med.name || 'Medicine')}</div>
      <div class="dose-meta">
        ${esc([med.dosage, med.strength, foodShort(med.food)].filter(Boolean).join(' · ') || '—')}
      </div>
      <div style="margin-top:7px">
        <span class="badge ${badgeClass}">${statusLabel}</span>
      </div>
      ${actions}
    </div>
  </article>`;
}

/* ------------------------------------------------------------
   SCREEN: MEDICINES
   ------------------------------------------------------------ */
function renderMedicines() {
  const listEl = $('medicineList');
  let items = state.medicines.slice();

  if (state.medFilter === 'active') items = items.filter(m => !m.paused);
  else if (state.medFilter === 'paused') items = items.filter(m => m.paused);
  else if (state.medFilter === 'low') {
    items = items.filter(m => {
      const inv = inventoryFor(m.id);
      return inv && inv.remaining <= inv.threshold;
    });
  }

  if (state.medSearch) {
    const q = state.medSearch.toLowerCase();
    items = items.filter(m =>
      (m.name || '').toLowerCase().includes(q) ||
      (m.type || '').toLowerCase().includes(q) ||
      (m.notes || '').toLowerCase().includes(q)
    );
  }

  if (!items.length) {
    listEl.innerHTML = emptyState(
      'pill',
      state.medicines.length ? 'Nothing matches' : 'No medicines yet',
      state.medicines.length ? 'Try a different filter or search.' : 'Tap + to add your first medicine.'
    );
    return;
  }

  listEl.innerHTML = items.map(med => {
    const inv = inventoryFor(med.id);
    const sched = scheduleFor(med.id);
    const times = sched && sched.times && sched.times.length
      ? sched.times.map(fmtTime).join(' · ')
      : 'No times set';

    const tags = [];
    if (med.paused) tags.push('<span class="med-tag paused">Paused</span>');
    if (inv) {
      const low = inv.remaining <= inv.threshold;
      tags.push(`<span class="med-tag ${low ? 'low' : ''}">${inv.remaining} left</span>`);
    }
    if (med.endDate) tags.push(`<span class="med-tag">Ends ${esc(fmtDateShort(med.endDate))}</span>`);

    return `
    <article class="med-card" data-action="med-open" data-id="${esc(med.id)}">
      <div class="med-avatar">
        ${med.image ? `<img src="${med.image}" alt="">` : esc((med.name || '?').charAt(0).toUpperCase())}
      </div>
      <div class="med-body">
        <div class="med-title-row">
          <span class="med-title">${esc(med.name)}</span>
          ${med.strength ? `<span class="med-tag">${esc(med.strength)}</span>` : ''}
        </div>
        <div class="med-sub">${esc([med.type, med.dosage].filter(Boolean).join(' · ') || '—')}</div>
        <div class="med-sub" style="color:var(--ink3)">${esc(times)}</div>
        ${tags.length ? `<div class="med-tags">${tags.join('')}</div>` : ''}
      </div>
    </article>`;
  }).join('');
}

/* ------------------------------------------------------------
   SCREEN: MEDICINE FORM
   ------------------------------------------------------------ */
function prepareForm(id) {
  const med = id ? state.medicines.find(m => m.id === id) : null;
  state.formId = med ? med.id : null;

  if (med) {
    const sched = scheduleFor(med.id);
    state.formTimes = sched && sched.times && sched.times.length ? sched.times.slice() : ['08:00'];
    state.formDays = sched && sched.days && sched.days.length ? sched.days.slice() : [0,1,2,3,4,5,6];
    state.formFood = med.food || 'after';
    state.formImage = med.image || '';
  } else {
    state.formTimes = ['08:00'];
    state.formDays = [0,1,2,3,4,5,6];
    state.formFood = 'after';
    state.formImage = '';
  }

  $('fId').value = med ? med.id : '';
  $('fName').value = med ? med.name || '' : '';
  $('fType').value = med ? med.type || 'Tablet' : 'Tablet';
  $('fStrength').value = med ? med.strength || '' : '';
  $('fDosage').value = med ? med.dosage || '' : '';
  $('fStart').value = med ? med.startDate || todayStr() : todayStr();
  $('fEnd').value = med ? med.endDate || '' : '';
  $('fNotes').value = med ? med.notes || '' : '';

  const inv = med ? inventoryFor(med.id) : null;
  $('fStockEnabled').checked = !!inv;
  $('stockFields').classList.toggle('hidden', !inv);
  $('fStockInitial').value = inv ? inv.initial : 30;
  $('fStockThreshold').value = inv ? inv.threshold : 5;

  const daily = state.formDays.length === 7;
  $('fDaily').checked = daily;

  renderDayChips();
  renderFoodSegment();
  renderTimeRows();
  renderImagePreview();
}

function renderDayChips() {
  $$('#fDays .day-chip').forEach(chip => {
    const day = parseInt(chip.dataset.day, 10);
    chip.classList.toggle('active', state.formDays.includes(day));
  });
  $('fDaily').checked = state.formDays.length === 7;
}

function renderFoodSegment() {
  $$('#fFood button').forEach(b => {
    b.classList.toggle('active', b.dataset.val === state.formFood);
  });
}

function renderTimeRows() {
  const wrap = $('timeList');
  wrap.innerHTML = '';

  if (!state.formTimes.length) {
    wrap.innerHTML = '<p style="font-size:13px;color:var(--ink3);padding:6px 2px">No reminder times added yet.</p>';
    return;
  }

  state.formTimes.forEach((t, index) => {
    const row = document.createElement('div');
    row.className = 'time-row';
    row.innerHTML = `
      <input type="time" value="${esc(t)}" data-index="${index}" />
      <button type="button" class="icon-btn danger" data-remove="${index}" aria-label="Remove time">
        <svg class="ic"><use href="#i-x"/></svg>
      </button>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('input[type=time]').forEach(inp => {
    inp.addEventListener('change', () => {
      const i = parseInt(inp.dataset.index, 10);
      if (inp.value) state.formTimes[i] = inp.value;
    });
  });

  wrap.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.remove, 10);
      state.formTimes.splice(i, 1);
      renderTimeRows();
    });
  });
}

function renderImagePreview() {
  const prev = $('imagePreview');
  if (state.formImage) {
    prev.classList.remove('hidden');
    $('imagePreviewImg').src = state.formImage;
  } else {
    prev.classList.add('hidden');
    $('imagePreviewImg').removeAttribute('src');
  }
}

async function handleMedicineSubmit(e) {
  e.preventDefault();

  const name = $('fName').value.trim();
  if (!name) { toast('Please enter a medicine name'); $('fName').focus(); return; }

  const startDate = $('fStart').value;
  if (!startDate) { toast('Please choose a start date'); return; }

  const endDate = $('fEnd').value;
  if (endDate && endDate < startDate) { toast('End date must be after start date'); return; }

  if (!state.formTimes.length) { toast('Add at least one reminder time'); return; }
  if (!state.formDays.length) { toast('Select at least one repeat day'); return; }

  const id = state.formId || uid();
  const existing = state.medicines.find(m => m.id === id);

  const medicine = {
    id,
    name,
    type: $('fType').value,
    strength: $('fStrength').value.trim(),
    dosage: $('fDosage').value.trim(),
    startDate,
    endDate,
    food: state.formFood,
    notes: $('fNotes').value.trim(),
    image: state.formImage || '',
    paused: existing ? !!existing.paused : false,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: Date.now()
  };

  await dbPut(STORE.MEDICINES, medicine);

  // Schedule record
  const existingSchedule = scheduleFor(id);
  const schedule = {
    id: existingSchedule ? existingSchedule.id : uid(),
    medicineId: id,
    times: state.formTimes.slice().sort(),
    days: state.formDays.slice().sort(),
    active: true,
    updatedAt: Date.now()
  };
  await dbPut(STORE.SCHEDULES, schedule);

  // Inventory
  if ($('fStockEnabled').checked) {
    const inv = inventoryFor(id);
    const initial = Math.max(0, parseInt($('fStockInitial').value, 10) || 0);
    const threshold = Math.max(0, parseInt($('fStockThreshold').value, 10) || 0);

    const record = inv
      ? { ...inv, initial, threshold, remaining: Math.min(inv.remaining, initial), updatedAt: Date.now() }
      : {
          medicineId: id,
          initial,
          remaining: initial,
          threshold,
          lowNotified: false,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
    await dbPut(STORE.INVENTORY, record);
  } else {
    await dbDelete(STORE.INVENTORY, id);
  }

  await loadAll();
  await rescheduleAllNotifications();

  toast(existing ? 'Medicine updated' : 'Medicine added');
  showScreen('medicines');
}

/* ------------------------------------------------------------
   SCREEN: MEDICINE DETAIL
   ------------------------------------------------------------ */
function renderMedicineDetail(id) {
  const med = state.medicines.find(m => m.id === id);
  const container = $('medicineDetail');

  if (!med) {
    container.innerHTML = emptyState('pill', 'Not found', 'This medicine no longer exists.');
    return;
  }

  state.currentDetailId = id;

  $('headerTitle').textContent = med.name;
  $('headerSub').textContent = [med.strength, med.type].filter(Boolean).join(' · ');

  const sched = scheduleFor(med.id);
  const inv = inventoryFor(med.id);

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayText = sched && sched.days
    ? (sched.days.length === 7 ? 'Every day' : sched.days.slice().sort().map(d => dayNames[d]).join(', '))
    : '—';

  const times = sched && sched.times && sched.times.length
    ? sched.times.slice().sort().map(t => `<span class="med-tag">${esc(fmtTime(t))}</span>`).join('')
    : '<span class="med-tag">No times</span>';

  // Recent logs for this medicine
  const recent = Array.from(state.doseLogs.values())
    .filter(l => l.medicineId === med.id)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
    .slice(0, 8);

  const recentHTML = recent.length
    ? recent.map(l => `
        <div class="bar-row">
          <span class="bar-label">${esc(fmtDateShort(l.date))}</span>
          <span style="flex:1;font-size:12.5px;color:var(--ink2)">${esc(fmtTime(l.time))}</span>
          <span class="badge ${l.status === 'taken' ? 'ok' : l.status === 'skipped' ? 'warn' : 'bad'}">
            ${l.status.charAt(0).toUpperCase() + l.status.slice(1)}
          </span>
        </div>`).join('')
    : `<p style="font-size:13px;color:var(--ink3)">No dose records yet.</p>`;

  container.innerHTML = `
    ${med.image ? `<div class="card" style="padding:0;overflow:hidden">
      <img src="${med.image}" alt="Prescription" style="width:100%;display:block;max-height:260px;object-fit:cover" />
    </div>` : ''}

    <div class="card">
      <div class="med-title-row" style="margin-bottom:4px">
        <span class="med-title" style="font-size:19px">${esc(med.name)}</span>
        ${med.paused ? '<span class="med-tag paused">Paused</span>' : '<span class="med-tag">Active</span>'}
      </div>
      <p class="med-sub">${esc([med.type, med.strength, med.dosage].filter(Boolean).join(' · ') || '—')}</p>

      <div style="margin-top:14px;display:flex;flex-direction:column;gap:9px">
        <div style="display:flex;justify-content:space-between;font-size:13.5px">
          <span style="color:var(--ink2)">Start date</span><strong>${esc(fmtDate(med.startDate))}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13.5px">
          <span style="color:var(--ink2)">End date</span><strong>${esc(med.endDate ? fmtDate(med.endDate) : 'Ongoing')}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13.5px">
          <span style="color:var(--ink2)">Food</span><strong>${esc(foodLabel(med.food) || '—')}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13.5px">
          <span style="color:var(--ink2)">Repeat</span><strong>${esc(dayText)}</strong>
        </div>
      </div>

      <div class="med-tags" style="margin-top:14px">${times}</div>

      ${med.notes ? `<div style="margin-top:14px;padding:12px;background:var(--bg);border-radius:13px;font-size:13px;color:var(--ink2)">
        ${esc(med.notes)}
      </div>` : ''}
    </div>

    ${inv ? `
    <div class="card">
      <div class="stock-top">
        <div>
          <div class="stock-name">Stock</div>
          <div class="stock-sub">${inv.remaining} of ${inv.initial} remaining</div>
        </div>
        <span class="badge ${inv.remaining <= inv.threshold ? 'bad' : 'ok'}">
          ${inv.remaining <= inv.threshold ? 'Low' : 'OK'}
        </span>
      </div>
      <div class="stock-bar">
        <i class="${inv.remaining <= 0 ? 'empty' : inv.remaining <= inv.threshold ? 'low' : ''}"
           style="width:${Math.min(100, Math.round((inv.remaining / Math.max(1, inv.initial)) * 100))}%"></i>
      </div>
    </div>` : ''}

    <div class="card">
      <div class="section-head" style="margin-top:0"><h3>Recent doses</h3></div>
      ${recentHTML}
    </div>

    <div class="form-actions" style="grid-template-columns:1fr 1fr">
      <button class="btn ghost" data-action="med-edit" data-id="${esc(med.id)}">
        <svg class="ic"><use href="#i-edit"/></svg> Edit
      </button>
      <button class="btn ghost" data-action="med-pause" data-id="${esc(med.id)}">
        <svg class="ic"><use href="#i-${med.paused ? 'play' : 'pause'}"/></svg>
        ${med.paused ? 'Resume' : 'Pause'}
      </button>
    </div>
    <div class="form-actions" style="grid-template-columns:1fr">
      <button class="btn danger" data-action="med-delete" data-id="${esc(med.id)}">
        <svg class="ic"><use href="#i-trash"/></svg> Delete medicine
      </button>
    </div>
  `;
}

/* ------------------------------------------------------------
   SCREEN: TIMETABLE
   ------------------------------------------------------------ */
function renderTimetable() {
  $$('#weekdayRow .wd-chip').forEach(chip => {
    chip.classList.toggle('active', parseInt(chip.dataset.day, 10) === state.timetableDay);
  });

  // Build a date matching the selected weekday (within this week)
  const today = new Date();
  const base = startOfWeek(today);
  let offset = state.timetableDay - base.getDay();
  if (offset < 0) offset += 7;
  const target = addDays(base, offset);
  const ds = dateStr(target);

  const doses = dosesForDate(ds).map(d => ({ ...d, status: doseStatus(d) }));
  const body = $('timetableBody');

  if (!doses.length) {
    body.innerHTML = emptyState('clock', 'No doses scheduled', 'Nothing is scheduled for this day.');
    return;
  }

  const groups = { Morning: [], Afternoon: [], Evening: [], Night: [] };
  doses.forEach(d => groups[periodOf(d.time)].push(d));

  body.innerHTML = Object.keys(groups).map(period => {
    const list = groups[period];
    if (!list.length) return '';
    return `
      <div class="period-block">
        <div class="period-head"><i class="dot"></i>${period}</div>
        ${list.map(d => `
          <div class="tt-item">
            <div class="tt-time">${esc(fmtTime(d.time))}</div>
            <div class="tt-body">
              <div class="tt-name">${esc(d.med.name)}${d.med.strength ? ` · ${esc(d.med.strength)}` : ''}</div>
              <div class="tt-meta">
                ${esc([d.med.dosage, foodShort(d.med.food)].filter(Boolean).join(' · ') || '—')}
              </div>
            </div>
            <span class="badge ${
              d.status === 'taken' ? 'ok' :
              d.status === 'skipped' ? 'warn' :
              d.status === 'missed' ? 'bad' : 'info'
            }">${d.status.charAt(0).toUpperCase() + d.status.slice(1)}</span>
          </div>`).join('')}
      </div>`;
  }).join('') || emptyState('clock', 'Nothing scheduled', 'No doses on this day.');
}

/* ------------------------------------------------------------
   SCREEN: CALENDAR
   ------------------------------------------------------------ */
function daySummary(ds) {
  const doses = dosesForDate(ds);
  if (!doses.length) return { state: 'none', total: 0, taken: 0 };

  let taken = 0, skipped = 0, missed = 0, pending = 0;
  doses.forEach(d => {
    const s = doseStatus(d);
    if (s === 'taken') taken++;
    else if (s === 'skipped') skipped++;
    else if (s === 'missed') missed++;
    else pending++;
  });

  let st = 'none';
  if (taken === doses.length) st = 'ok';
  else if (taken > 0 || skipped > 0) st = 'part';
  else if (missed > 0) st = 'bad';

  return { state: st, total: doses.length, taken, skipped, missed, pending };
}

function renderCalendar() {
  const year = state.calendarYear;
  const month = state.calendarMonth;

  $('calTitle').textContent = new Date(year, month, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let html = '';
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-cell empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${year}-${pad2(month + 1)}-${pad2(day)}`;
    const summary = daySummary(ds);
    const classes = ['cal-cell'];
    if (ds === today) classes.push('today');
    if (ds === state.calendarSelected) classes.push('selected');
    if (summary.state !== 'none') classes.push(summary.state);
    html += `<div class="${classes.join(' ')}" data-action="cal-day" data-date="${ds}">${day}</div>`;
  }

  $('calGrid').innerHTML = html;

  // Selected day list
  const sel = state.calendarSelected;
  $('calDayTitle').textContent = fmtDate(sel);

  const doses = dosesForDate(sel).map(d => ({ ...d, status: doseStatus(d) }));
  $('calDayList').innerHTML = doses.length
    ? doses.map(d => doseCardHTML(d)).join('')
    : emptyState('calendar', 'No doses', 'Nothing scheduled on this day.');
}

/* ------------------------------------------------------------
   SCREEN: REPORTS
   ------------------------------------------------------------ */
function statsForRange(startDs, endDs) {
  const totals = { scheduled: 0, taken: 0, skipped: 0, missed: 0, pending: 0 };
  const perMed = new Map();

  let cursor = parseDate(startDs);
  const end = parseDate(endDs);

  while (cursor <= end) {
    const ds = dateStr(cursor);
    const doses = dosesForDate(ds);

    doses.forEach(d => {
      const s = doseStatus(d);
      totals.scheduled++;
      totals[s] = (totals[s] || 0) + 1;

      if (!perMed.has(d.medicineId)) {
        perMed.set(d.medicineId, { scheduled: 0, taken: 0, missed: 0, skipped: 0 });
      }
      const m = perMed.get(d.medicineId);
      m.scheduled++;
      m[s] = (m[s] || 0) + 1;
    });

    cursor = addDays(cursor, 1);
  }

  totals.adherence = totals.scheduled
    ? Math.round((totals.taken / totals.scheduled) * 100)
    : 0;

  return { totals, perMed };
}

function renderReports() {
  $$('#reportTabs .chip').forEach(c => {
    c.classList.toggle('active', c.dataset.period === state.reportPeriod);
  });

  const today = new Date();
  const body = $('reportBody');

  let start, end, label, buckets = [];

  if (state.reportPeriod === 'daily') {
    end = dateStr(today);
    start = dateStr(addDays(today, -13));
    label = 'Last 14 days';

    for (let i = 13; i >= 0; i--) {
      const d = addDays(today, -i);
      const ds = dateStr(d);
      const doses = dosesForDate(ds);
      if (!doses.length) continue;
      let taken = 0, missed = 0, skipped = 0;
      doses.forEach(x => {
        const s = doseStatus(x);
        if (s === 'taken') taken++;
        else if (s === 'missed') missed++;
        else if (s === 'skipped') skipped++;
      });
      buckets.push({
        label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        scheduled: doses.length, taken, missed, skipped
      });
    }
  } else if (state.reportPeriod === 'weekly') {
    const thisWeekStart = startOfWeek(today);
    end = dateStr(today);
    start = dateStr(addDays(thisWeekStart, -7 * 5));
    label = 'Last 6 weeks';

    for (let w = 5; w >= 0; w--) {
      const ws = addDays(thisWeekStart, -7 * w);
      const we = addDays(ws, 6);
      const sDs = dateStr(ws);
      const eDs = dateStr(we);
      const { totals } = statsForRange(sDs, eDs);
      if (!totals.scheduled) continue;
      buckets.push({
        label: `${ws.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
        scheduled: totals.scheduled,
        taken: totals.taken,
        missed: totals.missed,
        skipped: totals.skipped
      });
    }
  } else {
    end = dateStr(today);
    const m0 = new Date(today.getFullYear(), today.getMonth() - 5, 1);
    start = dateStr(m0);
    label = 'Last 6 months';

    for (let i = 5; i >= 0; i--) {
      const ms = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const me = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
      const { totals } = statsForRange(dateStr(ms), dateStr(me));
      if (!totals.scheduled) continue;
      buckets.push({
        label: ms.toLocaleDateString(undefined, { month: 'short' }),
        scheduled: totals.scheduled,
        taken: totals.taken,
        missed: totals.missed,
        skipped: totals.skipped
      });
    }
  }

  const { totals, perMed } = statsForRange(start, end);

  const medBars = Array.from(perMed.entries()).map(([medId, m]) => {
    const med = state.medicines.find(x => x.id === medId);
    const pct = m.scheduled ? Math.round((m.taken / m.scheduled) * 100) : 0;
    return `
      <div class="bar-row">
        <span class="bar-label">${esc(med ? med.name : 'Deleted')}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-val">${pct}%</span>
      </div>`;
  }).join('') || '<p style="font-size:13px;color:var(--ink3)">No data in this range.</p>';

  const bucketsHTML = buckets.length
    ? buckets.map(b => {
        const pct = b.scheduled ? Math.round((b.taken / b.scheduled) * 100) : 0;
        return `
          <div class="bar-row">
            <span class="bar-label">${esc(b.label)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
            <span class="bar-val">${b.taken}/${b.scheduled}</span>
          </div>`;
      }).join('')
    : '<p style="font-size:13px;color:var(--ink3)">No doses recorded in this range.</p>';

  body.innerHTML = `
    <div class="report-hero">
      <div class="rh-item">
        <div class="rh-val">${totals.adherence}%</div>
        <div class="rh-lbl">Adherence</div>
      </div>
      <div class="rh-item">
        <div class="rh-val">${totals.taken}</div>
        <div class="rh-lbl">Taken</div>
      </div>
      <div class="rh-item">
        <div class="rh-val" style="color:var(--bad)">${totals.missed}</div>
        <div class="rh-lbl">Missed</div>
      </div>
    </div>

    <div class="card">
      <div class="section-head" style="margin-top:0"><h3>${esc(label)}</h3></div>
      ${bucketsHTML}
    </div>

    <div class="card">
      <div class="section-head" style="margin-top:0"><h3>By medicine</h3></div>
      ${medBars}
    </div>

    <div class="card">
      <div class="section-head" style="margin-top:0"><h3>Summary</h3></div>
      <div style="display:flex;flex-direction:column;gap:9px;font-size:13.5px">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--ink2)">Scheduled doses</span><strong>${totals.scheduled}</strong></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--ink2)">Taken</span><strong style="color:var(--ok)">${totals.taken}</strong></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--ink2)">Skipped</span><strong style="color:var(--warn)">${totals.skipped}</strong></div>
        <div style="display:flex;justify-content:space-between"><span style="color:var(--ink2)">Missed</span><strong style="color:var(--bad)">${totals.missed}</strong></div>
      </div>
    </div>

    <button class="btn ghost block" data-action="export-pdf">
      <svg class="ic"><use href="#i-file"/></svg> Export PDF report
    </button>
  `;
}

/* ------------------------------------------------------------
   SCREEN: STOCK
   ------------------------------------------------------------ */
function renderStock() {
  const body = $('stockBody');
  const tracked = state.medicines.filter(m => inventoryFor(m.id));

  if (!tracked.length) {
    body.innerHTML = emptyState('box', 'No stock tracking', 'Enable stock tracking when adding a medicine.');
    return;
  }

  body.innerHTML = tracked.map(med => {
    const inv = inventoryFor(med.id);
    const pct = Math.min(100, Math.round((inv.remaining / Math.max(1, inv.initial)) * 100));
    const low = inv.remaining <= inv.threshold;
    const barClass = inv.remaining <= 0 ? 'empty' : low ? 'low' : '';

    return `
    <div class="stock-card">
      <div class="stock-top">
        <div>
          <div class="stock-name">${esc(med.name)}</div>
          <div class="stock-sub">${esc([med.type, med.strength].filter(Boolean).join(' · ') || '—')}</div>
        </div>
        <div style="text-align:right">
          <div class="stock-nums"><strong>${inv.remaining}</strong><span>/ ${inv.initial}</span></div>
          <span class="badge ${low ? 'bad' : 'ok'}">${low ? 'Low stock' : 'In stock'}</span>
        </div>
      </div>
      <div class="stock-bar"><i class="${barClass}" style="width:${pct}%"></i></div>
      <div class="stock-actions">
        <button class="mini-btn" data-action="stock-add" data-id="${esc(med.id)}">
          <svg class="ic"><use href="#i-plus"/></svg> Add stock
        </button>
        <button class="mini-btn" data-action="stock-remove" data-id="${esc(med.id)}">
          <svg class="ic"><use href="#i-x"/></svg> Remove
        </button>
      </div>
    </div>`;
  }).join('');
}

/* ------------------------------------------------------------
   SCREEN: SETTINGS
   ------------------------------------------------------------ */
function renderSettings() {
  const hasPin = !!state.settings.pinHash;
  const bioOn = !!state.settings.biometric;

  const notifDesc = !state.notifSupported
    ? 'Native notifications available in the Android app'
    : state.notifPermission
      ? 'Enabled — reminders will be delivered'
      : 'Permission required for reminders';

  const exactDesc = state.exactAlarm === null
    ? 'Not applicable on this platform'
    : state.exactAlarm
      ? 'Exact alarms allowed'
      : 'Exact alarms blocked — reminders may be delayed';

  $('settingsBody').innerHTML = `
    <div class="settings-group">
      <h4>Security</h4>

      <div class="setting-row" data-action="toggle-pin">
        <div class="setting-icon"><svg class="ic"><use href="#i-lock"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">PIN lock</div>
          <div class="setting-desc">${hasPin ? 'PIN is enabled — tap to change or remove' : 'Protect your data with a 4-digit PIN'}</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>

      <div class="setting-row" data-action="toggle-bio">
        <div class="setting-icon"><svg class="ic"><use href="#i-shield"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">Biometric unlock</div>
          <div class="setting-desc">${state.biometricAvailable ? (bioOn ? 'Enabled' : 'Tap to enable') : 'Not available on this device'}</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>
    </div>

    <div class="settings-group">
      <h4>Notifications</h4>

      <div class="setting-row" data-action="notif-permission">
        <div class="setting-icon"><svg class="ic"><use href="#i-bell"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">Notification permission</div>
          <div class="setting-desc">${esc(notifDesc)}</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>

      <div class="setting-row" data-action="exact-alarm">
        <div class="setting-icon"><svg class="ic"><use href="#i-alert"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">Exact alarms</div>
          <div class="setting-desc">${esc(exactDesc)}</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>

      <div class="setting-row" data-action="reschedule">
        <div class="setting-icon"><svg class="ic"><use href="#i-refresh"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">Reschedule reminders</div>
          <div class="setting-desc">Rebuild all pending notifications</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>
    </div>

    <div class="settings-group">
      <h4>Data</h4>

      <div class="setting-row" data-action="backup">
        <div class="setting-icon"><svg class="ic"><use href="#i-download"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">Backup data</div>
          <div class="setting-desc">Export all data as a JSON file</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>

      <div class="setting-row" data-action="restore">
        <div class="setting-icon"><svg class="ic"><use href="#i-upload"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">Restore data</div>
          <div class="setting-desc">Import a MyMed JSON backup</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>

      <div class="setting-row" data-action="export-pdf">
        <div class="setting-icon"><svg class="ic"><use href="#i-file"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">Export PDF report</div>
          <div class="setting-desc">Generate a 30-day adherence report</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>

      <div class="setting-row" data-action="reset">
        <div class="setting-icon" style="background:var(--bad-soft);color:var(--bad)">
          <svg class="ic"><use href="#i-trash"/></svg>
        </div>
        <div class="setting-body">
          <div class="setting-title" style="color:var(--bad)">Reset all data</div>
          <div class="setting-desc">Delete everything permanently</div>
        </div>
        <svg class="ic ic-chev"><use href="#i-chevron-right"/></svg>
      </div>
    </div>

    <div class="settings-group">
      <h4>About</h4>
      <div class="setting-row" style="cursor:default">
        <div class="setting-icon"><svg class="ic"><use href="#i-info"/></svg></div>
        <div class="setting-body">
          <div class="setting-title">MyMed v1.0.0</div>
          <div class="setting-desc">Offline personal medicine manager</div>
        </div>
      </div>
    </div>

    <p style="font-size:11.5px;color:var(--ink3);text-align:center;padding:8px 20px 4px;line-height:1.6">
      Reminders use Android local notifications. Delivery can be affected by battery
      optimisation and manufacturer restrictions. Always follow your prescriber's advice.
    </p>

    <input type="file" id="restoreInput" accept="application/json,.json" hidden />
  `;
}

/* ------------------------------------------------------------
   BACKUP / RESTORE / PDF
   ------------------------------------------------------------ */
function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
    return true;
  } catch (e) {
    return false;
  }
}

async function backupData() {
  const payload = {
    app: 'MyMed',
    version: 1,
    exportedAt: new Date().toISOString(),
    medicines: state.medicines,
    schedules: state.schedules,
    doseLogs: Array.from(state.doseLogs.values()),
    inventory: state.inventory,
    settings: Object.entries(state.settings).map(([key, value]) => ({ key, value }))
  };

  const json = JSON.stringify(payload, null, 2);
  const ok = downloadBlob(new Blob([json], { type: 'application/json' }), `mymed-backup-${todayStr()}.json`);

  if (ok) toast('Backup file created');
  else toast('Unable to save file on this device');
}

async function restoreData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data || data.app !== 'MyMed') {
      toast('This is not a MyMed backup file');
      return;
    }

    const confirmed = await confirmDialog({
      title: 'Restore backup?',
      message: 'This replaces all current MyMed data with the backup contents.',
      confirmText: 'Restore',
      danger: true
    });
    if (!confirmed) return;

    await dbClear(STORE.MEDICINES);
    await dbClear(STORE.SCHEDULES);
    await dbClear(STORE.DOSES);
    await dbClear(STORE.INVENTORY);
    await dbClear(STORE.SETTINGS);

    for (const m of data.medicines || []) await dbPut(STORE.MEDICINES, m);
    for (const s of data.schedules || []) await dbPut(STORE.SCHEDULES, s);
    for (const d of data.doseLogs || []) await dbPut(STORE.DOSES, d);
    for (const i of data.inventory || []) await dbPut(STORE.INVENTORY, i);
    for (const s of data.settings || []) {
      if (s.key === 'pinHash' || s.key === 'biometric') continue;
      await dbPut(STORE.SETTINGS, s);
    }

    await loadAll();
    await rescheduleAllNotifications();

    toast('Backup restored');
    showScreen('home');
  } catch (e) {
    toast('Invalid backup file');
  }
}

/* Minimal standards-compliant PDF generator (single page, Helvetica) */
function buildPDF(lines) {
  const sanitize = (s) => String(s).replace(/[^\x20-\x7E]/g, '?');
  const escapePdf = (s) => sanitize(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  let content = 'BT\n/F1 11 Tf\n40 800 Td\n16 TL\n';
  lines.slice(0, 46).forEach(line => {
    content += `(${escapePdf(line)}) Tj\nT*\n`;
  });
  content += 'ET';

  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objs[5] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  for (let i = 1; i <= 5; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }

  const xrefPos = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return new Blob([pdf], { type: 'application/pdf' });
}

function exportPDFReport() {
  const today = new Date();
  const start = dateStr(addDays(today, -29));
  const end = dateStr(today);
  const { totals, perMed } = statsForRange(start, end);

  const lines = [
    'MyMed - Medicine Adherence Report',
    '=================================',
    '',
    `Generated: ${new Date().toLocaleString()}`,
    `Period:    ${fmtDate(start)} to ${fmtDate(end)}`,
    '',
    'SUMMARY',
    '---------------------------------',
    `Scheduled doses : ${totals.scheduled}`,
    `Taken           : ${totals.taken}`,
    `Skipped         : ${totals.skipped}`,
    `Missed          : ${totals.missed}`,
    `Adherence       : ${totals.adherence}%`,
    '',
    'BY MEDICINE',
    '---------------------------------'
  ];

  perMed.forEach((m, medId) => {
    const med = state.medicines.find(x => x.id === medId);
    const pct = m.scheduled ? Math.round((m.taken / m.scheduled) * 100) : 0;
    lines.push(`${(med ? med.name : 'Deleted').slice(0, 26).padEnd(28)} ${String(pct).padStart(3)}%  (${m.taken}/${m.scheduled})`);
  });

  if (!perMed.size) lines.push('No dose data recorded in this period.');

  lines.push('', 'Generated by MyMed - Personal Medicine Manager');

  const ok = downloadBlob(buildPDF(lines), `mymed-report-${todayStr()}.pdf`);
  toast(ok ? 'PDF report generated' : 'Unable to save PDF on this device');
}

/* ------------------------------------------------------------
   LOCK / PIN / BIOMETRIC
   ------------------------------------------------------------ */
let pinBuffer = '';
let pinMode = 'unlock';       // 'unlock' | 'set' | 'confirm'
let pinFirstEntry = '';

function setPinDots(filled) {
  $$('#pinDots span').forEach((dot, i) => dot.classList.toggle('on', i < filled));
}

function resetPinBuffer() {
  pinBuffer = '';
  setPinDots(0);
}

function lockApp() {
  if (!state.settings.pinHash) return;
  pinMode = 'unlock';
  resetPinBuffer();
  $('lockMsg').textContent = 'Enter your 4-digit PIN';
  $('lockMsg').classList.remove('error');
  $('lockScreen').classList.remove('hidden');
  $('app').classList.add('hidden');
}

function unlockApp() {
  $('lockScreen').classList.add('hidden');
  $('app').classList.remove('hidden');
  resetPinBuffer();
}

async function handlePinComplete(pin) {
  if (pinMode === 'set') {
    pinFirstEntry = pin;
    pinMode = 'confirm';
    resetPinBuffer();
    $('lockMsg').textContent = 'Confirm your new PIN';
    return;
  }

  if (pinMode === 'confirm') {
    if (pin !== pinFirstEntry) {
      pinMode = 'set';
      pinFirstEntry = '';
      resetPinBuffer();
      $('lockMsg').textContent = 'PINs did not match — try again';
      $('lockMsg').classList.add('error');
      $('pinDots').classList.add('shake');
      setTimeout(() => $('pinDots').classList.remove('shake'), 400);
      return;
    }

    const hash = await sha256(pin);
    await setSetting('pinHash', hash);
    pinMode = 'unlock';
    resetPinBuffer();
    $('lockMsg').textContent = 'PIN set successfully';
    $('lockMsg').classList.remove('error');
    unlockApp();
    renderSettings();
    toast('PIN enabled');
    return;
  }

  // unlock
  const hash = await sha256(pin);
  if (hash === state.settings.pinHash) {
    unlockApp();
  } else {
    resetPinBuffer();
    $('lockMsg').textContent = 'Incorrect PIN — try again';
    $('lockMsg').classList.add('error');
    $('pinDots').classList.add('shake');
    setTimeout(() => $('pinDots').classList.remove('shake'), 400);
  }
}

function pinKeyPress(key) {
  if (key === 'del') {
    pinBuffer = pinBuffer.slice(0, -1);
    setPinDots(pinBuffer.length);
    return;
  }
  if (key === 'bio') {
    attemptBiometric();
    return;
  }
  if (!/^\d$/.test(key)) return;
  if (pinBuffer.length >= 4) return;

  pinBuffer += key;
  setPinDots(pinBuffer.length);

  if (pinBuffer.length === 4) {
    const pin = pinBuffer;
    setTimeout(() => handlePinComplete(pin), 120);
  }
}

function detectBiometric() {
  state.biometricAvailable = !!(
    window.Capacitor &&
    Capacitor.Plugins &&
    (Capacitor.Plugins.BiometricAuth || Capacitor.Plugins.NativeBiometric)
  );
}

async function attemptBiometric() {
  const plugin =
    (window.Capacitor && Capacitor.Plugins &&
      (Capacitor.Plugins.BiometricAuth || Capacitor.Plugins.NativeBiometric)) || null;

  if (!plugin) {
    toast('Biometric unlock is not available on this device');
    return;
  }

  try {
    const result = await plugin.verifyIdentity({ reason: 'Unlock MyMed' });
    const success = result && (result.verified === true || result.success === true);
    if (success) {
      unlockApp();
    } else {
      toast('Biometric verification failed');
    }
  } catch (e) {
    toast('Biometric verification cancelled');
  }
}

async function togglePinSetting() {
  const hasPin = !!state.settings.pinHash;

  if (!hasPin) {
    pinMode = 'set';
    pinFirstEntry = '';
    resetPinBuffer();
    $('lockMsg').textContent = 'Choose a 4-digit PIN';
    $('lockMsg').classList.remove('error');
    $('lockScreen').classList.remove('hidden');
    $('app').classList.add('hidden');
    return;
  }

  const keep = await confirmDialog({
    title: 'Disable PIN lock?',
    message: 'Your data stays on this device but will no longer be protected by a PIN.',
    confirmText: 'Disable',
    danger: true
  });

  if (keep) {
    await setSetting('pinHash', null);
    await setSetting('biometric', false);
    $('headerLockBtn').hidden = true;
    renderSettings();
    toast('PIN disabled');
  }
}

/* ------------------------------------------------------------
   GLOBAL CLICK DELEGATION
   ------------------------------------------------------------ */
async function handleDelegatedClick(e) {
  const trigger = e.target.closest('[data-action], [data-goto], [data-nav]');
  if (!trigger) return;

  /* Navigation */
  if (trigger.dataset.nav) {
    showScreen(trigger.dataset.nav);
    return;
  }
  if (trigger.dataset.goto) {
    showScreen(trigger.dataset.goto);
    return;
  }

  const action = trigger.dataset.action;
  const id = trigger.dataset.id;
  const key = trigger.dataset.key;

  switch (action) {
    /* ---- doses ---- */
    case 'dose-taken':
    case 'dose-skip':
    case 'dose-undo': {
      if (!key) return;
      const [medicineId, date, time] = key.split('|');
      if (action === 'dose-taken') {
        await setDoseStatus(medicineId, date, time, 'taken');
        toast('Marked as taken');
      } else if (action === 'dose-skip') {
        await setDoseStatus(medicineId, date, time, 'skipped');
        toast('Dose skipped');
      } else {
        await setDoseStatus(medicineId, date, time, 'pending');
        toast('Record cleared');
      }
      await loadAll();
      renderCurrent();
      break;
    }

    /* ---- medicines ---- */
    case 'med-open': {
      const med = state.medicines.find(m => m.id === id);
      showScreen('medicine-detail', { id, med });
      break;
    }
    case 'med-edit': {
      showScreen('medicine-form', { id });
      break;
    }
    case 'med-pause': {
      const med = state.medicines.find(m => m.id === id);
      if (!med) return;
      med.paused = !med.paused;
      med.updatedAt = Date.now();
      await dbPut(STORE.MEDICINES, med);
      await loadAll();
      await rescheduleAllNotifications();
      toast(med.paused ? 'Medicine paused' : 'Medicine resumed');
      renderCurrent();
      break;
    }
    case 'med-delete': {
      const med = state.medicines.find(m => m.id === id);
      if (!med) return;
      const ok = await confirmDialog({
        title: 'Delete medicine?',
        message: `"${med.name}" and its schedule will be removed. Dose history is kept for reports.`,
        confirmText: 'Delete',
        danger: true
      });
      if (!ok) return;

      await dbDelete(STORE.MEDICINES, id);
      const sched = scheduleFor(id);
      if (sched) await dbDelete(STORE.SCHEDULES, sched.id);
      await dbDelete(STORE.INVENTORY, id);

      await loadAll();
      await rescheduleAllNotifications();
      toast('Medicine deleted');
      showScreen('medicines');
      break;
    }

    /* ---- calendar ---- */
    case 'cal-day': {
      state.calendarSelected = trigger.dataset.date;
      renderCalendar();
      break;
    }

    /* ---- stock ---- */
    case 'stock-add': {
      const value = await promptDialog({
        title: 'Add stock',
        message: 'How many units are you adding?',
        value: '10',
        type: 'number',
        confirmText: 'Add'
      });
      if (value === null) return;
      const n = parseInt(value, 10);
      if (!n || n <= 0) { toast('Enter a valid amount'); return; }

      const inv = inventoryFor(id);
      if (inv) {
        inv.initial += n;
        inv.remaining += n;
        inv.updatedAt = Date.now();
        await dbPut(STORE.INVENTORY, inv);
        await loadAll();
        renderStock();
        toast(`${n} units added`);
      }
      break;
    }
    case 'stock-remove': {
      const value = await promptDialog({
        title: 'Remove stock',
        message: 'How many units are you removing?',
        value: '1',
        type: 'number',
        confirmText: 'Remove'
      });
      if (value === null) return;
      const n = parseInt(value, 10);
      if (!n || n <= 0) { toast('Enter a valid amount'); return; }

      await adjustStock(id, -n);
      await loadAll();
      renderStock();
      toast(`${n} units removed`);
      break;
    }

    /* ---- settings ---- */
    case 'toggle-pin':   await togglePinSetting(); break;
    case 'toggle-bio': {
      if (!state.biometricAvailable) {
        toast('Biometric unlock is not available on this device');
        return;
      }
      const next = !state.settings.biometric;
      await setSetting('biometric', next);
      renderSettings();
      toast(next ? 'Biometric unlock enabled' : 'Biometric unlock disabled');
      break;
    }
    case 'notif-permission': {
      const granted = await refreshNotificationPermission(true);
      if (granted) {
        await rescheduleAllNotifications();
        toast('Notifications enabled');
      } else {
        toast('Open system settings › Notifications');
      }
      renderSettings();
      break;
    }
    case 'exact-alarm': {
      await requestExactAlarm();
      renderSettings();
      break;
    }
    case 'reschedule': {
      await rescheduleAllNotifications();
      toast('Reminders rescheduled');
      break;
    }
    case 'backup':  await backupData(); break;
    case 'restore': {
      const input = $('restoreInput');
      if (input) input.click();
      break;
    }
    case 'export-pdf': exportPDFReport(); break;
    case 'reset': {
      const ok = await confirmDialog({
        title: 'Reset all data?',
        message: 'Every medicine, schedule, dose record and setting will be permanently deleted.',
        confirmText: 'Delete everything',
        danger: true
      });
      if (!ok) return;

      const LN = getLN();
      if (LN) {
        try {
          const pending = await LN.getPending();
          const mine = (pending.notifications || [])
            .filter(n => !n.extra || n.extra.mymed)
            .map(n => ({ id: n.id }));
          if (mine.length) await LN.cancel({ notifications: mine });
        } catch (err) { /* ignore */ }
      }

      await dbClear(STORE.MEDICINES);
      await dbClear(STORE.SCHEDULES);
      await dbClear(STORE.DOSES);
      await dbClear(STORE.INVENTORY);
      await dbClear(STORE.SETTINGS);

      await loadAll();
      $('headerLockBtn').hidden = true;
      toast('All data deleted');
      showScreen('home');
      break;
    }
  }
}

/* ------------------------------------------------------------
   UI BINDING
   ------------------------------------------------------------ */
function bindUI() {
  document.addEventListener('click', (e) => {
    handleDelegatedClick(e).catch(err => console.warn(err));
  });

  $('backBtn').addEventListener('click', () => {
    if (state.screen === 'medicine-form' || state.screen === 'medicine-detail') {
      showScreen('medicines');
    } else if (state.screen === 'calendar' || state.screen === 'stock') {
      showScreen('home');
    } else {
      showScreen('home');
    }
  });

  $('fab').addEventListener('click', () => showScreen('medicine-form'));

  $('headerLockBtn').addEventListener('click', lockApp);

  /* PIN pad */
  $('pinPad').addEventListener('click', (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn) return;
    pinKeyPress(btn.dataset.key);
  });
  document.addEventListener('keydown', (e) => {
    if ($('lockScreen').classList.contains('hidden')) return;
    if (/^\d$/.test(e.key)) pinKeyPress(e.key);
    else if (e.key === 'Backspace') pinKeyPress('del');
  });

  /* Medicine form */
  $('medicineForm').addEventListener('submit', handleMedicineSubmit);

  $('cancelFormBtn').addEventListener('click', () => showScreen('medicines'));

  $('fDays').addEventListener('click', (e) => {
    const chip = e.target.closest('.day-chip');
    if (!chip) return;
    const day = parseInt(chip.dataset.day, 10);
    if (state.formDays.includes(day)) {
      state.formDays = state.formDays.filter(d => d !== day);
    } else {
      state.formDays.push(day);
    }
    renderDayChips();
  });

  $('fDaily').addEventListener('change', (e) => {
    state.formDays = e.target.checked ? [0, 1, 2, 3, 4, 5, 6] : [];
    renderDayChips();
  });

  $('fFood').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    state.formFood = btn.dataset.val;
    renderFoodSegment();
  });

  $('addTimeBtn').addEventListener('click', () => {
    if (state.formTimes.length >= 8) { toast('Maximum 8 reminder times'); return; }
    const last = state.formTimes[state.formTimes.length - 1] || '08:00';
    const [h, m] = last.split(':').map(Number);
    const nextHour = (h + 4) % 24;
    state.formTimes.push(`${pad2(nextHour)}:${pad2(m)}`);
    renderTimeRows();
  });

  $('fStockEnabled').addEventListener('change', (e) => {
    $('stockFields').classList.toggle('hidden', !e.target.checked);
  });

  $('pickImage').addEventListener('click', () => $('fImage').click());

  $('fImage').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      state.formImage = await fileToDataURL(file);
      renderImagePreview();
    } catch (err) {
      toast('Could not read image');
    }
    e.target.value = '';
  });

  $('removeImage').addEventListener('click', () => {
    state.formImage = '';
    renderImagePreview();
  });

  /* Medicines filters + search */
  $('medFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.medFilter = chip.dataset.filter;
    $$('#medFilters .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderMedicines();
  });

  $('medSearch').addEventListener('input', (e) => {
    state.medSearch = e.target.value.trim();
    renderMedicines();
  });

  /* Timetable weekdays */
  $('weekdayRow').addEventListener('click', (e) => {
    const chip = e.target.closest('.wd-chip');
    if (!chip) return;
    state.timetableDay = parseInt(chip.dataset.day, 10);
    renderTimetable();
  });

  /* Calendar navigation */
  $('calPrev').addEventListener('click', () => {
    state.calendarMonth--;
    if (state.calendarMonth < 0) { state.calendarMonth = 11; state.calendarYear--; }
    renderCalendar();
  });
  $('calNext').addEventListener('click', () => {
    state.calendarMonth++;
    if (state.calendarMonth > 11) { state.calendarMonth = 0; state.calendarYear++; }
    renderCalendar();
  });

  /* Report tabs */
  $('reportTabs').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.reportPeriod = chip.dataset.period;
    renderReports();
  });

  /* Restore input (created dynamically inside settings) */
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'restoreInput') {
      const file = e.target.files && e.target.files[0];
      if (file) restoreData(file);
      e.target.value = '';
    }
  });

  /* Re-sync when the app returns to foreground (handles reboot recovery) */
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (!db) return;
    await loadAll();
    await checkExactAlarm();
    renderCurrent();
    rescheduleAllNotifications();
  });
}

/* Image compression helper */
function fileToDataURL(file, maxDim = 1100, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------
   BOOT
   ------------------------------------------------------------ */
async function init() {
  try {
    db = await openDB();
  } catch (err) {
    document.body.innerHTML =
      '<div style="padding:40px;text-align:center;font-family:sans-serif">' +
      '<h2>Storage unavailable</h2><p>MyMed could not open its local database.</p></div>';
    return;
  }

  await loadAll();
  detectBiometric();
  bindUI();
  await initNotifications();

  const hasPin = !!state.settings.pinHash;
  $('headerLockBtn').hidden = !hasPin;

  if (hasPin) {
    pinMode = 'unlock';
    resetPinBuffer();
    $('lockScreen').classList.remove('hidden');
    $('app').classList.add('hidden');
  } else {
    $('lockScreen').classList.add('hidden');
    $('app').classList.remove('hidden');
  }

  showScreen('home');
  rescheduleAllNotifications();
}

document.addEventListener('DOMContentLoaded', init);
