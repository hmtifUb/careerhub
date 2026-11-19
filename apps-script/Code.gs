// ============================================================================
// HMTIF CAREER HUB — GOOGLE APPS SCRIPT (ARSITEKTUR HYBRID)
// Peran Google Sheets: CMS Pengurus + Log Aktivitas + Arsip + Notifikasi Email
// Peran Supabase     : Database Eksternal Super Ringan untuk Web Publik
//
// SETUP SEKALI:
// 1. Di Apps Script -> Project Settings (ikon gerigi) -> Script Properties, isi:
//      - SUPABASE_URL        : https://<project-ref>.supabase.co
//      - SUPABASE_SECRET_KEY : sb_secret_... (atau Legacy service_role key)
//      - PUBLIC_WEB_URL      : https://<domain-web-kamu> (opsional)
// 2. Jalankan fungsi pancingEmail() sekali untuk memberi izin MailApp.
// 3. Jalankan fungsi setupCareerHubHybrid() sekali sebagai PEMILIK Spreadsheet.
// 4. Jalankan fungsi migrateExistingStatsToSupabase() SEKALI untuk memindahkan
//    data kunjungan & rating lama ke Supabase.
// ============================================================================

const CAREER_HUB_SHEETS = ['KARIER', 'PENGEMBANGAN', 'OPPORTUNITIES'];
const CAREER_HUB_NEWS_SHEET = 'BERITA';
const CAREER_HUB_TZ = 'Asia/Jakarta';
const CAREER_HUB_ARCHIVE_PREFIX = 'ARSIP - ';
const CAREER_HUB_TRAFFIC_SHEET = 'STAT_KUNJUNGAN';
const CAREER_HUB_AUDIT_SHEET = 'LOG AKTIVITAS';
const CAREER_HUB_NOTIFY_EMAIL = 'rehanramadehan23@gmail.com';
const CAREER_HUB_AUDIT_HEADERS = [
  'Waktu (WIB)', 'Email Editor', 'Nama Sheet', 'Sel / Rentang',
  'Jenis Aktivitas', 'Nilai Sebelum', 'Nilai Sesudah', 'Jumlah Sel'
];

// ============================================================================
// MENU GOOGLE SHEETS (1-klik sync langsung dari spreadsheet)
// ============================================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('HMTIF Career Hub')
    .addItem('Sync Semua Data ke Supabase Sekarang', 'syncAllToSupabaseMenu')
    .addItem('Cek Feedback Baru & Kirim Email', 'pullNewFeedbackMenu')
    .addItem('Arsipkan Program Berakhir & Sync', 'archiveCareerHubExpiredMenu')
    .addSeparator()
    .addItem('Buat Template Tab BERITA', 'setupCareerHubNewsSheetMenu')
    .addItem('Migrasi Data Lama ke Supabase (Sekali)', 'migrateExistingStatsMenu')
    .addItem('Cek Koneksi Supabase & Sheet', 'checkCareerHubConnectionMenu')
    .addToUi();
}

function syncAllToSupabaseMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    const res = syncAllToSupabase();
    ui.alert(
      'Sync Berhasil',
      'Program tersinkron: ' + res.synced +
      (typeof res.synced_news === 'number' ? '\nBerita tersinkron: ' + res.synced_news : '') +
      '\nTerakhir update: ' + res.last_updated,
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert('Sync Gagal', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

function setupCareerHubNewsSheetMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    const msg = setupCareerHubNewsSheet();
    ui.alert('Tab BERITA Siap', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Gagal Membuat Tab BERITA', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

function pullNewFeedbackMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    const res = pullNewFeedbackFromSupabase();
    ui.alert('Cek Feedback Selesai', 'Feedback diproses: ' + res.processed + '\nEmail terkirim: ' + res.emailed, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Gagal Cek Feedback', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

function archiveCareerHubExpiredMenu() {
  const ui = SpreadsheetApp.getUi();
  try {
    const res = archiveCareerHubExpired();
    ui.alert('Arsip & Sync Selesai', 'Total dipindahkan ke tab ARSIP: ' + res.total + ' program.', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Gagal Arsip', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

function migrateExistingStatsMenu() {
  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert(
    'Migrasi Data Lama ke Supabase',
    'Fitur ini memindahkan semua program, riwayat kunjungan (STAT_KUNJUNGAN & HOME), serta riwayat RATING ke Supabase.\n\nLanjutkan?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;
  try {
    const res = migrateExistingStatsToSupabase();
    ui.alert(
      'Migrasi Selesai',
      'Program tersinkron: ' + res.programsSynced +
      '\nHari kunjungan dimigrasi: ' + res.visitDaysMigrated +
      '\nOffset kunjungan historis: ' + res.historicalVisitsOffset +
      '\nRating lama dimigrasi: ' + res.ratingsMigrated,
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert('Migrasi Gagal', String(err && err.message ? err.message : err), ui.ButtonSet.OK);
  }
}

function checkCareerHubConnectionMenu() {
  const ui = SpreadsheetApp.getUi();
  const res = checkCareerHubConnection();
  ui.alert('Status Koneksi HMTIF Career Hub', JSON.stringify(res, null, 2), ui.ButtonSet.OK);
}

// ============================================================================
// KONFIGURASI & CLIENT HTTP SUPABASE
// ============================================================================

function cleanSheetName_(name) {
  return String(name || '').trim().toUpperCase();
}

function isCareerHubMonitoredSheet_(name) {
  const cleaned = cleanSheetName_(name);
  if (cleaned === cleanSheetName_(CAREER_HUB_NEWS_SHEET)) return true;
  if (CAREER_HUB_SHEETS.includes(cleaned)) return true;
  return CAREER_HUB_SHEETS.some(cat => cleaned === cleanSheetName_(CAREER_HUB_ARCHIVE_PREFIX + cat));
}

function getSupabaseConfig_() {
  const props = PropertiesService.getScriptProperties();
  const url = String(props.getProperty('SUPABASE_URL') || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');
  const secretKey = String(
    props.getProperty('SUPABASE_SECRET_KEY') ||
    props.getProperty('SUPABASE_SERVICE_ROLE_KEY') ||
    ''
  ).trim();

  if (!url || !secretKey) {
    throw new Error(
      'Konfigurasi Supabase belum diisi. Buka Apps Script -> Project Settings -> Script Properties, ' +
      'lalu tambahkan SUPABASE_URL dan SUPABASE_SECRET_KEY.'
    );
  }
  return { url, secretKey };
}

function supabaseHeaders_(secretKey, extraHeaders) {
  const headers = {
    apikey: secretKey
  };
  // Legacy JWT key (eyJ...) memakai Bearer; sb_secret_... cukup lewat header apikey.
  if (secretKey.indexOf('eyJ') === 0) {
    headers.Authorization = 'Bearer ' + secretKey;
  }
  if (extraHeaders) {
    Object.keys(extraHeaders).forEach(k => { headers[k] = extraHeaders[k]; });
  }
  return headers;
}

function supabaseRequest_(path, method, payload, extraHeaders) {
  const cfg = getSupabaseConfig_();
  const options = {
    method: method || 'get',
    contentType: 'application/json',
    headers: supabaseHeaders_(cfg.secretKey, extraHeaders),
    muteHttpExceptions: true
  };
  if (payload !== undefined && payload !== null) {
    options.payload = JSON.stringify(payload);
  }

  const response = UrlFetchApp.fetch(cfg.url + path, options);
  const code = response.getResponseCode();
  const text = response.getContentText() || '';

  if (code < 200 || code >= 300) {
    throw new Error('Supabase HTTP ' + code + ' (' + path + '): ' + text.slice(0, 400));
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return text;
  }
}

function markSupabaseSyncNeeded_() {
  PropertiesService.getScriptProperties().setProperty('SUPABASE_SYNC_DIRTY', 'true');
}

// ============================================================================
// PEMBACAAN DATA SHEET & SINKRONISASI KE SUPABASE
// ============================================================================

function careerHubDateKey_(raw, display) {
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return Utilities.formatDate(raw, CAREER_HUB_TZ, 'yyyy-MM-dd');
  }
  const text = String(display || raw || '').trim();
  let match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (match) {
    const d = Number(match[1]), m = Number(match[2]), y = Number(match[3]);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
  }
  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  }
  const months = {
    januari: 1, january: 1, jan: 1,
    februari: 2, february: 2, feb: 2,
    maret: 3, march: 3, mar: 3,
    april: 4, apr: 4,
    mei: 5, may: 5,
    juni: 6, june: 6, jun: 6,
    juli: 7, july: 7, jul: 7,
    agustus: 8, august: 8, agu: 8, aug: 8,
    september: 9, sep: 9,
    oktober: 10, october: 10, okt: 10, oct: 10,
    november: 11, nov: 11,
    desember: 12, december: 12, des: 12, dec: 12
  };
  match = text.toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (match && months[match[2]]) {
    return match[3] + '-' + String(months[match[2]]).padStart(2, '0') + '-' + String(match[1]).padStart(2, '0');
  }
  return '';
}

function careerHubIsExpired_(status, rawDate, displayDate) {
  const value = String(status || '').toLowerCase();
  if (/telah berakhir|sudah berakhir|ditutup|closed|selesai|\btutup\b/.test(value)) return true;
  const key = careerHubDateKey_(rawDate, displayDate);
  const today = Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'yyyy-MM-dd');
  return Boolean(key && key < today);
}

function careerHubColumns_(headers, category) {
  const normalized = headers.map(v => String(v || '').trim().toLowerCase());
  const fallback = {
    KARIER: { penyelenggara: 1, jenis: 3, date: 4, status: 5, link: 6 },
    PENGEMBANGAN: { penyelenggara: 1, jenis: 2, date: 5, status: 6, link: 7 },
    OPPORTUNITIES: { penyelenggara: 1, jenis: 2, date: 6, status: 7, link: 8 }
  }[category];

  const find = (regex, fb) => {
    const idx = normalized.findIndex(v => regex.test(v));
    return idx >= 0 ? idx : fb;
  };

  return {
    penyelenggara: find(/perusahaan|penyelenggara|instansi|organisasi/, fallback.penyelenggara),
    jenis: find(/^jenis$|kategori|tipe/, fallback.jenis),
    date: find(/tanggal|deadline/, fallback.date),
    status: find(/^status$/, fallback.status),
    link: find(/link|tautan|url/, fallback.link)
  };
}

function findSheetCaseInsensitive_(ss, targetName) {
  const cleanTarget = cleanSheetName_(targetName);
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (cleanSheetName_(sheets[i].getName()) === cleanTarget) return sheets[i];
  }
  return null;
}

function extractCellValue_(displayText, richCell, formula) {
  let url = richCell ? richCell.getLinkUrl() : null;
  if (!url && richCell) {
    const runs = richCell.getRuns();
    for (let k = 0; k < runs.length; k++) {
      const runUrl = runs[k].getLinkUrl();
      if (runUrl) {
        url = runUrl;
        break;
      }
    }
  }
  if (url) return url;
  if (formula && formula.toUpperCase().indexOf('=HYPERLINK') !== -1) {
    const match = formula.match(/=HYPERLINK\(\s*"([^"]+)"/i);
    if (match && match[1]) return match[1];
  }
  return displayText;
}

function careerHubCollectSheetPrograms_(sheet, category, isArchiveSheet, startOrder) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const range = sheet.getDataRange();
  const displayValues = range.getDisplayValues();
  const rawValues = range.getValues();
  const richValues = range.getRichTextValues();
  const formulas = range.getFormulas();

  const headers = displayValues[0] || [];
  const cols = careerHubColumns_(headers, category);
  const sourceSheetName = sheet.getName();
  const records = [];

  for (let i = 1; i < displayValues.length; i++) {
    const nama = String(displayValues[i][0] || '').trim();
    if (!nama) continue;

    const extractedRow = displayValues[i].map((text, j) =>
      extractCellValue_(text, richValues[i][j], formulas[i][j])
    );

    const penyelenggara = String(extractedRow[cols.penyelenggara] || '').trim();
    const jenis = String(extractedRow[cols.jenis] || '').trim();
    const deadlineText = String(displayValues[i][cols.date] || '').trim();
    const deadlineIso = careerHubDateKey_(rawValues[i][cols.date], deadlineText) || null;
    const rawStatus = String(displayValues[i][cols.status] || '').trim();
    const linkInfo = String(extractedRow[cols.link] || '').trim();
    const expired = isArchiveSheet || careerHubIsExpired_(rawStatus, rawValues[i][cols.date], deadlineText);

    const extraFields = [];
    for (let j = 0; j < Math.max(headers.length, extractedRow.length); j++) {
      extraFields.push({
        label: String(headers[j] || ('Kolom ' + (j + 1))).trim(),
        value: String(extractedRow[j] == null ? '' : extractedRow[j]).trim()
      });
    }

    records.push({
      category: category,
      source_sheet: sourceSheetName,
      row_order: startOrder + records.length,
      nama: nama,
      penyelenggara: penyelenggara,
      jenis: jenis,
      deadline_text: deadlineText,
      deadline_date: deadlineIso,
      status: expired ? '🔴 Telah Berakhir' : rawStatus,
      link_info: linkInfo,
      extra_fields: extraFields,
      is_archived: expired
    });
  }
  return records;
}

function careerHubCollectNews_(ss) {
  const sheet = findSheetCaseInsensitive_(ss, CAREER_HUB_NEWS_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return null;

  const range = sheet.getDataRange();
  const display = range.getDisplayValues();
  const rich = range.getRichTextValues();
  const formulas = range.getFormulas();
  const headers = (display[0] || []).map(v => String(v || '').trim().toLowerCase());

  const col = (regex, fb) => {
    const idx = headers.findIndex(v => regex.test(v));
    return idx >= 0 ? idx : fb;
  };
  const cJudul = col(/judul|title/, 0);
  const cKategori = col(/kategori|label|jenis/, 1);
  const cRingkasan = col(/ringkasan|deskripsi|summary/, 2);
  const cIsi = col(/isi|detail|konten/, 3);
  const cGambar = col(/gambar|poster|banner|image/, 4);
  const cLampiran = col(/lampiran|attachment|download/, 5);
  const cLink = col(/link|tautan|url/, 6);
  const cTanggal = col(/tanggal|waktu|date/, 7);
  const cStatus = col(/status|aktif/, 8);

  const items = [];
  for (let i = 1; i < display.length; i++) {
    const judul = String(display[i][cJudul] || '').trim();
    if (!judul) continue;
    const statusText = String(display[i][cStatus] || 'Aktif').trim().toLowerCase();
    const isActive = !/nonaktif|arsip|hidden|sembunyi|false|tidak/.test(statusText);

    const val = (idx) => idx < display[i].length
      ? String(extractCellValue_(display[i][idx], rich[i][idx], formulas[i][idx]) || '').trim()
      : '';

    items.push({
      row_order: items.length + 1,
      judul: judul,
      kategori: String(display[i][cKategori] || 'Pengumuman').trim() || 'Pengumuman',
      ringkasan: String(display[i][cRingkasan] || '').trim(),
      isi_lengkap: String(display[i][cIsi] || '').trim(),
      gambar_url: val(cGambar),
      lampiran_url: val(cLampiran),
      link_url: val(cLink),
      tanggal_text: String(display[i][cTanggal] || '').trim(),
      is_active: isActive
    });
  }
  return items;
}

function setupCareerHubNewsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = findSheetCaseInsensitive_(ss, CAREER_HUB_NEWS_SHEET);
  if (sheet) return 'Tab BERITA sudah ada. Edit barisnya lalu jalankan Sync Semua Data ke Supabase.';

  sheet = ss.insertSheet(CAREER_HUB_NEWS_SHEET);
  const headers = ['Judul', 'Kategori', 'Ringkasan', 'Isi Lengkap', 'Gambar URL', 'Lampiran URL', 'Link Selengkapnya', 'Tanggal', 'Status'];
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight('bold')
    .setBackground('#8e1430')
    .setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setTabColor('#a61932');
  sheet.appendRow([
    'PEMBARUAN INFORMASI HMTIF CAREER HUB',
    'Pengumuman',
    'Seluruh info magang, lowongan kerja, pelatihan, dan lomba mahasiswa Teknik Informatika Universitas Bakrie diperbarui rutin setiap pekan.',
    'Halo mahasiswa Teknik Informatika Universitas Bakrie! HMTIF Career Hub kini berjalan di sistem cloud baru yang jauh lebih cepat. Pantau terus tab Karier, Pengembangan, dan Opportunities agar tidak ketinggalan deadline.',
    '',
    '',
    'https://whatsapp.com/channel/0029VbDskQcDDmFLvlye9R0R',
    Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'dd MMMM yyyy'),
    'Aktif'
  ]);
  return 'Tab BERITA berhasil dibuat dengan contoh 1 berita. Kamu bisa menambahkan berita kampus/HMTIF di tab tersebut.';
}

/**
 * Sinkronisasi seluruh program aktif & arsip (plus tab BERITA jika ada) dari Google Sheets ke Supabase
 * dalam 1 transaksi atomik (RPC replace_career_hub_programs).
 */
function syncAllToSupabase(allowEmpty) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('Spreadsheet tidak terhubung dengan project Apps Script.');

    const allPrograms = [];
    CAREER_HUB_SHEETS.forEach(category => {
      const liveSheet = findSheetCaseInsensitive_(ss, category);
      const archiveSheet = findSheetCaseInsensitive_(ss, CAREER_HUB_ARCHIVE_PREFIX + category);

      const liveItems = careerHubCollectSheetPrograms_(liveSheet, category, false, allPrograms.length + 1);
      liveItems.forEach(item => allPrograms.push(item));

      const archiveItems = careerHubCollectSheetPrograms_(archiveSheet, category, true, allPrograms.length + 1);
      archiveItems.forEach(item => allPrograms.push(item));
    });

    const home = ss.getSheetByName('HOME');
    let lastUpdated = home ? String(home.getRange('K9').getDisplayValue() || '').trim() : '';
    if (!lastUpdated) {
      lastUpdated = Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'dd MMMM yyyy\nHH:mm');
    }

    const result = supabaseRequest_('/rest/v1/rpc/replace_career_hub_programs', 'post', {
      p_programs: allPrograms,
      p_last_updated: lastUpdated,
      p_allow_empty: Boolean(allowEmpty)
    });

    let syncedNews = null;
    const newsItems = careerHubCollectNews_(ss);
    if (newsItems !== null) {
      try {
        const newsRes = supabaseRequest_('/rest/v1/rpc/replace_career_hub_news', 'post', {
          p_news: newsItems
        });
        syncedNews = newsRes && typeof newsRes.synced_news === 'number' ? newsRes.synced_news : newsItems.length;
      } catch (newsErr) {
        console.warn('Sync tab BERITA dilewati (pastikan tabel news sudah dibuat di Supabase): ' + newsErr);
      }
    }

    const props = PropertiesService.getScriptProperties();
    props.setProperty('SUPABASE_SYNC_DIRTY', 'false');
    props.setProperty('SUPABASE_LAST_SYNC_AT', String(Date.now()));

    const output = result || { synced: allPrograms.length, last_updated: lastUpdated };
    if (syncedNews !== null) output.synced_news = syncedNews;
    return output;
  } finally {
    lock.releaseLock();
  }
}

// ============================================================================
// TARIK FEEDBACK BARU DARI SUPABASE -> SIMPAN KE TAB RATING & KIRIM EMAIL
// ============================================================================

function pullNewFeedbackFromSupabase() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const pending = supabaseRequest_(
      '/rest/v1/ratings?select=id,star,saran,emailed,synced_to_sheet,created_at&or=(emailed.eq.false,synced_to_sheet.eq.false)&order=id.asc&limit=50',
      'get'
    );
    if (!Array.isArray(pending) || !pending.length) {
      return { processed: 0, emailed: 0 };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('RATING');
    if (!sheet) {
      sheet = ss.insertSheet('RATING');
      sheet.appendRow(['Waktu', 'Bintang', 'Saran']);
    }

    let processed = 0;
    let emailedCount = 0;

    pending.forEach(item => {
      const star = Number(item.star) || 0;
      const saran = String(item.saran || '').trim();
      const createdAt = item.created_at ? new Date(item.created_at) : new Date();
      let syncedSheet = Boolean(item.synced_to_sheet);
      let emailed = Boolean(item.emailed);

      if (!syncedSheet) {
        sheet.appendRow([createdAt, star > 0 ? star : '-', saran]);
        syncedSheet = true;
      }

      if (!emailed) {
        if (star > 0 || saran !== '') {
          try {
            let subject, body;
            const waktuText = Utilities.formatDate(createdAt, CAREER_HUB_TZ, 'dd MMMM yyyy HH:mm:ss');
            if (star > 0) {
              subject = 'Feedback Baru - HMTIF Career Hub';
              const saranText = saran !== '' ? saran : '(Hanya memberi bintang, tidak menulis saran)';
              body = 'Halo Pengelola HMTIF Career Hub!\n\n' +
                     'Ada penilaian & masukan baru dari pengguna:\n\n' +
                     'Tingkat Kepuasan : ' + star + ' Bintang\n' +
                     'Saran / Masukan  : ' + saranText + '\n\n' +
                     'Waktu Pengiriman : ' + waktuText;
            } else {
              subject = 'Saran Tambahan - HMTIF Career Hub';
              body = 'Halo Pengelola HMTIF Career Hub!\n\n' +
                     'Ada saran TAMBAHAN baru dari pengguna yang sudah pernah memberi rating bintang sebelumnya:\n\n' +
                     'Saran / Masukan  : ' + saran + '\n\n' +
                     'Waktu Pengiriman : ' + waktuText;
            }
            MailApp.sendEmail(CAREER_HUB_NOTIFY_EMAIL, subject, body);
            emailed = true;
            emailedCount++;
          } catch (mailErr) {
            console.error('Gagal mengirim email feedback #' + item.id + ': ' + mailErr);
          }
        } else {
          emailed = true;
        }
      }

      supabaseRequest_(
        '/rest/v1/ratings?id=eq.' + encodeURIComponent(String(item.id)),
        'patch',
        { emailed: emailed, synced_to_sheet: syncedSheet }
      );
      processed++;
    });

    return { processed: processed, emailed: emailedCount };
  } finally {
    lock.releaseLock();
  }
}

