-- Require a login. Nothing is readable anonymously any more.
--
-- This is enforced in the database, not just in the app: even someone holding
-- the publishable key (which ships to every browser) gets nothing back without
-- a signed-in session. The web app's own guard is the convenience layer; this
-- is the one that actually matters.
--
-- The importer is unaffected — it uses the service-role key, which bypasses RLS.

drop policy if exists voters_public_read on public.voters;
drop policy if exists parts_public_read  on public.voter_parts;
drop policy if exists voters_read        on public.voters;
drop policy if exists parts_read         on public.voter_parts;

create policy voters_read on public.voters
  for select to authenticated using (true);
create policy parts_read on public.voter_parts
  for select to authenticated using (true);

-- search_voters() is SECURITY INVOKER (the default), so it reads through the
-- caller's own policies — an anonymous caller sees an empty table, not a leak.
--
-- Looped over every overload rather than naming one signature: 0001 drops and
-- recreates search_voters() as its parameter list evolves (an f_epic box was
-- added after this file first shipped), and a revoke/grant naming the old
-- signature would fail outright once that signature no longer exists.
do $grants$
declare sig text;
begin
  for sig in
    select oid::regprocedure::text
    from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'search_voters'
  loop
    execute 'revoke all on function ' || sig || ' from anon';
    execute 'grant execute on function ' || sig || ' to authenticated';
  end loop;
end
$grants$;

revoke select on public.voters, public.voter_parts from anon;
