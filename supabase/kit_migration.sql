CREATE TABLE IF NOT EXISTS public.career_kit (
  id BIGSERIAL PRIMARY KEY,
  row_order INTEGER NOT NULL DEFAULT 0,
  judul TEXT NOT NULL,
  kategori TEXT NOT NULL DEFAULT 'CV ATS',
  tipe TEXT NOT NULL DEFAULT 'Template',
  level TEXT NOT NULL DEFAULT 'Semua Level',
  deskripsi TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_career_kit_active_order
  ON public.career_kit (is_active, row_order, id);

CREATE OR REPLACE FUNCTION public.get_career_kit()
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', k.id,
        'judul', k.judul,
        'kategori', k.kategori,
        'tipe', k.tipe,
        'level', k.level,
        'deskripsi', k.deskripsi,
        'link_url', k.link_url,
        'tag', k.tag,
        'is_featured', k.is_featured
      )
      ORDER BY k.is_featured DESC, k.row_order ASC, k.id ASC
    ),
    '[]'::jsonb
  )
  FROM public.career_kit k
  WHERE k.is_active = TRUE;
$$;

CREATE OR REPLACE FUNCTION public.replace_career_hub_kit(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items harus berupa JSON array.';
  END IF;

  DELETE FROM public.career_kit WHERE TRUE;

  INSERT INTO public.career_kit (
    row_order, judul, kategori, tipe, level, deskripsi, link_url, tag, is_featured, is_active, updated_at
  )
  SELECT
    COALESCE(NULLIF(item->>'row_order', '')::INTEGER, ord::INTEGER),
    TRIM(item->>'judul'),
    COALESCE(NULLIF(TRIM(item->>'kategori'), ''), 'CV ATS'),
    COALESCE(NULLIF(TRIM(item->>'tipe'), ''), 'Panduan'),
    COALESCE(NULLIF(TRIM(item->>'level'), ''), 'Semua Level'),
    COALESCE(item->>'deskripsi', ''),
    COALESCE(item->>'link_url', ''),
    COALESCE(item->>'tag', ''),
    COALESCE((item->>'is_featured')::BOOLEAN, FALSE),
    COALESCE((item->>'is_active')::BOOLEAN, TRUE),
    NOW()
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(item, ord)
  WHERE TRIM(COALESCE(item->>'judul', '')) <> '';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('synced_kit', v_count);
END;
$$;

ALTER TABLE public.career_kit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read career_kit" ON public.career_kit;
CREATE POLICY "Public read career_kit"
  ON public.career_kit FOR SELECT
  TO anon, authenticated
  USING (is_active = TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.career_kit TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

REVOKE ALL ON FUNCTION public.get_career_kit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_career_kit() TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.replace_career_hub_kit(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.replace_career_hub_kit(JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_career_hub_kit(JSONB) TO service_role;
