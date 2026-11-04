/**
 * AllesBau — Work Hour Tracking & Payroll Approval PWA
 * Frontend Application with Multi-User Authentication & Live Multi-Device Database Sync
 */

// Server API Base URL & Mode Detection
function getApiBaseUrl() {
  const custom = localStorage.getItem('allesbau_backend_url');
  if (custom && custom.trim()) return custom.trim();
  if (window.location.hostname && !['localhost', '127.0.0.1', ''].includes(window.location.hostname)) {
    return window.location.origin; // Hosted directly on PythonAnywhere or production server
  }
  if (window.location.port === '5000') {
    return window.location.origin; // Local Flask development
  }
  return ''; // Local browser DB fallback
}

// Initial Empty Database Schema (Fresh Start - No dummy data)
const INITIAL_LOCAL_DB = {
  crews: [],
  users: [],
  shifts: [],
  payments: [],
  timers: {}
};

// Automatic cleanup on first launch of this version: Clear all legacy and cached test data
const ALLESBAU_STORAGE_TAG = 'allesbau_data_cleared_v9';
if (localStorage.getItem('allesbau_storage_version') !== ALLESBAU_STORAGE_TAG) {
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('crewhours_') || k.startsWith('allesbau_'))) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) {}
  localStorage.setItem('allesbau_storage_version', ALLESBAU_STORAGE_TAG);
  localStorage.setItem('allesbau_local_db_prod', JSON.stringify(INITIAL_LOCAL_DB));
}

function getLocalDb() {
  const saved = localStorage.getItem('allesbau_local_db_prod');
  if (saved) {
    try { return JSON.parse(saved); } catch (e) {}
  }
  localStorage.setItem('allesbau_local_db_prod', JSON.stringify(INITIAL_LOCAL_DB));
  return JSON.parse(JSON.stringify(INITIAL_LOCAL_DB));
}

function saveLocalDb(db) {
  localStorage.setItem('allesbau_local_db_prod', JSON.stringify(db));
  localStorage.setItem('allesbau_db_touch', Date.now().toString());
}

/**
 * 30-Minute Interval Time Rounding Logic
 * Rule: if minutes > 15 and <= 45 -> 30 mins
 *       else (<= 15 or > 45) -> 00 mins (rolls over to next hour if > 45)
 * Examples: 8:14 -> 8:00, 8:16 -> 8:30, 8:45 -> 8:30, 8:46 -> 9:00
 */
function roundTimeTo30Minutes(timeInput) {
  if (!timeInput) return '08:00';
  let hours = 0;
  let minutes = 0;

  if (timeInput instanceof Date) {
    hours = timeInput.getHours();
    minutes = timeInput.getMinutes();
  } else if (typeof timeInput === 'string' && timeInput.includes(':')) {
    const parts = timeInput.trim().split(':').map(Number);
    hours = isNaN(parts[0]) ? 0 : parts[0];
    minutes = isNaN(parts[1]) ? 0 : parts[1];
  } else {
    return timeInput;
  }

  let roundedHours = hours;
  let roundedMinutes = 0;

  if (minutes > 15 && minutes <= 45) {
    roundedMinutes = 30;
  } else {
    roundedMinutes = 0;
    if (minutes > 45) {
      roundedHours = (roundedHours + 1) % 24;
    }
  }

  return `${String(roundedHours).padStart(2, '0')}:${String(roundedMinutes).padStart(2, '0')}`;
}

function calculateShiftHours(startTimeStr, endTimeStr, breakMinutes = 0) {
  if (!startTimeStr || !endTimeStr) return 0.0;
  const roundedStart = roundTimeTo30Minutes(startTimeStr);
  const roundedEnd = roundTimeTo30Minutes(endTimeStr);

  const [sH, sM] = roundedStart.split(':').map(Number);
  const [eH, eM] = roundedEnd.split(':').map(Number);

  let startMinutes = sH * 60 + sM;
  let endMinutes = eH * 60 + eM;

  if (endMinutes < startMinutes) {
    endMinutes += 24 * 60; // Overnight shift
  }

  const workedMinutes = Math.max(0, endMinutes - startMinutes - (parseInt(breakMinutes) || 0));
  return parseFloat((workedMinutes / 60).toFixed(2));
}

// Local In-Browser API Implementation
function handleLocalApi(endpoint, method, body) {
  const db = getLocalDb();
  const cleanEndpoint = endpoint.split('?')[0];

  if (cleanEndpoint === '/api/auth/login' && method === 'POST') {
    const user = db.users.find(u => u.username.toLowerCase() === (body.username || '').toLowerCase().trim());
    if (!user || user.password !== body.password) {
      throw new Error('Invalid username or password');
    }
    const crew = db.crews.find(c => c.id === user.crew_id) || { company_name: 'Crew' };
    const token = `local_${user.id}_${Date.now()}`;
    const hRate = parseFloat(user.hourly_rate) || 20.0;
    const bRate = parseFloat(user.billing_rate ?? hRate) || hRate;

    const userPayload = {
      id: user.id,
      crew_id: user.crew_id,
      username: user.username,
      role: user.role,
      name: user.name,
      company_name: crew.company_name
    };

    if (user.role === 'leader') {
      userPayload.hourly_rate = hRate;
      userPayload.billing_rate = bRate;
    } else if (user.role === 'supervisor') {
      userPayload.hourly_rate = bRate;
      userPayload.billing_rate = bRate;
    } else {
      userPayload.hourly_rate = hRate;
    }

    return {
      token,
      user: userPayload
    };
  }

  if (cleanEndpoint === '/api/auth/register-leader' && method === 'POST') {
    const username = (body.username || '').toLowerCase().trim();
    if (db.users.some(u => u.username.toLowerCase() === username)) {
      throw new Error('Username already taken');
    }
    const crewId = 'c_' + Date.now();
    const userId = 'u_' + Date.now();
    db.crews.push({ id: crewId, company_name: body.company_name, created_at: new Date().toISOString() });
    const newUser = {
      id: userId,
      crew_id: crewId,
      username,
      password: body.password,
      role: 'leader',
      name: body.leader_name,
      hourly_rate: 0.0,
      billing_rate: 0.0,
      active: 1
    };
    db.users.push(newUser);
    saveLocalDb(db);

    const token = `local_${userId}_${Date.now()}`;
    return {
      message: 'Crew registered successfully',
      token,
      user: {
        id: userId,
        crew_id: crewId,
        username,
        role: 'leader',
        name: body.leader_name,
        company_name: body.company_name
      }
    };
  }

  if (cleanEndpoint === '/api/auth/change-password' && method === 'POST') {
    const user = db.users.find(u => u.id === authState.user.id);
    if (!user || user.password !== body.current_password) {
      throw new Error('Current password incorrect');
    }
    user.password = body.new_password;
    saveLocalDb(db);
    return { message: 'Password changed successfully' };
  }

  if (cleanEndpoint === '/api/users/add-supervisor' && method === 'POST') {
    const username = (body.username || '').toLowerCase().trim();
    if (db.users.some(u => u.username.toLowerCase() === username)) {
      throw new Error('Username already taken');
    }
    const userId = 'u_' + Date.now();
    db.users.push({
      id: userId,
      crew_id: authState.user.crew_id,
      username,
      password: body.password,
      role: 'supervisor',
      name: body.name,
      active: 1
    });
    saveLocalDb(db);
    return { message: `Supervisor ${body.name} added`, user_id: userId };
  }

  if (cleanEndpoint === '/api/users/add-worker' && method === 'POST') {
    const username = (body.username || '').toLowerCase().trim();
    if (db.users.some(u => u.username.toLowerCase() === username)) {
      throw new Error('Username already taken');
    }
    const userId = 'w_' + Date.now();
    const hourly_rate = parseFloat(body.hourly_rate) || 20.0;
    const billing_rate = parseFloat(body.billing_rate ?? hourly_rate) || hourly_rate;

    db.users.push({
      id: userId,
      crew_id: authState.user.crew_id,
      username,
      password: body.password,
      role: 'worker',
      name: body.name,
      hourly_rate,
      billing_rate,
      phone: body.phone || '',
      active: 1
    });
    saveLocalDb(db);
    return {
      message: `Worker ${body.name} registered`,
      user_id: userId,
      worker: { id: userId, name: body.name, hourly_rate, billing_rate }
    };
  }

  if (cleanEndpoint.startsWith('/api/users/') && cleanEndpoint.endsWith('/rates') && (method === 'POST' || method === 'PUT')) {
    if (authState.user?.role !== 'leader') {
      throw new Error('Only leaders can modify worker rates');
    }
    const parts = cleanEndpoint.split('/');
    const workerId = parts[3];
    const worker = db.users.find(u => u.id === workerId && u.role === 'worker');
    if (!worker) {
      throw new Error('Worker not found');
    }
    if (body.hourly_rate !== undefined) worker.hourly_rate = parseFloat(body.hourly_rate) || 0;
    if (body.billing_rate !== undefined) worker.billing_rate = parseFloat(body.billing_rate) || 0;
    if (body.name) worker.name = body.name.trim();
    if (body.phone !== undefined) worker.phone = body.phone.trim();
    saveLocalDb(db);
    return {
      success: true,
      message: `Raten für ${worker.name} gespeichert`,
      worker: { id: workerId, hourly_rate: worker.hourly_rate, billing_rate: worker.billing_rate }
    };
  }

  if (cleanEndpoint === '/api/sync' && method === 'GET') {
    const crewId = authState.user?.crew_id;
    if (!crewId) {
      return { timestamp: Date.now(), workers: [], shifts: [], payments: [], timers: {} };
    }
    const role = authState.user?.role;
    const rawWorkers = db.users.filter(u => u.crew_id === crewId && u.active);
    const workers = rawWorkers.map(u => {
      const copy = { ...u };
      delete copy.password;
      const hRate = parseFloat(copy.hourly_rate) || 0;
      const bRate = parseFloat(copy.billing_rate ?? hRate) || hRate;
      copy.billing_rate = bRate;

      if (role === 'leader') {
        // Leader sees both rates
        return copy;
      } else if (role === 'supervisor') {
        // Supervisor only sees what he is paying
        copy.hourly_rate = bRate;
        copy.billing_rate = bRate;
        return copy;
      } else {
        // Worker only sees their salary
        delete copy.billing_rate;
        return copy;
      }
    });

    return {
      timestamp: Date.now(),
      workers,
      shifts: db.shifts.filter(s => s.crew_id === crewId),
      payments: db.payments.filter(p => p.crew_id === crewId),
      timers: db.timers || {}
    };
  }

  if (cleanEndpoint === '/api/timers/start' && method === 'POST') {
    db.timers = db.timers || {};
    db.timers[body.worker_id] = {
      startTime: Date.now(),
      pausedAccumulated: 0,
      pauseStartedAt: null,
      status: 'running'
    };
    saveLocalDb(db);
    return { success: true };
  }

  if (cleanEndpoint === '/api/timers/pause' && method === 'POST') {
    db.timers = db.timers || {};
    const timer = db.timers[body.worker_id];
    if (timer) {
      const now = Date.now();
      if (timer.status === 'running') {
        timer.pausedAccumulated = (timer.pausedAccumulated || 0) + Math.floor((now - timer.startTime) / 1000);
        timer.pauseStartedAt = now;
        timer.status = 'paused';
        timer.startTime = null;
      } else {
        timer.startTime = now;
        timer.pauseStartedAt = null;
        timer.status = 'running';
      }
      saveLocalDb(db);
    }
    return { success: true };
  }

  if (cleanEndpoint === '/api/timers/stop' && method === 'POST') {
    const shiftId = 's_' + Date.now();
    const roundTime = body.round_time !== false;
    const startTime = roundTime ? roundTimeTo30Minutes(body.start_time) : String(body.start_time).trim();
    const endTime = roundTime ? roundTimeTo30Minutes(body.end_time) : String(body.end_time).trim();
    const breakMinutes = parseInt(body.break_minutes) || 0;
    const totalHours = parseFloat(body.total_hours) || calculateShiftHours(startTime, endTime, breakMinutes);
    const media = Array.isArray(body.media) ? JSON.stringify(body.media) : (body.media || '');

    // Duplicate check
    const isDup = (db.shifts || []).some(s => 
      s.crew_id === authState.user.crew_id && 
      (s.workerId === body.worker_id || s.worker_id === body.worker_id) && 
      s.date === body.date && 
      (s.startTime || s.start_time) === startTime && 
      (s.endTime || s.end_time) === endTime
    );
    if (isDup) {
      throw new Error('Doppelte Schicht: Für diesen Arbeiter existiert bereits eine Schicht zu dieser Zeit.');
    }

    db.shifts.unshift({
      id: shiftId,
      crew_id: authState.user.crew_id,
      workerId: body.worker_id,
      worker_id: body.worker_id,
      date: body.date,
      startTime: startTime,
      endTime: endTime,
      breakMinutes: breakMinutes,
      totalHours: totalHours,
      status: 'pending',
      approvedBy: null,
      note: body.note || 'Live timer shift',
      media: media
    });
    if (db.timers) delete db.timers[body.worker_id];
    saveLocalDb(db);
    return { success: true, shift_id: shiftId };
  }

  if (cleanEndpoint === '/api/shifts/manual' && method === 'POST') {
    const workerIds = body.worker_ids || (body.worker_id ? [body.worker_id] : []);
    const roundTime = body.round_time !== false;
    const startTime = roundTime ? roundTimeTo30Minutes(body.start_time) : String(body.start_time).trim();
    const endTime = roundTime ? roundTimeTo30Minutes(body.end_time) : String(body.end_time).trim();
    const breakMinutes = parseInt(body.break_minutes) || 0;
    const totalHours = parseFloat(body.total_hours) || calculateShiftHours(startTime, endTime, breakMinutes);
    const media = Array.isArray(body.media) ? JSON.stringify(body.media) : (body.media || '');
    const shiftIds = [];

    workerIds.forEach((wid, idx) => {
      // Duplicate check
      const isDup = (db.shifts || []).some(s => 
        s.crew_id === authState.user.crew_id && 
        (s.workerId === wid || s.worker_id === wid) && 
        s.date === body.date && 
        (s.startTime || s.start_time) === startTime && 
        (s.endTime || s.end_time) === endTime
      );
      if (isDup) return;

      const shiftId = 's_' + Date.now() + '_' + idx;
      db.shifts.unshift({
        id: shiftId,
        crew_id: authState.user.crew_id,
        workerId: wid,
        worker_id: wid,
        date: body.date,
        startTime: startTime,
        endTime: endTime,
        breakMinutes: breakMinutes,
        totalHours: totalHours,
        status: 'pending',
        approvedBy: null,
        note: body.note || '',
        media: media
      });
      shiftIds.push(shiftId);
    });

    if (shiftIds.length === 0) {
      throw new Error('Für alle gewählten Mitarbeiter existieren bereits Schichten zu dieser Zeit.');
    }
    saveLocalDb(db);
    return { success: true, shift_ids: shiftIds, shift_id: shiftIds[0] };
  }

  if (cleanEndpoint.startsWith('/api/shifts/') && cleanEndpoint.endsWith('/status') && method === 'PUT') {
    const parts = cleanEndpoint.split('/');
    const shiftId = parts[3];
    const shift = db.shifts.find(s => s.id === shiftId);
    if (shift) {
      shift.status = body.status;
      shift.approvedBy = authState.user?.role === 'supervisor' ? 'Supervisor' : 'Leader';
      saveLocalDb(db);
    }
    return { success: true };
  }

  // Edit Shift (Leader only)
  if (cleanEndpoint.startsWith('/api/shifts/') && !cleanEndpoint.endsWith('/status') && method === 'PUT') {
    if (authState.user?.role !== 'leader') {
      throw new Error('Only leaders can edit shifts');
    }
    const parts = cleanEndpoint.split('/');
    const shiftId = parts[3];
    const shift = db.shifts.find(s => s.id === shiftId);
    if (!shift) {
      throw new Error('Shift not found');
    }
    const wid = body.worker_id || body.workerId || shift.workerId;
    shift.workerId = wid;
    shift.worker_id = wid;
    if (body.date) shift.date = body.date;
    if (body.start_time || body.startTime) shift.startTime = body.start_time || body.startTime;
    if (body.end_time || body.endTime) shift.endTime = body.end_time || body.endTime;
    if (body.break_minutes !== undefined || body.breakMinutes !== undefined) {
      shift.breakMinutes = parseInt(body.break_minutes ?? body.breakMinutes) || 0;
    }
    shift.totalHours = parseFloat(body.total_hours ?? body.totalHours) || calculateShiftHours(shift.startTime, shift.endTime, shift.breakMinutes);
    if (body.note !== undefined) shift.note = body.note;
    if (body.media !== undefined) shift.media = Array.isArray(body.media) ? JSON.stringify(body.media) : body.media;
    if (body.status) shift.status = body.status;
    saveLocalDb(db);
    return { success: true };
  }

  // Delete Shift (Leader only)
  if (cleanEndpoint.startsWith('/api/shifts/') && method === 'DELETE') {
    if (authState.user?.role !== 'leader') {
      throw new Error('Only leaders can delete shifts');
    }
    const parts = cleanEndpoint.split('/');
    const shiftId = parts[3];
    db.shifts = (db.shifts || []).filter(s => s.id !== shiftId);
    saveLocalDb(db);
    return { success: true };
  }

  if (cleanEndpoint === '/api/shifts/approve-all' && method === 'POST') {
    const crewId = authState.user.crew_id;
    db.shifts.forEach(s => {
      if (s.crew_id === crewId && s.status === 'pending') {
        s.status = 'approved';
        s.approvedBy = authState.user?.role === 'supervisor' ? 'Supervisor' : 'Leader';
      }
    });
    saveLocalDb(db);
    return { success: true };
  }

  if (cleanEndpoint === '/api/payments' && method === 'POST') {
    const paymentId = 'p_' + Date.now();
    const wid = body.worker_id || body.workerId;
    const amount = parseFloat(body.amount) || 0;

    // Duplicate pending payment check
    const isDup = (db.payments || []).some(p => 
      p.crew_id === authState.user.crew_id && 
      (p.workerId === wid || p.worker_id === wid) && 
      p.date === body.date && 
      parseFloat(p.amount) === amount && 
      p.status === 'pending'
    );
    if (isDup) {
      throw new Error('Eine identische ausstehende Zahlung existiert bereits für diesen Tag.');
    }

    db.payments.unshift({
      id: paymentId,
      crew_id: authState.user.crew_id,
      workerId: wid,
      worker_id: wid,
      amount: amount,
      date: body.date,
      receivedBy: body.received_by || '',
      loggedBy: authState.user.role.toUpperCase(),
      comment: body.comment || '',
      status: body.status || 'pending'
    });
    saveLocalDb(db);
    return { success: true, payment_id: paymentId };
  }

  if (cleanEndpoint.startsWith('/api/payments/') && cleanEndpoint.endsWith('/status') && method === 'PUT') {
    const parts = cleanEndpoint.split('/');
    const paymentId = parts[3];
    const payment = db.payments.find(p => p.id === paymentId);
    if (payment) {
      payment.status = body.status;
      saveLocalDb(db);
    }
    return { success: true };
  }

  return { success: true };
}

// Default Offline Empty Fallback
const DEFAULT_DATA = {
  workers: [],
  timers: {},
  shifts: [],
  payments: []
};

// Global App State
let authState = loadAuthToken(); // { token, user }
let appData = loadLocalData();

let currentLang = localStorage.getItem('allesbau_lang') || 'de';

function toggleLanguage() {
  currentLang = currentLang === 'de' ? 'en' : 'de';
  localStorage.setItem('allesbau_lang', currentLang);
  renderApp();
}

