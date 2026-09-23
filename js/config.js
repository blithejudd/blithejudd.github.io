// Public configuration only. Never put service_role, passwords or bot tokens here.
export const config = Object.freeze({
  supabaseUrl: 'https://yepcevucujbqafbqrfrr.supabase.co',
  supabaseKey: 'sb_publishable_tNU2uoz7-9CnkAdChsTijg_9LukCbkO', // Public publishable key; RLS enforces access.
  contactEnabled: false, // Enable only after deploying the contact Edge Function.
});