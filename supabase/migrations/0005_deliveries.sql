-- Tracking which voters have been handed their पर्ची.
--
-- Two tables rather than free-text columns on `voters`:
--
--   addresses  — the localities a canvasser types over and over. Split into a
--                parent (मोहल्ला / colony) and a child (गली / block) so the
--                dialog can offer each as its own dropdown and a new value in
--                either one is just a new row. Kept separate from the roll's
--                own `section_label`, which is what the printed roll says and
--                must never be edited.
--
--   deliveries — one row per voter, so marking is idempotent: handing the same
--                person a second slip updates the row rather than piling up
--                duplicates, and un-marking is a plain delete.
--
-- Everything except the voter is optional. A canvasser at a doorstep should be
-- able to tap "दे दी" and move on; the address, mobile and "कौन लाएगा" are
-- filled in when they happen to be known.

create extension if not exists "pgcrypto";

create table if not exists public.addresses (
  id         uuid primary key default gen_random_uuid(),
  parent     text not null,
  child      text not null default '',
  created_at timestamptz not null default now()
);

-- One row per distinct locality pair, so the dropdowns never show duplicates
-- and "create it if it isn't there yet" is a plain upsert.
create unique index if not exists addresses_parent_child_key
  on public.addresses (parent, child);

create table if not exists public.deliveries (
  voter_id     text primary key references public.voters (id) on delete cascade,
  address_id   uuid references public.addresses (id) on delete set null,
  brought_by   text,
  mobile       text,
  note         text,
  delivered_at timestamptz not null default now(),
  delivered_by uuid references auth.users (id) default auth.uid()
);

create index if not exists deliveries_address_idx on public.deliveries (address_id);
create index if not exists deliveries_delivered_at_idx on public.deliveries (delivered_at desc);

alter table public.addresses  enable row level security;
alter table public.deliveries enable row level security;

-- Same trust model as the roll itself: any signed-in user of this private site
-- may read and record deliveries. There is no anonymous access at all.
drop policy if exists addresses_read   on public.addresses;
drop policy if exists addresses_write  on public.addresses;
drop policy if exists deliveries_read  on public.deliveries;
drop policy if exists deliveries_write on public.deliveries;

create policy addresses_read on public.addresses
  for select to authenticated using (true);
create policy addresses_write on public.addresses
  for all to authenticated using (true) with check (true);

create policy deliveries_read on public.deliveries
  for select to authenticated using (true);
create policy deliveries_write on public.deliveries
  for all to authenticated using (true) with check (true);

revoke all on public.addresses, public.deliveries from anon;
grant select, insert, update, delete on public.addresses, public.deliveries to authenticated;
