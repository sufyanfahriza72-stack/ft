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
  initTugasDetailUI();
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
    html += `<div class="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30"><strong>[Tugas ${t.MataPelajaran}]</strong> ${getTaskDisplayName(t)}</div>`;
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

// ==================== TUGAS (DESKRIPSI, FOTO, PDF, LINK GDRIVE) ====================
function initTugasDetailUI() {
  const fotoInput = document.getElementById('tugas-file-foto');
  const pdfInput = document.getElementById('tugas-file-pdf');
  const driveInput = document.getElementById('tugas-link-drive');
  const descInput = document.getElementById('tugas-detail-deskripsi');

  if (fotoInput) {
    fotoInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        document.getElementById('tugas-foto-data').value = '';
        document.getElementById('tugas-foto-name').value = '';
        renderTugasAttachmentPreview();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById('tugas-foto-data').value = reader.result || '';
        document.getElementById('tugas-foto-name').value = file.name;
        renderTugasAttachmentPreview();
      };
      reader.readAsDataURL(file);
    });
  }

  if (pdfInput) {
    pdfInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        document.getElementById('tugas-pdf-data').value = '';
        document.getElementById('tugas-pdf-name').value = '';
        renderTugasAttachmentPreview();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById('tugas-pdf-data').value = reader.result || '';
        document.getElementById('tugas-pdf-name').value = file.name;
        renderTugasAttachmentPreview();
      };
      reader.readAsDataURL(file);
    });
  }

  if (driveInput) {
    driveInput.addEventListener('input', renderTugasAttachmentPreview);
  }
  if (descInput) {
    descInput.addEventListener('input', renderTugasAttachmentPreview);
  }
}

function toggleTugasDetailMode() {
  const mode = document.getElementById('tugas-tipe-detail').value;
  document.getElementById('tugas-box-deskripsi').classList.toggle('hidden', mode !== 'deskripsi' && mode !== 'semua');
  document.getElementById('tugas-box-foto').classList.toggle('hidden', mode !== 'foto' && mode !== 'semua');
  document.getElementById('tugas-box-pdf').classList.toggle('hidden', mode !== 'pdf' && mode !== 'semua');
  document.getElementById('tugas-box-drive').classList.toggle('hidden', mode !== 'drive' && mode !== 'semua');
  renderTugasAttachmentPreview();
}

function renderTugasAttachmentPreview() {
  const box = document.getElementById('tugas-lampiran-preview');
  if (!box) return;

  const desc = (document.getElementById('tugas-detail-deskripsi')?.value || '').trim();
  const fotoData = document.getElementById('tugas-foto-data')?.value || '';
  const fotoName = document.getElementById('tugas-foto-name')?.value || 'Foto Tugas';
  const pdfData = document.getElementById('tugas-pdf-data')?.value || '';
  const pdfName = document.getElementById('tugas-pdf-name')?.value || 'Dokumen Tugas.pdf';
  const driveLink = (document.getElementById('tugas-link-drive')?.value || '').trim();

  const parts = [];
  if (desc) parts.push(`<div class="text-xs font-semibold text-slate-700 dark:text-slate-200">${escapeHtml_(desc)}</div>`);
  if (fotoData) {
    parts.push(`<div class="flex items-center gap-2 mt-1"><img src="${fotoData}" alt="${escapeHtml_(fotoName)}" class="w-14 h-14 object-cover rounded-lg border border-slate-300 dark:border-slate-700"><span class="text-[11px] font-medium">${escapeHtml_(fotoName)}</span></div>`);
  }
  if (pdfData || pdfName) {
    parts.push(`<div class="text-[11px] font-semibold text-rose-600 dark:text-rose-400 mt-1"><i class="fa-solid fa-file-pdf mr-1"></i>PDF: ${escapeHtml_(pdfName)}</div>`);
  }
  if (driveLink) {
    parts.push(`<div class="text-[11px] font-semibold text-blue-600 dark:text-blue-400 mt-1 break-all"><i class="fa-brands fa-google-drive mr-1"></i>Drive: ${escapeHtml_(driveLink)}</div>`);
  }

  if (parts.length === 0) {
    box.innerHTML = '<span class="text-[11px] text-slate-400 italic">Belum ada lampiran/deskripsi yang dipilih.</span>';
  } else {
    box.innerHTML = parts.join('');
  }
}

