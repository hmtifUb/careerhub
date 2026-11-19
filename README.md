# HMTIF Career Hub — Universitas Bakrie

Arsitektur **Hybrid (Google Sheets → Supabase → GitHub Pages)** yang membuat **HMTIF Career Hub** jauh lebih ringan dan cepat untuk pengunjung, sementara pengurus HMTIF (PPP) tetap nyaman mengelola data melalui Google Sheets lengkap dengan `LOG AKTIVITAS`, arsip otomatis, dan notifikasi email feedback.

## Struktur Repository

```text
career-hub/
├── index.html            # Frontend utama (disajikan langsung oleh GitHub Pages)
├── config.js             # Konfigurasi publik Supabase (URL + Publishable Key)
├── .nojekyll             # Menonaktifkan build Jekyll agar deploy GitHub Pages lebih cepat
├── supabase/
│   └── schema.sql        # Skema tabel, RPC publik/admin, dan keamanan RLS PostgreSQL
├── apps-script/
│   └── Code.gs           # Mesin sync Google Sheets -> Supabase, audit log, arsip & email
└── README.md
```

## Alur Kerja Data
1. Pengurus menambah atau mengedit program di Google Sheets (`KARIER`, `PENGEMBANGAN`, `OPPORTUNITIES`).
2. Apps Script otomatis menyinkronkan data ke Supabase dalam **maksimal 5 menit** (atau instan via menu Google Sheets: **HMTIF Career Hub → Sync Semua Data ke Supabase Sekarang**).
3. Web statis di GitHub Pages membaca langsung dari Supabase (tanpa *cold start* Apps Script dan tanpa antrean `LockService`).
4. Feedback & saran baru dari pengguna tersimpan aman di Supabase (terlindungi RLS), lalu otomatis ditarik ke tab `RATING` dan dikirim via email ke pengelola oleh Apps Script.

## Mengaktifkan GitHub Pages
1. Buka **Settings → Pages** pada repository ini.
2. Pada **Build and deployment**, pilih:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` — folder `/(root)` → klik **Save**.
3. Web akan aktif di `https://codecrafter-fourr.github.io/career-hub/`.
4. Masukkan URL tersebut ke **Properti Skrip** Apps Script (`PUBLIC_WEB_URL`) agar link `/exec` lama otomatis mengarah ke web baru.