/** Sinkronkan balik angka total kunjungan terbaru dari Supabase ke HOME!M7 (best-effort, tidak pernah menurunkan angka historis). */
function syncVisitTotalBackToHome_() {
  try {
    const stats = supabaseRequest_('/rest/v1/rpc/get_visit_stats', 'post', { p_days: 7 });
    const total = Number(stats && stats.total) || 0;
    if (total <= 0) return;

    const props = PropertiesService.getScriptProperties();
    const existingProps = Number(props.getProperty('KUNJUNGAN')) || 0;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const home = ss && ss.getSheetByName('HOME');
    let existingHome = 0;
    if (home) {
      try {
        existingHome = Number(home.getRange('M7').getValue()) || 0;
      } catch (err) {}
    }

    const bestTotal = Math.max(total, existingProps, existingHome);
    props.setProperty('KUNJUNGAN', String(bestTotal));
    if (home && bestTotal > existingHome) {
      home.getRange('M7').setValue(bestTotal);
    }
  } catch (err) {
    console.warn('Sinkronisasi total kunjungan ke HOME!M7 dilewati: ' + err);
  }
}

// ============================================================================
// TRIGGER OTOMATIS SETIAP 5 MENIT
// ============================================================================

function scheduledCareerHubSync() {
  const props = PropertiesService.getScriptProperties();
  const dirty = props.getProperty('SUPABASE_SYNC_DIRTY') === 'true';
  const lastSyncAt = Number(props.getProperty('SUPABASE_LAST_SYNC_AT')) || 0;
  const stale = (Date.now() - lastSyncAt) > (60 * 60 * 1000); // refresh pengaman tiap 1 jam

  if (dirty || stale) {
    try {
      syncAllToSupabase();
    } catch (err) {
      console.error('scheduledCareerHubSync -> syncAllToSupabase gagal: ' + err);
    }
  }

  try {
    pullNewFeedbackFromSupabase();
  } catch (err) {
    console.error('scheduledCareerHubSync -> pullNewFeedbackFromSupabase gagal: ' + err);
  }

  syncVisitTotalBackToHome_();
}

