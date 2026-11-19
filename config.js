/**
 * Konfigurasi publik HMTIF Career Hub (aman untuk ditaruh di frontend).
 *
 * PENTING:
 * - Gunakan Publishable Key (sb_publishable_...) atau Legacy Anon Key (eyJ...).
 * - JANGAN PERNAH menaruh Secret Key (sb_secret_...) atau service_role key di file ini!
 */
window.HUB_CONFIG = {
  SUPABASE_URL: 'https://ijilypvrhkcpnofdrqlp.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_SGzI5Ztm_m5gFoMRQ0JzkQ_N-JazhTc',

  // Opsional: isi URL publik web kamu untuk tautan share WhatsApp.
  // Jika dibiarkan kosong (''), otomatis memakai URL browser saat ini.
  PUBLIC_URL: ''
};
