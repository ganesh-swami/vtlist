-- The distinct localities printed on the roll.
--
-- Every elector carries a section_label — the मोहल्ला / गली heading printed
-- above their block on the page — so this is the address list that covers the
-- whole ward, not just the people who have already been handed a slip. The
-- filter box offers these alongside the addresses recorded during delivery.
--
-- A view rather than a select-distinct from the app: it is ~100 rows out of
-- 4,000-odd electors, and pulling every row over the wire to dedupe in the
-- browser on each filter-panel open would be silly.

create or replace view public.voter_sections as
  select distinct section_label
  from public.voters
  where section_label is not null and section_label <> '';

-- Views run with the privileges of their owner, so this one is explicitly
-- restricted to signed-in users the same way the underlying table is.
alter view public.voter_sections set (security_invoker = on);

revoke all on public.voter_sections from anon;
grant select on public.voter_sections to authenticated;