// ============================================================================
// MIGRASI SEKALI DATA LAMA (STAT_KUNJUNGAN, HOME!M7, RATING) KE SUPABASE
// ============================================================================

function migrateExistingStatsToSupabase(forceRatings) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Spreadsheet tidak ditemukan.');

  // 1. Sync seluruh program aktif & arsip
  const progRes = syncAllToSupabase();

  // 2. Migrasi STAT_KUNJUNGAN -> daily_visits
  const log = ss.getSheetByName(CAREER_HUB_TRAFFIC_SHEET);
  const dailyMap = {};
  if (log && log.getLastRow() > 1) {
    const range = log.getRange(2, 1, log.getLastRow() - 1, 2);
    const data = range.getValues();
    const display = range.getDisplayValues();
    data.forEach((row, i) => {
      const date = careerHubDateKey_(row[0], display[i][0]);
      const amount = Math.max(0, Math.round(Number(row[1]) || 0));
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && amount > 0) {
        dailyMap[date] = (dailyMap[date] || 0) + amount;
      }
    });
  }

  const dailyRows = Object.keys(dailyMap).sort().map(date => ({
    visit_date: date,
    count: dailyMap[date]
  }));

  if (dailyRows.length) {
    supabaseRequest_(
      '/rest/v1/daily_visits?on_conflict=visit_date',
      'post',
      dailyRows,
      { Prefer: 'resolution=merge-duplicates' }
    );
  }

  // Hitung selisih historis agar total kunjungan tidak berkurang
  const sumDaily = dailyRows.reduce((acc, r) => acc + r.count, 0);
  const propsTotal = Number(PropertiesService.getScriptProperties().getProperty('KUNJUNGAN')) || 0;
  const home = ss.getSheetByName('HOME');
  let homeTotal = 0;
  if (home) {
    try {
      homeTotal = Number(home.getRange('M7').getValue()) || Number(home.getRange('N7').getValue()) || 0;
    } catch (err) {}
  }
  const historicalTotal = Math.max(propsTotal, homeTotal, sumDaily);
  const historicalOffset = Math.max(0, historicalTotal - sumDaily);

  supabaseRequest_(
    '/rest/v1/hub_meta?on_conflict=key',
    'post',
    [{ key: 'historical_visits_offset', value: String(historicalOffset) }],
    { Prefer: 'resolution=merge-duplicates' }
  );

  // 3. Migrasi RATING lama (hanya jika tabel ratings Supabase masih kosong, atau forceRatings=true)
  let ratingsMigrated = 0;
  const existingRatings = supabaseRequest_('/rest/v1/ratings?select=id&limit=1', 'get');
  const ratingSheet = ss.getSheetByName('RATING');
  if (ratingSheet && ratingSheet.getLastRow() > 1 && (forceRatings === true || !existingRatings || existingRatings.length === 0)) {
    const rawRatings = ratingSheet.getRange(2, 1, ratingSheet.getLastRow() - 1, 3).getValues();
    const payload = [];
    rawRatings.forEach(r => {
      const star = Number(r[1]);
      const validStar = (star >= 1 && star <= 5) ? Math.round(star) : 0;
      const saran = String(r[2] || '').trim().slice(0, 2000);
      if (validStar === 0 && saran === '') return;
      const dt = (r[0] instanceof Date && !isNaN(r[0].getTime())) ? r[0].toISOString() : new Date().toISOString();
      payload.push({
        star: validStar,
        saran: saran,
        emailed: true,
        synced_to_sheet: true,
        created_at: dt
      });
    });

    if (payload.length) {
      supabaseRequest_('/rest/v1/ratings', 'post', payload);
      ratingsMigrated = payload.length;
    }
  }

  return {
    programsSynced: progRes.synced || 0,
    visitDaysMigrated: dailyRows.length,
    historicalVisitsOffset: historicalOffset,
    ratingsMigrated: ratingsMigrated
  };
}

