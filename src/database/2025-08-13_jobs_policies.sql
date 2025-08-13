alter table public.jobs enable row level security;

do $$
declare r record;
begin
  for r in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'jobs'
  loop
    execute format('drop policy if exists %I on public.jobs;', r.policyname);
  end loop;
end$$;

create policy "users-manage-own-jobs"
on public.jobs
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy "service-role-all"
on public.jobs
for all
to public
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