const I18N = {
  de: {
    nav_home: "Übersicht",
    nav_calendar: "Kalender",
    nav_payments: "Auszahlungen",
    active_now: "Aktiv",
    sync_tooltip: "Synchronisieren",
    cal_title: "Kalender & Schichten",
    cal_month_shifts: "Schichten im Monat",
    download_report_pdf: "Monatsbericht herunterladen (PDF)",
    download_report_pdf_worker: "Monatsbericht herunterladen (PDF) — ",
    filter_worker: "Mitarbeiter",
    all_workers: "Alle Mitarbeiter",
    filter_status: "Status Filter",
    all_status: "Alle Status",
    status_pending: "Ausstehend",
    status_approved: "Genehmigt",
    status_rejected: "Abgelehnt",
    stat_total_approved_all_time: "Genehmigt (Gesamt)",
    stat_approved_month: "Genehmigt (Monat)",
    stat_work_days_month: "Arbeitstage (Monat)",
    stat_pending_hours: "Ausstehend (Std.)",
    all_time: "Alle Zeiten",
    this_month: "Dieser Monat",
    under_review: "Zur Prüfung",
    col_date: "Datum / Tag",
    col_worker: "Mitarbeiter",
    col_time: "Arbeitszeit",
    col_break: "Pause",
    col_hours: "Stunden",
    col_status: "Status",
    col_actions: "Aktion",
    col_comments: "Kommentare",
    col_media: "Fotos",
    workers_count: "Arbeiter",
    show_photos: "Fotos",
    no_shifts_month: "Keine Schichten für diesen Monat gefunden.",
    edit: "Bearbeiten",
    delete: "Löschen",
    approve: "Genehmigen",
    reject: "Ablehnen",
    approve_all: "Alle genehmigen",
    pending_approval_notice: "ausstehende Schichten zur Prüfung",
    clock_in: "Schicht starten",
    clock_out: "Schicht beenden",
    pause: "Pause",
    resume: "Weiter",
    running: "Läuft",
    stop: "Stop",
    round_toggle: "30-Minuten-Rundung aktivieren",
    shift_note: "Notiz / Baustelle",
    upload_photos: "Fotos hinzufügen (Tagesende)",
    photos_selected: "Fotos ausgewählt",
    stop_and_submit: "Schicht abschließen & senden",
    cancel: "Abbrechen",
    save: "Speichern",
    payments_title: "Abrechnung & Auszahlungen",
    total_earned: "Verdienst",
    total_paid: "Bereits bezahlt",
    balance_remaining: "Noch offen",
    log_payment: "Auszahlung erfassen",
    payment_details_invoice: "Beleg / Quittung",
    saving: "Wird gespeichert...",
    dup_shift_warning: "Für diesen Mitarbeiter existiert bereits eine Schicht zu dieser Zeit!",
    dup_payment_warning: "Eine identische ausstehende Zahlung existiert bereits!",
    confirm_delete_shift: "Möchten Sie diese Schicht wirklich unwiderruflich löschen?",
    shift_deleted: "Schicht erfolgreich gelöscht! 🗑️",
    shift_saved: "Schicht erfolgreich aktualisiert! ✅",
    mark_approved_directly: "Direkt als genehmigt buchen (vom Lohn abziehen)",
    all_workers_worked: "Arbeiter am Tag",
    details_expand: "Details anzeigen",
    details_collapse: "Details schließen",
    history_title: "Auszahlungsverlauf & Belege",
    history_subtitle: "Chronologisches Zahlungsjournal & Quittungsarchiv",
    receipt_no: "Beleg-Nr.",
    recipient: "Empfänger",
    logged_by: "Erfasst durch",
    no_payments_yet: "Noch keine Auszahlungen erfasst.",
    fold_all: "Alle zuklappen",
    unfold_all: "Alle aufklappen",
    add_worker: "+ Mitarbeiter anlegen",
    manual_entry: "+ Schicht eintragen",
    worker_portal: "Mitarbeiter-Portal",
    logged_in_as: "Angemeldet als:",
    today_shifts: "Heutige erfasste Schichten",
    no_shifts_today: "Heute noch keine Schichten abgeschlossen.",
    shift_clock: "Laufende Arbeitszeit",
    today_status: "Heutiger Status",
    on_break: "In Pause",
    not_clocked_in: "Nicht eingestempelt",
    crew_workers: "Mitarbeiter-Team",
    active_workers_count: "aktiv",
    supervisor_view: "Supervisor-Ansicht",
    change_password: "Passwort ändern",
    current_password: "Aktuelles Passwort",
    new_password: "Neues Passwort",
    update_password: "Passwort aktualisieren",
    filter_worker_balance: "Mitarbeiter filtern:"
  },
  en: {
    nav_home: "Home",
    nav_calendar: "Calendar",
    nav_payments: "Payments",
    active_now: "Active",
    sync_tooltip: "Synchronize",
    cal_title: "Calendar & Shifts",
    cal_month_shifts: "shifts in month",
    download_report_pdf: "Download Monthly Report (PDF)",
    download_report_pdf_worker: "Download Monthly Report (PDF) — ",
    filter_worker: "Worker",
    all_workers: "All Workers",
    filter_status: "Status Filter",
    all_status: "All Statuses",
    status_pending: "Pending",
    status_approved: "Approved",
    status_rejected: "Rejected",
    stat_total_approved_all_time: "Approved (All Time)",
    stat_approved_month: "Approved (Month)",
    stat_work_days_month: "Work Days (Month)",
    stat_pending_hours: "Pending Hours",
    all_time: "All Time",
    this_month: "This Month",
    under_review: "Under Review",
    col_date: "Date / Day",
    col_worker: "Worker",
    col_time: "Working Hours",
    col_break: "Break",
    col_hours: "Hours",
    col_status: "Status",
    col_actions: "Action",
    col_comments: "Comments",
    col_media: "Photos",
    workers_count: "workers",
    show_photos: "Photos",
    no_shifts_month: "No shifts found for this month.",
    edit: "Edit",
    delete: "Delete",
    approve: "Approve",
    reject: "Reject",
    approve_all: "Approve All",
    pending_approval_notice: "pending shifts under review",
    clock_in: "Clock In",
    clock_out: "Clock Out",
    pause: "Pause",
    resume: "Resume",
    running: "Running",
    stop: "Stop",
    round_toggle: "Enable 30-minute interval rounding",
    shift_note: "Site / Note",
    upload_photos: "Attach End-of-Day Photos",
    photos_selected: "photos selected",
    stop_and_submit: "Stop & Submit Shift",
    cancel: "Cancel",
    save: "Save",
    payments_title: "Payroll & Payouts",
    total_earned: "Earned",
    total_paid: "Already Paid",
    balance_remaining: "Remaining Balance",
    log_payment: "Log Payment",
    payment_details_invoice: "Receipt / Invoice",
    saving: "Saving...",
    dup_shift_warning: "A shift already exists for this worker at this time!",
    dup_payment_warning: "An identical pending payment already exists!",
    confirm_delete_shift: "Are you sure you want to permanently delete this shift?",
    shift_deleted: "Shift deleted successfully! 🗑️",
    shift_saved: "Shift updated successfully! ✅",
    mark_approved_directly: "Mark as approved immediately (deduct from wage)",
    all_workers_worked: "Workers on day",
    details_expand: "Show details",
    details_collapse: "Hide details",
    history_title: "Payment History & Receipts",
    history_subtitle: "Chronological transaction journal & receipt archive",
    receipt_no: "Receipt #",
    recipient: "Recipient",
    logged_by: "Logged by",
    no_payments_yet: "No payment history recorded yet.",
    fold_all: "Collapse all",
    unfold_all: "Expand all",
    add_worker: "+ Add Worker",
    manual_entry: "+ Manual Entry",
    worker_portal: "Worker Portal",
    logged_in_as: "Logged in as:",
    today_shifts: "Today's Logged Shifts",
    no_shifts_today: "No completed shifts logged for today yet.",
    shift_clock: "Live Shift Clock",
    today_status: "Today's Status",
    on_break: "On Break",
    not_clocked_in: "Not Clocked In",
    crew_workers: "Crew Workers",
    active_workers_count: "active",
    supervisor_view: "Supervisor View",
    change_password: "Change Password",
    current_password: "Current Password",
    new_password: "New Password",
    update_password: "Update Password",
    filter_worker_balance: "Filter Worker Balance:"
  }
};

function t(key, fallback = '') {
  return I18N[currentLang]?.[key] || I18N.de[key] || fallback || key;
}