// ============================================================================
// ARSIP OTOMATIS HARIAN DI GOOGLE SHEETS (TETAP DIPERTAHANKAN + AUTO SYNC)
// ============================================================================

function archiveCareerHubExpired() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  const totals = {};
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const nowKey = Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'dd MMMM yyyy\nHH:mm');
    CAREER_HUB_SHEETS.forEach(category => {
      const source = findSheetCaseInsensitive_(ss, category);
      totals[category] = 0;
      if (!source || source.getLastRow() < 2) return;

      const lastCol = source.getLastColumn();
      const data = source.getRange(1, 1, source.getLastRow(), lastCol);
      const raw = data.getValues();
      const display = data.getDisplayValues();
      const cols = careerHubColumns_(display[0], category);
      let archive = findSheetCaseInsensitive_(ss, CAREER_HUB_ARCHIVE_PREFIX + category);

      for (let r = display.length - 1; r >= 1; r--) {
        if (!String(display[r][0] || '').trim()) continue;
        if (!careerHubIsExpired_(display[r][cols.status], raw[r][cols.date], display[r][cols.date])) continue;

        if (!archive) {
          archive = ss.insertSheet(CAREER_HUB_ARCHIVE_PREFIX + category);
          source.getRange(1, 1, 1, lastCol).copyTo(archive.getRange(1, 1, 1, lastCol));
          archive.setFrozenRows(1);
        }
        const dest = archive.getLastRow() + 1;
        source.getRange(r + 1, 1, 1, lastCol).copyTo(archive.getRange(dest, 1, 1, lastCol));
        archive.getRange(dest, cols.date + 1).setValue(raw[r][cols.date]);
        archive.getRange(dest, cols.status + 1).setValue('🔴 Telah Berakhir');
        source.deleteRow(r + 1);
        totals[category]++;
      }
    });

    if (Object.values(totals).some(v => v > 0)) {
      const home = ss.getSheetByName('HOME');
      if (home) home.getRange('K9').setValue(nowKey);
    }
  } finally {
    lock.releaseLock();
  }

  // Dorong hasil terbaru ke Supabase setelah arsip selesai
  try {
    syncAllToSupabase();
  } catch (err) {
    console.error('Sync Supabase pasca-arsip gagal: ' + err);
  }

  return { moved: totals, total: Object.values(totals).reduce((a, b) => a + b, 0) };
}

