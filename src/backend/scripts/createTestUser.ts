// scripts/createTestUser.ts
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
(async () => {
  const { data, error } = await s.auth.admin.createUser({
    email: 'system@test.devcommandhub.local',
    email_confirm: true
  });
  if (error) { throw error; }
  console.log('TEST_USER_ID=', data.user?.id);
})();
