const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzHhuO2NxbSVEq5Wf4duRhdHSJp02NbjBEDGcn8pN3hKS_3J8jDnoys4kQlgxE-9UAnhg/exec";

let appData = { agenda: [], pelajaran: [], ujian: [], tugas: [], notulensi: [] };
let userRole = null;
let verifiedPin = null;
let pendingTab = null;
let currentCalDate = new Date();
let selectedDateStr = new Date().toISOString().split('T')[0];
let verifiedTTEData = null;
let deferredPrompt = null;
let triggeredAlarms = new Set();
let alarmInterval = null;
let currentActiveToken = '';

async function callBackend(action, payload = {}, method = 'POST') {
  let url = SCRIPT_URL;
  const options = {
    method: method,
    redirect: 'follow'
  };

  if (method === 'GET') {
    const query = new URLSearchParams({ action, ...payload }).toString();
    url = `${SCRIPT_URL}?${query}`;
  } else {
    // Menggunakan text/plain agar tidak memicu CORS preflight yang ditolak Apps Script
    options.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    options.body = JSON.stringify({ action, ...payload });
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  const json = await response.json();
  if (!json.ok) {
    throw new Error(json.error || 'Terjadi kesalahan pada Apps Script.');
  }
  return json.data;
}

window.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  startLiveClock();
  setInterval(updateCountdown, 1000);
  setInterval(checkDeadlinesAndAlarms, 15000);
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

function installPWA() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
  } else {
    alert("Untuk menginstal MUSAFA Mobile:\n• Di Chrome/Edge VS Code / Browser: Klik ikon 'Install' di pojok kanan atas address bar.\n• Di HP Android/iOS: Pilih 'Tambahkan ke Layar Utama'.");
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function requestAutoFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

function togglePasswordVisibility() {
  const inp = document.getElementById('login-username');
  const icon = document.getElementById('eye-icon');
  if (inp.type === 'password') {
    inp.type = 'text';
    icon.classList.replace('fa-eye', 'fa-eye-slash');
  } else {
    inp.type = 'password';
    icon.classList.replace('fa-eye-slash', 'fa-eye');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const val = document.getElementById('login-username').value;
  const btn = document.getElementById('btn-login-submit');
  const err = document.getElementById('login-error');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Memverifikasi...';

  try {
    const res = await callBackend('verifyLogin', { username: val }, 'POST');
    if (res && res.success) {
      userRole = 'admin';
      startApp();
    } else {
      err.textContent = (res && res.message) ? res.message : 'Kredensial tidak valid!';
      err.classList.remove('hidden');
    }
  } catch (error) {
    err.textContent = 'Terjadi kesalahan koneksi: ' + error.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> MASUK APLIKASI';
  }
}

function enterGuestMode() {
  userRole = 'guest';
  startApp();
}

function startApp() {
  requestAutoFullscreen();
  if ("Notification" in window && Notification.permission !== "granted") {
    Notification.requestPermission();
  }
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');
  document.getElementById('main-app').classList.add('flex');

  const badge = document.getElementById('role-badge');
  const adminEls = document.querySelectorAll('.admin-only');
  if (userRole === 'guest') {
    badge.textContent = 'MODE TAMU';
    badge.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800';
    adminEls.forEach(el => el.classList.add('hidden'));
  } else {
    badge.textContent = 'ADMINISTRATOR';
    badge.className = 'hidden sm:inline-block px-2.5 py-1 rounded-full text-xs font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300';
    adminEls.forEach(el => el.classList.remove('hidden'));
    refreshAdminQRToken();
    setInterval(refreshAdminQRToken, 10000);
  }
  syncData(true);
  setInterval(() => syncData(false), 30000);
}

function logout() {
  userRole = null;
  verifiedPin = null;
  verifiedTTEData = null;
  document.getElementById('login-username').value = '';
  closeModal('modal-setting');
  document.getElementById('main-app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  switchTab('dashboard');
}

function requestProtectedTab(tabName) {
  if (userRole !== 'admin') return;
  if (verifiedPin) {
    switchTab(tabName);
  } else {
    pendingTab = tabName;
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-error').classList.add('hidden');
    openModal('modal-pin');
  }
}

async function confirmPin() {
  const pinVal = document.getElementById('pin-input').value;
  try {
    const res = await callBackend('verifyPin', { pin: pinVal }, 'POST');
    if (res && res.valid) {
      verifiedPin = pinVal;
      closeModal('modal-pin');
      if (pendingTab) switchTab(pendingTab);
    } else {
      document.getElementById('pin-error').classList.remove('hidden');
    }
  } catch (err) {
    alert('Error verifikasi PIN: ' + err.message);
  }
}

function switchTab(tabName) {
  ['dashboard', 'agenda', 'pelajaran', 'ujian', 'tugas', 'notulensi', 'tte', 'notifikasi'].forEach(t => {
    const view = document.getElementById('view-' + t);
    if (view) view.classList.add('hidden');
    const btn = document.getElementById('tab-' + t);
    if (btn) {
      btn.classList.remove('bg-blue-700', 'text-white');
      btn.classList.add('text-slate-600', 'dark:text-slate-300');
    }
  });
  const activeView = document.getElementById('view-' + tabName);
  if (activeView) activeView.classList.remove('hidden');
  const activeBtn = document.getElementById('tab-' + tabName);
  if (activeBtn) {
    activeBtn.classList.add('bg-blue-700', 'text-white');
    activeBtn.classList.remove('text-slate-600', 'dark:text-slate-300');
  }
  if (tabName === 'tte' && userRole === 'admin') {
    refreshAdminQRToken();
  }
  if (tabName === 'notifikasi' && userRole === 'admin') {
    populateNotifItemOptions();
    renderNotifTrackedSummary();
  }
}

async function syncData(showSpin) {
  const icon = document.getElementById('sync-icon');
  if (showSpin) icon.classList.add('fa-spin');
  try {
    const data = await callBackend('getAllData', {}, 'GET');
    if (data) {
      appData = data;
      renderAll();
    }
  } catch (err) {
    console.error(err);
  } finally {
    if (showSpin) icon.classList.remove('fa-spin');
  }
}

function renderAll() {
  renderDashboardAgenda();
  renderCalendar();
  renderSelectedDateItems();
  renderJadwalPelajaranDanUjian();
  renderDashboardTugas();
  renderAdminTables();
  renderSavedNotulensi();
  populateNotifItemOptions();
  renderNotifTrackedSummary();
  checkDeadlinesAndAlarms();
}

function startLiveClock() {
  const hariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const bulanArr = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  setInterval(() => {
    const now = new Date();
    const str = `${hariArr[now.getDay()]}, ${now.getDate()} ${bulanArr[now.getMonth()]} ${now.getFullYear()} • ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')} WIB`;
    document.getElementById('live-clock').textContent = str;
  }, 1000);
}

function getSortedUpcomingAgendas() {
  const now = new Date();
  const prioRank = { 'DINAS': 1, 'KHUSUS': 2, 'UMUM': 3 };
  return appData.agenda
    .filter(a => a.Status !== 'Selesai' && new Date(String(a.JatuhTempo).replace(' ', 'T')) >= now)
    .sort((a, b) => {
      const timeDiff = new Date(String(a.JatuhTempo).replace(' ', 'T')) - new Date(String(b.JatuhTempo).replace(' ', 'T'));
      if (Math.abs(timeDiff) < 3600000) {
        return (prioRank[a.Prioritas] || 9) - (prioRank[b.Prioritas] || 9);
      }
      return timeDiff;
    });
}

function updateCountdown() {
  const upcoming = getSortedUpcomingAgendas();
  if (upcoming.length === 0) {
    document.getElementById('countdown-title').textContent = 'Tidak ada agenda mendatang';
    document.getElementById('countdown-loc').textContent = '-';
    document.getElementById('countdown-priority').textContent = '-';
    ['cd-days','cd-hours','cd-mins','cd-secs'].forEach(id => document.getElementById(id).textContent = '00');
    return;
  }
  const next = upcoming[0];
  document.getElementById('countdown-title').textContent = next.Judul;
  document.getElementById('countdown-loc').textContent = `Lokasi: ${next.Lokasi} (${next.Durasi})`;
  document.getElementById('countdown-priority').textContent = next.Prioritas;

  const diff = new Date(String(next.JatuhTempo).replace(' ', 'T')) - new Date();
  if (diff <= 0) return;
  const d = Math.floor(diff / (1000 * 60 * 60 * 24));
  const h = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const m = Math.floor((diff / 1000 / 60) % 60);
  const s = Math.floor((diff / 1000) % 60);

  document.getElementById('cd-days').textContent = String(d).padStart(2, '0');
  document.getElementById('cd-hours').textContent = String(h).padStart(2, '0');
  document.getElementById('cd-mins').textContent = String(m).padStart(2, '0');
  document.getElementById('cd-secs').textContent = String(s).padStart(2, '0');
}

function renderDashboardAgenda() {
  const container = document.getElementById('dashboard-agenda-list');
  const prioRank = { 'DINAS': 1, 'KHUSUS': 2, 'UMUM': 3 };
  const sorted = [...appData.agenda].sort((a, b) => {
    if (a.Status === 'Selesai' && b.Status !== 'Selesai') return 1;
    if (a.Status !== 'Selesai' && b.Status === 'Selesai') return -1;
    const pDiff = (prioRank[a.Prioritas] || 9) - (prioRank[b.Prioritas] || 9);
    if (pDiff !== 0) return pDiff;
    return new Date(String(a.JatuhTempo).replace(' ', 'T')) - new Date(String(b.JatuhTempo).replace(' ', 'T'));
  });

  if (sorted.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-400 italic">Belum ada data agenda.</p>';
    return;
  }

  container.innerHTML = sorted.map(a => {
    const badgeColor = a.Prioritas === 'DINAS' ? 'bg-red-600 text-white' : (a.Prioritas === 'KHUSUS' ? 'bg-amber-500 text-slate-900' : 'bg-blue-600 text-white');
    const statusBadge = a.Status === 'Selesai' ? 'bg-emerald-500/20 text-emerald-500' : (a.Status === 'Disposisi' ? 'bg-purple-500/20 text-purple-400' : 'bg-sky-500/20 text-sky-400');
    return `
      <div class="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${a.Status === 'Selesai' ? 'opacity-60' : ''}">
        <div>
          <div class="flex flex-wrap items-center gap-1.5 mb-1">
            <span class="px-2 py-0.5 rounded text-[10px] font-extrabold ${badgeColor}">${a.Prioritas}</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${statusBadge}">${a.Status}${a.Status === 'Disposisi' && a.DisposisiKepada ? ' → ' + a.DisposisiKepada : ''}</span>
            <span class="text-[11px] text-slate-500 dark:text-slate-400"><i class="fa-regular fa-clock"></i> ${String(a.JatuhTempo).replace('T', ' ')} (${a.Durasi})</span>
          </div>
          <h4 class="font-bold text-sm">${a.Judul}</h4>
          <p class="text-xs text-slate-500 dark:text-slate-400"><i class="fa-solid fa-location-dot text-rose-500 mr-1"></i>${a.Lokasi} ${a.TamuKhusus ? '• Tamu: <strong>' + a.TamuKhusus + '</strong>' : ''}</p>
        </div>
      </div>
    `;
  }).join('');
}

function changeMonth(delta) {
  currentCalDate.setMonth(currentCalDate.getMonth() + delta);
  renderCalendar();
}

function renderCalendar() {
  const year = currentCalDate.getFullYear();
  const month = currentCalDate.getMonth();
  const bulanArr = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  document.getElementById('cal-month-year').textContent = `${bulanArr[month]} ${year}`;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  for (let i = 0; i < firstDay; i++) {
    grid.innerHTML += '<div></div>';
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hasAgenda = appData.agenda.some(a => a.JatuhTempo && String(a.JatuhTempo).startsWith(dateStr));
    const hasTugas = appData.tugas.some(t => t.Deadline && String(t.Deadline).startsWith(dateStr));
    const isSelected = dateStr === selectedDateStr;

    grid.innerHTML += `
      <button onclick="selectCalendarDate('${dateStr}')"
              class="p-2 rounded-lg font-semibold relative transition ${isSelected ? 'bg-blue-700 text-white' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}">
        ${d}
        <div class="flex justify-center gap-0.5 mt-0.5">
          ${hasAgenda ? '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>' : ''}
          ${hasTugas ? '<span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>' : ''}
        </div>
      </button>
    `;
  }
}

function selectCalendarDate(dateStr) {
  selectedDateStr = dateStr;
  document.getElementById('selected-date-label').textContent = dateStr;
  renderCalendar();
  renderSelectedDateItems();
}

function renderSelectedDateItems() {
  const box = document.getElementById('selected-date-items');
  const agendas = appData.agenda.filter(a => a.JatuhTempo && String(a.JatuhTempo).startsWith(selectedDateStr));
  const tugases = appData.tugas.filter(t => t.Deadline && String(t.Deadline).startsWith(selectedDateStr));

  if (agendas.length === 0 && tugases.length === 0) {
    box.innerHTML = '<div class="text-slate-400 italic">Tidak ada agenda maupun tugas pada tanggal ini.</div>';
    return;
  }

  let html = '';
  agendas.forEach(a => {
    const timePart = String(a.JatuhTempo).split('T')[1] || '';
    html += `<div class="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30"><strong>[Agenda]</strong> ${a.Judul} (${timePart})</div>`;
  });
  tugases.forEach(t => {
    html += `<div class="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30"><strong>[Tugas ${t.MataPelajaran}]</strong> ${t.DetailTugas}</div>`;
  });
  box.innerHTML = html;
}

function renderJadwalPelajaranDanUjian() {
  const hariArr = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const now = new Date();
  const todayName = hariArr[now.getDay()];
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(now.getDate() + 1);
  const tomorrowName = hariArr[tomorrowDate.getDay()];

  document.getElementById('label-hari-ini').textContent = todayName;
  document.getElementById('label-hari-besok').textContent = tomorrowName;

  const activeExams = appData.ujian.filter(u => String(u.StatusAktif || '').trim().toLowerCase() === 'aktif');
  const isExamMode = activeExams.length > 0;
  const examBadge = document.getElementById('exam-mode-badge');
  const secTitle = document.getElementById('jadwal-section-title');

  if (isExamMode) {
    examBadge.classList.remove('hidden');
    secTitle.textContent = 'Jadwal Ujian Aktif (Hari Ini & Besok)';
  } else {
    examBadge.classList.add('hidden');
    secTitle.textContent = 'Jadwal Pelajaran (Hari Ini & Besok)';
  }

  const isTimePassed = (timeRangeStr, waktuSelesaiStr) => {
    const rawEnd = waktuSelesaiStr || (timeRangeStr && String(timeRangeStr).includes('-') ? String(timeRangeStr).split('-')[1] : '');
    const endStr = String(rawEnd || '').trim();
    if (!endStr) return false;
    const [hh, mm] = endStr.split(':').map(Number);
    if (isNaN(hh)) return false;
    const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm || 0);
    return now > endDate;
  };

  const hasTaskForMapel = (mapel) => {
    return appData.tugas.some(t => t.MataPelajaran && String(t.MataPelajaran).toLowerCase().trim() === String(mapel).toLowerCase().trim());
  };

  const sameDay = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  let todayItems = [];
  let tomorrowItems = [];

  if (isExamMode) {
    todayItems = activeExams.filter(u => sameDay(u.Hari, todayName) && !isTimePassed(u.Jam, ''))
      .map(u => ({ mapel: u.MataPelajaran, waktu: u.Jam, sub: 'Ujian Sekolah', hasTask: hasTaskForMapel(u.MataPelajaran) }));
    tomorrowItems = activeExams.filter(u => sameDay(u.Hari, tomorrowName))
      .map(u => ({ mapel: u.MataPelajaran, waktu: u.Jam, sub: 'Ujian Sekolah', hasTask: hasTaskForMapel(u.MataPelajaran) }));
  } else {
    todayItems = appData.pelajaran.filter(p => sameDay(p.Hari, todayName) && !isTimePassed(p.Waktu, p.WaktuSelesai))
      .map(p => ({ mapel: p.MataPelajaran, waktu: p.Waktu, sub: p.GuruMapel, hasTask: hasTaskForMapel(p.MataPelajaran) }));
    tomorrowItems = appData.pelajaran.filter(p => sameDay(p.Hari, tomorrowName))
      .map(p => ({ mapel: p.MataPelajaran, waktu: p.Waktu, sub: p.GuruMapel, hasTask: hasTaskForMapel(p.MataPelajaran) }));
  }

  const renderList = (items, emptyMsg) => {
    if (items.length === 0) return `<div class="p-3 rounded-xl bg-slate-100 dark:bg-slate-800/60 text-xs text-slate-500 italic">${emptyMsg}</div>`;
    return items.map(item => `
      <div class="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-between gap-2">
        <div>
          <div class="font-bold text-xs flex items-center gap-1.5">
            <span>${item.mapel || '-'}</span>
            ${item.hasTask ? '<span class="px-1.5 py-0.5 rounded bg-rose-600 text-white text-[9px] font-extrabold animate-pulse">ADA TUGAS</span>' : ''}
          </div>
          <div class="text-[11px] text-slate-500 dark:text-slate-400">${item.sub || '-'}</div>
        </div>
        <span class="text-[11px] font-mono font-bold text-blue-600 dark:text-blue-400 shrink-0">${item.waktu || '-'}</span>
      </div>
    `).join('');
  };

  document.getElementById('list-pelajaran-today').innerHTML = renderList(todayItems, 'Semua jadwal hari ini telah selesai.');
  document.getElementById('list-pelajaran-tomorrow').innerHTML = renderList(tomorrowItems, 'Tidak ada jadwal pelajaran/ujian besok.');

  const bannerBox = document.getElementById('status-banners');
  let bannersHtml = '';
  const todayStr = now.toISOString().split('T')[0];
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  const activeTodayAgendas = appData.agenda.filter(a => a.JatuhTempo && String(a.JatuhTempo).startsWith(todayStr) && a.Status !== 'Selesai');
  if (todayItems.length === 0 && activeTodayAgendas.length === 0) {
    bannersHtml += `
      <div class="p-4 rounded-2xl bg-emerald-600 text-white font-extrabold text-xs md:text-sm text-center shadow-md tracking-wide">
        <i class="fa-solid fa-mug-hot mr-2"></i> TERIMAKASIH SUDAH BEKERJA DENGAN BAIK,SAATNYA ISTIRAHAT
      </div>
    `;
  }

  const tomorrowAgendas = appData.agenda.filter(a => a.JatuhTempo && String(a.JatuhTempo).startsWith(tomorrowStr));
  if (tomorrowItems.length === 0 && tomorrowAgendas.length === 0) {
    bannersHtml += `
      <div class="p-4 rounded-2xl bg-indigo-700 text-white font-extrabold text-xs md:text-sm text-center shadow-md tracking-wide">
        <i class="fa-solid fa-car-side mr-2"></i> SAATNYA PULANG KE TEMPAT ASAL HATI HATI DIJALAN
      </div>
    `;
  }
  bannerBox.innerHTML = bannersHtml;
}

function renderDashboardTugas() {
  const box = document.getElementById('dashboard-tugas-list');
  const sorted = [...appData.tugas].sort((a, b) => new Date(String(a.Deadline).replace(' ', 'T')) - new Date(String(b.Deadline).replace(' ', 'T')));
  if (sorted.length === 0) {
    box.innerHTML = '<p class="text-xs text-slate-400 italic">Tidak ada tugas sekolah.</p>';
    return;
  }
  box.innerHTML = sorted.map(t => `
    <div class="p-3 rounded-xl border border-rose-200 dark:border-rose-900/40 bg-rose-50/50 dark:bg-rose-950/20">
      <div class="flex justify-between items-center text-[11px] font-bold text-rose-600 dark:text-rose-400 mb-1">
        <span>${t.MataPelajaran || '-'}</span>
        <span><i class="fa-solid fa-hourglass-half"></i> ${String(t.Deadline || '').replace('T', ' ')}</span>
      </div>
      <p class="text-xs font-semibold">${t.DetailTugas || '-'}</p>
      <p class="text-[11px] text-slate-500 mt-0.5">Guru: ${t.GuruMapel || '-'}</p>
    </div>
  `).join('');
}

function checkDeadlinesAndAlarms() {
  const now = new Date();
  const oneHourMs = 60 * 60 * 1000;
  const oneDayMs = 24 * 60 * 60 * 1000;

  appData.agenda.forEach(a => {
    if (a.Status !== 'Selesai' && a.JatuhTempo) {
      const diff = new Date(String(a.JatuhTempo).replace(' ', 'T')) - now;
      const key = 'AG-' + a.ID;
      if (diff > 0 && diff <= oneHourMs && !triggeredAlarms.has(key)) {
        triggeredAlarms.add(key);
        triggerAlarm(`1 jam lagi agenda ${a.Judul} akan segera dimulai`);
      }
    }
  });

  appData.tugas.forEach(t => {
    if (t.Deadline) {
      const diff = new Date(String(t.Deadline).replace(' ', 'T')) - now;
      const key = 'TG-' + t.ID;
      const namaTugas = getTaskDisplayName(t);
      if (diff > 0 && diff <= oneDayMs && !triggeredAlarms.has(key)) {
        triggeredAlarms.add(key);
        triggerAlarm(`Tugas ${namaTugas} akan dikumpulkan`);
      }
    }
  });
}

function triggerAlarm(message) {
  document.getElementById('alarm-text').textContent = message;
  document.getElementById('alarm-banner').classList.remove('hidden');

  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("MUSAFA Mobile", { body: message });
  }

  const playBeep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
  };
  playBeep();
  if (alarmInterval) clearInterval(alarmInterval);
  alarmInterval = setInterval(playBeep, 2000);
}