function setupCareerHubArchive() {
  const handler = 'archiveCareerHubExpired';
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyDays(1)
    .atHour(1)
    .inTimezone(CAREER_HUB_TZ)
    .create();
  return 'Pemicu arsip otomatis harian (sekitar 01.00 WIB) berhasil dibuat.';
}

function setupCareerHubSyncTrigger() {
  const handler = 'scheduledCareerHubSync';
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyMinutes(5)
    .create();
  return 'Pemicu sinkronisasi Supabase setiap 5 menit berhasil dibuat.';
}

// ============================================================================
// UPDATE WAKTU & LOG AKTIVITAS EDITOR (TETAP DIPERTAHANKAN)
// ============================================================================

function updateLastUpdated(e) {
  if (!e || !e.range) return;
  const ss = e.source || SpreadsheetApp.getActiveSpreadsheet();
  const sheet = e.range.getSheet();
  const namaSheet = sheet.getName();

  if (!isCareerHubMonitoredSheet_(namaSheet)) return;

  const home = ss.getSheetByName('HOME');
  if (home) {
    home.getRange('K9').setValue(
      Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'dd MMMM yyyy\nHH:mm')
    );
  }
  markSupabaseSyncNeeded_();
}

function careerHubAuditEmail_(e) {
  try {
    if (e && e.user && typeof e.user.getEmail === 'function') {
      const email = String(e.user.getEmail() || '').trim();
      if (email) return email;
    }
  } catch (err) {
    console.warn('Identitas editor tidak disediakan Google: ' + err);
  }
  return 'Tidak tersedia (pembatasan Google)';
}

