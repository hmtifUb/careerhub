# HMTIF Career Hub — Universitas Bakrie

Arsitektur **Hybrid (Google Sheets → Supabase → GitHub Pages)** yang membuat **HMTIF Career Hub** jauh lebih ringan, dapat di-install seperti aplikasi (**PWA**), mendukung **deep-link per program**, serta tetap nyaman dikelola pengurus HMTIF (PPP) lewat Google Sheets lengkap dengan **Generator Teks Broadcast WA**, `LOG AKTIVITAS`, arsip otomatis, dan notifikasi email feedback.

## Struktur Repository

```text
careerhub/
├── index.html            # Frontend utama (PWA + Deep-Link + Roll Feed + Berita)
├── kit.html              # Halaman khusus Kit Persiapan Karier (CV ATS, Email, Interview, Roadmap)
├── config.js             # Konfigurasi publik Supabase (URL + Publishable Key)
├── manifest.json         # Manifest PWA (installable di Android/iOS/Desktop)
├── sw.js                 # Service Worker ringan (Network-First shell, live Supabase)
├── arsitektur.html       # Diagram interaktif arsitektur sistem Hybrid
├── assets/               # Logo lokal & icon PWA (192x192 & 512x512)
├── .nojekyll             # Menonaktifkan build Jekyll di GitHub Pages
├── supabase/
│   ├── schema.sql        # Skema tabel, RPC publik/admin, dan keamanan RLS PostgreSQL
│   ├── news_migration.sql# Migrasi khusus tabel Berita & Pengumuman
│   └── kit_migration.sql # Migrasi khusus tabel Kit Persiapan Karier (CAREER_KIT)
├── apps-script/
│   └── Code.gs           # Mesin sync, Generator Broadcast WA, audit log, arsip & email
└── README.md
```

## Fitur Utama
- **Kit Persiapan Karier (`/kit.html`):** Studio karier interaktif terpisah berisi Katalog Resource (tersinkron dari tab `CAREER_KIT` Google Sheets), **ATS CV Builder + Skor Real-Time + Export PDF A4**, **Generator Email & DM HRD**, **Simulator Interview 90 Detik + Checklist Kesiapan**, serta **Roadmap Karier IT**.
- **Mode PWA:** Dapat dipasang ke layar utama HP/Desktop via tombol **Install App** (dengan icon lokal HMTIF).
- **Deep-Link per Program (`?cat=...&p=...`):** Membagikan link spesifik program ke WhatsApp — saat diklik langsung membuka modal detail program (termasuk fallback otomatis ke Arsip).
- **Generator Teks Broadcast WA:** Tersedia di menu Google Sheets **HMTIF Career Hub → Buat Teks Broadcast WA** (preset Ringkas, Mendesak ≤ 7 Hari, Semua Aktif + deep-link siap copy-paste).
- **Live Sync & Keamanan RLS:** Auto-sync tiap 5 menit (atau 1-klik), saran pengguna rahasia di database, dan pencatatan kunjungan atomik bebas antrean.

## Alamat Live
- Web Utama: https://hmtifub.github.io/careerhub/
- Kit Persiapan Karier: https://hmtifub.github.io/careerhub/kit.html
- Diagram Arsitektur: https://hmtifub.github.io/careerhub/arsitektur.html
