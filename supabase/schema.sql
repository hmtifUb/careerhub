-- ============================================================================
-- HMTIF CAREER HUB — SKEMA DATABASE SUPABASE (PostgreSQL)
-- Arsitektur Hybrid: Google Sheets (CMS Pengurus) -> Supabase -> Web Statis
--
-- Cara pakai:
-- 1. Buka Dashboard Supabase -> SQL Editor -> New Query
-- 2. Paste seluruh isi file ini -> Klik "Run"
-- ============================================================================

-- 1. TABEL UTAMA: PROGRAMS (KARIER, PENGEMBANGAN, OPPORTUNITIES + ARSIP)
CREATE TABLE IF NOT EXISTS public.programs (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('KARIER', 'PENGEMBANGAN', 'OPPORTUNITIES')),
  source_sheet TEXT NOT NULL DEFAULT '',
  row_order INTEGER NOT NULL DEFAULT 0,
  nama TEXT NOT NULL,
  penyelenggara TEXT NOT NULL DEFAULT '',
  jenis TEXT NOT NULL DEFAULT '',
  deadline_text TEXT NOT NULL DEFAULT '',
  deadline_date DATE NULL,
  status TEXT NOT NULL DEFAULT '',
  link_info TEXT NOT NULL DEFAULT '',
  extra_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_programs_category_order
  ON public.programs (category, row_order, id);

CREATE INDEX IF NOT EXISTS idx_programs_archived_deadline
  ON public.programs (is_archived, deadline_date);

-- 2. TABEL RATING & SARAN (saran bersifat rahasia, tidak bisa dibaca langsung oleh publik)
CREATE TABLE IF NOT EXISTS public.ratings (
  id BIGSERIAL PRIMARY KEY,
  star SMALLINT NOT NULL DEFAULT 0 CHECK (star >= 0 AND star <= 5),
  saran TEXT NOT NULL DEFAULT '',
  emailed BOOLEAN NOT NULL DEFAULT FALSE,
  synced_to_sheet BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ratings_pending_sync
  ON public.ratings (id)
  WHERE (emailed = FALSE OR synced_to_sheet = FALSE);

-- 3. TABEL KUNJUNGAN HARIAN (atomic increment, bebas antrean LockService)
CREATE TABLE IF NOT EXISTS public.daily_visits (
  visit_date DATE PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);

-- 4. TABEL METADATA PLATFORM (waktu update terakhir & offset historis kunjungan lama)
CREATE TABLE IF NOT EXISTS public.hub_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.hub_meta (key, value)
VALUES
  ('last_updated', '-'),
  ('historical_visits_offset', '0')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- FUNGSI HELPER ZONA WAKTU WIB & STATUS ARSIP OTOMATIS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.career_hub_today_wib()
RETURNS DATE
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (NOW() AT TIME ZONE 'Asia/Jakarta')::date;
$$;

CREATE OR REPLACE FUNCTION public.program_is_effectively_archived(
  p_is_archived BOOLEAN,
  p_status TEXT,
  p_deadline_date DATE
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE(p_is_archived, FALSE)
    OR COALESCE(p_status, '') ~* '(telah berakhir|sudah berakhir|ditutup|closed|selesai|\ytutup\y)'
    OR (p_deadline_date IS NOT NULL AND p_deadline_date < public.career_hub_today_wib());
$$;

-- ============================================================================
-- RPC PUBLIK (Dipanggil langsung oleh public/index.html via Publishable/Anon Key)
-- ============================================================================

-- A. Ringkasan statistik dashboard
CREATE OR REPLACE FUNCTION public.get_dashboard_stats()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH prog AS (
    SELECT
      category,
      public.program_is_effectively_archived(is_archived, status, deadline_date) AS archived
    FROM public.programs
  ),
  visit_sum AS (
    SELECT COALESCE(SUM(count), 0)::BIGINT AS daily_total
    FROM public.daily_visits
  ),
  meta AS (
    SELECT
      COALESCE(MAX(value) FILTER (WHERE key = 'last_updated'), '-') AS last_updated,
      CASE
        WHEN MAX(value) FILTER (WHERE key = 'historical_visits_offset') ~ '^\d+$'
        THEN (MAX(value) FILTER (WHERE key = 'historical_visits_offset'))::BIGINT
        ELSE 0
      END AS visits_offset
    FROM public.hub_meta
  )
  SELECT jsonb_build_object(
    'peluangAktif', (SELECT COUNT(*) FROM prog WHERE NOT archived),
    'lowongan', (SELECT COUNT(*) FROM prog WHERE category = 'KARIER' AND NOT archived),
    'pelatihan', (SELECT COUNT(*) FROM prog WHERE category = 'PENGEMBANGAN' AND NOT archived),
    'lomba', (SELECT COUNT(*) FROM prog WHERE category = 'OPPORTUNITIES' AND NOT archived),
    'arsipTotal', (SELECT COUNT(*) FROM prog WHERE archived),
    'kunjungan', (SELECT visits_offset FROM meta) + (SELECT daily_total FROM visit_sum),
    'terakhirupdate', (SELECT last_updated FROM meta)
  );
$$;

-- B. Daftar program per kategori & tampilan (aktif / arsip)
CREATE OR REPLACE FUNCTION public.get_programs(
  p_category TEXT,
  p_archived BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'category', p.category,
        'nama', p.nama,
        'penyelenggara', p.penyelenggara,
        'jenis', p.jenis,
        'deadline', p.deadline_text,
        'deadline_date', p.deadline_date,
        'status', CASE WHEN COALESCE(p_archived, FALSE) THEN '🔴 Telah Berakhir' ELSE p.status END,
        'linkData', p.link_info,
        'extra_fields', p.extra_fields,
        'is_archived', public.program_is_effectively_archived(p.is_archived, p.status, p.deadline_date)
      )
      ORDER BY p.row_order ASC, p.id ASC
    ),
    '[]'::jsonb
  )
  FROM public.programs p
  WHERE p.category = UPPER(TRIM(COALESCE(p_category, '')))
    AND public.program_is_effectively_archived(p.is_archived, p.status, p.deadline_date) = COALESCE(p_archived, FALSE);