function compressImageFile(file, maxWidth = 1000, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

let appState = {
  activeTab: 'home', // 'home' | 'calendar' | 'payments'
  selectedMonth: getCurrentMonthString(),
  calendarWorkerFilter: 'all',
  calendarStatusFilter: 'all',
  paymentWorkerFilter: 'all',
  activeModal: null, // null | 'addUser' | 'manualShift' | 'logPayment' | 'changePassword' | 'stopTimerConfirm' | 'serverConfig' | 'editShift' | 'paymentInvoice' | 'mediaViewer'
  modalPayload: null,
  authTab: 'login', // 'login' | 'register'
  isSyncing: false,
  isOnline: Boolean(getApiBaseUrl()),
  isSubmitting: false,
  expandedCalendarDays: {},
  manualShiftMedia: []
};

// -------------------------------------------------------------
// AUTHENTICATION & STORAGE HELPERS
// -------------------------------------------------------------

function loadAuthToken() {
  const savedToken = localStorage.getItem('allesbau_auth_token');
  const savedUser = localStorage.getItem('allesbau_auth_user');
  if (savedToken && savedUser) {
    try {
      return { token: savedToken, user: JSON.parse(savedUser) };
    } catch (e) {}
  }
  return { token: null, user: null };
}

function saveAuthToken(token, user) {
  authState.token = token;
  authState.user = user;
  if (token) {
    localStorage.setItem('allesbau_auth_token', token);
    localStorage.setItem('allesbau_auth_user', JSON.stringify(user));
  } else {
    localStorage.removeItem('allesbau_auth_token');
    localStorage.removeItem('allesbau_auth_user');
  }
}

function logout() {
  saveAuthToken(null, null);
  showToast('Erfolgreich abgemeldet', 'info');
  renderApp();
}

function loadLocalData() {
  const saved = localStorage.getItem('allesbau_db_cache');
  if (saved) {
    try { return JSON.parse(saved); } catch (e) {}
  }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveLocalData() {
  localStorage.setItem('allesbau_db_cache', JSON.stringify(appData));
}

// -------------------------------------------------------------
// API REQUEST HELPER (With automatic local database fallback)
// -------------------------------------------------------------

async function apiRequest(endpoint, method = 'GET', body = null) {
  const baseUrl = getApiBaseUrl();

  if (baseUrl) {
    const headers = { 'Content-Type': 'application/json' };
    if (authState.token && !authState.token.startsWith('local_')) {
      headers['Authorization'] = `Bearer ${authState.token}`;
    }

    try {
      const res = await fetch(`${baseUrl}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null
      });

      const contentType = res.headers.get('content-type') || '';
      let data = null;
      if (contentType.includes('application/json')) {
        try {
          data = await res.json();
        } catch (jsonErr) {
          data = { error: 'Ungültiges Datenformat vom Server' };
        }
      } else {
        const text = await res.text();
        if (!res.ok) {
          throw new Error(res.status === 404 ? 'Endpunkt nicht gefunden (404)' : `Serverfehler (${res.status})`);
        }
        data = { message: text };
      }

      if (!res.ok) {
        if (res.status === 401) {
          logout();
        }
        throw new Error(data?.error || data?.message || 'Serverfehler');
      }
      appState.isOnline = true;
      return data;
    } catch (err) {
      if (err.message && !err.message.includes('Failed to fetch') && !err.message.includes('NetworkError') && !err.message.includes('Load failed')) {
        throw err;
      }
      console.warn(`Cloud backend at ${baseUrl} unreachable, falling back to local browser database.`);
      appState.isOnline = false;
    }
  }

  // Local Browser Database Fallback
  return handleLocalApi(endpoint, method, body);
}

// -------------------------------------------------------------
// LIVE MULTI-DEVICE SYNC ENGINE
// -------------------------------------------------------------

let syncInterval = null;

async function syncDataWithServer() {
  if (!authState.token || appState.isSyncing) return;
  appState.isSyncing = true;

  try {
    const data = await apiRequest('/api/sync');
    if (data && data.workers) {
      appData.workers = data.workers;
      appData.shifts = data.shifts || [];
      appData.payments = data.payments || [];
      appData.timers = data.timers || {};
      saveLocalData();
      
      // Update DOM timer tick readout silently
      updateTimerDisplays();
      renderAppSilently();
    }
  } catch (err) {
    // Offline mode fallback
  } finally {
    appState.isSyncing = false;
  }
}

function syncOnAppOpen() {
  syncDataWithServer();
}

// -------------------------------------------------------------
// FORMATTERS & CALCULATIONS
// -------------------------------------------------------------

const GERMAN_WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const GERMAN_WEEKDAYS_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function formatCurrency(amount) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount || 0);
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCurrentMonthString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatElapsedSeconds(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getWorker(id) {
  return appData.workers.find(w => w.id === id);
}

function getWorkerElapsedSeconds(workerId) {
  const timer = appData.timers[workerId];
  if (!timer) return 0;
  let elapsed = timer.pausedAccumulated || 0;
  if (timer.status === 'running' && timer.startTime) {
    elapsed += Math.floor((Date.now() - timer.startTime) / 1000);
  }
  return elapsed;
}

function calculateWorkerFinancials(workerId) {
  const approvedShifts = appData.shifts.filter(s => (s.workerId === workerId || s.worker_id === workerId) && s.status === 'approved');
  const worker = getWorker(workerId);
  const user = authState.user;
  const isSupervisor = user?.role === 'supervisor';

  const workerRate = worker ? (parseFloat(worker.hourly_rate ?? worker.rate) || 0) : 0;
  const billingRate = worker ? (parseFloat(worker.billing_rate ?? workerRate) || workerRate) : 0;
  const cutRate = Math.max(0, billingRate - workerRate);

  const totalHours = approvedShifts.reduce((sum, s) => sum + (parseFloat(s.totalHours ?? s.total_hours) || 0), 0);

  const workerEarned = totalHours * workerRate;
  const supervisorCost = totalHours * billingRate;
  const leaderCut = totalHours * cutRate;

  const approvedPayments = appData.payments.filter(p => (p.workerId === workerId || p.worker_id === workerId) && p.status === 'approved');
  const totalPaid = approvedPayments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

  const totalEarned = isSupervisor ? supervisorCost : workerEarned;

  return {
    totalHours,
    workerRate,
    billingRate,
    cutRate,
    workerEarned,
    supervisorCost,
    leaderCut,
    totalEarned,
    totalPaid,
    balance: totalEarned - totalPaid,
    workerBalance: workerEarned - totalPaid,
    supervisorBalance: supervisorCost - totalPaid
  };
}

function calculateGlobalFinancials(workerIdFilter = 'all') {
  let targetWorkers = appData.workers.filter(w => w.active && w.role === 'worker');
  if (workerIdFilter !== 'all') {
    targetWorkers = appData.workers.filter(w => w.id === workerIdFilter);
  }

  let totalHours = 0;
  let totalWorkerEarned = 0;
  let totalSupervisorCost = 0;
  let totalLeaderCut = 0;
  let totalEarned = 0;
  let totalPaid = 0;

  targetWorkers.forEach(w => {
    const fin = calculateWorkerFinancials(w.id);
    totalHours += fin.totalHours;
    totalWorkerEarned += fin.workerEarned;
    totalSupervisorCost += fin.supervisorCost;
    totalLeaderCut += fin.leaderCut;
    totalEarned += fin.totalEarned;
    totalPaid += fin.totalPaid;
  });

  return {
    totalHours,
    totalWorkerEarned,
    totalSupervisorCost,
    totalLeaderCut,
    totalEarned,
    totalPaid,
    workerBalance: totalWorkerEarned - totalPaid,
    supervisorBalance: totalSupervisorCost - totalPaid,
    balance: totalEarned - totalPaid
  };
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bg = type === 'error' ? 'bg-red-600' : type === 'info' ? 'bg-blue-600' : 'bg-emerald-600';
  
  toast.className = `${bg} text-white px-4 py-3 rounded-xl shadow-lg font-medium text-sm flex items-center gap-2 animate-toast pointer-events-auto`;
  toast.innerHTML = `<span>${type === 'error' ? '⚠️' : type === 'info' ? 'ℹ️' : '✅'}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function updateTimerDisplays() {
  const timerElements = document.querySelectorAll('[data-live-timer]');
  timerElements.forEach(el => {
    const workerId = el.getAttribute('data-live-timer');
    const elapsed = getWorkerElapsedSeconds(workerId);
    el.textContent = formatElapsedSeconds(elapsed);
  });
}

// -------------------------------------------------------------
// AUTHENTICATION EVENT HANDLERS
// -------------------------------------------------------------

async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const username = form.username.value;
  const password = form.password.value;

  try {
    const data = await apiRequest('/api/auth/login', 'POST', { username, password });
    saveAuthToken(data.token, data.user);
    showToast(`Welcome back, ${data.user.name}!`);
    syncOnAppOpen();
    renderApp();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleRegisterLeader(e) {
  e.preventDefault();
  const form = e.target;
  const company_name = form.company_name.value;
  const leader_name = form.leader_name.value;
  const username = form.username.value;
  const password = form.password.value;

  try {
    const data = await apiRequest('/api/auth/register-leader', 'POST', {
      company_name,
      leader_name,
      username,
      password
    });
    saveAuthToken(data.token, data.user);
    showToast(`Crew "${company_name}" created!`);
    syncOnAppOpen();
    renderApp();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const form = e.target;
  const current_password = form.current_password.value;
  const new_password = form.new_password.value;

  try {
    await apiRequest('/api/auth/change-password', 'POST', { current_password, new_password });
    closeModal();
    showToast('Password updated successfully!');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -------------------------------------------------------------
// USER MANAGEMENT HANDLERS (LEADER ONLY)
// -------------------------------------------------------------

async function handleAddUser(e) {
  e.preventDefault();
  const form = e.target;
  const roleType = form.userRole.value; // 'supervisor' | 'worker'
  const name = form.name.value;
  const username = form.username.value;
  const password = form.password.value;

  try {
    if (roleType === 'supervisor') {
      await apiRequest('/api/users/add-supervisor', 'POST', { name, username, password });
      showToast(`Supervisor ${name} hinzugefügt!`);
    } else {
      const hourly_rate = parseFloat(form.hourly_rate?.value) || 20.0;
      const billing_rate = parseFloat(form.billing_rate?.value) || hourly_rate;
      const phone = form.phone?.value || '';
      await apiRequest('/api/users/add-worker', 'POST', { name, hourly_rate, billing_rate, phone, username, password });
      const cut = billing_rate - hourly_rate;
      showToast(`Arbeiter ${name} registriert (Cut: ${cut >= 0 ? '+' : ''}${formatCurrency(cut)}/Std.)!`);
    }
    closeModal();
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleUpdateWorkerRates(e, workerId) {
  e.preventDefault();
  const form = e.target;
  const hourly_rate = parseFloat(form.hourly_rate?.value);
  const billing_rate = parseFloat(form.billing_rate?.value);
  const name = form.name?.value?.trim();
  const phone = form.phone?.value?.trim();

  if (isNaN(hourly_rate) || isNaN(billing_rate)) {
    showToast('Bitte gültige Raten eingeben', 'error');
    return;
  }

  try {
    await apiRequest(`/api/users/${workerId}/rates`, 'POST', {
      hourly_rate,
      billing_rate,
      name,
      phone
    });
    const cut = billing_rate - hourly_rate;
    showToast(`Raten gespeichert! Dein Cut: ${cut >= 0 ? '+' : ''}${formatCurrency(cut)}/Std.`);
    closeModal();
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function updateAddUserCutPreview() {
  const bInput = document.getElementById('addUserBillingRate');
  const hInput = document.getElementById('addUserHourlyRate');
  const preview = document.getElementById('addUserCutPreview');
  if (!bInput || !hInput || !preview) return;

  const b = parseFloat(bInput.value) || 0;
  const h = parseFloat(hInput.value) || 0;
  const cut = b - h;

  preview.innerHTML = `
    <span class="text-slate-300 font-semibold">💰 Dein Leader-Anteil (Cut):</span>
    <span class="font-extrabold ${cut >= 0 ? 'text-[#F5C000]' : 'text-red-400'} text-sm">${cut >= 0 ? '+' : ''}${formatCurrency(cut)} / Std.</span>
  `;
}

function updateEditCutPreview() {
  const bInput = document.getElementById('editBillingRate');
  const hInput = document.getElementById('editHourlyRate');
  const val = document.getElementById('editCutValue');
  if (!bInput || !hInput || !val) return;

  const b = parseFloat(bInput.value) || 0;
  const h = parseFloat(hInput.value) || 0;
  const cut = b - h;

  val.className = `font-black text-sm ${cut >= 0 ? 'text-[#F5C000]' : 'text-red-400'}`;
  val.textContent = `${cut >= 0 ? '+' : ''}${formatCurrency(cut)}/h`;
}

// -------------------------------------------------------------
// SHIFT & TIMER ACTIONS
// -------------------------------------------------------------

async function handleStartTimer(workerId) {
  try {
    await apiRequest('/api/timers/start', 'POST', { worker_id: workerId });
    showToast('Timer live gestartet! ⏱️');
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handlePauseTimer(workerId) {
  try {
    await apiRequest('/api/timers/pause', 'POST', { worker_id: workerId });
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function handleStopTimerPrompt(workerId) {
  const elapsed = getWorkerElapsedSeconds(workerId);
  const worker = getWorker(workerId);
  if (!worker) return;

  const now = new Date();
  const rawStartDate = new Date(now.getTime() - elapsed * 1000);
  const rawStartTime = `${String(rawStartDate.getHours()).padStart(2, '0')}:${String(rawStartDate.getMinutes()).padStart(2, '0')}`;
  const rawEndTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const startTime = roundTimeTo30Minutes(rawStartTime);
  const endTime = roundTimeTo30Minutes(rawEndTime);
  const breakMinutes = 0;
  let calculatedHours = calculateShiftHours(startTime, endTime, breakMinutes);
  if (calculatedHours <= 0) {
    calculatedHours = 0.5; // Minimum 30 mins
  }

  appState.modalPayload = {
    workerId,
    workerName: worker.name,
    elapsedSeconds: elapsed,
    rawStartTime,
    rawEndTime,
    startTime,
    endTime,
    roundTime: true,
    breakMinutes,
    calculatedHours,
    date: getTodayString(),
    note: 'Schicht über Live-Timer erfasst',
    media: []
  };
  appState.activeModal = 'stopTimerConfirm';
  renderApp();
}

function toggleStopTimerRounding(forceVal = null) {
  const p = appState.modalPayload;
  if (!p) return;
  p.roundTime = forceVal !== null ? Boolean(forceVal) : !p.roundTime;
  if (p.roundTime) {
    p.startTime = roundTimeTo30Minutes(p.rawStartTime);
    p.endTime = roundTimeTo30Minutes(p.rawEndTime);
  } else {
    p.startTime = p.rawStartTime;
    p.endTime = p.rawEndTime;
  }
  const breakMins = parseInt(p.breakMinutes) || 0;
  p.calculatedHours = calculateShiftHours(p.startTime, p.endTime, breakMins);
  renderApp();
}

function updateStopTimerHours() {
  const p = appState.modalPayload;
  if (!p) return;
  const breakMins = parseInt(p.breakMinutes) || 0;
  p.calculatedHours = calculateShiftHours(p.startTime, p.endTime, breakMins);
  const input = document.getElementById('stopTimerHoursInput');
  if (input) input.value = p.calculatedHours;
}

async function handleConfirmStopTimer() {
  if (appState.isSubmitting) return;
  const p = appState.modalPayload;
  if (!p) return;

  const startTimeStr = p.startTime;
  const endTimeStr = p.endTime;
  const breakMins = parseInt(p.breakMinutes) || 0;
  const totalHours = parseFloat(p.calculatedHours) || calculateShiftHours(startTimeStr, endTimeStr, breakMins);

  // Double entry prevention
  const isDup = (appData.shifts || []).some(s => 
    (s.workerId === p.workerId || s.worker_id === p.workerId) &&
    s.date === p.date &&
    (s.startTime || s.start_time) === startTimeStr &&
    (s.endTime || s.end_time) === endTimeStr
  );
  if (isDup) {
    showToast(t('dup_shift_warning', 'Für diesen Mitarbeiter existiert bereits eine Schicht zu dieser Zeit!'), 'error');
    return;
  }

  const submitBtn = document.getElementById('stopTimerSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('saving', 'Wird gespeichert...');
  }
  appState.isSubmitting = true;

  try {
    await apiRequest('/api/timers/stop', 'POST', {
      worker_id: p.workerId,
      date: p.date,
      start_time: startTimeStr,
      end_time: endTimeStr,
      round_time: p.roundTime,
      break_minutes: breakMins,
      total_hours: totalHours,
      note: p.note,
      media: p.media || []
    });
    closeModal();
    showToast(`Schicht erfasst: ${p.workerName} (${startTimeStr} - ${endTimeStr}, ${totalHours} Std.)`);
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    appState.isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('stop_and_submit', 'Schicht abschließen & senden');
    }
  }
}

async function handleSaveManualShift(e) {
  e.preventDefault();
  if (appState.isSubmitting) return;

  const form = e.target;
  let workerIds = [];
  const checkedBoxes = form.querySelectorAll('input[name="workerId"]:checked');
  if (checkedBoxes.length > 0) {
    workerIds = Array.from(checkedBoxes).map(cb => cb.value);
  } else if (form.workerId && form.workerId.value) {
    workerIds = [form.workerId.value];
  }

  if (workerIds.length === 0) {
    showToast('Bitte mindestens einen Mitarbeiter auswählen', 'error');
    return;
  }

  const date = form.date.value;
  const roundTime = form.roundTimeToggle ? form.roundTimeToggle.checked : true;
  let startTime = form.startTime.value;
  let endTime = form.endTime.value;
  if (roundTime) {
    startTime = roundTimeTo30Minutes(startTime);
    endTime = roundTimeTo30Minutes(endTime);
  }
  const breakMinutes = parseInt(form.breakMinutes.value) || 0;
  const note = form.note.value;
  const totalHours = calculateShiftHours(startTime, endTime, breakMinutes);

  // Double entry check across workers
  const duplicateWorkerNames = [];
  workerIds.forEach(wid => {
    const existing = (appData.shifts || []).find(s => 
      (s.workerId === wid || s.worker_id === wid) &&
      s.date === date &&
      (s.startTime || s.start_time) === startTime &&
      (s.endTime || s.end_time) === endTime
    );
    if (existing) {
      const w = getWorker(wid);
      duplicateWorkerNames.push(w ? w.name : wid);
    }
  });

  if (duplicateWorkerNames.length > 0) {
    showToast(`Doppelte Schicht: Für ${duplicateWorkerNames.join(', ')} existiert bereits eine Schicht um diese Zeit!`, 'error');
    return;
  }

  const submitBtn = document.getElementById('manualShiftSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('saving', 'Wird gespeichert...');
  }
  appState.isSubmitting = true;

  try {
    await apiRequest('/api/shifts/manual', 'POST', {
      worker_ids: workerIds,
      worker_id: workerIds[0],
      date,
      start_time: startTime,
      end_time: endTime,
      round_time: roundTime,
      break_minutes: breakMinutes,
      total_hours: totalHours,
      note,
      media: appState.manualShiftMedia || []
    });
    appState.manualShiftMedia = [];
    closeModal();
    const countText = workerIds.length > 1 ? `für ${workerIds.length} Mitarbeiter` : '';
    showToast(`Schicht ${countText} erfasst: ${startTime} - ${endTime} (${totalHours.toFixed(1)} Std.)`);
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    appState.isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('save_shift', 'Schicht erfassen');
    }
  }
}

function openEditShiftModal(shiftId) {
  const shift = (appData.shifts || []).find(s => s.id === shiftId) || (getLocalDb().shifts || []).find(s => s.id === shiftId);
  if (!shift) {
    showToast('Schicht nicht gefunden', 'error');
    return;
  }
  let mediaArr = [];
  if (Array.isArray(shift.media)) {
    mediaArr = [...shift.media];
  } else if (typeof shift.media === 'string' && shift.media.trim()) {
    try { mediaArr = JSON.parse(shift.media) || []; } catch(e) { mediaArr = [shift.media]; }
  }

  const wid = shift.workerId || shift.worker_id;
  const startTime = shift.startTime || shift.start_time || '08:00';
  const endTime = shift.endTime || shift.end_time || '17:00';
  const breakMinutes = shift.breakMinutes ?? shift.break_minutes ?? 0;
  const totalHours = shift.totalHours ?? shift.total_hours ?? calculateShiftHours(startTime, endTime, breakMinutes);

  appState.modalPayload = {
    id: shift.id,
    workerId: wid,
    date: shift.date,
    startTime: startTime,
    endTime: endTime,
    breakMinutes: breakMinutes,
    totalHours: totalHours,
    note: shift.note || '',
    status: shift.status || 'pending',
    media: mediaArr,
    roundTime: false
  };
  appState.activeModal = 'editShift';
  renderApp();
}

async function handleSaveEditedShift(e) {
  e.preventDefault();
  if (appState.isSubmitting) return;
  const p = appState.modalPayload;
  if (!p) return;

  const form = e.target;
  const workerId = form.workerId.value;
  const date = form.date.value;
  const startTime = form.startTime.value;
  const endTime = form.endTime.value;
  const breakMinutes = parseInt(form.breakMinutes.value) || 0;
  const note = form.note.value;
  const status = form.status.value;
  const totalHours = calculateShiftHours(startTime, endTime, breakMinutes);

  const submitBtn = document.getElementById('editShiftSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('saving', 'Wird gespeichert...');
  }
  appState.isSubmitting = true;

  try {
    await apiRequest(`/api/shifts/${p.id}`, 'PUT', {
      worker_id: workerId,
      date,
      start_time: startTime,
      end_time: endTime,
      break_minutes: breakMinutes,
      total_hours: totalHours,
      note,
      status,
      media: p.media || []
    });
    closeModal();
    showToast(t('shift_saved', 'Schicht erfolgreich aktualisiert! ✅'));
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    appState.isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('save_changes', 'Speichern');
    }
  }
}

async function handleDeleteShift(shiftId) {
  if (authState.user?.role !== 'leader') {
    showToast('Nur der Leiter kann Schichten löschen', 'error');
    return;
  }
  const shift = (appData.shifts || []).find(s => s.id === shiftId);
  const w = shift ? getWorker(shift.workerId || shift.worker_id) : null;
  const workerName = w ? w.name : 'Mitarbeiter';
  const dateStr = shift ? shift.date : '';

  if (!confirm(`${t('confirm_delete_shift', 'Möchten Sie diese Schicht wirklich unwiderruflich löschen?')}\n(${workerName}, ${dateStr})`)) {
    return;
  }

  try {
    await apiRequest(`/api/shifts/${shiftId}`, 'DELETE');
    showToast(t('shift_deleted', 'Schicht erfolgreich gelöscht! 🗑️'));
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleApproveShift(shiftId) {
  try {
    await apiRequest(`/api/shifts/${shiftId}/status`, 'PUT', { status: 'approved' });
    showToast('Schicht genehmigt! 🟢');
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleRejectShift(shiftId) {
  try {
    await apiRequest(`/api/shifts/${shiftId}/status`, 'PUT', { status: 'rejected' });
    showToast('Schicht abgelehnt 🔴', 'error');
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleApproveAllShifts() {
  try {
    await apiRequest('/api/shifts/approve-all', 'POST');
    showToast('Alle ausstehenden Schichten genehmigt! 🟢');
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleSavePayment(e) {
  e.preventDefault();
  if (appState.isSubmitting) return;

  const form = e.target;
  const workerId = form.workerId.value;
  const amount = parseFloat(form.amount.value);
  const receivedBy = form.receivedBy.value;
  const date = form.date.value;
  const comment = form.comment.value;
  const markApproved = form.markApproved ? form.markApproved.checked : (authState.user?.role === 'leader');
  const status = markApproved ? 'approved' : 'pending';

  if (isNaN(amount) || amount <= 0) {
    showToast('Bitte einen Betrag größer als 0 eingeben', 'error');
    return;
  }

  // Duplicate pending payment check
  const isDup = (appData.payments || []).some(p => 
    (p.workerId === workerId || p.worker_id === workerId) &&
    p.date === date &&
    parseFloat(p.amount) === amount &&
    p.status === 'pending'
  );
  if (isDup) {
    showToast(t('dup_payment_warning', 'Eine identische ausstehende Zahlung existiert bereits für diesen Tag!'), 'error');
    return;
  }

  const submitBtn = document.getElementById('savePaymentSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('saving', 'Wird gespeichert...');
  }
  appState.isSubmitting = true;

  try {
    await apiRequest('/api/payments', 'POST', {
      worker_id: workerId,
      amount,
      date,
      received_by: receivedBy,
      comment,
      status
    });
    closeModal();
    showToast(status === 'approved' ? 'Zahlung gebucht und direkt verrechnet! 💵' : 'Zahlung erfasst! (Ausstehend)');
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    appState.isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = t('record_payment', 'Zahlung buchen');
    }
  }
}

async function handleApprovePayment(paymentId) {
  try {
    await apiRequest(`/api/payments/${paymentId}/status`, 'PUT', { status: 'approved' });
    showToast('Zahlung genehmigt! Restbetrag aktualisiert. 💵');
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleRejectPayment(paymentId) {
  try {
    await apiRequest(`/api/payments/${paymentId}/status`, 'PUT', { status: 'rejected' });
    showToast('Zahlung abgelehnt 🔴', 'error');
    syncDataWithServer();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function toggleCalendarDay(dateStr) {
  const current = appState.expandedCalendarDays[dateStr] ?? false;
  appState.expandedCalendarDays[dateStr] = !current;
  renderApp();
}

function toggleAllCalendarDays(expand = true) {
  const monthShifts = (appData.shifts || []).filter(s => s.date && s.date.startsWith(appState.selectedMonth));
  monthShifts.forEach(s => {
    appState.expandedCalendarDays[s.date] = expand;
  });
  renderApp();
}

function openMediaViewer(images, title = 'Fotos') {
  let list = [];
  if (Array.isArray(images)) list = images;
  else if (typeof images === 'string' && images.trim()) {
    try { list = JSON.parse(images) || []; } catch(e) { list = [images]; }
  }
  if (!list || list.length === 0) {
    showToast('Keine Fotos vorhanden', 'info');
    return;
  }
  appState.modalPayload = {
    images: list,
    title: title,
    activeIndex: 0
  };
  appState.activeModal = 'mediaViewer';
  renderApp();
}

function openShiftMediaViewer(shiftId) {
  const shift = (appData.shifts || []).find(s => s.id === shiftId);
  if (!shift || !shift.media) {
    showToast('Keine Fotos vorhanden', 'info');
    return;
  }
  const w = getWorker(shift.workerId || shift.worker_id);
  openMediaViewer(shift.media, `Fotos: ${w ? w.name : 'Mitarbeiter'} (${formatDate(shift.date)})`);
}

function openDateMediaViewer(dateStr) {
  const dayShifts = (appData.shifts || []).filter(s => s.date === dateStr);
  const allImages = [];
  dayShifts.forEach(s => {
    if (s.media) {
      if (Array.isArray(s.media)) allImages.push(...s.media);
      else if (typeof s.media === 'string') {
        try {
          const parsed = JSON.parse(s.media);
          if (Array.isArray(parsed)) allImages.push(...parsed);
          else allImages.push(s.media);
        } catch(e) {
          allImages.push(s.media);
        }
      }
    }
  });
  if (allImages.length === 0) {
    showToast('Keine Fotos für diesen Tag vorhanden', 'info');
    return;
  }
  openMediaViewer(allImages, `Fotos vom ${formatDate(dateStr)}`);
}

function downloadPaymentInvoicePdf(paymentId) {
  const p = (appData.payments || []).find(x => x.id === paymentId) || (getLocalDb().payments || []).find(x => x.id === paymentId);
  if (!p) {
    showToast('Zahlung nicht gefunden', 'error');
    return;
  }
  const wid = p.workerId || p.worker_id;
  const worker = getWorker(wid) || (getLocalDb().users || []).find(u => u.id === wid) || { name: p.receivedBy || 'Mitarbeiter', id: wid, role: 'worker' };

  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF-Modul wird geladen... Bitte kurz warten.', 'error');
    return;
  }

  showToast(`Erstelle Zahlungsbeleg für ${worker.name}... ⏳`, 'info');

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const brandYellow = [245, 192, 0];
  const darkGray = [26, 26, 26];

  // Header Banner
  doc.setFillColor(...brandYellow);
  doc.rect(0, 0, 210, 26, 'F');

  doc.setTextColor(17, 17, 17);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('allesBau', 14, 15);

  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  doc.text('Arbeitsstunden & Lohnverwaltung • Bauunternehmen', 14, 21);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('ZAHLUNGSBELEG & LOHNQUITTUNG', 210 - 14, 15, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Beleg-Nr: AB-PAY-${(p.id || '').replace('p_', '').toUpperCase()}`, 210 - 14, 21, { align: 'right' });

  // Metadata Section
  doc.setTextColor(30, 30, 30);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('EMPFÄNGER (ARBEITNEHMER):', 14, 38);
  doc.setFont('helvetica', 'normal');
  doc.text(`Name: ${worker.name}`, 14, 44);
  doc.text(`Mitarbeiter-ID: ${worker.id || '-'}`, 14, 50);
  doc.text(`Rolle: ${worker.role === 'supervisor' ? 'Vorarbeiter' : 'Bauarbeiter'}`, 14, 56);

  doc.setFont('helvetica', 'bold');
  doc.text('ZAHLUNGSDETAILS:', 120, 38);
  doc.setFont('helvetica', 'normal');
  doc.text(`Zahlungsdatum: ${formatDate(p.date)}`, 120, 44);
  doc.text(`Ausgezahlt durch: ${p.loggedBy || 'AllesBau Leitung'}`, 120, 50);
  doc.text(`Status: ${p.status === 'approved' ? 'GENEHMIGT / AUSGEZAHLT' : 'AUSSTEHEND'}`, 120, 56);

  // Table
  doc.autoTable({
    startY: 64,
    theme: 'grid',
    head: [['Pos.', 'Beschreibung / Verwendungszweck', 'Empfänger bestätigt', 'Auszahlungsbetrag']],
    body: [
      [
        '1',
        p.comment ? `Lohnabschlag / Auszahlung: ${p.comment}` : 'Reguläre Abschlagszahlung für geleistete Bauarbeiten',
        p.receivedBy || worker.name,
        formatCurrency(p.amount)
      ]
    ],
    foot: [
      ['', 'GESAMTAUSZAHLUNGSBETRAG (NETTO)', '', formatCurrency(p.amount)]
    ],
    headStyles: {
      fillColor: darkGray,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 9
    },
    footStyles: {
      fillColor: brandYellow,
      textColor: [17, 17, 17],
      fontStyle: 'bold',
      fontSize: 10
    },
    styles: {
      font: 'helvetica',
      fontSize: 9,
      cellPadding: 4
    },
    columnStyles: {
      0: { cellWidth: 15, halign: 'center' },
      1: { cellWidth: 95 },
      2: { cellWidth: 45 },
      3: { cellWidth: 35, halign: 'right', fontStyle: 'bold' }
    }
  });

  const finalY = doc.lastAutoTable.finalY + 12;

  // Legal Confirmation Notice
  doc.setFillColor(248, 248, 248);
  doc.rect(14, finalY, 182, 22, 'F');
  doc.setDrawColor(220, 220, 220);
  doc.rect(14, finalY, 182, 22, 'S');

  doc.setFontSize(8.5);
  doc.setTextColor(80, 80, 80);
  doc.setFont('helvetica', 'italic');
  doc.text(
    'Hiermit wird bestätigt, dass der oben genannte Auszahlungsbetrag ordnungsgemäß ausgezahlt und vom Empfänger\n' +
    'in voller Höhe dankend bar oder per Banküberweisung erhalten wurde. Der Betrag wird mit dem Lohnanspruch verrechnet.',
    18,
    finalY + 7
  );

  // Signatures
  const sigY = finalY + 36;
  doc.setDrawColor(120, 120, 120);

  // Left: Employer
  doc.line(18, sigY + 15, 90, sigY + 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(60, 60, 60);
  doc.text('Ort, Datum', 18, sigY + 20);
  doc.setFont('helvetica', 'bold');
  doc.text('AllesBau (Arbeitgeber)', 18, sigY + 25);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text('Unterschrift zur Auszahlung', 18, sigY + 30);

  // Right: Employee
  doc.line(125, sigY + 15, 197, sigY + 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(60, 60, 60);
  doc.text('Ort, Datum', 125, sigY + 20);
  doc.setFont('helvetica', 'bold');
  doc.text(`${worker.name} (Empfänger / Arbeitnehmer)`, 125, sigY + 25);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text('Unterschrift zum Empfang', 125, sigY + 30);

  // Footer
  doc.setFontSize(7.5);
  doc.setTextColor(150, 150, 150);
  doc.setFont('helvetica', 'normal');
  doc.text(`AllesBau Bauunternehmen • Erstellt am ${new Date().toLocaleDateString('de-DE')} • Beleg #${p.id}`, 105, 285, { align: 'center' });

  doc.save(`AllesBau_Zahlungsbeleg_${worker.name.replace(/\s+/g, '_')}_${p.date}.pdf`);
  showToast('Zahlungsbeleg als PDF heruntergeladen! 📄');
}

function openModal(modalName, payload = null) {
  appState.activeModal = modalName;
  appState.modalPayload = payload;
  renderApp();
}

function closeModal() {
  appState.activeModal = null;
  appState.modalPayload = null;
  renderApp();
}

function switchTab(tabName) {
  appState.activeTab = tabName;
  renderApp();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// -------------------------------------------------------------
// AUTHENTICATION SCREEN RENDERER
// -------------------------------------------------------------

function renderAuthScreen() {
  const isLogin = appState.authTab === 'login';
  const customUrl = localStorage.getItem('allesbau_backend_url') || '';

  return `
    <div class="min-h-screen bg-[#0d0d0d] flex items-center justify-center p-4">
      <div class="w-full max-w-md bg-[#111111] border border-[#2a2a2a] rounded-3xl p-6 shadow-2xl space-y-5">
        
        <!-- App Title & Real AllesBau Logo -->
        <div class="text-center space-y-2">
          <div class="w-28 h-28 mx-auto rounded-3xl overflow-hidden bg-black border border-[#F5C000]/40 flex items-center justify-center shadow-xl shadow-[#F5C000]/15 p-1.5">
            <img src="./logo.png" alt="AllesBau Logo" class="w-full h-full object-contain">
          </div>
          <div>
            <h1 class="text-2xl font-black tracking-tight text-white">alles<span class="text-[#F5C000]">Bau</span></h1>
            <p class="text-[11px] text-[#aaa] font-bold tracking-widest uppercase">Bauunternehmen • Alles aus einer Hand!</p>
          </div>
          
          <!-- Mode Indicator -->
          <div class="pt-1">
            <span class="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full text-[11px] font-semibold ${getApiBaseUrl() ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/50' : 'bg-[#1a1a1a] text-[#888] border border-[#2a2a2a]'}">
              <span class="w-1.5 h-1.5 rounded-full ${getApiBaseUrl() ? 'bg-emerald-400' : 'bg-[#F5C000]'}"></span>
              ${getApiBaseUrl() ? 'Cloud verbunden' : 'Lokale Datenbank'}
            </span>
          </div>
        </div>

        <!-- Auth Tabs Switcher -->
        <div class="grid grid-cols-2 p-1 bg-[#1a1a1a] rounded-2xl border border-[#2a2a2a]">
          <button onclick="appState.authTab='login'; renderApp();" 
            class="py-2 text-xs font-bold rounded-xl transition ${isLogin ? 'bg-[#F5C000] text-black shadow-md' : 'text-[#666] hover:text-white'}">
            Login
          </button>
          <button onclick="appState.authTab='register'; renderApp();" 
            class="py-2 text-xs font-bold rounded-xl transition ${!isLogin ? 'bg-[#F5C000] text-black shadow-md' : 'text-[#666] hover:text-white'}">
            Registrieren
          </button>
        </div>

        <!-- Sign In Form -->
        ${isLogin ? `
          <form onsubmit="handleLogin(event)" class="space-y-3.5">
            <div>
              <label class="text-xs font-semibold text-[#999] block mb-1">Benutzername</label>
              <input type="text" name="username" required placeholder="Benutzername eingeben"
                class="w-full bg-[#1a1a1a] border border-[#2a2a2a] text-white rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#F5C000]/60 transition">
            </div>

            <div>
              <label class="text-xs font-semibold text-[#999] block mb-1">Passwort</label>
              <input type="password" name="password" required placeholder="Passwort eingeben"
                class="w-full bg-[#1a1a1a] border border-[#2a2a2a] text-white rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#F5C000]/60 transition">
            </div>

            <button type="submit" class="w-full bg-[#F5C000] hover:bg-[#ffd333] text-black py-3 rounded-xl font-bold text-sm shadow-lg active-press transition">
              Login
            </button>
          </form>
        ` : `
          <!-- Register Crew Leader Form -->
          <form onsubmit="handleRegisterLeader(event)" class="space-y-3">
            <div>
              <label class="text-xs font-semibold text-[#999] block mb-1">Firma / Team-Name</label>
              <input type="text" name="company_name" required placeholder="z.B. AllesBau GmbH"
                class="w-full bg-[#1a1a1a] border border-[#2a2a2a] text-white rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:border-[#F5C000]/60 transition">
            </div>

            <div>
              <label class="text-xs font-semibold text-[#999] block mb-1">Vorname & Nachname (Leiter)</label>
              <input type="text" name="leader_name" required placeholder="z.B. Max Mustermann"
                class="w-full bg-[#1a1a1a] border border-[#2a2a2a] text-white rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:border-[#F5C000]/60 transition">
            </div>

            <div>
              <label class="text-xs font-semibold text-[#999] block mb-1">Benutzername (Leiter)</label>
              <input type="text" name="username" required placeholder="z.B. max_leiter"
                class="w-full bg-[#1a1a1a] border border-[#2a2a2a] text-white rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:border-[#F5C000]/60 transition">
            </div>

            <div>
              <label class="text-xs font-semibold text-[#999] block mb-1">Passwort</label>
              <input type="password" name="password" required placeholder="Passwort wählen"
                class="w-full bg-[#1a1a1a] border border-[#2a2a2a] text-white rounded-xl px-3.5 py-2 text-sm focus:outline-none focus:border-[#F5C000]/60 transition">
            </div>

            <button type="submit" class="w-full bg-[#F5C000] hover:bg-[#ffd333] text-black py-3 rounded-xl font-bold text-sm shadow-lg active-press transition mt-2">
              Team-Account erstellen
            </button>
          </form>
        `}

        <!-- Server Config Link -->
        <div class="pt-2 border-t border-[#1e1e1e] text-center">
          <button onclick="openModal('serverConfig')" class="text-xs text-[#555] hover:text-[#F5C000] transition inline-flex items-center gap-1.5 font-medium">
            <span>⚙️</span>
            <span>Cloud-Server / Backend URL konfigurieren</span>
          </button>
        </div>
      </div>
    </div>
  `;
}


// -------------------------------------------------------------
// APP HEADER & VIEWS
// -------------------------------------------------------------

function renderHeader() {
  const user = authState.user;
  const isLeader = user?.role === 'leader';
  const isSupervisor = user?.role === 'supervisor';
  const activeCount = Object.values(appData.timers).filter(t => t.status === 'running').length;

  let roleIcon = '🛠️';
  if (isSupervisor) roleIcon = '🛡️';
  else if (user?.role === 'worker') roleIcon = '👷';

  return `
    <header class="bg-[#111111]/95 backdrop-blur-md border-b border-[#222] sticky top-0 z-30 shadow-md safe-top">
      <div class="flex items-center justify-between px-4 py-2.5 max-w-[480px] mx-auto">
        
        <!-- Left: Logo + App Name -->
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="w-10 h-10 rounded-xl overflow-hidden bg-black border border-[#F5C000]/30 flex items-center justify-center flex-shrink-0 p-0.5">
            <img src="./logo.png" alt="AllesBau Logo" class="w-full h-full object-contain">
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-base font-black tracking-tight text-white leading-none">alles<span class="text-[#F5C000]">Bau</span></span>
              <span onclick="openModal('serverConfig')" class="cursor-pointer text-[10px] font-bold px-1.5 py-0.5 rounded-full ${getApiBaseUrl() ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/50' : 'bg-[#1e1e1e] text-[#666] border border-[#2a2a2a]'}" title="Backend konfigurieren">
                ${getApiBaseUrl() ? '🟢' : '💾'}
              </span>
            </div>
            <div class="text-[11px] text-[#888] leading-tight truncate max-w-[130px]">
              ${activeCount > 0 ? `<span class="text-emerald-400 font-semibold flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 live-pulse inline-block"></span>${activeCount} Aktiv</span>` : `<span>${user?.company_name || 'AllesBau'}</span>`}
            </div>
          </div>
        </div>

        <!-- Right: Language + Sync + User -->
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <button onclick="toggleLanguage()" 
            class="px-2.5 py-1.5 rounded-full border border-[#2a2a2a] bg-[#1a1a1a] text-[11px] font-bold text-[#F5C000] hover:text-white hover:border-[#F5C000]/60 transition active-press flex items-center gap-1 shadow-sm"
            title="Sprache wechseln / Switch Language">
            <span>${currentLang === 'de' ? '🇩🇪 DE' : '🇬🇧 EN'}</span>
          </button>
          <button onclick="syncDataWithServer(); showToast('Daten aktualisiert! 🔄', 'info');" 
            title="Synchronisieren" class="p-1.5 rounded-full text-[#555] hover:text-white hover:bg-[#1e1e1e] border border-[#222] transition active-press">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg>
          </button>
          <button onclick="openModal('userProfile')" 
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-full border border-[#2a2a2a] bg-[#1a1a1a] text-xs font-semibold text-[#aaa] hover:text-white hover:border-[#F5C000]/40 transition active-press">
            <span>${roleIcon}</span>
            <span class="max-w-[70px] truncate">${user?.name?.split(' ')[0] || user?.name}</span>
            <svg class="w-3 h-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
          </button>
        </div>
      </div>
    </header>
  `;
}



function renderHome() {
  const user = authState.user;
  const isLeader = user?.role === 'leader';
  const isSupervisor = user?.role === 'supervisor';
  const isWorker = user?.role === 'worker';

  let html = '';

  if (isWorker) {
    const workerTimer = appData.timers[user.id];
    const isRunning = workerTimer && workerTimer.status === 'running';
    const isPaused = workerTimer && workerTimer.status === 'paused';
    const todayShifts = appData.shifts.filter(s => s.workerId === user.id && s.date === getTodayString());
    const fin = calculateWorkerFinancials(user.id);

    return `
      <div class="space-y-4">
        <div class="bg-slate-800/80 border border-slate-700/70 rounded-2xl p-5 shadow-lg">
          <div class="flex items-start justify-between">
            <div>
              <span class="text-xs font-semibold uppercase tracking-wider text-emerald-400">${t('worker_portal', 'Mitarbeiter-Portal')}</span>
              <h2 class="text-2xl font-bold text-white mt-0.5">${user.name}</h2>
              <p class="text-xs text-slate-400 mt-0.5">${t('logged_in_as', 'Angemeldet als:')} <span class="text-slate-200 font-semibold">${user.username}</span></p>
            </div>
            <div class="text-right">
              <span class="text-xs text-slate-400">${t('balance_remaining', 'Offener Lohnanspruch')}</span>
              <div class="text-xl font-bold text-emerald-400 mt-0.5">${formatCurrency(fin.balance)}</div>
            </div>
          </div>

          <div class="mt-4 pt-4 border-t border-slate-700/60 flex items-center justify-between">
            <div>
              <span class="text-xs text-slate-400 block">${t('today_status', 'Heutiger Status')}</span>
              ${isRunning ? `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-900/60 text-emerald-300 border border-emerald-700/50 mt-1">
                  <span class="w-2 h-2 rounded-full bg-emerald-400 live-pulse"></span> ${t('active_now', 'Aktiv (Eingestempelt)')}
                </span>
              ` : isPaused ? `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-900/60 text-amber-300 border border-amber-700/50 mt-1">
                  ⏸️ ${t('on_break', 'In Pause')}
                </span>
              ` : `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-700/60 text-slate-300 mt-1">
                  ⚪ ${t('not_clocked_in', 'Nicht eingestempelt')}
                </span>
              `}
            </div>

            ${(isRunning || isPaused) ? `
              <div class="text-right">
                <span class="text-xs text-slate-400 block">${t('shift_clock', 'Laufende Arbeitszeit')}</span>
                <span class="text-2xl font-mono font-bold text-emerald-400" data-live-timer="${user.id}">
                  ${formatElapsedSeconds(getWorkerElapsedSeconds(user.id))}
                </span>
              </div>
            ` : ''}
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-sm font-semibold text-slate-300 px-1">${t('today_shifts', 'Heutige erfasste Schichten')}</h3>
          ${todayShifts.length === 0 ? `
            <div class="bg-slate-800/40 border border-slate-800 rounded-xl p-6 text-center text-slate-400 text-sm">
              ${t('no_shifts_today', 'Heute noch keine Schichten abgeschlossen.')}
            </div>
          ` : todayShifts.map(s => `
            <div class="bg-slate-800/60 border border-slate-700/60 rounded-xl p-4 flex items-center justify-between">
              <div>
                <div class="text-sm font-semibold text-white">${s.startTime} - ${s.endTime} (${s.totalHours} Std.)</div>
                <div class="text-xs text-slate-400 mt-0.5">${s.note || 'Reguläre Schicht'}</div>
              </div>
              <div>
                ${s.status === 'approved' ? `<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-900/60 text-emerald-300 border border-emerald-700/50">🟢 ${t('status_approved', 'Genehmigt')}</span>`
                : s.status === 'rejected' ? `<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-red-900/60 text-red-300 border border-red-700/50">🔴 ${t('status_rejected', 'Abgelehnt')}</span>`
                : `<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-900/60 text-amber-300 border border-amber-700/50">🟡 ${t('status_pending', 'Ausstehend')}</span>`}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  const activeWorkers = appData.workers.filter(w => w.active && w.role === 'worker');
  const activeRunningCount = Object.values(appData.timers).filter(t => t.status === 'running').length;

  return `
    <div class="space-y-3">
      <div class="flex items-center justify-between px-1">
        <div class="flex items-center gap-2">
          <h2 class="text-xs font-bold tracking-wider uppercase text-slate-400">${t('crew_workers', 'Mitarbeiter-Team')} (${activeWorkers.length})</h2>
          ${activeRunningCount > 0 ? `
            <span class="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 rounded-full">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 live-pulse"></span>
              ${activeRunningCount} ${t('active_workers_count', 'aktiv')}
            </span>
          ` : ''}
        </div>
        ${isSupervisor ? `
          <span class="text-xs text-purple-400 font-semibold bg-purple-900/30 px-2.5 py-0.5 rounded-full border border-purple-800/50">${t('supervisor_view', 'Supervisor-Ansicht')}</span>
        ` : ''}
      </div>

      <div class="space-y-2">
        ${activeWorkers.length === 0 ? `
          <div class="bg-slate-800/40 border border-slate-800 rounded-2xl p-8 text-center text-slate-400">
            <p>Noch keine Mitarbeiter im Team angelegt.</p>
            ${isLeader ? `<button onclick="openModal('addUser')" class="mt-3 text-xs bg-[#F5C000] text-black px-4 py-2 rounded-xl font-bold shadow-md">+ Ersten Mitarbeiter anlegen</button>` : ''}
          </div>
        ` : activeWorkers.map(w => {
          const timer = appData.timers[w.id];
          const isRunning = timer && timer.status === 'running';
          const isPaused = timer && timer.status === 'paused';
          const elapsed = getWorkerElapsedSeconds(w.id);

          return `
            <div class="bg-slate-800/70 hover:bg-slate-800 border ${isRunning ? 'border-emerald-500/60 shadow-md shadow-emerald-950/20' : isPaused ? 'border-amber-500/60' : 'border-slate-700/60'} rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3 transition">
              <div class="flex items-center gap-2.5 min-w-0">
                <span class="w-2.5 h-2.5 rounded-full flex-shrink-0 ${isRunning ? 'bg-emerald-400 live-pulse' : isPaused ? 'bg-amber-400' : 'bg-slate-500'}"></span>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5 truncate">
                    <span class="text-sm font-bold text-white truncate">${w.name}</span>
                    ${isLeader ? `
                      <button onclick="openModal('editWorkerRates', '${w.id}')" 
                        class="text-slate-400 hover:text-[#F5C000] text-xs p-0.5 rounded transition"
                        title="Raten anpassen">
                        ✏️
                      </button>
                    ` : ''}
                  </div>
                  <div class="text-[11px] text-slate-400 truncate flex items-center gap-1.5">
                    <span class="font-mono text-slate-300">@${w.username}</span>
                    ${isRunning ? `<span class="text-emerald-400 font-semibold">• ${t('running', 'Läuft')}</span>` : isPaused ? `<span class="text-amber-400 font-semibold">• ${t('pause', 'Pause')}</span>` : '<span class="text-slate-500">• Inaktiv</span>'}
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-3 flex-shrink-0">
                <div class="text-right">
                  <div class="text-base sm:text-lg font-mono font-bold tracking-tight ${isRunning ? 'text-emerald-400' : isPaused ? 'text-amber-400' : 'text-slate-500'}" data-live-timer="${w.id}">
                    ${formatElapsedSeconds(elapsed)}
                  </div>
                </div>

                ${isLeader ? `
                  <div class="flex items-center gap-1.5">
                    ${!isRunning && !isPaused ? `
                      <button onclick="handleStartTimer('${w.id}')" 
                        class="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 active-press text-white px-3 py-1.5 rounded-lg text-xs font-bold shadow transition"
                        title="Schicht starten">
                        <span>▶️</span>
                        <span>Start</span>
                      </button>
                    ` : `
                      <button onclick="handlePauseTimer('${w.id}')" 
                        class="flex items-center gap-1 ${isPaused ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-amber-600 hover:bg-amber-500'} active-press text-white px-2.5 py-1.5 rounded-lg text-xs font-semibold transition"
                        title="${isPaused ? 'Fortsetzen' : 'Pause'}">
                        <span>${isPaused ? '▶️' : '⏸️'}</span>
                      </button>
                      <button onclick="handleStopTimerPrompt('${w.id}')" 
                        class="flex items-center gap-1 bg-red-600 hover:bg-red-500 active-press text-white px-2.5 py-1.5 rounded-lg text-xs font-semibold shadow transition"
                        title="Schicht beenden">
                        <span>⏹️</span>
                        <span>Stop</span>
                      </button>
                    `}
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${isLeader ? `
        <!-- Action buttons moved to the bottom -->
        <div class="pt-2 flex items-center gap-2">
          <button onclick="openModal('addUser')" 
            class="flex-1 flex items-center justify-center gap-2 bg-[#1c1c1c] hover:bg-[#262626] border border-[#333] hover:border-[#F5C000]/60 active-press text-white py-3 px-3 rounded-2xl text-xs font-bold shadow-md transition">
            <span class="text-[#F5C000] text-sm">👤+</span>
            <span>${t('add_worker', '+ Mitarbeiter anlegen')}</span>
          </button>
          <button onclick="openModal('manualShift')" 
            class="flex-1 flex items-center justify-center gap-2 bg-[#1c1c1c] hover:bg-[#262626] border border-[#333] hover:border-[#F5C000]/60 active-press text-white py-3 px-3 rounded-2xl text-xs font-bold shadow-md transition">
            <span class="text-[#F5C000] text-sm">⏱️</span>
            <span>${t('manual_entry', '+ Schicht eintragen')}</span>
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

// -------------------------------------------------------------
// MONTHLY REPORT PDF GENERATOR & TABLE CALENDAR
// -------------------------------------------------------------

let _cachedLogoDataUrl = null;
function getLogoDataUrl() {
  if (_cachedLogoDataUrl) return Promise.resolve(_cachedLogoDataUrl);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const maxDim = 320;
        const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        _cachedLogoDataUrl = canvas.toDataURL('image/jpeg', 0.9);
        resolve(_cachedLogoDataUrl);
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = './logo.jpg';
  });
}
// Pre-cache logo in background
getLogoDataUrl().catch(() => {});

function getWeekNumber(d) {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.getTime();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.getTime()) / 604800000);
}

async function downloadMonthlyReportPdf(workerId, targetMonth = null) {
  const monthStr = targetMonth || appState.selectedMonth || getCurrentMonthString();
  let worker = getWorker(workerId);
  if (!worker && authState.user?.id === workerId) {
    worker = authState.user;
  }
  if (!worker) {
    const localDb = getLocalDb();
    worker = (localDb.users || []).find(u => u.id === workerId);
  }

  if (!worker) {
    showToast('Mitarbeiter nicht gefunden', 'error');
    return;
  }

  if (!window.jspdf || !window.jspdf.jsPDF) {
    showToast('PDF-Modul wird geladen... Bitte kurz warten.', 'error');
    return;
  }

  showToast(`Erstelle Monatsbericht für ${worker.name}... ⏳`, 'info');

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4' // 210 x 297 mm
  });

  const [yearStr, mStr] = monthStr.split('-');
  const year = parseInt(yearStr);
  const month = parseInt(mStr);
  const monthFormatted = new Date(year, month - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const totalDays = new Date(year, month, 0).getDate();

  // Fresh shifts: use in-memory appData or fallback to local storage DB
  const localDb = getLocalDb();
  let allShifts = (appData.shifts && appData.shifts.length > 0) ? appData.shifts : (localDb.shifts || []);

  // Filter shifts belonging to this worker and matching the target month (include all non-rejected shifts)
  const workerShifts = allShifts.filter(s => {
    const sWorkerId = s.workerId || s.worker_id;
    if (String(sWorkerId).trim() !== String(worker.id).trim()) return false;
    if (!s.date) return false;
    const parts = s.date.trim().split('-');
    const normMonth = parts.length >= 2 ? `${parts[0]}-${String(parts[1]).padStart(2, '0')}` : '';
    if (normMonth !== monthStr) return false;
    return s.status !== 'rejected';
  });

  // Group shifts by normalized date (YYYY-MM-DD) so multiple shifts per day are preserved
  const shiftsByDate = {};
  workerShifts.forEach(s => {
    const parts = s.date.trim().split('-');
    const normDate = parts.length === 3 ? `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}` : s.date.trim();
    if (!shiftsByDate[normDate]) shiftsByDate[normDate] = [];
    shiftsByDate[normDate].push(s);
  });

  const rows = [];
  let totalWorkedHours = 0;
  let totalApprovedHours = 0;
  let totalPendingHours = 0;
  let totalWorkedDays = 0;
  let weekRunningHours = 0;

  for (let day = 1; day <= totalDays; day++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = dateObj.getDay(); // 0 = So, 1 = Mo ... 6 = Sa
    const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
    const dayName = GERMAN_WEEKDAYS[dayOfWeek];
    const kw = getWeekNumber(dateObj);

    const dayShifts = shiftsByDate[dateStr] || [];
    let start = '-';
    let end = '-';
    let pause = '-';
    let hoursStr = '-';
    let hoursVal = 0;
    let hasApproved = false;
    let hasPending = false;

    if (dayShifts.length > 0) {
      dayShifts.forEach(s => {
        let hrs = parseFloat(s.totalHours ?? s.total_hours ?? 0);
        if (!hrs && (s.startTime || s.start_time) && (s.endTime || s.end_time)) {
          hrs = calculateShiftHours(s.startTime || s.start_time, s.endTime || s.end_time, s.breakMinutes ?? s.break_minutes ?? 0);
        }
        hoursVal += hrs;
        if (s.status === 'approved') {
          totalApprovedHours += hrs;
          hasApproved = true;
        } else {
          totalPendingHours += hrs;
          hasPending = true;
        }
      });

      const totalBreakMins = dayShifts.reduce((acc, s) => acc + (parseInt(s.breakMinutes ?? s.break_minutes ?? 0) || 0), 0);
      pause = totalBreakMins > 0 ? `${totalBreakMins} Min.` : '-';

      if (dayShifts.length === 1) {
        start = dayShifts[0].startTime || dayShifts[0].start_time || '-';
        end = dayShifts[0].endTime || dayShifts[0].end_time || '-';
      } else {
        const starts = dayShifts.map(s => s.startTime || s.start_time).filter(Boolean);
        const ends = dayShifts.map(s => s.endTime || s.end_time).filter(Boolean);
        start = starts.length > 0 ? starts[0] : '-';
        end = ends.length > 0 ? ends[ends.length - 1] : '-';
      }

      hoursVal = Math.round(hoursVal * 100) / 100;
      hoursStr = `${hoursVal.toFixed(1)} Std.`;
      totalWorkedHours += hoursVal;
      weekRunningHours += hoursVal;
      if (hoursVal > 0) totalWorkedDays++;
    }

    const formattedDate = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
    rows.push({
      date: formattedDate,
      dayName: dayName,
      start: start,
      end: end,
      pause: pause,
      hours: hoursStr,
      isWeekend: isWeekend,
      hasHours: hoursVal > 0,
      hasApproved: hasApproved,
      hasPending: hasPending,
      kw: kw
    });

    // Week separator: after Sunday or on the very last day of month
    if (dayOfWeek === 0 || day === totalDays) {
      rows.push({
        isWeekSeparator: true,
        kw: kw,
        weekTotal: weekRunningHours
      });
      weekRunningHours = 0;
    }
  }

  // Header Logo & Branding
  const logoData = await getLogoDataUrl();
  if (logoData) {
    try {
      doc.addImage(logoData, 'JPEG', 12, 7, 19, 19);
    } catch (e) {}
  }

  // Company Name & Subtitle
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(20, 20, 20);
  doc.text('ALLESBAU BAUUNTERNEHMEN', 34, 13);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(190, 140, 0); // AllesBau Gold
  doc.text('Alles aus einer Hand! • Zuverlässig • Kompetent • Pünktlich', 34, 18);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(40, 40, 40);
  doc.text('MONATLICHER STUNDENNACHWEIS / ARBEITSZEITERFASSUNG', 34, 23.5);

  // Metadata Strip
  doc.setFillColor(248, 249, 250);
  doc.setDrawColor(215, 215, 215);
  doc.roundedRect(12, 27, 186, 7.5, 1, 1, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(50, 50, 50);
  doc.text('Mitarbeiter:', 15, 32);
  doc.setFont('helvetica', 'normal');
  doc.text(worker.name, 31, 32);

  doc.setFont('helvetica', 'bold');
  doc.text('Abrechnungsmonat:', 85, 32);
  doc.setFont('helvetica', 'normal');
  doc.text(monthFormatted, 114, 32);

  doc.setFont('helvetica', 'bold');
  doc.text('Erstellt am:', 152, 32);
  doc.setFont('helvetica', 'normal');
  doc.text(new Date().toLocaleDateString('de-DE'), 168, 32);

  // Build AutoTable Rows
  const tableBody = [];
  rows.forEach(r => {
    if (r.isWeekSeparator) {
      tableBody.push([
        {
          content: `── Kalenderwoche ${r.kw}  •  Wochenstunden: ${r.weekTotal.toFixed(1)} Std. ──`,
          colSpan: 6,
          styles: {
            halign: 'center',
            fontStyle: 'bold',
            fontSize: 6.5,
            fillColor: [245, 192, 0], // AllesBau Gold
            textColor: [17, 17, 17],
            cellPadding: 0.5
          }
        }
      ]);
    } else {
      tableBody.push([
        r.date,
        r.isWeekend ? `${r.dayName} (WE)` : r.dayName,
        r.start,
        r.end,
        r.pause,
        r.hours
      ]);
    }
  });

  doc.autoTable({
    startY: 37,
    theme: 'grid',
    head: [['Datum', 'Wochentag', 'Beginn', 'Ende', 'Pause', 'Stunden']],
    body: tableBody,
    styles: {
      fontSize: 6.8,
      cellPadding: { top: 0.55, bottom: 0.55, left: 1.5, right: 1.5 },
      lineColor: [215, 215, 215],
      lineWidth: 0.1,
      textColor: [30, 30, 30]
    },
    headStyles: {
      fillColor: [17, 17, 17],
      textColor: [245, 192, 0],
      fontStyle: 'bold',
      fontSize: 7.2,
      cellPadding: 1.0,
      halign: 'left'
    },
    columnStyles: {
      0: { cellWidth: 26, halign: 'left' },
      1: { cellWidth: 30, halign: 'left' },
      2: { cellWidth: 32, halign: 'center' },
      3: { cellWidth: 32, halign: 'center' },
      4: { cellWidth: 28, halign: 'center' },
      5: { cellWidth: 38, halign: 'right' }
    },
    margin: { left: 12, right: 12, top: 37, bottom: 15 },
    pageBreak: 'auto',
    didParseCell: function(data) {
      if (data.section === 'body') {
        const item = rows[data.row.index];
        if (item && !item.isWeekSeparator) {
          if (item.isWeekend) {
            data.cell.styles.fillColor = [246, 247, 249];
            data.cell.styles.textColor = [130, 130, 130];
          } else {
            if (data.column.index === 1) {
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.textColor = [17, 24, 39];
            }
            if (item.hasHours && data.column.index === 5) {
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.textColor = item.hasApproved ? [16, 120, 50] : [190, 120, 0];
            }
          }
        }
      }
    }
  });

  // Calculate position for summary and signature blocks on the final page
  const totalPages = doc.internal.getNumberOfPages();
  doc.setPage(totalPages);

  let finalY = doc.lastAutoTable ? doc.lastAutoTable.finalY : 210;

  // If table ran too close to bottom of current page, add new page for summary and signature
  if (finalY > 255) {
    doc.addPage();
    finalY = 20;
  }

  // Summary Banner
  doc.setFillColor(17, 17, 17);
  doc.roundedRect(12, finalY + 2.5, 186, 8, 1, 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(245, 192, 0);
  doc.text(`Monatssumme: ${totalWorkedHours.toFixed(1)} Std.`, 16, finalY + 7.5);
  doc.setTextColor(255, 255, 255);
  doc.text(`Arbeitstage: ${totalWorkedDays} Tage`, 75, finalY + 7.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(180, 180, 180);
  if (totalPendingHours > 0 && totalApprovedHours > 0) {
    doc.text(`(Genehmigt: ${totalApprovedHours.toFixed(1)} Std. • Ausstehend: ${totalPendingHours.toFixed(1)} Std.)`, 118, finalY + 7.5);
  } else if (totalPendingHours > 0 && totalApprovedHours === 0) {
    doc.text('(Ausstehende Freigabe)', 145, finalY + 7.5);
  } else {
    doc.text('Ausschließlich genehmigte Arbeitsstunden', 128, finalY + 7.5);
  }

  // Signature Block
  doc.setFontSize(7.0);
  doc.setTextColor(60, 60, 60);

  // Worker signature
  doc.setDrawColor(180, 180, 180);
  doc.line(16, finalY + 20, 90, finalY + 20);
  doc.text('Datum, Unterschrift Arbeitnehmer (Mitarbeiter)', 16, finalY + 24);

  // Employer signature
  doc.line(115, finalY + 20, 189, finalY + 20);
  doc.text('Datum, Unterschrift Bauleitung (AllesBau)', 115, finalY + 24);

  // Save PDF
  const safeName = (worker.name || 'Mitarbeiter').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `AllesBau_Monatsbericht_${safeName}_${monthStr}.pdf`;
  doc.save(filename);

  showToast(`Monatsbericht für ${worker.name} heruntergeladen! 📄`, 'success');
}

function handleTriggerMonthlyReport() {
  const user = authState.user;
  const isWorker = user?.role === 'worker';
  const selectedWorkerId = isWorker ? user.id : appState.calendarWorkerFilter;

  if (selectedWorkerId && selectedWorkerId !== 'all') {
    downloadMonthlyReportPdf(selectedWorkerId, appState.selectedMonth);
  } else {
    const workers = appData.workers.filter(w => w.role === 'worker');
    if (workers.length === 0) {
      showToast('Keine Mitarbeiter vorhanden. Bitte zuerst Mitarbeiter registrieren.', 'info');
      return;
    }
    if (workers.length === 1) {
      downloadMonthlyReportPdf(workers[0].id, appState.selectedMonth);
      return;
    }
    openModal('selectWorkerForReport');
  }
}

function renderCalendar() {
  const user = authState.user;
  const isLeader = user?.role === 'leader';
  const isSupervisor = user?.role === 'supervisor';
  const isWorker = user?.role === 'worker';
  const canApprove = isSupervisor || isLeader;

  const selectedWorkerId = isWorker ? user.id : appState.calendarWorkerFilter;
  const selectedWorker = selectedWorkerId !== 'all' ? getWorker(selectedWorkerId) : null;

  const [yearStr, monthStr] = appState.selectedMonth.split('-');
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const daysInMonth = new Date(year, month, 0).getDate();

  // 1. Shifts for selected worker across ALL TIME (for stat: Total approved hours for all time)
  const allTimeShifts = (appData.shifts || []).filter(s => {
    const sWorkerId = s.workerId || s.worker_id;
    if (selectedWorkerId !== 'all' && sWorkerId !== selectedWorkerId) return false;
    return true;
  });

  const totalApprovedHoursAllTime = allTimeShifts
    .filter(s => s.status === 'approved')
    .reduce((sum, s) => sum + (parseFloat(s.totalHours ?? s.total_hours) || 0), 0);

  // 2. Filtered shifts for the selected month and status filter
  const monthShifts = allTimeShifts.filter(s => s.date && s.date.startsWith(appState.selectedMonth));
  const filteredShifts = monthShifts.filter(s => {
    if (appState.calendarStatusFilter !== 'all' && s.status !== appState.calendarStatusFilter) return false;
    return true;
  });

  // Approved hours for CURRENT MONTH
  const approvedHoursCurrentMonth = monthShifts
    .filter(s => s.status === 'approved')
    .reduce((sum, s) => sum + (parseFloat(s.totalHours ?? s.total_hours) || 0), 0);

  // Total work days in CURRENT MONTH
  const workDaysCurrentMonth = new Set(
    monthShifts
      .filter(s => (parseFloat(s.totalHours ?? s.total_hours) || 0) > 0 && s.status !== 'rejected')
      .map(s => s.date)
  ).size;

  // Total pending hours
  const pendingHoursMonth = monthShifts
    .filter(s => s.status === 'pending')
    .reduce((sum, s) => sum + (parseFloat(s.totalHours ?? s.total_hours) || 0), 0);

  const pendingCount = monthShifts.filter(s => s.status === 'pending').length;

  return `
    <div class="space-y-4">
      
      <!-- Month Navigation & Report Action Header -->
      <div class="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-4 shadow-lg space-y-3">
        <div class="flex items-center justify-between">
          <button onclick="changeMonth(-1)" class="p-2 text-slate-300 hover:bg-[#222] rounded-xl transition active-press">◀</button>
          <div class="text-center">
            <h2 class="text-base font-extrabold text-white">${formatMonthYear(appState.selectedMonth)}</h2>
            <span class="text-[11px] text-[#888] font-medium">${monthShifts.length} ${t('cal_month_shifts', 'Schichten im Monat')}</span>
          </div>
          <button onclick="changeMonth(1)" class="p-2 text-slate-300 hover:bg-[#222] rounded-xl transition active-press">▶</button>
        </div>

        <!-- 1-Page Monthly PDF Report Generator Button (Always German document) -->
        <button onclick="handleTriggerMonthlyReport()" 
          class="w-full bg-gradient-to-r from-[#F5C000] to-[#e6b400] hover:from-[#ffd333] hover:to-[#F5C000] text-black font-black px-4 py-3 rounded-xl text-xs flex items-center justify-center gap-2 shadow-lg shadow-[#F5C000]/15 active-press transition">
          <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
          </svg>
          <span class="truncate">${selectedWorker ? `${t('download_report_pdf_worker', 'Monatsbericht herunterladen (PDF) — ')}${selectedWorker.name}` : t('download_report_pdf', 'Monatsbericht herunterladen (1-Seite PDF)')}</span>
        </button>

        <!-- Filter Controls -->
        <div class="pt-3 border-t border-[#222] grid grid-cols-2 gap-2">
          ${!isWorker ? `
            <div>
              <label class="text-[10px] uppercase font-bold text-[#888] block mb-1">${t('filter_worker', 'Mitarbeiter')}</label>
              <select onchange="appState.calendarWorkerFilter=this.value; renderApp();" class="w-full bg-[#1c1c1c] text-white text-xs border border-[#333] rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-[#F5C000]/60">
                <option value="all" ${appState.calendarWorkerFilter === 'all' ? 'selected' : ''}>${t('all_workers', 'Alle Mitarbeiter')}</option>
                ${appData.workers.filter(w => w.role === 'worker').map(w => `<option value="${w.id}" ${appState.calendarWorkerFilter === w.id ? 'selected' : ''}>${w.name}</option>`).join('')}
              </select>
            </div>
          ` : ''}

          <div class="${isWorker ? 'col-span-2' : ''}">
            <label class="text-[10px] uppercase font-bold text-[#888] block mb-1">${t('filter_status', 'Status Filter')}</label>
            <select onchange="appState.calendarStatusFilter=this.value; renderApp();" class="w-full bg-[#1c1c1c] text-white text-xs border border-[#333] rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-[#F5C000]/60">
              <option value="all" ${appState.calendarStatusFilter === 'all' ? 'selected' : ''}>${t('all_status', 'Alle Status')}</option>
              <option value="pending" ${appState.calendarStatusFilter === 'pending' ? 'selected' : ''}>🟡 ${t('status_pending', 'Ausstehend (Pending)')}</option>
              <option value="approved" ${appState.calendarStatusFilter === 'approved' ? 'selected' : ''}>🟢 ${t('status_approved', 'Genehmigt (Approved)')}</option>
              <option value="rejected" ${appState.calendarStatusFilter === 'rejected' ? 'selected' : ''}>🔴 ${t('status_rejected', 'Abgelehnt (Rejected)')}</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 4 Stat Cards: Approved All Time, Approved Month, Work Days Month, Pending Hours -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <!-- 1. Approved All Time -->
        <div class="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-3 text-center">
          <span class="text-[10px] text-[#F5C000] font-bold uppercase block truncate">${t('stat_total_approved_all_time', 'Genehmigt (Gesamt)')}</span>
          <div class="text-base font-black text-white mt-0.5">${totalApprovedHoursAllTime.toFixed(1)} Std.</div>
          <div class="text-[10px] text-[#888] mt-0.5">${t('all_time', 'Alle Zeiten')}</div>
        </div>

        <!-- 2. Approved Current Month -->
        <div class="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-3 text-center">
          <span class="text-[10px] text-emerald-400 font-bold uppercase block truncate">${t('stat_approved_month', 'Genehmigt (Monat)')}</span>
          <div class="text-base font-black text-emerald-400 mt-0.5">${approvedHoursCurrentMonth.toFixed(1)} Std.</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${formatMonthYear(appState.selectedMonth)}</div>
        </div>

        <!-- 3. Work Days Current Month -->
        <div class="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-3 text-center">
          <span class="text-[10px] text-blue-400 font-bold uppercase block truncate">${t('stat_work_days_month', 'Arbeitstage (Monat)')}</span>
          <div class="text-base font-black text-blue-300 mt-0.5">${workDaysCurrentMonth} Tage</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${t('this_month', 'im Monat')}</div>
        </div>

        <!-- 4. Pending Hours -->
        <div class="bg-[#141414] border border-[#2a2a2a] rounded-2xl p-3 text-center">
          <span class="text-[10px] text-amber-400 font-bold uppercase block truncate">${t('stat_pending_hours', 'Ausstehend (Std.)')}</span>
          <div class="text-base font-black text-amber-300 mt-0.5">${pendingHoursMonth.toFixed(1)} Std.</div>
          <div class="text-[10px] text-slate-400 mt-0.5">${pendingCount} ${t('under_review', 'Zur Prüfung')}</div>
        </div>
      </div>

      ${canApprove && pendingCount > 0 ? `
        <div class="bg-amber-950/40 border border-amber-800/60 rounded-2xl p-3.5 flex items-center justify-between shadow-sm">
          <div>
            <div class="text-xs font-bold text-amber-300">🟡 ${pendingCount} ${t('pending_approval_notice', 'ausstehende Schichten zur Prüfung')}</div>
            <div class="text-[11px] text-amber-400/80">Freigabe für Monatsbericht & Lohn erforderlich</div>
          </div>
          <button onclick="handleApproveAllShifts()" class="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-xl text-xs font-bold active-press shadow-md transition">
            ${t('approve_all', 'Alle genehmigen')}
          </button>
        </div>
      ` : ''}

      <!-- TABLE & GROUPED DAYS CONTENT -->
      <div class="rounded-2xl border border-[#262626] bg-[#121212] overflow-hidden shadow-xl">
        ${(() => {
          if (selectedWorkerId !== 'all') {
            // SINGLE WORKER VIEW: Month calendar with full day sequence & edit/delete options
            const rowsHtml = [];
            let currentKw = null;

            for (let d = 1; d <= daysInMonth; d++) {
              const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const dObj = new Date(year, month - 1, d);
              const dayOfWeek = dObj.getDay();
              const dayName = GERMAN_WEEKDAYS[dayOfWeek];
              const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
              const kw = getWeekNumber(dObj);

              if (kw !== currentKw) {
                currentKw = kw;
                rowsHtml.push(`
                  <tr class="bg-gradient-to-r from-[#F5C000]/15 via-[#F5C000]/5 to-transparent border-y border-[#F5C000]/30 font-bold">
                    <td colspan="${isLeader ? 7 : (isSupervisor ? 6 : 5)}" class="py-2 px-3">
                      <div class="flex items-center justify-between text-[#F5C000] text-[11px]">
                        <span class="flex items-center gap-1.5">
                          <span>📅</span>
                          <span>Kalenderwoche ${kw}</span>
                        </span>
                        <span class="text-[10px] text-slate-400 font-normal">Woche ${kw}</span>
                      </div>
                    </td>
                  </tr>
                `);
              }

              const dayShifts = filteredShifts.filter(s => s.date === dateStr);

              if (dayShifts.length > 0) {
                dayShifts.forEach(s => {
                  let photosCount = 0;
                  if (s.media) {
                    if (Array.isArray(s.media)) photosCount = s.media.length;
                    else if (typeof s.media === 'string') {
                      try { photosCount = (JSON.parse(s.media) || []).length; } catch(e) { photosCount = s.media ? 1 : 0; }
                    }
                  }

                  rowsHtml.push(`
                    <tr class="hover:bg-[#181818] transition ${isWeekend ? 'bg-[#151515]' : ''}">
                      <td class="py-2.5 px-3 whitespace-nowrap">
                        <div class="flex items-center gap-1.5">
                          <span class="font-bold text-white">${String(d).padStart(2, '0')}.${String(month).padStart(2, '0')}.</span>
                          <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${isWeekend ? 'bg-amber-950/40 text-amber-300 border border-amber-800/40' : 'bg-[#262626] text-[#F5C000] border border-[#333]'}">
                            ${dayName}
                          </span>
                        </div>
                      </td>
                      <td class="py-2.5 px-3 whitespace-nowrap font-mono text-slate-200">
                        <div>${s.startTime || s.start_time} - ${s.endTime || s.end_time}</div>
                        ${s.note ? `<div class="text-[10px] text-[#777] italic truncate max-w-[140px]">"${s.note}"</div>` : ''}
                        ${photosCount > 0 ? `
                          <button onclick="openShiftMediaViewer('${s.id}')" class="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-blue-950/70 border border-blue-700/60 text-blue-300 text-[10px] font-bold hover:bg-blue-900 transition">
                            <span>📷</span> <span>${photosCount} Fotos</span>
                          </button>
                        ` : ''}
                      </td>
                      <td class="py-2.5 px-3 text-center whitespace-nowrap text-slate-400">
                        ${(s.breakMinutes ?? s.break_minutes ?? 0) > 0 ? `${s.breakMinutes ?? s.break_minutes}m` : '-'}
                      </td>
                      <td class="py-2.5 px-3 text-right whitespace-nowrap font-bold ${s.status === 'approved' ? 'text-emerald-400' : 'text-[#F5C000]'}">
                        ${(s.totalHours || s.total_hours || 0).toFixed(1)} Std.
                      </td>
                      <td class="py-2.5 px-3 text-center whitespace-nowrap">
                        ${s.status === 'approved' 
                          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/70 text-emerald-400 border border-emerald-800/60 inline-flex items-center gap-1">🟢 Genehmigt</span>`
                          : s.status === 'rejected'
                          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-950/70 text-red-400 border border-red-800/60 inline-flex items-center gap-1">🔴 Abgelehnt</span>`
                          : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-950/70 text-amber-300 border border-amber-800/60 inline-flex items-center gap-1">🟡 Ausstehend</span>`}
                      </td>
                      ${(isLeader || isSupervisor) ? `
                        <td class="py-2.5 px-3 text-right whitespace-nowrap">
                          <div class="flex items-center justify-end gap-1.5">
                            ${isSupervisor && s.status === 'pending' ? `
                              <button onclick="handleApproveShift('${s.id}')" title="Genehmigen" class="bg-emerald-600 hover:bg-emerald-500 text-white p-1 rounded-lg text-xs font-bold active-press">✓</button>
                              <button onclick="handleRejectShift('${s.id}')" title="Ablehnen" class="bg-red-600 hover:bg-red-500 text-white p-1 rounded-lg text-xs font-bold active-press">✕</button>
                            ` : ''}
                            ${isLeader ? `
                              <button onclick="openEditShiftModal('${s.id}')" title="Bearbeiten" class="bg-blue-600/80 hover:bg-blue-600 text-white p-1.5 rounded-lg text-xs font-bold active-press shadow-sm">✏️</button>
                              <button onclick="handleDeleteShift('${s.id}')" title="Löschen" class="bg-red-600/80 hover:bg-red-600 text-white p-1.5 rounded-lg text-xs font-bold active-press shadow-sm">🗑️</button>
                            ` : ''}
                          </div>
                        </td>
                      ` : ''}
                    </tr>
                  `);
                });
              } else if (appState.calendarStatusFilter === 'all') {
                rowsHtml.push(`
                  <tr class="hover:bg-[#161616] transition opacity-70 ${isWeekend ? 'bg-[#131313]' : ''}">
                    <td class="py-2 px-3 whitespace-nowrap">
                      <div class="flex items-center gap-1.5">
                        <span class="text-[#777]">${String(d).padStart(2, '0')}.${String(month).padStart(2, '0')}.</span>
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ${isWeekend ? 'bg-slate-900 text-slate-500 border border-slate-800' : 'bg-[#1e1e1e] text-[#888]'}">
                          ${dayName}
                        </span>
                      </div>
                    </td>
                    <td class="py-2 px-3 text-slate-600">—</td>
                    <td class="py-2 px-3 text-center text-slate-600">—</td>
                    <td class="py-2 px-3 text-right text-slate-600">—</td>
                    <td class="py-2 px-3 text-center">
                      <span class="text-slate-600 text-[10px] italic">${isWeekend ? 'Wochenende' : 'Frei'}</span>
                    </td>
                    ${(isLeader || isSupervisor) ? '<td class="py-2 px-3 text-right text-slate-700">—</td>' : ''}
                  </tr>
                `);
              }
            }

            return `
              <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr class="bg-[#1a1a1a] text-[#aaa] border-b border-[#282828] font-bold uppercase tracking-wider text-[10px]">
                      <th class="py-2.5 px-3">${t('col_date', 'Datum / Tag')}</th>
                      <th class="py-2.5 px-3">${t('col_time', 'Arbeitszeit')}</th>
                      <th class="py-2.5 px-3 text-center">${t('col_break', 'Pause')}</th>
                      <th class="py-2.5 px-3 text-right">${t('col_hours', 'Stunden')}</th>
                      <th class="py-2.5 px-3 text-center">${t('col_status', 'Status')}</th>
                      ${(isLeader || isSupervisor) ? `<th class="py-2.5 px-3 text-right">${t('col_actions', 'Aktion')}</th>` : ''}
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-[#202020]">
                    ${rowsHtml.join('')}
                  </tbody>
                </table>
              </div>
            `;
          } else {
            // ALL WORKERS DEFAULT VIEW: Group shifts by Day into Collapsible Rows (Requirement 6)
            if (filteredShifts.length === 0) {
              return `
                <div class="p-8 text-center text-slate-500 text-xs">
                  ${t('no_shifts_month', 'Keine Schichten für diesen Monat gefunden. Tippe auf "+ Schicht eintragen", um Daten manuell einzufügen.')}
                </div>
              `;
            }

            // Group shifts by date (YYYY-MM-DD)
            const groupedByDate = {};
            filteredShifts.forEach(s => {
              if (!groupedByDate[s.date]) groupedByDate[s.date] = [];
              groupedByDate[s.date].push(s);
            });

            // Sort dates descending
            const sortedDates = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));
            let currentKw = null;

            return `
              <!-- Quick Collapse / Expand All Toolbar (Requirement 3: Folded by default) -->
              <div class="bg-[#171717] px-3.5 py-2 border-b border-[#262626] flex items-center justify-between text-xs">
                <span class="text-slate-400 font-semibold text-[11px]">${sortedDates.length} Arbeitstage im Monat</span>
                <div class="flex items-center gap-2">
                  <button type="button" onclick="toggleAllCalendarDays(true)" 
                    class="text-[#F5C000] hover:underline font-bold text-[11px] flex items-center gap-1 active-press">
                    <span>🔽</span> <span>${t('unfold_all', 'Alle aufklappen')}</span>
                  </button>
                  <span class="text-slate-600">|</span>
                  <button type="button" onclick="toggleAllCalendarDays(false)" 
                    class="text-slate-400 hover:text-white text-[11px] flex items-center gap-1 active-press">
                    <span>🔼</span> <span>${t('fold_all', 'Alle zuklappen')}</span>
                  </button>
                </div>
              </div>

              <div class="divide-y divide-[#202020]">
                ${sortedDates.map(dateStr => {
                  const dayShifts = groupedByDate[dateStr];
                  const dParts = dateStr.split('-');
                  const dObj = new Date(parseInt(dParts[0]), parseInt(dParts[1]) - 1, parseInt(dParts[2]));
                  const dayOfWeek = dObj.getDay();
                  const dayName = GERMAN_WEEKDAYS[dayOfWeek];
                  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
                  const kw = getWeekNumber(dObj);

                  // Unique workers on this day
                  const workerIdsOnDay = Array.from(new Set(dayShifts.map(s => s.workerId || s.worker_id)));
                  const dayTotalHours = dayShifts.reduce((sum, s) => sum + (parseFloat(s.totalHours ?? s.total_hours) || 0), 0);
                  
                  // Collect comments
                  const notesList = dayShifts.map(s => s.note).filter(n => n && n.trim() && n !== 'Live timer shift');
                  const firstNote = notesList.length > 0 ? notesList[0] : (dayShifts[0]?.note || '');

                  // Collect day media
                  const dayMedia = [];
                  dayShifts.forEach(s => {
                    if (s.media) {
                      if (Array.isArray(s.media)) dayMedia.push(...s.media);
                      else if (typeof s.media === 'string') {
                        try {
                          const parsed = JSON.parse(s.media);
                          if (Array.isArray(parsed)) dayMedia.push(...parsed);
                          else dayMedia.push(s.media);
                        } catch(e) {
                          dayMedia.push(s.media);
                        }
                      }
                    }
                  });

                  // Status summary
                  const allApproved = dayShifts.every(s => s.status === 'approved');
                  const hasPending = dayShifts.some(s => s.status === 'pending');
                  const hasRejected = dayShifts.some(s => s.status === 'rejected');

                  // Expansion state: FOLDED UP BY DEFAULT (Requirement 3)
                  const isExpanded = appState.expandedCalendarDays[dateStr] ?? false;

                  let weekHeader = '';
                  if (kw !== currentKw) {
                    currentKw = kw;
                    weekHeader = `
                      <div class="bg-gradient-to-r from-[#F5C000]/15 via-[#F5C000]/5 to-transparent px-4 py-2 border-y border-[#F5C000]/30 font-bold text-[#F5C000] text-xs flex items-center justify-between">
                        <span>📅 Kalenderwoche ${kw}</span>
                        <span class="text-[10px] text-slate-400 font-normal">Woche ${kw}</span>
                      </div>
                    `;
                  }

                  return `
                    ${weekHeader}
                    <div class="border-b border-[#222]">
                      <!-- Main Collapsible Day Header Row -->
                      <div onclick="toggleCalendarDay('${dateStr}')" 
                        class="p-3 bg-[#161616] hover:bg-[#1a1a1a] cursor-pointer transition flex flex-wrap items-center justify-between gap-2 select-none">
                        
                        <!-- Left: Date & Workers Summary -->
                        <div class="flex items-center gap-2.5">
                          <button type="button" class="text-slate-400 hover:text-white text-xs transition transform ${isExpanded ? 'rotate-90' : ''}">
                            ▶
                          </button>
                          
                          <div class="flex items-center gap-1.5">
                            <span class="font-black text-white text-sm">${dParts[2]}.${dParts[1]}.</span>
                            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${isWeekend ? 'bg-amber-950/40 text-amber-300 border border-amber-800/40' : 'bg-[#262626] text-[#F5C000] border border-[#333]'}">
                              ${dayName}
                            </span>
                          </div>

                          <div class="flex items-center gap-1 bg-slate-800/80 px-2 py-0.5 rounded-lg border border-slate-700/60 text-xs font-bold text-slate-200">
                            <span>👷</span> <span>${workerIdsOnDay.length} ${t('workers_count', 'Arbeiter')}</span>
                          </div>
                        </div>

                        <!-- Center: Total Hours & Comments -->
                        <div class="flex items-center gap-3">
                          <div class="text-xs font-black ${allApproved ? 'text-emerald-400' : 'text-[#F5C000]'}">
                            ${dayTotalHours.toFixed(1)} Std.
                          </div>

                          ${firstNote ? `
                            <div class="hidden sm:block text-[11px] text-[#888] italic truncate max-w-[160px]" title="${firstNote}">
                              💬 "${firstNote}"
                            </div>
                          ` : ''}

                          <!-- Media button (if photos uploaded) -->
                          ${dayMedia.length > 0 ? `
                            <button onclick="event.stopPropagation(); openDateMediaViewer('${dateStr}')" 
                              class="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-blue-950/70 hover:bg-blue-900 border border-blue-700/60 text-blue-300 text-[11px] font-bold active-press shadow-sm transition">
                              <span>📷</span> <span>${dayMedia.length} ${t('show_photos', 'Fotos')}</span>
                            </button>
                          ` : ''}

                          <!-- Status Pill -->
                          <div>
                            ${allApproved ? `
                              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/70 text-emerald-400 border border-emerald-800/60">
                                🟢 ${t('status_approved', 'Genehmigt')}
                              </span>
                            ` : hasPending ? `
                              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-950/70 text-amber-300 border border-amber-800/60">
                                🟡 ${dayShifts.filter(s => s.status === 'pending').length} ${t('status_pending', 'Ausstehend')}
                              </span>
                            ` : `
                              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-950/70 text-red-400 border border-red-800/60">
                                🔴 ${t('status_rejected', 'Abgelehnt')}
                              </span>
                            `}
                          </div>
                        </div>
                      </div>

                      <!-- Collapsible Breakdown of individual worker shifts on this day -->
                      ${isExpanded ? `
                        <div class="bg-[#101010] p-2 space-y-2 border-t border-[#1e1e1e]">
                          ${dayShifts.map(s => {
                            const w = getWorker(s.workerId || s.worker_id);
                            let shiftPhotos = 0;
                            if (s.media) {
                              if (Array.isArray(s.media)) shiftPhotos = s.media.length;
                              else if (typeof s.media === 'string') {
                                try { shiftPhotos = (JSON.parse(s.media) || []).length; } catch(e) { shiftPhotos = s.media ? 1 : 0; }
                              }
                            }

                            return `
                              <div class="bg-[#181818] border border-[#262626] rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-2 hover:border-[#383838] transition">
                                <div class="flex items-center gap-2.5 min-w-0">
                                  <div class="w-7 h-7 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-xs font-bold text-[#F5C000] flex-shrink-0">
                                    👷
                                  </div>
                                  <div class="min-w-0">
                                    <div class="text-xs font-bold text-white truncate">${w ? w.name : 'Mitarbeiter'}</div>
                                    <div class="text-[11px] font-mono text-slate-300">
                                      ${s.startTime || s.start_time} - ${s.endTime || s.end_time} 
                                      <span class="text-slate-500">• Pause: ${(s.breakMinutes ?? s.break_minutes ?? 0)}m</span>
                                    </div>
                                    ${s.note ? `<div class="text-[10px] text-[#777] italic truncate max-w-[200px]">"${s.note}"</div>` : ''}
                                  </div>
                                </div>

                                <div class="flex items-center gap-2.5 flex-shrink-0">
                                  <div class="text-right">
                                    <div class="text-xs font-extrabold ${s.status === 'approved' ? 'text-emerald-400' : 'text-[#F5C000]'}">
                                      ${(s.totalHours || s.total_hours || 0).toFixed(1)} Std.
                                    </div>
                                    <div class="text-[9px] uppercase font-bold text-slate-400">
                                      ${s.status === 'approved' ? '🟢 Genehmigt' : s.status === 'rejected' ? '🔴 Abgelehnt' : '🟡 Ausstehend'}
                                    </div>
                                  </div>

                                  ${shiftPhotos > 0 ? `
                                    <button onclick="openShiftMediaViewer('${s.id}')" class="p-1 px-2 rounded-lg bg-blue-950/70 border border-blue-700/60 text-blue-300 text-[10px] font-bold hover:bg-blue-900 transition flex items-center gap-1">
                                      <span>📷</span> <span>${shiftPhotos}</span>
                                    </button>
                                  ` : ''}

                                  <!-- Actions: Supervisor Approve/Reject & Leader Edit/Delete -->
                                  <div class="flex items-center gap-1 border-l border-[#282828] pl-2">
                                    ${isSupervisor && s.status === 'pending' ? `
                                      <button onclick="handleApproveShift('${s.id}')" title="Genehmigen" class="bg-emerald-600 hover:bg-emerald-500 text-white p-1 rounded-lg text-xs font-bold active-press shadow-sm">✓</button>
                                      <button onclick="handleRejectShift('${s.id}')" title="Ablehnen" class="bg-red-600 hover:bg-red-500 text-white p-1 rounded-lg text-xs font-bold active-press shadow-sm">✕</button>
                                    ` : ''}
                                    ${isLeader ? `
                                      <button onclick="openEditShiftModal('${s.id}')" title="Bearbeiten" class="bg-blue-600/80 hover:bg-blue-600 text-white p-1.5 rounded-lg text-xs font-bold active-press shadow-sm">✏️</button>
                                      <button onclick="handleDeleteShift('${s.id}')" title="Löschen" class="bg-red-600/80 hover:bg-red-600 text-white p-1.5 rounded-lg text-xs font-bold active-press shadow-sm">🗑️</button>
                                    ` : ''}
                                  </div>
                                </div>
                              </div>
                            `;
                          }).join('')}
                        </div>
                      ` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            `;
          }
        })()}
      </div>

    </div>
  `;
}

function renderPayments() {
  const user = authState.user;
  const isLeader = user?.role === 'leader';
  const isSupervisor = user?.role === 'supervisor';
  const isWorker = user?.role === 'worker';

  const workerFilter = isWorker ? user.id : appState.paymentWorkerFilter;
  const fin = calculateGlobalFinancials(workerFilter);

  const filteredPayments = (appData.payments || []).filter(p => {
    const wid = p.workerId || p.worker_id;
    if (workerFilter !== 'all' && wid !== workerFilter) return false;
    return true;
  });

  return `
    <div class="space-y-4">
      ${!isWorker ? `
        <div class="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-3 flex items-center justify-between">
          <label class="text-xs font-semibold text-slate-300">${t('filter_worker_balance', 'Mitarbeiter filtern:')}</label>
          <select onchange="appState.paymentWorkerFilter=this.value; renderApp();" class="bg-slate-900 text-white text-xs border border-slate-700 rounded-xl px-3 py-1.5 focus:outline-none focus:border-[#F5C000]">
            <option value="all" ${appState.paymentWorkerFilter === 'all' ? 'selected' : ''}>${t('all_workers', 'Alle Mitarbeiter')}</option>
            ${appData.workers.filter(w => w.role === 'worker').map(w => `<option value="${w.id}" ${appState.paymentWorkerFilter === w.id ? 'selected' : ''}>${w.name}</option>`).join('')}
          </select>
        </div>
      ` : ''}

      <div class="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700/70 rounded-3xl p-5 shadow-xl space-y-4">
        <div class="flex items-center justify-between">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-400">
            ${isLeader ? 'Leader Lohnabrechnung & Gewinnübersicht' : isSupervisor ? 'Abrechnung & Ausgaben' : 'Lohn- & Auszahlungsübersicht'}
          </span>
          ${isLeader ? `
            <button onclick="openModal('logPayment')" 
              class="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 active-press text-white px-3.5 py-1.5 rounded-xl text-xs font-bold shadow-md">
              <span>+ ${t('log_payment', 'Auszahlung erfassen')}</span>
            </button>
          ` : ''}
        </div>

        ${isLeader ? `
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-700/60 text-center">
            <div class="p-2.5 rounded-xl bg-slate-800/60 border border-slate-700">
              <span class="text-[10px] text-blue-400 uppercase font-bold block">Chef zahlt</span>
              <span class="text-sm font-black text-blue-300 mt-0.5 block truncate">${formatCurrency(fin.totalSupervisorCost)}</span>
            </div>

            <div class="p-2.5 rounded-xl bg-slate-800/60 border border-slate-700">
              <span class="text-[10px] text-slate-300 uppercase font-bold block">${t('total_earned', 'Arbeiterlohn')}</span>
              <span class="text-sm font-black text-slate-200 mt-0.5 block truncate">${formatCurrency(fin.totalWorkerEarned)}</span>
            </div>

            <div class="p-2.5 rounded-xl bg-amber-950/40 border border-amber-800/60">
              <span class="text-[10px] text-amber-300 uppercase font-black block">Dein Cut</span>
              <span class="text-sm font-black text-[#F5C000] mt-0.5 block truncate">+${formatCurrency(fin.totalLeaderCut)}</span>
            </div>

            <div class="p-2.5 rounded-xl ${fin.workerBalance > 0 ? 'bg-emerald-950/60 border border-emerald-800/50' : 'bg-slate-800/60 border border-slate-700'}">
              <span class="text-[10px] text-emerald-300 uppercase font-bold block">Offen an Arbeiter</span>
              <span class="text-sm font-black ${fin.workerBalance > 0 ? 'text-emerald-400' : 'text-slate-300'} mt-0.5 block truncate">${formatCurrency(fin.workerBalance)}</span>
            </div>
          </div>
        ` : isSupervisor ? `
          <div class="grid grid-cols-3 gap-2 pt-2 border-t border-slate-700/60 text-center">
            <div class="p-2 rounded-xl bg-slate-800/50">
              <span class="text-[10px] text-slate-400 uppercase font-semibold block">Gesamtsumme</span>
              <span class="text-sm font-bold text-white mt-0.5 block truncate">${formatCurrency(fin.totalSupervisorCost)}</span>
            </div>

            <div class="p-2 rounded-xl bg-slate-800/50">
              <span class="text-[10px] text-slate-400 uppercase font-semibold block">${t('total_paid', 'Bereits bezahlt')}</span>
              <span class="text-sm font-bold text-blue-400 mt-0.5 block truncate">${formatCurrency(fin.totalPaid)}</span>
            </div>

            <div class="p-2 rounded-xl ${fin.supervisorBalance > 0 ? 'bg-emerald-950/60 border border-emerald-800/50' : 'bg-slate-800/50'}">
              <span class="text-[10px] text-emerald-300 uppercase font-bold block">${t('balance_remaining', 'Noch offen')}</span>
              <span class="text-base font-extrabold ${fin.supervisorBalance > 0 ? 'text-emerald-400' : 'text-slate-300'} mt-0.5 block truncate">${formatCurrency(fin.supervisorBalance)}</span>
            </div>
          </div>
        ` : `
          <div class="grid grid-cols-3 gap-2 pt-2 border-t border-slate-700/60 text-center">
            <div class="p-2 rounded-xl bg-slate-800/50">
              <span class="text-[10px] text-slate-400 uppercase font-semibold block">${t('total_earned', 'Dein Verdienst')}</span>
              <span class="text-sm font-bold text-white mt-0.5 block truncate">${formatCurrency(fin.totalWorkerEarned)}</span>
            </div>

            <div class="p-2 rounded-xl bg-slate-800/50">
              <span class="text-[10px] text-slate-400 uppercase font-semibold block">${t('total_paid', 'Erhalten')}</span>
              <span class="text-sm font-bold text-blue-400 mt-0.5 block truncate">${formatCurrency(fin.totalPaid)}</span>
            </div>

            <div class="p-2 rounded-xl ${fin.workerBalance > 0 ? 'bg-emerald-950/60 border border-emerald-800/50' : 'bg-slate-800/50'}">
              <span class="text-[10px] text-emerald-300 uppercase font-bold block">${t('balance_remaining', 'Offener Lohn')}</span>
              <span class="text-base font-extrabold ${fin.workerBalance > 0 ? 'text-emerald-400' : 'text-slate-300'} mt-0.5 block truncate">${formatCurrency(fin.workerBalance)}</span>
            </div>
          </div>
        `}
      </div>

      <!-- Worker-by-Worker Payment & Balance Stats (Total, Paid, Remaining) -->
      ${(!isWorker || isLeader || isSupervisor) ? `
        <div class="space-y-2.5">
          <div class="flex items-center justify-between px-1">
            <h3 class="text-xs font-bold text-slate-300 uppercase tracking-wider">Abrechnung pro Mitarbeiter</h3>
            <span class="text-[11px] text-slate-400 font-semibold">${appData.workers.filter(w => w.role === 'worker').length} Mitarbeiter</span>
          </div>

          <div class="space-y-2">
            ${appData.workers.filter(w => w.role === 'worker').map(w => {
              const wFin = calculateWorkerFinancials(w.id);
              const remaining = Math.max(0, wFin.workerBalance);
              const isFullyPaid = wFin.workerEarned > 0 && remaining <= 0;
              return `
                <div class="bg-slate-800/70 border border-slate-700/60 rounded-2xl p-3.5 space-y-2.5 shadow-sm">
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                      <div class="w-7 h-7 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center text-xs font-bold text-[#F5C000]">
                        👷
                      </div>
                      <div>
                        <div class="text-xs font-bold text-white">${w.name}</div>
                        <div class="text-[10px] text-slate-400">@${w.username} • ${formatCurrency(w.hourly_rate || w.rate)}/h</div>
                      </div>
                    </div>

                    <div>
                      ${isFullyPaid ? `
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/70 text-emerald-400 border border-emerald-800/60">
                          🟢 Vollständig bezahlt
                        </span>
                      ` : remaining > 0 ? `
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-950/70 text-amber-300 border border-amber-800/60">
                          🟡 ${formatCurrency(remaining)} offen
                        </span>
                      ` : `
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-900 text-slate-400 border border-slate-700/60">
                          0,00 € (Keine Schichten)
                        </span>
                      `}
                    </div>
                  </div>

                  <!-- 3 Stats Columns: Total Earned, Paid, To be paid -->
                  <div class="grid grid-cols-3 gap-2 bg-slate-900/60 border border-slate-700/40 rounded-xl p-2.5 text-center text-xs">
                    <div>
                      <span class="text-[10px] text-slate-400 uppercase font-semibold block">${t('total_earned', 'Total Lohn')}</span>
                      <span class="font-extrabold text-white text-xs block mt-0.5">${formatCurrency(wFin.workerEarned)}</span>
                      <span class="text-[9px] text-slate-500 block">${wFin.totalHours.toFixed(1)} Std.</span>
                    </div>

                    <div>
                      <span class="text-[10px] text-slate-400 uppercase font-semibold block">${t('total_paid', 'Bezahlt')}</span>
                      <span class="font-extrabold text-blue-400 text-xs block mt-0.5">${formatCurrency(wFin.totalPaid)}</span>
                      <span class="text-[9px] text-slate-500 block">${appData.payments.filter(p => (p.workerId === w.id || p.worker_id === w.id) && p.status === 'approved').length} Zahlungen</span>
                    </div>

                    <div>
                      <span class="text-[10px] text-[#F5C000] uppercase font-bold block">${t('balance_remaining', 'Noch offen')}</span>
                      <span class="font-black text-xs block mt-0.5 ${remaining > 0 ? 'text-emerald-400' : 'text-slate-400'}">${formatCurrency(remaining)}</span>
                      <span class="text-[9px] text-slate-500 block">Restbetrag</span>
                    </div>
                  </div>

                  ${isLeader ? `
                    <div class="flex items-center justify-end gap-2 pt-1 border-t border-slate-700/40">
                      <button onclick="openModal('logPayment', '${w.id}')"
                        class="bg-emerald-600/90 hover:bg-emerald-500 text-white font-bold px-3 py-1.5 rounded-xl text-[11px] active-press transition flex items-center gap-1 shadow-sm">
                        <span>💵</span> <span>${t('log_payment', 'Auszahlung erfassen')}</span>
                      </button>
                    </div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
      ` : ''}

      <!-- Distinct Payment & Payout History Section (Requirement 4: Distinct Receipt/Ledger Styling) -->
      <div class="space-y-3 pt-2">
        <div class="flex items-center justify-between px-1">
          <div class="flex items-center gap-2">
            <span class="text-lg">📜</span>
            <div>
              <h3 class="text-sm font-black text-white uppercase tracking-wider">${t('history_title', 'Auszahlungsverlauf & Belege')}</h3>
              <p class="text-[11px] text-slate-400">${t('history_subtitle', 'Chronologisches Zahlungsjournal & Quittungsarchiv')}</p>
            </div>
          </div>
          <span class="text-[11px] font-mono px-2 py-0.5 rounded-lg bg-blue-950/70 border border-blue-800/50 text-blue-300 font-bold">
            ${filteredPayments.length} Belege
          </span>
        </div>

        ${filteredPayments.length === 0 ? `
          <div class="bg-gradient-to-br from-[#0c131d] to-[#121c2b] border border-blue-900/40 rounded-2xl p-8 text-center text-slate-400 text-sm">
            ${t('no_payments_yet', 'Noch keine Auszahlungen erfasst.')}
          </div>
        ` : filteredPayments.map(p => {
          const wid = p.workerId || p.worker_id;
          const worker = getWorker(wid);
          const isApproved = p.status === 'approved';
          const isRejected = p.status === 'rejected';

          return `
            <div class="bg-gradient-to-br from-[#0c131d] via-[#101926] to-[#141f30] border-2 border-slate-700/70 ${isApproved ? 'border-l-4 border-l-emerald-500' : isRejected ? 'border-l-4 border-l-red-500' : 'border-l-4 border-l-[#F5C000]'} rounded-2xl p-4 shadow-xl space-y-2.5 relative overflow-hidden transition hover:border-slate-600">
              <!-- Top Row: Receipt Code + Date + Status -->
              <div class="flex items-center justify-between pb-2 border-b border-slate-700/60 text-xs">
                <div class="flex items-center gap-2">
                  <span class="px-2 py-0.5 rounded-lg bg-slate-900 border border-slate-700 text-[#F5C000] font-mono text-[11px] font-bold">
                    🧾 AB-PAY-${(p.id || '').replace('p_', '').toUpperCase().slice(0, 8)}
                  </span>
                  <span class="text-slate-400 font-medium">📅 ${formatDate(p.date)}</span>
                </div>
                <div>
                  ${isApproved ? `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">🟢 Genehmigt</span>`
                  : isRejected ? `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-red-950/80 text-red-400 border border-red-800/60">🔴 Abgelehnt</span>`
                  : `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-950/80 text-amber-300 border border-amber-800/60">🟡 Ausstehend</span>`}
                </div>
              </div>

              <!-- Main Amount & Recipient Box -->
              <div class="flex items-center justify-between py-1">
                <div>
                  <span class="text-[10px] text-slate-400 uppercase font-semibold block">Auszahlungsbetrag</span>
                  <span class="text-xl font-black text-[#F5C000] font-mono tracking-tight block">${formatCurrency(p.amount)}</span>
                </div>
                <div class="text-right">
                  <span class="text-[10px] text-slate-400 uppercase font-semibold block">Empfänger</span>
                  <span class="text-xs font-bold text-white block">${p.receivedBy || worker?.name || 'Mitarbeiter'}</span>
                  <span class="text-[10px] text-slate-500 font-mono block">@${worker?.username || '-'}</span>
                </div>
              </div>

              <!-- Transaction Metadata Details Box -->
              <div class="p-2 rounded-xl bg-slate-900/80 border border-slate-800/80 text-[11px] space-y-1 text-slate-300">
                <div class="flex items-center justify-between text-slate-400">
                  <span>✍️ ${t('logged_by', 'Erfasst durch')}:</span>
                  <span class="text-slate-200 font-semibold">${p.loggedBy || 'LEADER'}</span>
                </div>
                ${p.comment ? `
                  <div class="flex items-center justify-between text-slate-400">
                    <span>💬 Notiz / Zweck:</span>
                    <span class="text-slate-200 italic font-medium truncate max-w-[200px]" title="${p.comment}">"${p.comment}"</span>
                  </div>
                ` : ''}
              </div>

              <!-- Perforated / Dashed Receipt Divider -->
              <div class="border-t border-dashed border-slate-700/80 pt-2 flex flex-wrap items-center justify-between gap-2">
                <button onclick="openModal('paymentInvoice', '${p.id}')" 
                  class="bg-slate-900 hover:bg-slate-850 border border-slate-700 text-[#F5C000] px-3 py-1.5 rounded-xl text-xs font-bold active-press transition flex items-center gap-1.5 shadow-sm">
                  <span>📄</span> <span>${t('payment_details_invoice', 'Beleg / Quittung')}</span>
                </button>

                <div class="flex items-center gap-2">
                  <button onclick="downloadPaymentInvoicePdf('${p.id}')" title="Als PDF herunterladen" 
                    class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1.5 rounded-xl text-xs font-semibold active-press transition flex items-center gap-1">
                    <span>📥</span> <span>PDF</span>
                  </button>

                  ${(isSupervisor || isLeader) && p.status === 'pending' ? `
                    <button onclick="handleApprovePayment('${p.id}')" class="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-xl text-xs font-bold active-press transition">
                      ${t('approve', 'Genehmigen')}
                    </button>
                    <button onclick="handleRejectPayment('${p.id}')" class="bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-xl text-xs font-bold active-press transition">
                      ${t('reject', 'Ablehnen')}
                    </button>
                  ` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderBottomNav() {
  const tabs = [
    { id: 'home', label: t('nav_home', 'Übersicht'), icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path>` },
    { id: 'calendar', label: t('nav_calendar', 'Kalender'), icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>` },
    { id: 'payments', label: t('nav_payments', 'Auszahlungen'), icon: `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>` }
  ];

  return `
    <nav class="fixed bottom-0 left-0 right-0 max-w-[480px] mx-auto glass-nav border-t border-slate-800 z-40 safe-area-nav">
      <div class="grid grid-cols-3 gap-1 px-3 py-2">
        ${tabs.map(t => {
          const isActive = appState.activeTab === t.id;
          return `
            <button onclick="switchTab('${t.id}')" 
              class="flex flex-col items-center justify-center py-1.5 rounded-2xl transition active-press ${isActive ? 'text-blue-400 font-bold bg-blue-950/40 border border-blue-800/40' : 'text-slate-400 hover:text-slate-200'}">
              <svg class="w-6 h-6 mb-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${t.icon}</svg>
              <span class="text-[11px]">${t.label}</span>
            </button>
          `;
        }).join('')}
      </div>
    </nav>
  `;
}

// -------------------------------------------------------------
// MODALS
// -------------------------------------------------------------

function renderModals() {
  if (!appState.activeModal) return '';

  const modal = appState.activeModal;
  const user = authState.user;

  let modalContent = '';

  // 1. User Profile & Password Change / Logout
  if (modal === 'userProfile') {
    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-sm animate-slide-up space-y-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 class="text-base font-bold text-white">Benutzerprofil</h3>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <div class="space-y-2 bg-slate-800/60 p-4 rounded-2xl border border-slate-700">
          <div class="text-sm font-bold text-white">${user?.name}</div>
          <div class="text-xs text-slate-400">Rolle: <span class="text-[#F5C000] font-semibold uppercase">${user?.role}</span></div>
          <div class="text-xs text-slate-400">Benutzername: <span class="text-slate-200 font-mono">${user?.username}</span></div>
          <div class="text-xs text-slate-400">Firma: <span class="text-slate-200">${user?.company_name || 'AllesBau'}</span></div>
        </div>

        <div class="space-y-2">
          <button onclick="downloadMonthlyReportPdf('${user?.id}', appState.selectedMonth); closeModal();"
            class="w-full text-left bg-gradient-to-r from-[#F5C000] to-[#e6b400] text-black p-3 rounded-2xl text-xs font-bold transition flex items-center justify-between shadow-md active-press">
            <span>📄 Monatsbericht herunterladen (PDF)</span>
            <span>⬇</span>
          </button>

          <button onclick="openModal('changePassword')" 
            class="w-full text-left bg-slate-800 hover:bg-slate-700 text-slate-200 p-3 rounded-2xl text-xs font-semibold transition border border-slate-700">
            🔑 Passwort ändern
          </button>

          <button onclick="handleClearAllData()" 
            class="w-full text-left bg-red-950/40 hover:bg-red-900/60 text-red-300 p-3 rounded-2xl text-xs font-semibold transition border border-red-800/40">
            🗑️ Alle Daten löschen (Reset)
          </button>
        </div>

        <div class="pt-2 border-t border-slate-800 flex justify-between items-center">
          <button onclick="logout()" class="text-xs text-red-400 font-bold hover:text-red-300">Abmelden</button>
          <button onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Fertig</button>
        </div>
      </div>
    `;
  }

  // 1b. Select Worker for Monthly Report Modal
  else if (modal === 'selectWorkerForReport') {
    const workers = appData.workers.filter(w => w.role === 'worker');
    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-sm animate-slide-up space-y-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 class="text-base font-bold text-white">📄 Monatsbericht wählen</h3>
            <p class="text-[11px] text-[#888]">${formatMonthYear(appState.selectedMonth)} (1-Seite PDF)</p>
          </div>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <p class="text-xs text-slate-300">
          Wähle einen Mitarbeiter aus, um den offiziellen Monatsbericht für <b>${formatMonthYear(appState.selectedMonth)}</b> als 1-seitiges PDF herunterzuladen:
        </p>

        <div class="space-y-2 max-h-64 overflow-y-auto pr-1">
          ${workers.length === 0 ? `
            <div class="text-center text-slate-500 py-4 text-xs">Keine Arbeiter registriert.</div>
          ` : workers.map(w => {
            const mShifts = appData.shifts.filter(s => (s.workerId === w.id || s.worker_id === w.id) && s.date && s.date.startsWith(appState.selectedMonth) && s.status !== 'rejected');
            const totalHours = mShifts.reduce((sum, s) => sum + (s.totalHours || s.total_hours || 0), 0);
            const approvedHours = mShifts.filter(s => s.status === 'approved').reduce((sum, s) => sum + (s.totalHours || s.total_hours || 0), 0);
            return `
              <div class="bg-slate-800/70 border border-slate-700/70 rounded-2xl p-3 flex items-center justify-between">
                <div>
                  <div class="text-xs font-bold text-white">${w.name}</div>
                  <div class="text-[10px] text-emerald-400 font-medium">${totalHours.toFixed(1)} Std. gesamt (${approvedHours.toFixed(1)} genehmigt)</div>
                </div>
                <button onclick="downloadMonthlyReportPdf('${w.id}', appState.selectedMonth); closeModal();"
                  class="bg-[#F5C000] hover:bg-[#ffd333] text-black font-extrabold px-3 py-1.5 rounded-xl text-xs active-press transition flex items-center gap-1 shadow-sm">
                  <span>📥</span>
                  <span>PDF</span>
                </button>
              </div>
            `;
          }).join('')}
        </div>

        ${workers.length > 1 ? `
          <button onclick="appData.workers.filter(w => w.role === 'worker').forEach(w => downloadMonthlyReportPdf(w.id, appState.selectedMonth)); closeModal();"
            class="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 rounded-xl text-xs font-bold border border-slate-700 active-press transition">
            📥 Alle Berichte herunterladen (${workers.length})
          </button>
        ` : ''}

        <div class="pt-2 border-t border-slate-800 flex justify-end">
          <button onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Schließen</button>
        </div>
      </div>
    `;
  }

  // 2. Change Password Modal
  else if (modal === 'changePassword') {
    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-5 sm:p-6 w-full max-w-sm animate-slide-up space-y-4 max-h-[88vh] overflow-y-auto my-auto shadow-2xl">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 class="text-base font-bold text-white">${t('change_password', 'Passwort ändern')}</h3>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <form onsubmit="handleChangePassword(event)" class="space-y-3">
          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">${t('current_password', 'Aktuelles Passwort')}</label>
            <input type="password" name="current_password" required placeholder="Aktuelles Passwort eingeben"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">${t('new_password', 'Neues Passwort')}</label>
            <input type="password" name="new_password" required placeholder="Neues Passwort eingeben"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div class="pt-3 flex justify-end gap-2">
            <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
            <button type="submit" class="bg-[#F5C000] hover:bg-[#ffd333] text-black px-4 py-2 rounded-xl text-xs font-bold active-press shadow-md">${t('update_password', 'Passwort aktualisieren')}</button>
          </div>
        </form>
      </div>
    `;
  }

  // 3. Add Supervisor or Worker (Leader action)
  else if (modal === 'addUser') {
    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-5 sm:p-6 w-full max-w-sm animate-slide-up space-y-4 max-h-[88vh] overflow-y-auto my-auto shadow-2xl">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 class="text-base font-bold text-white">Mitarbeiter registrieren</h3>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <form onsubmit="handleAddUser(event)" class="space-y-3">
          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Rolle</label>
            <select name="userRole" onchange="const wBox=document.getElementById('workerFields'); if(this.value==='worker'){wBox.classList.remove('hidden')}else{wBox.classList.add('hidden')}"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
              <option value="worker" selected>👷 Arbeiter (Arbeitskraft)</option>
              <option value="supervisor">🛡️ Supervisor (Freigeber / Zahler)</option>
            </select>
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Vollständiger Name</label>
            <input type="text" name="name" required placeholder="z.B. Ali Hasan"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Benutzername</label>
            <input type="text" name="username" required placeholder="z.B. ali_h"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Initiales Passwort</label>
            <input type="password" name="password" required placeholder="Passwort festlegen"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div id="workerFields" class="space-y-3">
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-0.5">Stundensatz Chef / Supervisor (€/Std.)</label>
              <span class="text-[10px] text-slate-400 block mb-1">Was der Chef/Kunde zahlt (nur für Chef & Leader sichtbar)</span>
              <input type="number" step="0.5" name="billing_rate" id="addUserBillingRate" value="30.00" oninput="updateAddUserCutPreview()"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-0.5">Auszahlungslohn an Arbeiter (€/Std.)</label>
              <span class="text-[10px] text-slate-400 block mb-1">Was du dem Arbeiter auszahlst (Arbeiter sieht nur dies)</span>
              <input type="number" step="0.5" name="hourly_rate" id="addUserHourlyRate" value="20.00" oninput="updateAddUserCutPreview()"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <!-- Dynamic Leader Cut Preview -->
            <div id="addUserCutPreview" class="p-2.5 rounded-xl bg-amber-950/40 border border-amber-800/60 flex items-center justify-between text-xs">
              <span class="text-slate-300 font-semibold">💰 Dein Leader-Anteil (Cut):</span>
              <span class="font-extrabold text-[#F5C000] text-sm">+10,00 € / Std.</span>
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Telefonnummer (Optional)</label>
              <input type="text" name="phone" placeholder="+49 170 0000000"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none">
            </div>
          </div>

          <div class="pt-3 flex justify-end gap-2 border-t border-slate-800">
            <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
            <button type="submit" class="bg-[#F5C000] hover:bg-[#ffd333] text-black px-4 py-2 rounded-xl text-xs font-bold active-press shadow-md">Registrieren</button>
          </div>
        </form>
      </div>
    `;
  }

  // 3b. Edit Worker Rates & Info (Leader action)
  else if (modal === 'editWorkerRates' && appState.modalPayload) {
    const worker = getWorker(appState.modalPayload);
    if (!worker) return '';

    const currentWorkerRate = parseFloat(worker.hourly_rate ?? worker.rate) || 20.0;
    const currentBillingRate = parseFloat(worker.billing_rate ?? currentWorkerRate) || currentWorkerRate;
    const currentCut = currentBillingRate - currentWorkerRate;

    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-5 sm:p-6 w-full max-w-sm animate-slide-up space-y-4 max-h-[88vh] overflow-y-auto my-auto shadow-2xl">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 class="text-base font-bold text-white">Raten & Lohn anpassen</h3>
            <p class="text-xs text-[#F5C000] font-semibold">${worker.name} (@${worker.username})</p>
          </div>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <form onsubmit="handleUpdateWorkerRates(event, '${worker.id}')" class="space-y-3.5">
          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Name des Mitarbeiters</label>
            <input type="text" name="name" value="${worker.name}" required
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-0.5">Abrechnungssatz Chef / Supervisor (€/Std.)</label>
            <span class="text-[10px] text-slate-400 block mb-1">Was der Chef/Supervisor zahlt (nur für Chef & Leader sichtbar)</span>
            <input type="number" step="0.5" name="billing_rate" id="editBillingRate" value="${currentBillingRate.toFixed(2)}" oninput="updateEditCutPreview()" required
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-0.5">Auszahlungslohn an Arbeiter (€/Std.)</label>
            <span class="text-[10px] text-slate-400 block mb-1">Was der Arbeiter erhält (Arbeiter sieht nur dies)</span>
            <input type="number" step="0.5" name="hourly_rate" id="editHourlyRate" value="${currentWorkerRate.toFixed(2)}" oninput="updateEditCutPreview()" required
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <!-- Dynamic Cut Readout -->
          <div id="editCutPreview" class="p-3 rounded-xl bg-gradient-to-r from-amber-950/60 to-[#141414] border border-amber-800/60 flex items-center justify-between text-xs">
            <div>
              <span class="text-slate-300 font-bold block">💰 Dein Leader-Gewinn (Cut):</span>
              <span class="text-[10px] text-slate-400">Differenz pro geleistete Arbeitsstunde</span>
            </div>
            <span id="editCutValue" class="font-black text-sm ${currentCut >= 0 ? 'text-[#F5C000]' : 'text-red-400'}">
              ${currentCut >= 0 ? '+' : ''}${formatCurrency(currentCut)}/h
            </span>
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Telefonnummer (Optional)</label>
            <input type="text" name="phone" value="${worker.phone || ''}" placeholder="+49 ..."
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none">
          </div>

          <div class="pt-3 border-t border-slate-800 flex justify-end gap-2">
            <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
            <button type="submit" class="bg-[#F5C000] hover:bg-[#ffd333] text-black px-4 py-2 rounded-xl text-xs font-bold shadow-md active-press">Raten speichern</button>
          </div>
        </form>
      </div>
    `;
  }

  // 4. Manual Shift Modal
  else if (modal === 'manualShift') {
    const crewWorkers = appData.workers.filter(w => w.role === 'worker');
    if (crewWorkers.length === 0) {
      modalContent = `
        <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-sm animate-slide-up space-y-4 text-center">
          <div class="text-3xl">👷</div>
          <h3 class="text-base font-bold text-white">Keine Mitarbeiter vorhanden</h3>
          <p class="text-xs text-slate-400">Bitte zuerst mindestens einen Mitarbeiter anlegen.</p>
          <div class="pt-2 flex justify-center gap-2">
            <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
            <button type="button" onclick="openModal('addUser')" class="bg-[#F5C000] text-black px-4 py-2 rounded-xl text-xs font-bold">+ Mitarbeiter anlegen</button>
          </div>
        </div>
      `;
    } else {
      modalContent = `
        <div class="bg-slate-900 border border-slate-700 rounded-3xl p-5 sm:p-6 w-full max-w-sm animate-slide-up space-y-4 max-h-[88vh] overflow-y-auto my-auto shadow-2xl">
          <div class="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h3 class="text-base font-bold text-white">Manuelle Schichterfassung</h3>
              <p class="text-[11px] text-slate-400">Stunden für mehrere Mitarbeiter gleichzeitig eintragen</p>
            </div>
            <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
          </div>

          <form onsubmit="handleSaveManualShift(event)" class="space-y-3.5">
            <div>
              <div class="flex items-center justify-between mb-1.5">
                <label class="text-xs font-semibold text-slate-300">Mitarbeiter auswählen</label>
                <div class="flex items-center gap-2 text-[11px]">
                  <button type="button" onclick="toggleAllManualShiftWorkers(true)" class="text-[#F5C000] hover:underline font-bold">Alle wählen</button>
                  <span class="text-slate-600">|</span>
                  <button type="button" onclick="toggleAllManualShiftWorkers(false)" class="text-slate-400 hover:underline">Keine</button>
                </div>
              </div>

              <div class="bg-slate-800/80 border border-slate-700 rounded-2xl p-2 max-h-40 overflow-y-auto space-y-1.5">
                ${crewWorkers.map((w, idx) => `
                  <label class="flex items-center justify-between p-2 rounded-xl bg-slate-900/60 hover:bg-slate-900 border border-slate-700/50 cursor-pointer transition select-none">
                    <div class="flex items-center gap-2.5">
                      <input type="checkbox" name="workerId" value="${w.id}" ${idx === 0 ? 'checked' : ''} onchange="updateManualWorkersSelectedCount()"
                        class="w-4 h-4 rounded text-[#F5C000] bg-slate-800 border-slate-600 focus:ring-0 focus:ring-offset-0 cursor-pointer">
                      <span class="text-xs font-bold text-white">${w.name}</span>
                    </div>
                    <span class="text-[11px] text-slate-400 font-mono">${formatCurrency(w.hourly_rate || w.rate)}/h</span>
                  </label>
                `).join('')}
              </div>
              <div class="flex items-center justify-between mt-1 text-[11px] text-slate-400 px-1">
                <span id="manualWorkerCountBadge" class="font-semibold text-slate-300">1 von ${crewWorkers.length} ausgewählt</span>
                <span class="text-emerald-400 text-[10px]">✓ Mehrfachauswahl aktiv</span>
              </div>
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Datum</label>
              <input type="date" name="date" value="${getTodayString()}" required class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <!-- Rounding Option Toggle (Requirement 2) -->
            <label class="flex items-center justify-between p-2.5 bg-slate-800/80 rounded-xl border border-slate-700 cursor-pointer">
              <div class="flex items-center gap-2">
                <span class="text-sm">🕒</span>
                <div>
                  <span class="text-xs font-bold text-white block">${t('round_toggle', '30-Minuten-Rundung aktivieren')}</span>
                  <span class="text-[10px] text-slate-400 block">Rundet Beginn und Ende auf 30-Minuten-Intervalle</span>
                </div>
              </div>
              <input type="checkbox" name="roundTimeToggle" checked onchange="updateManualHoursPreview()" class="w-4 h-4 rounded text-[#F5C000] bg-slate-900 border-slate-600 focus:ring-0 cursor-pointer">
            </label>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="text-xs font-semibold text-slate-300 block mb-1">Beginn</label>
                <input type="time" name="startTime" id="manualStartTime" value="08:00" required 
                  onchange="updateManualHoursPreview();"
                  class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none font-mono focus:border-[#F5C000]">
              </div>
              <div>
                <label class="text-xs font-semibold text-slate-300 block mb-1">Ende</label>
                <input type="time" name="endTime" id="manualEndTime" value="16:30" required 
                  onchange="updateManualHoursPreview();"
                  class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none font-mono focus:border-[#F5C000]">
              </div>
            </div>

            <!-- Live Hours Preview -->
            <div class="bg-slate-800/60 p-2 rounded-xl border border-slate-700 flex items-center justify-between text-xs">
              <span class="text-slate-400 flex items-center gap-1 text-[11px]">
                <span>⏱️</span> <span>Berechnete Arbeitszeit:</span>
              </span>
              <span id="manualShiftHoursPreview" class="font-bold text-emerald-400 font-mono text-xs">8.0 Std. (08:00 - 16:30)</span>
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Pause (Minuten)</label>
              <input type="number" name="breakMinutes" id="manualBreakMinutes" value="30" min="0" max="240" step="5"
                oninput="updateManualHoursPreview()"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Notiz / Baustelle</label>
              <input type="text" name="note" placeholder="z.B. Baustelle Neubau" class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <!-- Media / Photos upload section (Requirement 5) -->
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="text-xs font-semibold text-slate-300">📷 ${t('upload_photos', 'Fotos hinzufügen (Tagesende)')}</label>
                <span class="text-[10px] text-slate-400 font-mono">${(appState.manualShiftMedia || []).length} Fotos</span>
              </div>
              <input type="file" id="manualShiftFileInput" accept="image/*" multiple class="hidden" onchange="handleModalImageUpload(event, 'manualShift')">
              <button type="button" onclick="document.getElementById('manualShiftFileInput').click()" class="w-full bg-slate-800 hover:bg-slate-750 border border-dashed border-slate-600 text-slate-300 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 active-press transition">
                <span>📷</span> <span>+ Fotos auswählen / aufnehmen</span>
              </button>
              ${(appState.manualShiftMedia || []).length > 0 ? `
                <div class="flex items-center gap-2 mt-2 overflow-x-auto py-1">
                  ${appState.manualShiftMedia.map((img, idx) => `
                    <div class="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-600 flex-shrink-0 group">
                      <img src="${img}" class="w-full h-full object-cover">
                      <button type="button" onclick="removeModalImage('manualShift', ${idx})" class="absolute top-0 right-0 bg-red-600 text-white w-4 h-4 rounded-bl text-[10px] font-bold flex items-center justify-center">✕</button>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>

            <div class="pt-3 border-t border-slate-800 flex justify-end gap-2">
              <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
              <button type="submit" id="manualShiftSubmitBtn" class="bg-[#F5C000] hover:bg-[#ffd333] text-black px-4 py-2.5 rounded-xl text-xs font-bold shadow-md active-press transition">
                Schicht erfassen
              </button>
            </div>
          </form>
        </div>
      `;
    }
  }

  // 5. Log Payment Modal
  else if (modal === 'logPayment') {
    const crewWorkers = appData.workers.filter(w => w.role === 'worker');
    if (crewWorkers.length === 0) {
      modalContent = `
        <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-sm animate-slide-up space-y-4 text-center">
          <div class="text-3xl">💵</div>
          <h3 class="text-base font-bold text-white">Keine Mitarbeiter vorhanden</h3>
          <p class="text-xs text-slate-400">Bitte zuerst Mitarbeiter anlegen, bevor Auszahlungen erfasst werden können.</p>
          <div class="pt-2 flex justify-center gap-2">
            <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
            <button type="button" onclick="openModal('addUser')" class="bg-[#F5C000] text-black px-4 py-2 rounded-xl text-xs font-bold">+ Mitarbeiter anlegen</button>
          </div>
        </div>
      `;
    } else {
      const preselectedWorkerId = (appState.modalPayload && crewWorkers.some(w => w.id === appState.modalPayload))
        ? appState.modalPayload
        : crewWorkers[0].id;
      const initialFin = calculateWorkerFinancials(preselectedWorkerId);
      const initialRemaining = Math.max(0, initialFin.workerBalance);

      modalContent = `
        <div class="bg-slate-900 border border-slate-700 rounded-3xl p-5 sm:p-6 w-full max-w-sm animate-slide-up space-y-4 max-h-[88vh] overflow-y-auto my-auto shadow-2xl">
          <div class="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h3 class="text-base font-bold text-white">Auszahlung erfassen</h3>
              <p class="text-[11px] text-slate-400">Lohnzahlung an Mitarbeiter dokumentieren</p>
            </div>
            <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
          </div>

          <form onsubmit="handleSavePayment(event)" class="space-y-3.5">
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Mitarbeiter</label>
              <select name="workerId" id="logPaymentWorkerSelect" required onchange="updateLogPaymentWorkerStats(this.value)"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
                ${crewWorkers.map(w => `<option value="${w.id}" ${w.id === preselectedWorkerId ? 'selected' : ''}>${w.name} (${formatCurrency(w.hourly_rate || w.rate)}/h)</option>`).join('')}
              </select>
            </div>

            <!-- Live Payment Stats Box for Selected Worker -->
            <div id="logPaymentStatsBox" class="p-3 bg-slate-800/90 border border-slate-700 rounded-2xl space-y-2 text-xs">
              <div class="flex items-center justify-between">
                <span class="text-slate-400">Total Lohnanspruch:</span>
                <span class="font-bold text-white text-sm" id="payStatsTotal">${formatCurrency(initialFin.workerEarned)} (${initialFin.totalHours.toFixed(1)} Std.)</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-slate-400">Bereits bezahlt:</span>
                <span class="font-bold text-blue-400 text-sm" id="payStatsPaid">${formatCurrency(initialFin.totalPaid)}</span>
              </div>
              <div class="flex items-center justify-between border-t border-slate-700/70 pt-2">
                <span class="text-[#F5C000] font-bold">Noch offen (Restbetrag):</span>
                <span class="${initialRemaining > 0 ? 'font-black text-sm text-emerald-400' : 'font-bold text-sm text-slate-400'}" id="payStatsRemaining">${formatCurrency(initialRemaining)}</span>
              </div>
              <div class="pt-1">
                <button type="button" onclick="fillPaymentRemainingAmount()" 
                  class="w-full bg-amber-950/40 hover:bg-amber-900/60 text-[#F5C000] border border-amber-800/60 py-1.5 px-2.5 rounded-xl text-[11px] font-bold transition flex items-center justify-center gap-1.5 active-press">
                  <span>👉</span> <span>Restbetrag automatisch übernehmen</span>
                </button>
              </div>
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Auszahlungsbetrag (€)</label>
              <input type="number" step="0.01" name="amount" id="logPaymentAmountInput" value="${initialRemaining > 0 ? initialRemaining.toFixed(2) : ''}" placeholder="0.00" required
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000] font-mono">
            </div>

            <!-- Direct Approval Checkbox (Requirement 8) -->
            <label class="flex items-center gap-2.5 p-2.5 bg-slate-800/80 rounded-xl border border-slate-700 cursor-pointer">
              <input type="checkbox" name="markApproved" checked class="w-4 h-4 rounded text-emerald-500 bg-slate-900 border-slate-600 focus:ring-0 cursor-pointer">
              <div>
                <span class="text-xs font-bold text-white block">${t('mark_approved_directly', 'Direkt als genehmigt buchen (vom Lohn abziehen)')}</span>
                <span class="text-[10px] text-slate-400 block">Wird sofort vom Restbetrag des Arbeiters abgezogen</span>
              </div>
            </label>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Empfänger / Bestätigung</label>
              <input type="text" name="receivedBy" placeholder="Wer hat das Geld entgegengenommen?" class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Datum</label>
              <input type="date" name="date" value="${getTodayString()}" required class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Notiz / Zahlungsart (Optional)</label>
              <input type="text" name="comment" placeholder="z.B. Bar bezahlt, Überweisung..." class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
            </div>

            <div class="pt-3 border-t border-slate-800 flex justify-end gap-2">
              <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
              <button type="submit" id="savePaymentSubmitBtn" class="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-md active-press transition">
                Zahlung buchen
              </button>
            </div>
          </form>
        </div>
      `;
    }
  }

  // 6. Confirm Stop Timer Modal (Requirement 2 & 5)
  else if (modal === 'stopTimerConfirm' && appState.modalPayload) {
    const p = appState.modalPayload;
    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-5 sm:p-6 w-full max-w-sm animate-slide-up space-y-4 max-h-[88vh] overflow-y-auto my-auto shadow-2xl">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 class="text-base font-bold text-white">Schicht beenden</h3>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <div class="space-y-3">
          <div class="bg-slate-800/60 p-3 rounded-2xl border border-slate-700 space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400">Mitarbeiter:</span>
              <span class="text-white font-bold text-sm">${p.workerName}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-xs text-slate-400">Verstrichene Zeit:</span>
              <span class="text-emerald-400 font-mono font-bold">${formatElapsedSeconds(p.elapsedSeconds)}</span>
            </div>
            <div class="pt-1 border-t border-slate-700/60 flex items-center justify-between text-[11px]">
              <span class="text-slate-400">Erfasste Stempelzeiten:</span>
              <span class="text-slate-300 font-mono">${p.rawStartTime} - ${p.rawEndTime}</span>
            </div>
          </div>

          <!-- Rounding Option Toggle Switch (Requirement 2) -->
          <label class="flex items-center justify-between p-2.5 bg-slate-800/80 rounded-xl border border-slate-700 cursor-pointer">
            <div class="flex items-center gap-2">
              <span class="text-sm">🕒</span>
              <div>
                <span class="text-xs font-bold text-white block">${t('round_toggle', '30-Minuten-Rundung aktivieren')}</span>
                <span class="text-[10px] text-slate-400 block">${p.roundTime ? 'Rundet Start/Ende auf halbe Stunden' : 'Exakte Minuten verwenden'}</span>
              </div>
            </div>
            <input type="checkbox" ${p.roundTime ? 'checked' : ''} onchange="toggleStopTimerRounding(this.checked)" class="w-4 h-4 rounded text-[#F5C000] bg-slate-900 border-slate-600 focus:ring-0 cursor-pointer">
          </label>

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Startzeit</label>
              <input type="time" value="${p.startTime}" 
                onchange="appState.modalPayload.startTime = this.value; updateStopTimerHours();"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none font-mono">
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Endzeit</label>
              <input type="time" value="${p.endTime}" 
                onchange="appState.modalPayload.endTime = this.value; updateStopTimerHours();"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none font-mono">
            </div>
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Pause abziehen (Minuten)</label>
            <input type="number" value="${p.breakMinutes}" min="0" max="240" step="5"
              oninput="appState.modalPayload.breakMinutes = this.value; updateStopTimerHours();"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none">
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-semibold text-slate-300">Geleistete Arbeitszeit</label>
              <span class="text-[10px] text-emerald-400 font-semibold bg-emerald-950/60 px-2 py-0.5 rounded-full border border-emerald-800/40">
                ${p.roundTime ? '30m Intervall' : 'Exakt'}
              </span>
            </div>
            <input type="number" step="0.5" id="stopTimerHoursInput" value="${p.calculatedHours}" 
              onchange="appState.modalPayload.calculatedHours = parseFloat(this.value) || 0"
              class="w-full bg-slate-800 border border-slate-700 text-emerald-400 font-bold rounded-xl px-3 py-2 text-base focus:outline-none font-mono">
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Notiz / Baustelle</label>
            <input type="text" value="${p.note}" onchange="appState.modalPayload.note=this.value"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none">
          </div>

          <!-- Media / Photos upload section (Requirement 5) -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-semibold text-slate-300">📷 ${t('upload_photos', 'Fotos hinzufügen (Tagesende)')}</label>
              <span class="text-[10px] text-slate-400 font-mono">${(p.media || []).length} Fotos</span>
            </div>
            <input type="file" id="clockoutMediaFileInput" accept="image/*" multiple class="hidden" onchange="handleModalImageUpload(event, 'stopTimerConfirm')">
            <button type="button" onclick="document.getElementById('clockoutMediaFileInput').click()" class="w-full bg-slate-800 hover:bg-slate-750 border border-dashed border-slate-600 text-slate-300 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 active-press transition">
              <span>📷</span> <span>+ Fotos auswählen / aufnehmen</span>
            </button>
            ${(p.media || []).length > 0 ? `
              <div class="flex items-center gap-2 mt-2 overflow-x-auto py-1">
                ${p.media.map((img, idx) => `
                  <div class="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-600 flex-shrink-0 group">
                    <img src="${img}" class="w-full h-full object-cover">
                    <button type="button" onclick="removeModalImage('stopTimerConfirm', ${idx})" class="absolute top-0 right-0 bg-red-600 text-white w-4 h-4 rounded-bl text-[10px] font-bold flex items-center justify-center">✕</button>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        </div>

        <div class="pt-3 flex justify-end gap-2">
          <button onclick="closeModal()" class="bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
          <button onclick="handleConfirmStopTimer()" id="stopTimerSubmitBtn" class="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-xl text-xs font-bold active-press shadow-md transition">
            ${t('stop_and_submit', 'Schicht abschließen & senden')}
          </button>
        </div>
      </div>
    `;
  }

  // 7. Edit Shift Modal (Requirement 1 & Leader Only)
  else if (modal === 'editShift' && appState.modalPayload) {
    const p = appState.modalPayload;
    const crewWorkers = appData.workers.filter(w => w.role === 'worker');

    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-sm animate-slide-up space-y-4 max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 class="text-base font-bold text-white">✏️ Schicht bearbeiten</h3>
            <p class="text-[11px] text-slate-400">Nur Leiter können Schichten anpassen oder löschen</p>
          </div>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <form onsubmit="handleSaveEditedShift(event)" class="space-y-3.5">
          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Mitarbeiter</label>
            <select name="workerId" required class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
              ${crewWorkers.map(w => `<option value="${w.id}" ${w.id === p.workerId ? 'selected' : ''}>${w.name}</option>`).join('')}
            </select>
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Datum</label>
            <input type="date" name="date" value="${p.date}" required class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#F5C000]">
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Beginn</label>
              <input type="time" name="startTime" id="editStartTime" value="${p.startTime}" required 
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none font-mono focus:border-[#F5C000]">
            </div>
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Ende</label>
              <input type="time" name="endTime" id="editEndTime" value="${p.endTime}" required 
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none font-mono focus:border-[#F5C000]">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Pause (Min.)</label>
              <input type="number" name="breakMinutes" id="editBreakMinutes" value="${p.breakMinutes}" min="0" max="240" step="5"
                class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none">
            </div>

            <div>
              <label class="text-xs font-semibold text-slate-300 block mb-1">Status</label>
              <select name="status" class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none">
                <option value="pending" ${p.status === 'pending' ? 'selected' : ''}>🟡 Ausstehend</option>
                <option value="approved" ${p.status === 'approved' ? 'selected' : ''}>🟢 Genehmigt</option>
                <option value="rejected" ${p.status === 'rejected' ? 'selected' : ''}>🔴 Abgelehnt</option>
              </select>
            </div>
          </div>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Notiz / Baustelle</label>
            <input type="text" name="note" value="${p.note}" class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-sm focus:outline-none">
          </div>

          <!-- Photos in edit modal -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs font-semibold text-slate-300">📷 Fotos (${(p.media || []).length})</label>
            </div>
            <input type="file" id="editShiftFileInput" accept="image/*" multiple class="hidden" onchange="handleModalImageUpload(event, 'editShift')">
            <button type="button" onclick="document.getElementById('editShiftFileInput').click()" class="w-full bg-slate-800 hover:bg-slate-750 border border-dashed border-slate-600 text-slate-300 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 active-press transition">
              <span>📷</span> <span>+ Fotos hinzufügen / ändern</span>
            </button>
            ${(p.media || []).length > 0 ? `
              <div class="flex items-center gap-2 mt-2 overflow-x-auto py-1">
                ${p.media.map((img, idx) => `
                  <div class="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-600 flex-shrink-0">
                    <img src="${img}" class="w-full h-full object-cover">
                    <button type="button" onclick="removeModalImage('editShift', ${idx})" class="absolute top-0 right-0 bg-red-600 text-white w-4 h-4 rounded-bl text-[10px] font-bold flex items-center justify-center">✕</button>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>

          <div class="pt-3 border-t border-slate-800 flex justify-between gap-2">
            <button type="button" onclick="handleDeleteShift('${p.id}'); closeModal();" class="bg-red-600/80 hover:bg-red-600 text-white px-3 py-2 rounded-xl text-xs font-bold active-press transition">
              🗑️ Löschen
            </button>

            <div class="flex gap-2">
              <button type="button" onclick="closeModal()" class="bg-slate-800 text-slate-300 px-3.5 py-2 rounded-xl text-xs font-semibold">Abbrechen</button>
              <button type="submit" id="editShiftSubmitBtn" class="bg-[#F5C000] hover:bg-[#ffd333] text-black px-4 py-2 rounded-xl text-xs font-bold active-press transition">
                Speichern
              </button>
            </div>
          </div>
        </form>
      </div>
    `;
  }

  // 8. Payment Invoice / Receipt Modal (Requirement 7)
  else if (modal === 'paymentInvoice' && appState.modalPayload) {
    const paymentId = appState.modalPayload;
    const p = (appData.payments || []).find(x => x.id === paymentId) || (getLocalDb().payments || []).find(x => x.id === paymentId);
    const wid = p ? (p.workerId || p.worker_id) : null;
    const worker = wid ? getWorker(wid) : null;

    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-md animate-slide-up space-y-4 max-h-[92vh] overflow-y-auto">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div class="flex items-center gap-2">
            <span class="text-xl">📄</span>
            <h3 class="text-base font-bold text-white">Zahlungsbeleg & Quittung</h3>
          </div>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        ${!p ? `
          <div class="p-6 text-center text-slate-400 text-sm">Zahlung nicht gefunden</div>
        ` : `
          <!-- Printable Invoice / Receipt Box -->
          <div class="bg-[#141414] border border-[#2e2e2e] rounded-2xl p-4 space-y-4 shadow-inner text-slate-200">
            <!-- Header Banner -->
            <div class="border-b border-[#2a2a2a] pb-3 flex items-start justify-between">
              <div>
                <div class="text-lg font-black text-white leading-none">alles<span class="text-[#F5C000]">Bau</span></div>
                <div class="text-[10px] text-slate-400 font-semibold mt-0.5">Bauunternehmen • Lohnverwaltung</div>
              </div>
              <div class="text-right">
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${p.status === 'approved' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-amber-950 text-amber-300 border border-amber-800'}">
                  ${p.status === 'approved' ? '🟢 GENEHMIGT' : '🟡 AUSSTEHEND'}
                </span>
                <div class="text-[9px] font-mono text-slate-500 mt-1">#AB-PAY-${(p.id || '').replace('p_', '').toUpperCase()}</div>
              </div>
            </div>

            <!-- Payee & Payment Info -->
            <div class="grid grid-cols-2 gap-3 text-xs bg-slate-800/40 p-3 rounded-xl border border-slate-700/50">
              <div>
                <span class="text-[10px] uppercase font-bold text-slate-400 block">Empfänger (Arbeitnehmer)</span>
                <span class="font-bold text-white text-sm block mt-0.5">${worker ? worker.name : (p.receivedBy || 'Mitarbeiter')}</span>
                <span class="text-[10px] text-slate-400 block">${worker ? `@${worker.username} • ID: ${worker.id}` : ''}</span>
              </div>

              <div>
                <span class="text-[10px] uppercase font-bold text-slate-400 block">Zahlungsdetails</span>
                <span class="font-bold text-slate-200 block mt-0.5">${formatDate(p.date)}</span>
                <span class="text-[10px] text-slate-400 block">Ausgezahlt: ${p.loggedBy || 'AllesBau'}</span>
              </div>
            </div>

            <!-- Amount Highlight Box -->
            <div class="bg-gradient-to-r from-amber-950/40 to-slate-900 border border-amber-800/60 rounded-xl p-3.5 text-center">
              <span class="text-[10px] uppercase font-bold text-amber-300 block">Netto-Auszahlungsbetrag</span>
              <div class="text-2xl font-black text-[#F5C000] mt-0.5">${formatCurrency(p.amount)}</div>
              <div class="text-[11px] text-slate-300 mt-1 italic">
                ${p.comment ? `Verwendungszweck: "${p.comment}"` : 'Reguläre Lohnabschlagszahlung'}
              </div>
            </div>

            <!-- Confirmation Legal Text (German) -->
            <div class="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 text-[10px] text-slate-400 italic leading-relaxed">
              Hiermit wird bestätigt, dass der oben genannte Auszahlungsbetrag ordnungsgemäß ausgezahlt und vom Empfänger vollständig erhalten wurde. Der Betrag wird mit dem bestehenden Lohnanspruch verrechnet.
            </div>

            <!-- Signature Boxes -->
            <div class="grid grid-cols-2 gap-3 pt-2 text-[10px]">
              <div class="border-t border-slate-600 pt-1.5 text-center">
                <span class="font-bold text-slate-300 block">AllesBau (Arbeitgeber)</span>
                <span class="text-slate-500 italic block mt-0.5">Unterschrift / Bestätigung</span>
              </div>

              <div class="border-t border-slate-600 pt-1.5 text-center">
                <span class="font-bold text-slate-300 block">${worker ? worker.name : (p.receivedBy || 'Arbeitnehmer')}</span>
                <span class="text-slate-500 italic block mt-0.5">Unterschrift des Empfängers</span>
              </div>
            </div>
          </div>

          <!-- Actions -->
          <div class="pt-2 flex flex-wrap items-center justify-between gap-2">
            <button onclick="downloadPaymentInvoicePdf('${p.id}')" 
              class="bg-[#F5C000] hover:bg-[#ffd333] text-black font-black px-4 py-2.5 rounded-xl text-xs flex items-center gap-1.5 active-press shadow-md transition">
              <span>📥</span> <span>PDF Herunterladen</span>
            </button>

            <div class="flex items-center gap-2">
              <button onclick="window.print()" class="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-2 rounded-xl text-xs font-semibold active-press transition flex items-center gap-1">
                <span>🖨️</span> <span>Drucken</span>
              </button>
              <button onclick="closeModal()" class="bg-slate-800 text-slate-300 px-3 py-2 rounded-xl text-xs font-semibold">
                Schließen
              </button>
            </div>
          </div>
        `}
      </div>
    `;
  }

  // 9. Media Viewer / Lightbox Modal (Requirement 5 & 6)
  else if (modal === 'mediaViewer' && appState.modalPayload) {
    const p = appState.modalPayload;
    const images = Array.isArray(p.images) ? p.images : [];
    const activeIndex = p.activeIndex || 0;
    const currentImg = images[activeIndex] || images[0];

    modalContent = `
      <div class="bg-black/95 border border-slate-700 rounded-3xl p-4 w-full max-w-lg animate-slide-up space-y-3">
        <div class="flex items-center justify-between border-b border-slate-800 pb-2">
          <div class="flex items-center gap-2">
            <span class="text-base">📷</span>
            <h3 class="text-sm font-bold text-white">${p.title || 'Fotos'}</h3>
            <span class="text-xs text-slate-400">(${activeIndex + 1} / ${images.length})</span>
          </div>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1 text-sm">✕</button>
        </div>

        ${images.length === 0 ? `
          <div class="p-8 text-center text-slate-500 text-xs">Keine Fotos vorhanden</div>
        ` : `
          <!-- Main Full Photo Display -->
          <div class="relative w-full max-h-[60vh] flex items-center justify-center bg-black rounded-2xl overflow-hidden border border-slate-800">
            <img src="${currentImg}" class="max-w-full max-h-[58vh] object-contain rounded-xl">

            ${images.length > 1 ? `
              <button onclick="appState.modalPayload.activeIndex = (appState.modalPayload.activeIndex - 1 + ${images.length}) % ${images.length}; renderApp();"
                class="absolute left-2 top-1/2 -translate-y-1/2 bg-black/70 hover:bg-black text-white p-2 rounded-full border border-slate-600 transition">
                ◀
              </button>
              <button onclick="appState.modalPayload.activeIndex = (appState.modalPayload.activeIndex + 1) % ${images.length}; renderApp();"
                class="absolute right-2 top-1/2 -translate-y-1/2 bg-black/70 hover:bg-black text-white p-2 rounded-full border border-slate-600 transition">
                ▶
              </button>
            ` : ''}
          </div>

          <!-- Thumbnails Strip -->
          ${images.length > 1 ? `
            <div class="flex items-center gap-2 overflow-x-auto py-1">
              ${images.map((img, idx) => `
                <button type="button" onclick="appState.modalPayload.activeIndex = ${idx}; renderApp();"
                  class="w-14 h-14 rounded-lg overflow-hidden border-2 flex-shrink-0 transition ${idx === activeIndex ? 'border-[#F5C000] scale-105' : 'border-slate-700 opacity-60'}">
                  <img src="${img}" class="w-full h-full object-cover">
                </button>
              `).join('')}
            </div>
          ` : ''}
        `}

        <div class="pt-2 flex justify-end">
          <button onclick="closeModal()" class="bg-slate-800 hover:bg-slate-700 text-white px-4 py-2 rounded-xl text-xs font-semibold">
            Schließen
          </button>
        </div>
      </div>
    `;
  }

  // 10. Server / Backend Config Modal
  else if (modal === 'serverConfig') {
    const currentUrl = localStorage.getItem('allesbau_backend_url') || '';
    modalContent = `
      <div class="bg-slate-900 border border-slate-700 rounded-3xl p-6 w-full max-w-sm animate-slide-up space-y-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 class="text-base font-bold text-white">⚙️ Cloud / Backend Setup</h3>
          <button onclick="closeModal()" class="text-slate-400 hover:text-white p-1">✕</button>
        </div>

        <div class="space-y-3">
          <p class="text-xs text-slate-300 leading-relaxed">
            Wähle zwischen <b>Lokaler Browser-Datenbank</b> (sofort einsatzbereit ohne Installation) oder Verbindung zu deinem <b>PythonAnywhere Backend</b>.
          </p>

          <div>
            <label class="text-xs font-semibold text-slate-300 block mb-1">Backend URL (optional)</label>
            <input type="url" id="customBackendInput" value="${currentUrl}" placeholder="https://username.pythonanywhere.com"
              class="w-full bg-slate-800 border border-slate-700 text-white rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-amber-400 font-mono">
            <span class="text-[10px] text-slate-400 mt-1 block">Leer lassen für lokale Browser-Datenbank.</span>
          </div>

          <div class="pt-2 flex flex-col gap-2">
            <button onclick="saveBackendConfig()" class="w-full bg-[#F5C000] hover:bg-[#ffd333] text-black py-2.5 rounded-xl text-xs font-bold shadow-md active-press">
              Server-Einstellungen speichern
            </button>
            <button onclick="useLocalModeConfig()" class="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 py-2.5 rounded-xl text-xs font-semibold border border-slate-700">
              Lokale Datenbank nutzen
            </button>
            <button onclick="handleClearAllData()" class="w-full bg-red-950/40 hover:bg-red-900/60 text-red-300 py-2.5 rounded-xl text-xs font-semibold border border-red-800/40">
              🗑️ Alle Daten löschen (Datenbank zurücksetzen)
            </button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      ${modalContent}
    </div>
  `;
}

function updateStopTimerHours() {
  if (!appState.modalPayload) return;
  const p = appState.modalPayload;
  const hrs = calculateShiftHours(p.startTime, p.endTime, p.breakMinutes);
  p.calculatedHours = hrs;
  const input = document.getElementById('stopTimerHoursInput');
  if (input) input.value = hrs;
}

function updateManualHoursPreview() {
  const form = document.querySelector('form[onsubmit="handleSaveManualShift(event)"]');
  const sInput = document.getElementById('manualStartTime');
  const eInput = document.getElementById('manualEndTime');
  const bInput = document.getElementById('manualBreakMinutes');
  const preview = document.getElementById('manualShiftHoursPreview');
  if (sInput && eInput && preview) {
    const roundTime = form && form.roundTimeToggle ? form.roundTimeToggle.checked : true;
    const s = roundTime ? roundTimeTo30Minutes(sInput.value) : sInput.value;
    const e = roundTime ? roundTimeTo30Minutes(eInput.value) : eInput.value;
    const b = bInput ? parseInt(bInput.value) || 0 : 0;
    const hrs = calculateShiftHours(s, e, b);
    preview.textContent = `${hrs.toFixed(1)} Std. (${s} - ${e})${roundTime ? ' [30m]' : ' [Exakt]'}`;
  }
}

async function handleModalImageUpload(event, modalType) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  showToast('Fotos werden verarbeitet... ⏳', 'info');
  for (const f of files) {
    try {
      const base64 = await compressImageFile(f);
      if (modalType === 'manualShift') {
        appState.manualShiftMedia = appState.manualShiftMedia || [];
        appState.manualShiftMedia.push(base64);
      } else if (appState.modalPayload) {
        appState.modalPayload.media = appState.modalPayload.media || [];
        if (typeof appState.modalPayload.media === 'string') {
          try { appState.modalPayload.media = JSON.parse(appState.modalPayload.media) || []; } catch(e) { appState.modalPayload.media = []; }
        }
        appState.modalPayload.media.push(base64);
      }
    } catch (e) {}
  }
  renderApp();
}

function removeModalImage(modalType, index) {
  if (modalType === 'manualShift') {
    if (appState.manualShiftMedia) appState.manualShiftMedia.splice(index, 1);
  } else if (appState.modalPayload && appState.modalPayload.media) {
    if (Array.isArray(appState.modalPayload.media)) {
      appState.modalPayload.media.splice(index, 1);
    }
  }
  renderApp();
}

function toggleAllManualShiftWorkers(checkAll) {
  const form = document.querySelector('form[onsubmit="handleSaveManualShift(event)"]');
  if (!form) return;
  const cbs = form.querySelectorAll('input[name="workerId"]');
  cbs.forEach(cb => { cb.checked = checkAll; });
  updateManualWorkersSelectedCount();
}

function updateManualWorkersSelectedCount() {
  const form = document.querySelector('form[onsubmit="handleSaveManualShift(event)"]');
  if (!form) return;
  const total = form.querySelectorAll('input[name="workerId"]').length;
  const checked = form.querySelectorAll('input[name="workerId"]:checked').length;
  const badge = document.getElementById('manualWorkerCountBadge');
  if (badge) {
    badge.textContent = `${checked} von ${total} ausgewählt`;
  }
  const submitBtn = document.getElementById('manualShiftSubmitBtn');
  if (submitBtn) {
    submitBtn.textContent = checked > 1 ? `Schichten für ${checked} Mitarbeiter erfassen` : (checked === 1 ? 'Schicht erfassen' : 'Kein Mitarbeiter gewählt');
    submitBtn.disabled = checked === 0;
    submitBtn.classList.toggle('opacity-50', checked === 0);
  }
}

function updateLogPaymentWorkerStats(workerId) {
  if (!workerId) return;
  const fin = calculateWorkerFinancials(workerId);
  const totalEl = document.getElementById('payStatsTotal');
  const paidEl = document.getElementById('payStatsPaid');
  const remEl = document.getElementById('payStatsRemaining');

  if (totalEl) totalEl.textContent = `${formatCurrency(fin.workerEarned)} (${fin.totalHours.toFixed(1)} Std.)`;
  if (paidEl) paidEl.textContent = formatCurrency(fin.totalPaid);
  if (remEl) {
    const remaining = Math.max(0, fin.workerBalance);
    remEl.textContent = formatCurrency(remaining);
    remEl.className = remaining > 0 ? 'font-black text-sm text-emerald-400' : 'font-bold text-sm text-slate-400';
  }

  const amtInput = document.getElementById('logPaymentAmountInput');
  if (amtInput && (!amtInput.value || parseFloat(amtInput.value) === 0)) {
    const remaining = Math.max(0, fin.workerBalance);
    amtInput.value = remaining > 0 ? remaining.toFixed(2) : '';
  }
}

function fillPaymentRemainingAmount() {
  const sel = document.getElementById('logPaymentWorkerSelect');
  if (!sel) return;
  const fin = calculateWorkerFinancials(sel.value);
  const remaining = Math.max(0, fin.workerBalance);
  const input = document.getElementById('logPaymentAmountInput');
  if (input) {
    input.value = remaining > 0 ? remaining.toFixed(2) : '0.00';
  }
}

function saveBackendConfig() {
  const input = document.getElementById('customBackendInput');
  if (input) {
    const val = input.value.trim().replace(/\/+$/, '');
    if (val) {
      localStorage.setItem('allesbau_backend_url', val);
      showToast(`Verbunden mit: ${val}`, 'info');
    } else {
      localStorage.removeItem('allesbau_backend_url');
      showToast('Auf Lokale Browser-Datenbank umgestellt');
    }
  }
  closeModal();
  syncOnAppOpen();
  renderApp();
}

function useLocalModeConfig() {
  localStorage.removeItem('allesbau_backend_url');
  showToast('Auf Lokale Browser-Datenbank umgestellt');
  closeModal();
  syncOnAppOpen();
  renderApp();
}

function handleClearAllData() {
  if (confirm('Möchtest du wirklich ALLE Daten löschen? Alle Mitarbeiter, Schichten und Zahlungen werden gelöscht. Du startest komplett sauber.')) {
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('crewhours_') || k.startsWith('allesbau_'))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch (e) {}
    localStorage.setItem('allesbau_storage_version', ALLESBAU_STORAGE_TAG);
    localStorage.setItem('allesbau_local_db_prod', JSON.stringify(INITIAL_LOCAL_DB));
    authState = { token: null, user: null };
    appData = JSON.parse(JSON.stringify(DEFAULT_DATA));
    closeModal();
    showToast('Alle Daten wurden vollständig gelöscht! 🗑️', 'info');
    renderApp();
  }
}

function clearLocalAppCache() {
  handleClearAllData();
}

// -------------------------------------------------------------
// RENDER DISPATCHERS
// -------------------------------------------------------------

function renderAppSilently() {
  if (!authState.token) return;
  const root = document.getElementById('app-root');
  if (!root) return;

  // Selective update without interrupting focused form inputs
  if (!appState.activeModal) {
    let bodyContent = appState.activeTab === 'home' ? renderHome() : appState.activeTab === 'calendar' ? renderCalendar() : renderPayments();
    const mainEl = root.querySelector('main');
    if (mainEl) mainEl.innerHTML = bodyContent;
  }
}

function renderApp() {
  const root = document.getElementById('app-root');
  if (!root) return;

  if (!authState.token) {
    root.innerHTML = renderAuthScreen();
    return;
  }

  let bodyContent = appState.activeTab === 'home' ? renderHome() : appState.activeTab === 'calendar' ? renderCalendar() : renderPayments();

  root.innerHTML = `
    <div class="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans pb-24">
      ${renderHeader()}
      <main class="flex-1 p-4 max-w-[480px] w-full mx-auto">
        ${bodyContent}
      </main>
      ${renderBottomNav()}
      ${renderModals()}
    </div>
  `;

  updateTimerDisplays();
}

function changeMonth(delta) {
  const [yearStr, monthStr] = appState.selectedMonth.split('-');
  let year = parseInt(yearStr);
  let month = parseInt(monthStr) + delta;
  if (month < 1) { month = 12; year--; }
  else if (month > 12) { month = 1; year++; }
  appState.selectedMonth = `${year}-${String(month).padStart(2, '0')}`;
  renderApp();
}

function formatMonthYear(monthStr) {
  const [yearStr, mStr] = monthStr.split('-');
  const date = new Date(parseInt(yearStr), parseInt(mStr) - 1, 1);
  return date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
}

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
  renderApp();
  if (authState.token) {
    syncOnAppOpen();
  }

  // Cross-tab live synchronization
  window.addEventListener('storage', (e) => {
    if (e.key === 'allesbau_db_touch' || e.key === 'allesbau_local_db_prod') {
      if (authState.token) {
        syncDataWithServer();
      }
    }
  });

  // Sync on app tab focus / return from background
  window.addEventListener('focus', () => {
    if (authState.token) syncOnAppOpen();
  });
  
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && authState.token) syncOnAppOpen();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
});