function stopAlarm() {
  document.getElementById('alarm-banner').classList.add('hidden');
  if (alarmInterval) clearInterval(alarmInterval);
}

function toggleDisposisiField() {
  const st = document.getElementById('agenda-status').value;
  const box = document.getElementById('disposisi-container');
  if (st === 'Disposisi') box.classList.remove('hidden');
  else box.classList.add('hidden');
}

function submitAgenda(e) {
  e.preventDefault();
  const rec = {
    ID: document.getElementById('agenda-id').value,
    Judul: document.getElementById('agenda-judul').value,
    Lokasi: document.getElementById('agenda-lokasi').value,
    JatuhTempo: document.getElementById('agenda-jatuhtempo').value,
    Durasi: document.getElementById('agenda-durasi').value,
    Prioritas: document.getElementById('agenda-prioritas').value,
    Status: document.getElementById('agenda-status').value,
    DisposisiKepada: document.getElementById('agenda-disposisi').value,
    TamuKhusus: document.getElementById('agenda-tamu').value
  };
  saveToSheet('Agenda', rec, 'form-agenda', 'agenda-id');
}

function submitPelajaran(e) {
  e.preventDefault();
  const rec = {
    ID: document.getElementById('pelajaran-id').value,
    NamaMapel: document.getElementById('pelajaran-mapel').value,
    NamaGuru: document.getElementById('pelajaran-guru').value,
    Hari: document.getElementById('pelajaran-hari').value,
    Waktu: document.getElementById('pelajaran-waktu').value
  };
  saveToSheet('Pelajaran', rec, 'form-pelajaran', 'pelajaran-id');
}

