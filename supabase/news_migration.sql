-- ============================================================================
-- MIGRASI TABEL BERITA & PENGUMUMAN (OPSIONAL — JIKA INGIN EDIT BERITA DARI GOOGLE SHEETS)
-- Jalankan isi file ini sekali di Supabase -> SQL Editor -> New Query -> Run
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.news (
  id BIGSERIAL PRIMARY KEY,
  row_order INTEGER NOT NULL DEFAULT 0,
  judul TEXT NOT NULL,
  kategori TEXT NOT NULL DEFAULT 'Pengumuman',
  ringkasan TEXT NOT NULL DEFAULT '',
  isi_lengkap TEXT NOT NULL DEFAULT '',
  gambar_url TEXT NOT NULL DEFAULT '',
  lampiran_url TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  tanggal_text TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_active_order
  ON public.news (is_active, row_order, id);

CREATE OR REPLACE FUNCTION public.get_news()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', n.id,
        'judul', n.judul,
        'kategori', n.kategori,
        'ringkasan', n.ringkasan,
        'isi_lengkap', n.isi_lengkap,
        'gambar_url', n.gambar_url,
        'lampiran_url', n.lampiran_url,
        'link_url', n.link_url,
        'tanggal', n.tanggal_text
      )
      ORDER BY n.row_order ASC, n.id ASC
    ),
    '[]'::jsonb
  )
  FROM public.news n
  WHERE n.is_active = TRUE;
$$;

CREATE OR REPLACE FUNCTION public.replace_career_hub_news(p_news JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  IF p_news IS NULL OR jsonb_typeof(p_news) <> 'array' THEN
    RAISE EXCEPTION 'p_news harus berupa JSON array.';
  END IF;

  DELETE FROM public.news WHERE TRUE;

  INSERT INTO public.news (
    row_order, judul, kategori, ringkasan, isi_lengkap,
    gambar_url, lampiran_url, link_url, tanggal_text, is_active, updated_at
  )
  SELECT
    COALESCE(NULLIF(item->>'row_order', '')::INTEGER, ord::INTEGER),
    TRIM(item->>'judul'),
    COALESCE(NULLIF(TRIM(item->>'kategori'), ''), 'Pengumuman'),
    COALESCE(item->>'ringkasan', ''),
    COALESCE(item->>'isi_lengkap', ''),
    COALESCE(item->>'gambar_url', ''),
    COALESCE(item->>'lampiran_url', ''),
    COALESCE(item->>'link_url', ''),
    COALESCE(item->>'tanggal_text', ''),
    COALESCE((item->>'is_active')::BOOLEAN, TRUE),
    NOW()
  FROM jsonb_array_elements(p_news) WITH ORDINALITY AS t(item, ord)
  WHERE TRIM(COALESCE(item->>'judul', '')) <> '';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('synced_news', v_count);
END;
$$;

ALTER TABLE public.news ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read news" ON public.news;
CREATE POLICY "Public read news"
  ON public.news FOR SELECT
  TO anon, authenticated
  USING (is_active = TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.news TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

REVOKE ALL ON FUNCTION public.get_news() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_news() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.replace_career_hub_news(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.replace_career_hub_news(JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_career_hub_news(JSONB) TO service_role;
