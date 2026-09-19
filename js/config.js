// Public configuration only. Never put service_role, passwords or bot tokens here.
export const config = Object.freeze({
  supabaseUrl: 'https://tpbccsvlahbwupntcogq.supabase.co',
  supabaseKey: 'sb_publishable_8HVZcFtIM0fVaKmHuONqZA_HrebbATO', // Public publishable key; RLS enforces access.
  contactEnabled: false, // Enable only after deploying the contact Edge Function.
});