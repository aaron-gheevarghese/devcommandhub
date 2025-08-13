// src/backend/scripts/createTestUser.cjs
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  // 1) Env sanity
  console.log('[env] SUPABASE_URL set?', !!url);
  console.log('[env] SERVICE_KEY prefix:', (serviceKey || '').slice(0, 8), '…');
  if (!url || !serviceKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env (run this from the folder that contains .env).');
    process.exit(1);
  }

  // 2) Create *service* client
  const supa = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'devcommandhub-create-test-user/0.1.0' } },
  });

  // 3) Verify DB sees service_role on this code path
  try {
    const { data: dbg, error: dbgErr } = await supa.rpc('debug_auth');
    if (dbgErr) {
      console.warn('⚠️ debug_auth() RPC error (will still try createUser):', dbgErr);
    } else {
      console.log('[debug_auth] role =', dbg?.role, 'uid =', dbg?.uid, 'jwt_present =', dbg?.jwt_present);
      if (dbg?.role !== 'service_role') {
        console.error('❌ DB does not see service_role here. Check that this script loads the *service* key from the SAME .env.');
        process.exit(1);
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to call debug_auth() (function missing?). You can create it in SQL editor and re-run.');
  }

  // 4) Create a unique, throwaway dev user via Admin API
  const email = `system+${Date.now()}@test.devcommandhub.local`;
  console.log('[createUser] email =', email);

  const { data, error } = await supa.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (error) {
    console.error('❌ Failed to create user:', error);
    console.error('   Hints: ensure this is the SERVICE ROLE key (Project Settings → API → Service role).');
    process.exit(1);
  }

  const userId = data?.user?.id;
  if (!userId) {
    console.error('❌ No user id returned from createUser(). Raw:', data);
    process.exit(1);
  }

  console.log('✅ TEST_USER_ID=', userId);
  console.log('➡️  Add this to your .env (same folder):');
  console.log('TEST_USER_ID=' + userId);
})();