function parseTugasDetail(rawDetail) {
  const text = String(rawDetail || '').trim();
  if (!text) return { deskripsi: '', fotoData: '', fotoName: '', pdfData: '', pdfName: '', driveLink: '' };

  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return {
          deskripsi: parsed.deskripsi || '',
          fotoData: parsed.fotoData || '',
          fotoName: parsed.fotoName || '',
          pdfData: parsed.pdfData || '',
          pdfName: parsed.pdfName || '',
          driveLink: parsed.driveLink || ''
        };
      }
    } catch (e) {}
  }

  const lines = text.split('\n');
  let deskripsi = [];
  let fotoData = '';
  let fotoName = '';
  let pdfData = '';
  let pdfName = '';
  let driveLink = '';

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('[FOTO_DATA:')) {
      const idx = trimmed.indexOf(']:');
      if (idx !== -1) {
        fotoName = trimmed.slice(11, idx);
        fotoData = trimmed.slice(idx + 2).trim();
      }
    } else if (trimmed.startsWith('[FOTO:')) {
      fotoName = trimmed.slice(6, -1).trim();
    } else if (trimmed.startsWith('[PDF_DATA:')) {
      const idx = trimmed.indexOf(']:');
      if (idx !== -1) {
        pdfName = trimmed.slice(10, idx);
        pdfData = trimmed.slice(idx + 2).trim();
      }
    } else if (trimmed.startsWith('[PDF:')) {
      pdfName = trimmed.slice(5, -1).trim();
    } else if (trimmed.startsWith('[DRIVE:')) {
      driveLink = trimmed.slice(7, -1).trim();
    } else if (/^https?:\/\/(drive|docs)\.google\.com\//i.test(trimmed) && !driveLink) {
      driveLink = trimmed;
    } else {
      deskripsi.push(line);
    }
  });

  return {
    deskripsi: deskripsi.join('\n').trim(),
    fotoData,
    fotoName,
    pdfData,
    pdfName,
    driveLink
  };
}

function buildTugasDetailPayload() {
  const deskripsi = (document.getElementById('tugas-detail-deskripsi')?.value || '').trim();
  const fotoData = document.getElementById('tugas-foto-data')?.value || '';
  const fotoName = (document.getElementById('tugas-foto-name')?.value || '').trim();
  const pdfData = document.getElementById('tugas-pdf-data')?.value || '';
  const pdfName = (document.getElementById('tugas-pdf-name')?.value || '').trim();
  const driveLink = (document.getElementById('tugas-link-drive')?.value || '').trim();

  const segments = [];
  if (deskripsi) segments.push(deskripsi);
  if (fotoName) segments.push(`[FOTO: ${fotoName}]`);
  if (fotoData) segments.push(`[FOTO_DATA:${fotoName || 'foto.png'}]:${fotoData}`);
  if (pdfName) segments.push(`[PDF: ${pdfName}]`);
  if (pdfData) segments.push(`[PDF_DATA:${pdfName || 'tugas.pdf'}]:${pdfData}`);
  if (driveLink) segments.push(`[DRIVE: ${driveLink}]`);

  return segments.join('\n');
}

function renderTugasDetailRichHtml(rawDetail) {
  const info = parseTugasDetail(rawDetail);
  const blocks = [];

  if (info.deskripsi) {
    blocks.push(`<p class="text-xs font-semibold whitespace-pre-wrap break-words">${escapeHtml_(info.deskripsi)}</p>`);
  }
  if (info.fotoData) {
    blocks.push(`<div class="mt-1.5"><img src="${info.fotoData}" alt="${escapeHtml_(info.fotoName || 'Foto Tugas')}" class="max-h-36 rounded-lg border border-slate-300 dark:border-slate-700 object-contain bg-white"></div>`);
  } else if (info.fotoName) {
    blocks.push(`<div class="mt-1 text-[11px] text-slate-600 dark:text-slate-300"><i class="fa-solid fa-image mr-1 text-emerald-600"></i>Foto: ${escapeHtml_(info.fotoName)}</div>`);
  }
  if (info.pdfData) {
    blocks.push(`<div class="mt-1"><a href="${info.pdfData}" download="${escapeHtml_(info.pdfName || 'Tugas.pdf')}" class="inline-flex items-center gap-1 text-[11px] font-bold text-rose-600 dark:text-rose-400 underline"><i class="fa-solid fa-file-pdf"></i> Unduh PDF: ${escapeHtml_(info.pdfName || 'Tugas.pdf')}</a></div>`);
  } else if (info.pdfName) {
    blocks.push(`<div class="mt-1 text-[11px] font-semibold text-rose-600 dark:text-rose-400"><i class="fa-solid fa-file-pdf mr-1"></i>PDF: ${escapeHtml_(info.pdfName)}</div>`);
  }
  if (info.driveLink) {
    const safeUrl = /^https?:\/\//i.test(info.driveLink) ? info.driveLink : `https://${info.driveLink}`;
    blocks.push(`<div class="mt-1"><a href="${escapeHtml_(safeUrl)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 dark:text-blue-400 underline break-all"><i class="fa-brands fa-google-drive"></i> Buka Link Google Drive</a></div>`);
  }

  return blocks.length ? blocks.join('') : '<span class="text-xs text-slate-400 italic">-</span>';
}

