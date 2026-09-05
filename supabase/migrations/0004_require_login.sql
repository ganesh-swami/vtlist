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
revoke all on function public.search_voters(
  text, text, text, text, text, text, int, int, text, int, int
) from anon;
grant execute on function public.search_voters(
  text, text, text, text, text, text, int, int, text, int, int
) to authenticated;

revoke select on public.voters, public.voter_parts from anon;