$$;

-- C. Statistik grafik kunjungan harian (7 / 30 / 90 hari, WIB)
CREATE OR REPLACE FUNCTION public.get_visit_stats(p_days INTEGER DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_days INTEGER := CASE WHEN p_days IN (7, 30, 90) THEN p_days ELSE 7 END;
  v_today DATE := public.career_hub_today_wib();
  v_labels TEXT[];
  v_values INTEGER[];
  v_sum_window BIGINT;
  v_peak INTEGER;
  v_today_val INTEGER;
  v_total_daily BIGINT;
  v_offset BIGINT := 0;
  v_offset_text TEXT;
BEGIN
  SELECT
    array_agg(to_char(d.day, 'YYYY-MM-DD') ORDER BY d.day),
    array_agg(COALESCE(dv.count, 0) ORDER BY d.day),
    COALESCE(SUM(COALESCE(dv.count, 0)), 0),
    COALESCE(MAX(COALESCE(dv.count, 0)), 0),
    COALESCE(MAX(CASE WHEN d.day::date = v_today THEN COALESCE(dv.count, 0) END), 0)
  INTO v_labels, v_values, v_sum_window, v_peak, v_today_val
  FROM generate_series(v_today - (v_days - 1), v_today, INTERVAL '1 day') AS d(day)
  LEFT JOIN public.daily_visits dv ON dv.visit_date = d.day::date;

  SELECT COALESCE(SUM(count), 0) INTO v_total_daily FROM public.daily_visits;
  SELECT value INTO v_offset_text FROM public.hub_meta WHERE key = 'historical_visits_offset';
  IF v_offset_text ~ '^\d+$' THEN
    v_offset := v_offset_text::BIGINT;
  END IF;

  RETURN jsonb_build_object(
    'labels', to_jsonb(COALESCE(v_labels, ARRAY[]::TEXT[])),
    'values', to_jsonb(COALESCE(v_values, ARRAY[]::INTEGER[])),
    'total', v_offset + v_total_daily,
    'today', COALESCE(v_today_val, 0),
    'average', ROUND((COALESCE(v_sum_window, 0)::NUMERIC / v_days), 1),
    'peak', COALESCE(v_peak, 0),
    'zone', 'WIB'
  );
END;
$$;

-- D. Catat 1 kunjungan secara atomik + langsung kembalikan statistik grafik
CREATE OR REPLACE FUNCTION public.register_visit(p_days INTEGER DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today DATE := public.career_hub_today_wib();
BEGIN
  INSERT INTO public.daily_visits (visit_date, count)
  VALUES (v_today, 1)
  ON CONFLICT (visit_date)
  DO UPDATE SET count = public.daily_visits.count + 1;

  RETURN public.get_visit_stats(p_days);
END;
$$;

-- E. Statistik distribusi rating bintang [b1, b2, b3, b4, b5] (tanpa membocorkan isi saran)
CREATE OR REPLACE FUNCTION public.get_rating_stats()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_array(
    COUNT(*) FILTER (WHERE star = 1),
    COUNT(*) FILTER (WHERE star = 2),
    COUNT(*) FILTER (WHERE star = 3),
    COUNT(*) FILTER (WHERE star = 4),
    COUNT(*) FILTER (WHERE star = 5)
  )
  FROM public.ratings;
$$;

-- F. Simpan rating & saran baru secara aman
CREATE OR REPLACE FUNCTION public.submit_feedback(
  p_star INTEGER DEFAULT 0,
  p_saran TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_star SMALLINT := CASE WHEN COALESCE(p_star, 0) BETWEEN 1 AND 5 THEN p_star::SMALLINT ELSE 0 END;
  v_saran TEXT := LEFT(TRIM(COALESCE(p_saran, '')), 2000);
BEGIN
  IF v_star = 0 AND v_saran = '' THEN
    RAISE EXCEPTION 'Penilaian bintang atau saran tidak boleh keduanya kosong.';
  END IF;

  INSERT INTO public.ratings (star, saran)
  VALUES (v_star, v_saran);

  RETURN public.get_rating_stats();
END;
$$;

-- ============================================================================
-- RPC ADMIN (HANYA untuk Apps Script menggunakan Secret / service_role Key)
-- ============================================================================

-- Sinkronisasi penuh seluruh program dalam 1 transaksi atomik (tidak pernah kosong setengah jalan)
CREATE OR REPLACE FUNCTION public.replace_career_hub_programs(
  p_programs JSONB,
  p_last_updated TEXT DEFAULT NULL,
  p_allow_empty BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  IF p_programs IS NULL OR jsonb_typeof(p_programs) <> 'array' THEN
    RAISE EXCEPTION 'p_programs harus berupa JSON array.';
  END IF;

  IF jsonb_array_length(p_programs) = 0 AND NOT COALESCE(p_allow_empty, FALSE) THEN
    RAISE EXCEPTION 'Sync dibatalkan karena payload kosong. Kirim p_allow_empty=true jika memang ingin mengosongkan tabel.';
  END IF;

  DELETE FROM public.programs WHERE TRUE;

  INSERT INTO public.programs (
    category,
    source_sheet,
    row_order,
    nama,
    penyelenggara,
    jenis,
    deadline_text,
    deadline_date,
    status,
    link_info,
    extra_fields,
    is_archived,
    updated_at
  )
  SELECT
    UPPER(TRIM(item->>'category')),
    COALESCE(item->>'source_sheet', ''),
    COALESCE(NULLIF(item->>'row_order', '')::INTEGER, ord::INTEGER),
    TRIM(item->>'nama'),
    COALESCE(item->>'penyelenggara', ''),
    COALESCE(item->>'jenis', ''),
    COALESCE(item->>'deadline_text', ''),
    CASE
      WHEN COALESCE(item->>'deadline_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
      THEN (item->>'deadline_date')::DATE
      ELSE NULL
    END,
    COALESCE(item->>'status', ''),
    COALESCE(item->>'link_info', ''),
    CASE
      WHEN jsonb_typeof(item->'extra_fields') = 'array' THEN item->'extra_fields'
      ELSE '[]'::jsonb
    END,
    COALESCE((item->>'is_archived')::BOOLEAN, FALSE),
    NOW()
  FROM jsonb_array_elements(p_programs) WITH ORDINALITY AS t(item, ord)
  WHERE UPPER(TRIM(COALESCE(item->>'category', ''))) IN ('KARIER', 'PENGEMBANGAN', 'OPPORTUNITIES')
    AND TRIM(COALESCE(item->>'nama', '')) <> '';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF p_last_updated IS NOT NULL AND TRIM(p_last_updated) <> '' THEN
    INSERT INTO public.hub_meta (key, value, updated_at)
    VALUES ('last_updated', p_last_updated, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = NOW();
  END IF;

  RETURN jsonb_build_object(
    'synced', v_count,
    'last_updated', COALESCE(p_last_updated, '')
  );
END;
$$;

-- ============================================================================
-- KEAMANAN: ROW LEVEL SECURITY (RLS) & HAK EKSEKUSI FUNGSI
-- ============================================================================

ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hub_meta ENABLE ROW LEVEL SECURITY;

-- Publik hanya boleh membaca programs & hub_meta (tidak bisa mengubah/menghapus)
DROP POLICY IF EXISTS "Public read programs" ON public.programs;
CREATE POLICY "Public read programs"
  ON public.programs FOR SELECT
  TO anon, authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "Public read hub_meta" ON public.hub_meta;
CREATE POLICY "Public read hub_meta"
  ON public.hub_meta FOR SELECT
  TO anon, authenticated
  USING (TRUE);

-- Tabel ratings & daily_visits sengaja TIDAK diberi policy untuk anon/authenticated.
-- Publik hanya berinteraksi lewat RPC SECURITY DEFINER agar:
--   1. Saran pengguna tetap rahasia (tidak bisa di-SELECT dari browser).
--   2. Angka kunjungan tidak bisa dimanipulasi/dihapus dari luar.

-- Hak akses tabel untuk service_role (dipakai Apps Script saat migrasi & tarik feedback)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.programs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ratings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_visits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.hub_meta TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Hak eksekusi fungsi publik
REVOKE ALL ON FUNCTION public.get_dashboard_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_programs(TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_programs(TEXT, BOOLEAN) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_visit_stats(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_visit_stats(INTEGER) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.register_visit(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_visit(INTEGER) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_rating_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rating_stats() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.submit_feedback(INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_feedback(INTEGER, TEXT) TO anon, authenticated, service_role;

-- Hak eksekusi fungsi admin: EKSKLUSIF untuk service_role (Apps Script)
REVOKE ALL ON FUNCTION public.replace_career_hub_programs(JSONB, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.replace_career_hub_programs(JSONB, TEXT, BOOLEAN) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_career_hub_programs(JSONB, TEXT, BOOLEAN) TO service_role;