function renderDashboardTugas() {
  const box = document.getElementById('dashboard-tugas-list');
  const sorted = [...appData.tugas].sort((a, b) => new Date(String(a.Deadline).replace(' ', 'T')) - new Date(String(b.Deadline).replace(' ', 'T')));
  if (sorted.length === 0) {
    box.innerHTML = '<p class="text-xs text-slate-400 italic">Tidak ada tugas sekolah.</p>';
    return;
  }
  box.innerHTML = sorted.map(t => `
    <div class="p-3 rounded-xl border border-rose-200 dark:border-rose-900/40 bg-rose-50/50 dark:bg-rose-950/20 space-y-1">
      <div class="flex justify-between items-center text-[11px] font-bold text-rose-600 dark:text-rose-400">
        <span>${escapeHtml_(t.MataPelajaran || t.NamaMapel || '-')}</span>
        <span><i class="fa-solid fa-hourglass-half"></i> ${escapeHtml_(String(t.Deadline || '').replace('T', ' '))}</span>
      </div>
      ${renderTugasDetailRichHtml(t.DetailTugas)}
      <p class="text-[11px] text-slate-500 pt-0.5">Guru: ${escapeHtml_(t.GuruMapel || t.NamaGuru || '-')}</p>
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
  const detailPayload = buildTugasDetailPayload();
  if (!detailPayload) {
    alert('Harap isi minimal salah satu Detail Tugas: Deskripsi, Foto, PDF, atau Link Google Drive.');
    return;
  }
  const rec = {
    ID: document.getElementById('tugas-id').value,
    Deadline: document.getElementById('tugas-deadline').value,
    NamaMapel: document.getElementById('tugas-mapel').value,
    NamaGuru: document.getElementById('tugas-guru').value,
    DetailTugas: detailPayload
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
  if (formId === 'form-tugas') {
    ['tugas-foto-data', 'tugas-foto-name', 'tugas-pdf-data', 'tugas-pdf-name'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const modeEl = document.getElementById('tugas-tipe-detail');
    if (modeEl) modeEl.value = 'semua';
    toggleTugasDetailMode();
  }
}

function editAgenda(a) {
  switchTab('agenda');
  document.getElementById('agenda-id').value = a.ID || '';
  document.getElementById('agenda-judul').value = a.Judul || '';
  document.getElementById('agenda-lokasi').value = a.Lokasi || '';
  document.getElementById('agenda-jatuhtempo').value = a.JatuhTempo || '';
  document.getElementById('agenda-durasi').value = a.Durasi || 'Sesuai Jam';
  document.getElementById('agenda-prioritas').value = a.Prioritas || 'DINAS';
  document.getElementById('agenda-status').value = a.Status || 'Agendakan';
  document.getElementById('agenda-disposisi').value = a.DisposisiKepada || '';
  document.getElementById('agenda-tamu').value = a.TamuKhusus || '';
  toggleDisposisiField();
}

function editPelajaran(p) {
  switchTab('pelajaran');
  document.getElementById('pelajaran-id').value = p.ID || '';
  document.getElementById('pelajaran-mapel').value = p.MataPelajaran || p.NamaMapel || '';
  document.getElementById('pelajaran-guru').value = p.GuruMapel || p.NamaGuru || '';
  document.getElementById('pelajaran-hari').value = p.Hari || 'Senin';
  document.getElementById('pelajaran-waktu').value = p.Waktu || '';
}

function editUjian(u) {
  switchTab('ujian');
  document.getElementById('ujian-id').value = u.ID || '';
  document.getElementById('ujian-hari').value = u.Hari || 'Senin';
  document.getElementById('ujian-jam').value = u.Jam || '';
  document.getElementById('ujian-mapel').value = u.MataPelajaran || u.NamaMapel || '';
  document.getElementById('ujian-status').value = u.StatusAktif || 'Non Aktif';
}

function editTugasById(id) {
  const t = (appData.tugas || []).find(item => String(item.ID) === String(id));
  if (!t) return;
  editTugas(t);
}

function editTugas(t) {
  switchTab('tugas');
  const parsed = parseTugasDetail(t.DetailTugas);
  document.getElementById('tugas-id').value = t.ID || '';
  document.getElementById('tugas-deadline').value = t.Deadline || '';
  document.getElementById('tugas-mapel').value = t.MataPelajaran || t.NamaMapel || '';
  document.getElementById('tugas-guru').value = t.GuruMapel || t.NamaGuru || '';
  document.getElementById('tugas-detail-deskripsi').value = parsed.deskripsi || '';
  document.getElementById('tugas-foto-data').value = parsed.fotoData || '';
  document.getElementById('tugas-foto-name').value = parsed.fotoName || '';
  document.getElementById('tugas-pdf-data').value = parsed.pdfData || '';
  document.getElementById('tugas-pdf-name').value = parsed.pdfName || '';
  document.getElementById('tugas-link-drive').value = parsed.driveLink || '';

  const modeEl = document.getElementById('tugas-tipe-detail');
  if (modeEl) modeEl.value = 'semua';
  toggleTugasDetailMode();
  document.getElementById('form-tugas').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderAdminTables() {
  document.getElementById('table-agenda').innerHTML = appData.agenda.map(a => `
    <tr class="border-b border-slate-100 dark:border-slate-800">
      <td class="p-2 font-bold">${escapeHtml_(a.Judul || '')}</td>
      <td class="p-2">${escapeHtml_(a.Lokasi || '')}</td>
      <td class="p-2">${escapeHtml_(String(a.JatuhTempo || '').replace('T',' '))}</td>
      <td class="p-2 font-bold">${escapeHtml_(a.Prioritas || '')}</td>
      <td class="p-2">${escapeHtml_(a.Status || '')}</td>
      <td class="p-2">${escapeHtml_(a.TamuKhusus || '-')}</td>
      <td class="p-2 flex gap-1">
        <button onclick='editAgenda(${JSON.stringify(a)})' class="px-2 py-1 bg-amber-500 text-white rounded">Edit</button>
        <button onclick="deleteFromSheet('Agenda','${a.ID}')" class="px-2 py-1 bg-rose-600 text-white rounded">Hapus</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('table-pelajaran').innerHTML = appData.pelajaran.map(p => `
    <tr class="border-b border-slate-100 dark:border-slate-800">
      <td class="p-2">${escapeHtml_(p.Hari || '')}</td>
      <td class="p-2">${escapeHtml_(p.Waktu || '')}</td>
      <td class="p-2 font-bold">${escapeHtml_(p.MataPelajaran || p.NamaMapel || '')}</td>
      <td class="p-2">${escapeHtml_(p.GuruMapel || p.NamaGuru || '')}</td>
      <td class="p-2 flex gap-1">
        <button onclick='editPelajaran(${JSON.stringify(p)})' class="px-2 py-1 bg-amber-500 text-white rounded">Edit</button>
        <button onclick="deleteFromSheet('Pelajaran','${p.ID}')" class="px-2 py-1 bg-rose-600 text-white rounded">Hapus</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('table-ujian').innerHTML = appData.ujian.map(u => `
    <tr class="border-b border-slate-100 dark:border-slate-800">
      <td class="p-2">${escapeHtml_(u.Hari || '')}</td>
      <td class="p-2">${escapeHtml_(u.Jam || '')}</td>
      <td class="p-2 font-bold">${escapeHtml_(u.MataPelajaran || u.NamaMapel || '')}</td>
      <td class="p-2"><span class="px-2 py-0.5 rounded font-bold ${u.StatusAktif==='Aktif'?'bg-emerald-500/20 text-emerald-500':'bg-slate-500/20 text-slate-400'}">${escapeHtml_(u.StatusAktif || '')}</span></td>
      <td class="p-2 flex gap-1">
        <button onclick='editUjian(${JSON.stringify(u)})' class="px-2 py-1 bg-amber-500 text-white rounded">Edit</button>
        <button onclick="deleteFromSheet('Ujian','${u.ID}')" class="px-2 py-1 bg-rose-600 text-white rounded">Hapus</button>
      </td>
    </tr>
  `).join('');

  document.getElementById('table-tugas').innerHTML = appData.tugas.map(t => `
    <tr class="border-b border-slate-100 dark:border-slate-800 align-top">
      <td class="p-2 whitespace-nowrap">${escapeHtml_(String(t.Deadline || '').replace('T',' '))}</td>
      <td class="p-2 font-bold">${escapeHtml_(t.MataPelajaran || t.NamaMapel || '')}</td>
      <td class="p-2">${escapeHtml_(t.GuruMapel || t.NamaGuru || '')}</td>
      <td class="p-2 max-w-md">${renderTugasDetailRichHtml(t.DetailTugas)}</td>
      <td class="p-2">
        <div class="flex gap-1">
          <button type="button" onclick="editTugasById('${escapeHtml_(String(t.ID || ''))}')" class="px-2 py-1 bg-amber-500 hover:bg-amber-600 text-white rounded font-bold">Edit</button>
          <button type="button" onclick="deleteFromSheet('Tugas','${escapeHtml_(String(t.ID || ''))}')" class="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded font-bold">Hapus</button>
        </div>
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
            <h4 class="font-bold text-sm text-blue-700 dark:text-blue-400">${escapeHtml_(title)}</h4>
            <p class="text-[11px] text-slate-500">${escapeHtml_(dateStr)} • Token: <span class="font-mono font-bold">${escapeHtml_(tokenStr)}</span></p>
          </div>
          <button onclick="openNoteInTTE(${idx})" class="px-3 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded-lg text-[11px] font-bold shrink-0">
            <i class="fa-solid fa-signature mr-1"></i> TTE & PDF
          </button>
        </div>
        <pre class="text-xs whitespace-pre-wrap font-sans text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200 dark:border-slate-800 max-h-40 overflow-y-auto">${escapeHtml_(content)}</pre>
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
  document.getElementById('tte-doc-tanggal').value = document.getElementById('notulen-tanggal').value || formatDocTimestamp_(new Date());
  document.getElementById('tte-doc-isi').value = document.getElementById('notulen-isi').value;
  switchTab('tte');
}

function openNoteInTTE(index) {
  const n = (appData.notulensi || [])[index];
  if (!n) return;
  document.getElementById('tte-doc-judul').value = n.Judul || n.JudulRapat || '';
  document.getElementById('tte-doc-tanggal').value = n.Tanggal || formatDocTimestamp_(new Date());
  document.getElementById('tte-doc-isi').value = n.Isi || n.IsiNotulensi || '';
  if (n.TokenTTE) {
    document.getElementById('page-tte-token-input').value = n.TokenTTE;
  }
  switchTab('tte');
}

function escapeHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function formatInlineBold_(text) {
  return escapeHtml_(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function renderNotulensiBodyHtml_(rawText) {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      html.push('<div style="height: 6px;"></div>');
      continue;
    }

    if (/^#\s+/.test(line)) {
      closeList();
      html.push(`<div style="font-size: 14px; font-weight: 800; color: #0f172a; margin: 10px 0 4px; border-bottom: 1px solid #cbd5e1; padding-bottom: 2px;">${formatInlineBold_(line.replace(/^#\s+/, ''))}</div>`);
    } else if (/^##\s+/.test(line)) {
      closeList();
      html.push(`<div style="font-size: 13px; font-weight: 800; color: #1e3a8a; margin: 8px 0 3px;">${formatInlineBold_(line.replace(/^##\s+/, ''))}</div>`);
    } else if (/^###\s+/.test(line)) {
      closeList();
      html.push(`<div style="font-size: 12px; font-weight: 700; color: #0f172a; margin: 6px 0 2px;">${formatInlineBold_(line.replace(/^###\s+/, ''))}</div>`);
    } else if (/^[-*•]\s+/.test(line)) {
      if (!inList) {
        html.push('<ul style="margin: 2px 0 6px 18px; padding: 0; list-style-type: disc;">');
        inList = true;
      }
      html.push(`<li style="margin-bottom: 2px; line-height: 1.45;">${formatInlineBold_(line.replace(/^[-*•]\s+/, ''))}</li>`);
    } else {
      closeList();
      html.push(`<p style="margin: 0 0 5px; line-height: 1.48;">${formatInlineBold_(line)}</p>`);
    }
  }

  closeList();
  return html.join('');
}

function renderQRCodeSafe_(container, text, size = 100) {
  if (!container) return;
  container.innerHTML = '';
  const holder = document.createElement('div');
  holder.style.display = 'inline-block';
  container.appendChild(holder);

  new QRCode(holder, {
    text: text,
    width: size,
    height: size,
    correctLevel: QRCode.CorrectLevel.M
  });

  setTimeout(() => {
    const canvas = holder.querySelector('canvas');
    if (canvas) {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const img = document.createElement('img');
        img.src = dataUrl;
        img.width = size;
        img.height = size;
        img.style.width = size + 'px';
        img.style.height = size + 'px';
        img.style.display = 'block';
        holder.innerHTML = '';
        holder.appendChild(img);
      } catch (e) {}
    }
  }, 60);
}

function getActiveWebToken_() {
  const inputEl = document.getElementById('page-tte-token-input');
  const fromInput = inputEl ? inputEl.value.trim() : '';
  const dispEl = document.getElementById('admin-token-display');
  const fromDisp = dispEl ? dispEl.textContent.trim() : '';
  const candidate = fromInput || currentActiveToken || (fromDisp !== '------' ? fromDisp : '');
  return String(candidate || '').trim().toUpperCase();
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
      renderQRCodeSafe_(qrContainer, `TOKEN TTE MUSAFA MOBILE: ${res.token}`, 150);
    }
  } catch (err) {}
}