function careerHubAuditText_(value) {
  const text = String(value == null ? '' : value);
  return text.length > 800 ? text.slice(0, 800) + '… [dipotong]' : text;
}

function careerHubAuditPreview_(range) {
  const rowLimit = Math.min(range.getNumRows(), 4);
  const colLimit = Math.min(range.getNumColumns(), 4);
  const values = range.offset(0, 0, rowLimit, colLimit).getDisplayValues();
  const lines = values.map(row => row.map(value => String(value)).join(' | '));
  const sampled = rowLimit * colLimit;
  const total = range.getNumRows() * range.getNumColumns();
  return careerHubAuditText_(lines.join(' / ') +
    (total > sampled ? ' [contoh ' + sampled + ' dari ' + total + ' sel]' : ''));
}

function careerHubAuditAppend_(ss, record) {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const log = ss.getSheetByName(CAREER_HUB_AUDIT_SHEET);
    if (!log) throw new Error('Tab LOG AKTIVITAS belum ada. Jalankan setupCareerHubAudit() dulu.');
    log.appendRow(record);
  } finally {
    lock.releaseLock();
  }
}

function careerHubAuditOnEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  const sheetName = sheet.getName();
  if (cleanSheetName_(sheetName) === cleanSheetName_(CAREER_HUB_AUDIT_SHEET)) return;

  const ss = e.source || SpreadsheetApp.getActiveSpreadsheet();
  const range = e.range;
  const cellCount = range.getNumRows() * range.getNumColumns();
  let action, before, after;

  if (cellCount === 1) {
    before = Object.prototype.hasOwnProperty.call(e, 'oldValue')
      ? careerHubAuditText_(e.oldValue)
      : '(kosong / tidak tersedia dari Google)';
    const newDisplayValue = String(range.getDisplayValue() || '');
    after = newDisplayValue ? careerHubAuditText_(newDisplayValue) : '(kosong)';
    if (!newDisplayValue) action = 'Mengosongkan sel';
    else if (Object.prototype.hasOwnProperty.call(e, 'oldValue')) action = 'Mengubah sel';
    else action = 'Mengisi / mengubah sel';
  } else {
    action = 'Edit / tempel beberapa sel';
    before = 'Tidak tersedia untuk edit banyak sel';
    after = careerHubAuditPreview_(range);
  }

  careerHubAuditAppend_(ss, [
    Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'yyyy-MM-dd HH:mm:ss'),
    careerHubAuditEmail_(e),
    sheetName,
    range.getA1Notation(),
    action,
    before,
    after,
    cellCount
  ]);

  try {
    updateLastUpdated(e);
  } catch (err) {
    console.error('Gagal memperbarui waktu di HOME!K9: ' + err);
  }
}

function careerHubAuditOnChange(e) {
  if (!e || !e.source || !e.changeType) return;
  const types = {
    INSERT_ROW: 'Menambahkan baris',
    REMOVE_ROW: 'Menghapus baris',
    INSERT_COLUMN: 'Menambahkan kolom',
    REMOVE_COLUMN: 'Menghapus kolom',
    INSERT_GRID: 'Menambahkan sheet',
    REMOVE_GRID: 'Menghapus sheet',
    FORMAT: 'Mengubah format'
  };
  const action = types[String(e.changeType)];
  if (!action) return;

  careerHubAuditAppend_(e.source, [
    Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'yyyy-MM-dd HH:mm:ss'),
    careerHubAuditEmail_(e),
    '(tidak dipastikan oleh event onChange)',
    '(tidak tersedia)',
    action,
    '(tidak tersedia)',
    '(tidak tersedia)',
    '-'
  ]);

  if (['INSERT_ROW', 'REMOVE_ROW', 'INSERT_COLUMN', 'REMOVE_COLUMN'].includes(String(e.changeType))) {
    markSupabaseSyncNeeded_();
  }
}