function submitUjian(e) {
  e.preventDefault();
  const rec = {
    ID: document.getElementById('ujian-id').value,
    Hari: document.getElementById('ujian-hari').value,
    Jam: document.getElementById('ujian-jam').value,
    NamaMapel: document.getElementById('ujian-mapel').value,
    StatusAktif: document.getElementById('ujian-status').value
  };
  saveToSheet('Ujian', rec, 'form-ujian', 'ujian-id');
}

function submitTugas(e) {
  e.preventDefault();
  const rec = {
    ID: document.getElementById('tugas-id').value,
    Deadline: document.getElementById('tugas-deadline').value,
    NamaMapel: document.getElementById('tugas-mapel').value,
    NamaGuru: document.getElementById('tugas-guru').value,
    DetailTugas: document.getElementById('tugas-detail').value
  };
  saveToSheet('Tugas', rec, 'form-tugas', 'tugas-id');
}

async function saveToSheet(sheetName, record, formId, idField) {
  try {
    const data = await callBackend('saveRecord', { sheetName, record, pin: verifiedPin }, 'POST');
    appData = data;
    resetForm(formId, idField);
    renderAll();
    alert('Data berhasil disimpan ke Google Spreadsheet!');
  } catch (err) {
    alert('Gagal menyimpan: ' + err.message);
  }
}