function fillActiveTokenToInput() {
  if (currentActiveToken) {
    document.getElementById('page-tte-token-input').value = currentActiveToken;
  }
}

function formatDocTimestamp_(d) {
  const dt = d instanceof Date ? d : new Date();
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  const ss = String(dt.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy}, ${hh}.${min}.${ss} WIB`;
}

async function verifyTokenOnTTEPage() {
  const tokenVal = getActiveWebToken_();
  const errEl = document.getElementById('page-tte-error');
  const resBox = document.getElementById('page-tte-result');
  errEl.classList.add('hidden');

  if (!tokenVal) {
    verifiedTTEData = null;
    resBox.classList.add('hidden');
    errEl.textContent = 'Token TTE belum tersedia atau belum diisi.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const res = await callBackend('verifyTTEToken', { token: tokenVal }, 'POST');
    if (res && res.valid) {
      verifiedTTEData = {
        ...res,
        token: tokenVal,
        signer: res.signer || 'Muhammad Sufyan Fahriza'
      };
      delete verifiedTTEData.role;

      document.getElementById('tte-signer-name').textContent = verifiedTTEData.signer;
      const tokenLabelEl = document.getElementById('tte-verified-token-label');
      if (tokenLabelEl) tokenLabelEl.textContent = tokenVal;
      document.getElementById('tte-verified-time').textContent = 'Diverifikasi: ' + (res.verifiedAt || '');

      if (!document.getElementById('tte-doc-tanggal').value) {
        document.getElementById('tte-doc-tanggal').value = formatDocTimestamp_(new Date());
      }

      resBox.classList.remove('hidden');

      const previewBox = document.getElementById('verified-qr-preview');
      renderQRCodeSafe_(
        previewBox,
        `TTE MUSAFA MOBILE | Penandatangan: ${verifiedTTEData.signer} | Token: ${tokenVal}`,
        104
      );
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

function generateDocNumber() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `NOT-${y}${m}${d}-${rand}`;
}

async function downloadPDFWithVerifiedTTE() {
  if (!verifiedTTEData) {
    alert('Verifikasi Token TTE terlebih dahulu agar pengesahan QR TTE muncul.');
    return;
  }

  const noDokumen = generateDocNumber();
  const judulKegiatan = (document.getElementById('tte-doc-judul').value || '').trim() || 'Notulensi Kegiatan';
  const waktuCetak = (document.getElementById('tte-doc-tanggal').value || '').trim() || formatDocTimestamp_(new Date());
  const isiNotulensi = document.getElementById('tte-doc-isi').value || '';
  const tokenUsed = getActiveWebToken_() || verifiedTTEData.token || '-';
  const signerName = verifiedTTEData.signer || 'Muhammad Sufyan Fahriza';

  const qrPayload = `TTE MUSAFA MOBILE | ID: ${noDokumen} | Disahkan oleh: ${signerName} | TOKEN TTE VERIFIKASI: ${tokenUsed}`;
  const qrSize = 88;
  const tempQrDiv = document.createElement('div');
  tempQrDiv.style.position = 'fixed';
  tempQrDiv.style.left = '-9999px';
  tempQrDiv.style.top = '0';
  document.body.appendChild(tempQrDiv);

  new QRCode(tempQrDiv, {
    text: qrPayload,
    width: qrSize,
    height: qrSize,
    correctLevel: QRCode.CorrectLevel.M
  });

  await new Promise((resolve) => setTimeout(resolve, 150));

  let qrDataUrl = '';
  const tempCanvas = tempQrDiv.querySelector('canvas');
  const tempImg = tempQrDiv.querySelector('img');
  if (tempCanvas) {
    try {
      qrDataUrl = tempCanvas.toDataURL('image/png');
    } catch (e) {}
  }
  if (!qrDataUrl && tempImg && tempImg.src) {
    qrDataUrl = tempImg.src;
  }
  tempQrDiv.remove();

  const qrHtml = qrDataUrl
    ? `<img src="${qrDataUrl}" alt="QR TTE" width="${qrSize}" height="${qrSize}" style="width:${qrSize}px;height:${qrSize}px;display:block;margin:4px auto;">`
    : `<div style="width:${qrSize}px;height:${qrSize}px;line-height:${qrSize}px;border:1px solid #0f172a;font-size:10px;text-align:center;margin:4px auto;">${escapeHtml_(tokenUsed)}</div>`;

  const bodyHtml = renderNotulensiBodyHtml_(isiNotulensi);

  const pdfContainer = document.getElementById('pdf-render-area');
  pdfContainer.classList.remove('hidden');
  pdfContainer.style.display = 'block';
  pdfContainer.style.position = 'static';
  pdfContainer.style.visibility = 'visible';

  pdfContainer.innerHTML = `
    <div id="pdf-notulensi-sheet" style="width: 210mm; min-height: 297mm; padding: 14mm 16mm 16mm 16mm; font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; box-sizing: border-box; background: #ffffff;">

      <!-- HEADER RESMI -->
      <div style="display: flex; align-items: center; gap: 12px; padding-bottom: 8px; border-bottom: 2.5px solid #1e3a8a; margin-bottom: 12px;">
        <img src="https://drive.google.com/thumbnail?id=1v9XLw_NjWKP9zdtIgREkPYmgakhKMq_n&sz=w150"
             alt="Logo MUSAFA MOBILE"
             crossorigin="anonymous"
             onerror="this.style.display='none'"
             style="width: 44px; height: 44px; object-fit: contain; border-radius: 8px; border: 1px solid #cbd5e1; padding: 2px; flex-shrink: 0;">
        <div>
          <div style="font-size: 13px; font-weight: 800; color: #0f172a; letter-spacing: 0.3px;">MUSAFA MOBILE - SISTEM MANAJEMEN AGENDA DAN TUGAS</div>
          <div style="font-size: 10.5px; color: #475569; margin-top: 1px;">Dokumen Resmi Risalah Rapat & Notulensi Kegiatan Terverifikasi TTE</div>
        </div>
      </div>

      <!-- JUDUL DOKUMEN -->
      <div style="text-align: center; font-size: 15px; font-weight: 800; color: #0f172a; letter-spacing: 0.5px; margin-bottom: 10px;">
        NOTULENSI / RISALAH KEGIATAN
      </div>

      <!-- METADATA DOKUMEN -->
      <table style="width: 100%; border-collapse: collapse; font-size: 11px; line-height: 1.5; margin-bottom: 10px; border-bottom: 1px solid #cbd5e1; padding-bottom: 8px;">
        <tr>
          <td style="width: 110px; padding: 2px 0; font-weight: 700; color: #334155;">No. Dokumen</td>
          <td style="width: 12px; padding: 2px 0; font-weight: 700;">:</td>
          <td style="padding: 2px 0; font-family: monospace; font-weight: 700;">${escapeHtml_(noDokumen)}</td>
        </tr>
        <tr>
          <td style="padding: 2px 0; font-weight: 700; color: #334155;">Judul Kegiatan</td>
          <td style="padding: 2px 0; font-weight: 700;">:</td>
          <td style="padding: 2px 0; font-weight: 700;">${escapeHtml_(judulKegiatan)}</td>
        </tr>
        <tr>
          <td style="padding: 2px 0; font-weight: 700; color: #334155;">Waktu Cetak</td>
          <td style="padding: 2px 0; font-weight: 700;">:</td>
          <td style="padding: 2px 0;">${escapeHtml_(waktuCetak)}</td>
        </tr>
      </table>

      <!-- ISI NOTULENSI -->
      <div style="margin-bottom: 18px;">
        <div style="font-size: 11.5px; font-weight: 800; color: #0f172a; margin-bottom: 6px;">Isi Notulensi:</div>
        <div style="font-size: 11px; color: #1e293b;">${bodyHtml}</div>
      </div>

      <!-- PENGESAHAN TTE & TOKEN -->
      <div style="margin-top: 18px; padding-top: 12px; border-top: 1px dashed #94a3b8; display: flex; justify-content: flex-end;">
        <div style="width: 250px; text-align: center; font-size: 11px; line-height: 1.45;">
          <div style="font-weight: 600; color: #334155;">Disahkan secara elektronik (TTE) oleh,</div>
          ${qrHtml}
          <div style="font-size: 12px; font-weight: 800; color: #0f172a; margin-top: 2px;">${escapeHtml_(signerName)}</div>
          <div style="font-size: 10.5px; font-weight: 800; font-family: monospace; color: #1e3a8a; margin-top: 2px;">TOKEN TTE VERIFIKASI: ${escapeHtml_(tokenUsed)}</div>
        </div>
      </div>

      <!-- FOOTER ID & VERIFIKASI -->
      <div style="margin-top: 14px; padding-top: 6px; border-top: 1px solid #e2e8f0; font-size: 9.5px; color: #475569; text-align: center;">
        ID: ${escapeHtml_(noDokumen)} | Verifikasi token pada menu TTE & Verifikasi QR di MUSAFA Mobile
      </div>

    </div>
  `;

  await new Promise((resolve) => setTimeout(resolve, 150));

  const sheetEl = document.getElementById('pdf-notulensi-sheet') || pdfContainer;
  const opt = {
    margin: 0,
    filename: `Notulensi_${judulKegiatan.replace(/[^a-zA-Z0-9_-]+/g, '_')}_${noDokumen}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, allowTaint: true, logging: false },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };

  try {
    await html2pdf().set(opt).from(sheetEl).save();
  } finally {
    pdfContainer.classList.add('hidden');
    pdfContainer.style.display = '';
    pdfContainer.style.position = '';
    pdfContainer.style.visibility = '';
    pdfContainer.innerHTML = '';
  }
}

// ==================== NOTIFIKASI GMAIL OTOMATIS & TES ====================
function getTaskDisplayName(t) {
  const parsed = parseTugasDetail(t.DetailTugas);
  const detail = (parsed.deskripsi || parsed.pdfName || parsed.fotoName || parsed.driveLink || t.DetailTugas || '').trim();
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

  selEl.innerHTML = items.map((nm, idx) => `<option value="${idx}">${escapeHtml_(nm)}</option>`).join('');
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
      <div class="font-semibold">${escapeHtml_(a.Judul || '-')}</div>
      <div class="text-[11px] text-slate-500">${escapeHtml_(String(a.JatuhTempo || '').replace('T', ' '))}</div>
    </div>`;
  });

  tugases.forEach(t => {
    const nm = getTaskDisplayName(t);
    html += `<div class="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20">
      <div class="font-bold text-rose-600 dark:text-rose-400">[Tugas • 1 Hari Sebelumnya]</div>
      <div class="font-semibold">${escapeHtml_(nm)}</div>
      <div class="text-[11px] text-slate-500">${escapeHtml_(String(t.Deadline || '').replace('T', ' '))}</div>
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