function setupCareerHubAudit() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let log = ss.getSheetByName(CAREER_HUB_AUDIT_SHEET);
  if (!log) log = ss.insertSheet(CAREER_HUB_AUDIT_SHEET);

  log.getRange(1, 1, 1, CAREER_HUB_AUDIT_HEADERS.length)
    .setValues([CAREER_HUB_AUDIT_HEADERS])
    .setFontWeight('bold')
    .setBackground('#203a43')
    .setFontColor('#ffffff');
  log.setFrozenRows(1);
  log.setTabColor('#516395');
  log.setColumnWidth(1, 165);
  log.setColumnWidth(2, 275);
  log.setColumnWidth(3, 180);
  log.setColumnWidth(4, 150);
  log.setColumnWidth(5, 210);
  log.setColumnWidth(6, 285);
  log.setColumnWidth(7, 340);
  log.setColumnWidth(8, 105);
  log.getRange('A:A').setNumberFormat('@');

  const protections = log.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  const protection = protections.length ? protections[0] : log.protect();
  if (!protection.canEdit()) {
    throw new Error('Akun ini tidak diizinkan mengatur perlindungan tab log. Gunakan akun pemilik.');
  }
  protection.setDescription('HMTIF Career Hub - Log Aktivitas (hanya pengelola)');
  protection.setWarningOnly(false);
  protection.setUnprotectedRanges([]);

  const adminEmail = Session.getEffectiveUser().getEmail();
  if (!adminEmail) {
    throw new Error('Email akun admin tidak tersedia. Jalankan setup dari akun pemilik spreadsheet.');
  }
  protection.addEditor(adminEmail);
  const others = protection.getEditors().filter(user => user.getEmail() !== adminEmail);
  if (others.length) protection.removeEditors(others);
  if (protection.canDomainEdit()) protection.setDomainEdit(false);

  const handlers = ['careerHubAuditOnEdit', 'careerHubAuditOnChange'];
  ScriptApp.getProjectTriggers()
    .filter(trigger => handlers.includes(trigger.getHandlerFunction()))
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('careerHubAuditOnEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('careerHubAuditOnChange').forSpreadsheet(ss).onChange().create();

  return 'LOG AKTIVITAS siap. Trigger edit & perubahan struktur dipasang; log dilindungi.';
}

// ============================================================================
// SETUP UTAMA (JALANKAN SEKALI DARI EDITOR APPS SCRIPT SEBAGAI PEMILIK)
// ============================================================================

function setupCareerHubHybrid() {
  const auditMsg = setupCareerHubAudit();
  const archiveMsg = setupCareerHubArchive();
  const syncTriggerMsg = setupCareerHubSyncTrigger();
  const syncResult = syncAllToSupabase();
  return {
    audit: auditMsg,
    archive: archiveMsg,
    syncTrigger: syncTriggerMsg,
    initialSync: syncResult
  };
}

function pancingEmail() {
  MailApp.sendEmail(CAREER_HUB_NOTIFY_EMAIL, 'Sistem Izin Terbuka', 'Otorisasi email HMTIF Career Hub Hybrid berhasil.');
}

function checkCareerHubConnection() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return { ok: false, message: 'Apps Script belum terhubung dengan Google Sheets.' };

  let supabaseStatus = { ok: false, message: 'Belum diuji' };
  try {
    const stats = supabaseRequest_('/rest/v1/rpc/get_dashboard_stats', 'post', {});
    supabaseStatus = { ok: true, stats: stats };
  } catch (err) {
    supabaseStatus = { ok: false, message: String(err && err.message ? err.message : err) };
  }

  return {
    ok: supabaseStatus.ok,
    spreadsheet: ss.getName(),
    sheets: ['HOME', ...CAREER_HUB_SHEETS, CAREER_HUB_TRAFFIC_SHEET, 'RATING', CAREER_HUB_AUDIT_SHEET].map(n => ({
      name: n,
      exists: Boolean(findSheetCaseInsensitive_(ss, n))
    })),
    supabase: supabaseStatus,
    triggers: ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()),
    timestamp: Utilities.formatDate(new Date(), CAREER_HUB_TZ, 'yyyy-MM-dd HH:mm:ss')
  };
}

/** Halaman pengalihan ringan jika masih ada pengguna membuka URL lama /exec Apps Script. */
function doGet() {
  const publicUrl = String(PropertiesService.getScriptProperties().getProperty('PUBLIC_WEB_URL') || '').trim();
  const safeUrl = /^https?:\/\//i.test(publicUrl) ? publicUrl : '';
  const html = safeUrl
    ? '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta http-equiv="refresh" content="0;url=' + safeUrl + '"><title>HMTIF Career Hub</title></head>' +
      '<body style="font-family:sans-serif;text-align:center;padding:48px 16px;">' +
      '<h2>HMTIF Career Hub telah pindah ke alamat baru yang lebih cepat</h2>' +
      '<p><a href="' + safeUrl + '" style="display:inline-block;padding:12px 24px;background:#a61932;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold;">Buka HMTIF Career Hub</a></p>' +
      '</body></html>'
    : '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>HMTIF Career Hub</title></head>' +
      '<body style="font-family:sans-serif;text-align:center;padding:48px 16px;">' +
      '<h2>HMTIF Career Hub Sync Engine Aktif</h2><p>Set properti <code>PUBLIC_WEB_URL</code> di Script Properties agar halaman ini mengarah ke web statis baru.</p></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('HMTIF Career Hub')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