async function deleteFromSheet(sheetName, id) {
  if (!confirm('Yakin ingin menghapus data ini?')) return;
  try {
    const data = await callBackend('deleteRecord', { sheetName, id, pin: verifiedPin }, 'POST');
    appData = data;
    renderAll();
  } catch (err) {
    alert('Gagal menghapus: ' + err.message);
  }
}

function resetForm(formId, idField) {
  document.getElementById(formId).reset();
  document.getElementById(idField).value = '';
  if (formId === 'form-agenda') toggleDisposisiField();
}

function renderAdminTables() {
  document.getElementById('table-agenda').innerHTML = appData.agenda.map(a => `
    <tr class="border-b border-slate-100 dark:border-slate-800">
      <td class="p-2 font-bold">${a.Judul || ''}</td>
      <td class="p-2">${a.Lokasi || ''}</td>
      <td class="p-2">${String(a.JatuhTempo || '').replace('T',' ')}</td>
      <td class="p-2 font-bold">${a.Prioritas || ''}</td>
      <td class="p-2">${a.Status || ''}</td>
      <td class="p-2">${a.TamuKhusus || '-'}</td>
      <td class="p-2 flex gap-1">
        <button onclick='editAgenda(${JSON.stringify(a)})' class="px-2 py-1 bg-amber-500 text-white rounded">Edit</button>
        <button onclick="deleteFromSheet('Agenda','${a.ID}')" class="px-2 py-1 bg-rose-600 text-white rounded">Hapus</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('table-pelajaran').innerHTML = appData.pelajaran.map(p => `
    <tr class="border-b border-slate-100 dark:border-slate-800">
      <td class="p-2">${p.Hari || ''}</td>
      <td class="p-2">${p.Waktu || ''}</td>
      <td class="p-2 font-bold">${p.MataPelajaran || p.NamaMapel || ''}</td>
      <td class="p-2">${p.GuruMapel || p.NamaGuru || ''}</td>
      <td class="p-2 flex gap-1">
        <button onclick='editPelajaran(${JSON.stringify(p)})' class="px-2 py-1 bg-amber-500 text-white rounded">Edit</button>
        <button onclick="deleteFromSheet('Pelajaran','${p.ID}')" class="px-2 py-1 bg-rose-600 text-white rounded">Hapus</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('table-ujian').innerHTML = appData.ujian.map(u => `
    <tr class="border-b border-slate-100 dark:border-slate-800">
      <td class="p-2">${u.Hari || ''}</td>
      <td class="p-2">${u.Jam || ''}</td>
      <td class="p-2 font-bold">${u.MataPelajaran || u.NamaMapel || ''}</td>
      <td class="p-2"><span class="px-2 py-0.5 rounded font-bold ${u.StatusAktif==='Aktif'?'bg-emerald-500/20 text-emerald-500':'bg-slate-500/20 text-slate-400'}">${u.StatusAktif || ''}</span></td>
      <td class="p-2 flex gap-1">
        <button onclick='editUjian(${JSON.stringify(u)})' class="px-2 py-1 bg-amber-500 text-white rounded">Edit</button>
        <button onclick="deleteFromSheet('Ujian','${u.ID}')" class="px-2 py-1 bg-rose-600 text-white rounded">Hapus</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('table-tugas').innerHTML = appData.tugas.map(t => `
    <tr class="border-b border-slate-100 dark:border-slate-800">
      <td class="p-2">${String(t.Deadline || '').replace('T',' ')}</td>
      <td class="p-2 font-bold">${t.MataPelajaran || t.NamaMapel || ''}</td>
      <td class="p-2">${t.GuruMapel || t.NamaGuru || ''}</td>
      <td class="p-2">${t.DetailTugas || ''}</td>
      <td class="p-2 flex gap-1">
        <button onclick='editTugas(${JSON.stringify(t)})' class="px-2 py-1 bg-amber-500 text-white rounded">Edit</button>
        <button onclick="deleteFromSheet('Tugas','${t.ID}')" class="px-2 py-1 bg-rose-600 text-white rounded">Hapus</button>
      </td>
    </tr>
  `).join('');
}

function renderSavedNotulensi() {
  const box = document.getElementById('notulensi-list');
  const notes = appData.notulensi || [];
  document.getElementById('notulen-count-badge').textContent = notes.length;

  if (notes.length === 0) {
    box.innerHTML = '<p class="text-xs text-slate-400 italic">Belum ada catatan atau notulensi tersimpan.</p>';
    return;
  }

  box.innerHTML = notes.map((n, idx) => {
    const title = n.Judul || n.JudulRapat || 'Tanpa Judul';
    const content = n.Isi || n.IsiNotulensi || '';
    const dateStr = n.Tanggal || '-';
    const tokenStr = n.TokenTTE || '-';
    return `
      <div class="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-800/40 space-y-2">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h4 class="font-bold text-sm text-blue-700 dark:text-blue-400">${title}</h4>
            <p class="text-[11px] text-slate-500">${dateStr} • Token: <span class="font-mono font-bold">${tokenStr}</span></p>
          </div>
          <button onclick="openNoteInTTE(${idx})" class="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded-lg text-[11px] font-bold shrink-0">
            <i class="fa-solid fa-signature mr-1"></i> TTE & PDF
          </button>
        </div>
        <pre class="text-xs whitespace-pre-wrap font-sans text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200 dark:border-slate-800 max-h-40 overflow-y-auto">${content}</pre>
      </div>
    `;
  }).join('');
}

async function saveNoteOnly() {
  const judul = document.getElementById('notulen-judul').value.trim();
  const isi = document.getElementById('notulen-isi').value.trim();
  const tgl = document.getElementById('notulen-tanggal').value.trim();
  if (!judul || !isi) {
    alert('Harap isi Judul dan Isi Catatan/Notulensi terlebih dahulu.');
    return;
  }
  try {
    const data = await callBackend('saveNotulensi', { record: { JudulRapat: judul, IsiNotulensi: isi, Tanggal: tgl } }, 'POST');
    appData = data;
    renderSavedNotulensi();
    alert('Catatan berhasil disimpan ke Sheet Notulensi!');
  } catch (err) {
    alert('Gagal menyimpan catatan: ' + err.message);
  }
}

function goToTTEWithCurrentNote() {
  document.getElementById('tte-doc-judul').value = document.getElementById('notulen-judul').value;
  document.getElementById('tte-doc-tanggal').value = document.getElementById('notulen-tanggal').value || new Date().toLocaleDateString('id-ID');
  document.getElementById('tte-doc-isi').value = document.getElementById('notulen-isi').value;
  switchTab('tte');
}

function openNoteInTTE(index) {
  const n = (appData.notulensi || [])[index];
  if (!n) return;
  document.getElementById('tte-doc-judul').value = n.Judul || n.JudulRapat || '';
  document.getElementById('tte-doc-tanggal').value = n.Tanggal || '';
  document.getElementById('tte-doc-isi').value = n.Isi || n.IsiNotulensi || '';
  if (n.TokenTTE) {
    document.getElementById('page-tte-token-input').value = n.TokenTTE;
  }
  switchTab('tte');
}

async function refreshAdminQRToken() {
  if (userRole !== 'admin') return;
  try {
    const res = await callBackend('getCurrentTTEToken', {}, 'GET');
    if (!res) return;
    currentActiveToken = res.token;
    const tokenDisp = document.getElementById('admin-token-display');
    const cdDisp = document.getElementById('token-countdown');
    const qrContainer = document.getElementById('qrcode-container');
    if (tokenDisp) tokenDisp.textContent = res.token;
    if (cdDisp) cdDisp.textContent = res.secondsLeft;
    if (qrContainer) {
      qrContainer.innerHTML = '';
      new QRCode(qrContainer, {
        text: `TOKEN TTE MUSAFA MOBILE: ${res.token}`,
        width: 150,
        height: 150
      });
    }
  } catch (err) {}
}

function fillActiveTokenToInput() {
  if (currentActiveToken) {
    document.getElementById('page-tte-token-input').value = currentActiveToken;
  }
}

async function verifyTokenOnTTEPage() {
  const tokenVal = document.getElementById('page-tte-token-input').value.trim();
  const errEl = document.getElementById('page-tte-error');
  const resBox = document.getElementById('page-tte-result');
  errEl.classList.add('hidden');

  try {
    const res = await callBackend('verifyTTEToken', { token: tokenVal }, 'POST');
    if (res && res.valid) {
      verifiedTTEData = res;
      document.getElementById('page-tte-signature-img').src = res.ttdUrl;
      document.getElementById('tte-signer-name').textContent = res.signer || 'Muhammad Sufyan Fahriza';
      document.getElementById('tte-signer-role').textContent = res.role || 'Eselon III (Pejabat Rohis)';
      document.getElementById('tte-verified-time').textContent = 'Diverifikasi: ' + (res.verifiedAt || '');
      if (!document.getElementById('tte-doc-tanggal').value) {
        document.getElementById('tte-doc-tanggal').value = new Date().toLocaleString('id-ID');
      }
      resBox.classList.remove('hidden');
    } else {
      verifiedTTEData = null;
      resBox.classList.add('hidden');
      errEl.textContent = (res && res.message) ? res.message : 'Token TTE tidak valid.';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    errEl.textContent = 'Gagal memverifikasi token: ' + err.message;
    errEl.classList.remove('hidden');
  }
}

function downloadPDFWithVerifiedTTE() {
  if (!verifiedTTEData || !verifiedTTEData.ttdUrl) {
    alert('Verifikasi Token TTE terlebih dahulu agar tanda tangan muncul.');
    return;
  }
  const judul = document.getElementById('tte-doc-judul').value.trim() || 'Dokumen Resmi MUSAFA Mobile';
  const tgl = document.getElementById('tte-doc-tanggal').value.trim() || new Date().toLocaleDateString('id-ID');
  const isi = document.getElementById('tte-doc-isi').value || '';

  const pdfContainer = document.getElementById('pdf-render-area');
  pdfContainer.classList.remove('hidden');
  pdfContainer.innerHTML = `
    <div style="padding: 35px; font-family: Arial, sans-serif; color: #111;">
      <div style="display:flex; align-items:center; border-bottom: 3px solid #1e3a8a; padding-bottom: 12px; margin-bottom: 20px;">
        <img src="https://drive.google.com/thumbnail?id=1v9XLw_NjWKP9zdtIgREkPYmgakhKMq_n&sz=w150" style="width:65px; height:65px; margin-right:15px;">
        <div>
          <h2 style="margin:0; color:#1e3a8a; font-size:18px;">MUSAFA MOBILE</h2>
          <p style="margin:2px 0 0; font-size:12px; color:#475569;">Sistem Managemen Agenda dan Tugas • Dokumen Bertanda Tangan Elektronik</p>
        </div>
      </div>
      <table style="width:100%; font-size:13px; margin-bottom:20px;">
        <tr><td style="width:130px;"><strong>Perihal / Judul</strong></td><td>: ${judul}</td></tr>
        <tr><td><strong>Tanggal</strong></td><td>: ${tgl}</td></tr>
      </table>
      <div style="font-size:13px; line-height:1.6; white-space:pre-wrap; border:1px solid #cbd5e1; padding:15px; border-radius:8px; min-height:200px;">${isi}</div>
      <div style="margin-top:36px; display:flex; justify-content:flex-end;">
        <div style="text-align:center; width:250px;">
          <p style="font-size:12px; margin-bottom:5px;">Disahkan secara elektronik oleh,</p>
          <img src="${verifiedTTEData.ttdUrl}" style="height:85px; margin: 5px auto; display:block;">
          <p style="font-size:13px; font-weight:bold; text-decoration:underline; margin:0;">${verifiedTTEData.signer || 'Muhammad Sufyan Fahriza'}</p>
          <p style="font-size:11px; color:#475569; margin:2px 0 0;">${verifiedTTEData.role || 'Eselon III (Pejabat Rohis)'}</p>
        </div>
      </div>
    </div>
  `;

  const opt = {
    margin: 10,
    filename: `TTE_${judul.replace(/\s+/g, '_')}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(pdfContainer).save().then(() => {
    pdfContainer.classList.add('hidden');
  });
}

// ==================== NOTIFIKASI GMAIL OTOMATIS & TES ====================
function getTaskDisplayName(t) {
  const detail = (t.DetailTugas || '').trim();
  const mapel = (t.MataPelajaran || t.NamaMapel || '').trim();
  if (detail && mapel && !detail.toLowerCase().includes(mapel.toLowerCase())) {
    return `${detail} (${mapel})`;
  }
  return detail || mapel || 'Tugas';
}

function populateNotifItemOptions() {
  const jenisEl = document.getElementById('test-notif-jenis');
  const selEl = document.getElementById('test-notif-select');
  const nameEl = document.getElementById('test-notif-nama');
  if (!jenisEl || !selEl || !nameEl) return;

  const isTugas = jenisEl.value.toLowerCase() === 'tugas';
  const items = isTugas
    ? (appData.tugas || []).map(t => getTaskDisplayName(t)).filter(Boolean)
    : (appData.agenda || []).map(a => (a.Judul || '').trim()).filter(Boolean);

  if (items.length === 0) {
    selEl.innerHTML = `<option value="">Belum ada ${isTugas ? 'tugas' : 'agenda'} tersimpan</option>`;
    return;
  }

  selEl.innerHTML = items.map((nm, idx) => `<option value="${idx}">${nm}</option>`).join('');
  nameEl.value = items[0];
}

function syncSelectedNotifName() {
  const jenisEl = document.getElementById('test-notif-jenis');
  const selEl = document.getElementById('test-notif-select');
  const nameEl = document.getElementById('test-notif-nama');
  if (!jenisEl || !selEl || !nameEl) return;

  const idx = parseInt(selEl.value, 10);
  if (isNaN(idx)) return;

  const isTugas = jenisEl.value.toLowerCase() === 'tugas';
  const items = isTugas
    ? (appData.tugas || []).map(t => getTaskDisplayName(t))
    : (appData.agenda || []).map(a => (a.Judul || '').trim());

  if (items[idx] !== undefined) {
    nameEl.value = items[idx];
  }
}

function renderNotifTrackedSummary() {
  const box = document.getElementById('notif-tracked-summary');
  if (!box) return;

  const agendas = (appData.agenda || []).filter(a => a.Status !== 'Selesai');
  const tugases = (appData.tugas || []);

  if (agendas.length === 0 && tugases.length === 0) {
    box.innerHTML = '<div class="text-slate-400 italic">Belum ada agenda aktif atau tugas yang terpantau.</div>';
    return;
  }

  let html = '';
  agendas.forEach(a => {
    html += `<div class="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20">
      <div class="font-bold text-blue-600 dark:text-blue-400">[Agenda • 1 Jam Sebelumnya]</div>
      <div class="font-semibold">${a.Judul || '-'}</div>
      <div class="text-[11px] text-slate-500">${String(a.JatuhTempo || '').replace('T', ' ')}</div>
    </div>`;
  });

  tugases.forEach(t => {
    const nm = getTaskDisplayName(t);
    html += `<div class="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20">
      <div class="font-bold text-rose-600 dark:text-rose-400">[Tugas • 1 Hari Sebelumnya]</div>
      <div class="font-semibold">${nm}</div>
      <div class="text-[11px] text-slate-500">${String(t.Deadline || '').replace('T', ' ')}</div>
    </div>`;
  });

  box.innerHTML = html;
}

async function runTestNotification() {
  const jenis = document.getElementById('test-notif-jenis').value;
  const nama = document.getElementById('test-notif-nama').value.trim();
  const btn = document.getElementById('btn-tes-notifikasi');
  const statusEl = document.getElementById('test-notif-status');

  btn.disabled = true;
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Mengirim email notifikasi uji coba ke fahriztomi@gmail.com...';

  try {
    const res = await callBackend('sendTestNotification', { jenis, namaItem: nama }, 'POST');
    statusEl.textContent = `Terkirim ke ${res.recipient}: "${res.message}"`;
  } catch (err) {
    statusEl.textContent = 'Gagal mengirim notifikasi: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function runManualReminderCheck() {
  const statusEl = document.getElementById('test-notif-status');
  statusEl.classList.remove('hidden');
  statusEl.textContent = 'Memeriksa agenda (1 jam) dan tugas (1 hari) yang mendekati jatuh tempo...';

  try {
    const res = await callBackend('checkAndSendGmailReminders', {}, 'POST');
    const detail = res.sentMessages && res.sentMessages.length ? ` (${res.sentMessages.join(' | ')})` : '';
    statusEl.textContent = `Pengecekan selesai. Email terkirim: ${res.sentCount || 0} pesan${detail}.`;
  } catch (err) {
    statusEl.textContent = 'Gagal memeriksa: ' + err.message;
  }
}

function setTheme(mode) {
  if (mode === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
}

function setFontSize(size) {
  document.documentElement.classList.remove('font-small', 'font-medium', 'font-large');
  document.documentElement.classList.add('font-' + size);
}

function openModal(id) {
  const m = document.getElementById(id);
  m.classList.remove('hidden');
  m.classList.add('flex');
}

function closeModal(id) {
  const m = document.getElementById(id);
  m.classList.add('hidden');
  m.classList.remove('flex');
}