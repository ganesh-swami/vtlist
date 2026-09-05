-- Bikaner Nagar Nigam, Ward 1 — voter roll search.
--
-- Design notes that matter:
--
--  * id is the roll position itself: '{ward}_{part}_{serial}', e.g. '1_3_57'.
--    That is also the photo filename (public/photos/1_3_57.jpg), so a row and
--    its picture are always findable from each other with no lookup table.
--
--  * Names are NEVER deduplicated. Two people called राम लाल with the same
--    father's name and age are two rows, because they are two roll entries.
--    The only thing the primary key prevents is the same physical roll
--    position appearing twice, which makes re-running the importer safe.
--
--  * The roll's deletion list (विलोपन सूची) reprints entries that already
--    appear in the main list. Those set is_deleted on the existing row rather
--    than creating a second one — one person, one row, correctly flagged.
--
--  * The fuzzy matching columns (*_key, *_skeleton) are produced by
--    packages/normalize in TypeScript, and the SAME code normalises the user's
--    query before it reaches search_voters(). The folding rules therefore live
--    in exactly one place.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- source PDFs

create table if not exists public.voter_parts (
  id              text primary key,          -- '{ward}_{part}', e.g. '1_3'
  ward            text not null,
  part_no         text not null,
  state           text not null default 'Rajasthan',
  district        text not null default 'Bikaner',
  body_name       text,                      -- नगर निगम / नगर परिषद name
  assembly_seat   text,                      -- '13-बीकानेर पश्चिम'
  polling_station text,
  source_file     text not null,
  file_sha256     text not null,
  page_count      int,
  elector_count   int,
  extraction_mode text not null,             -- 'text-layer' | 'text+vision'
  imported_at     timestamptz not null default now()
);

-- -------------------------------------------------------------------- entries

create table if not exists public.voters (
  id                text primary key,        -- '{ward}_{part}_{serial}'
  part_id           text not null references public.voter_parts (id) on delete cascade,

  ward              text not null,
  part_no           text not null,
  serial_no         int  not null,

  -- as printed on the roll
  epic_no           text,                    -- absent on supplement additions
  house_no          text,
  age               int,
  gender            text check (gender in ('M', 'F', 'O')),
  section_label     text,                    -- street/locality heading above the box
  list_type         text not null default 'main'
                    check (list_type in ('main', 'supplement')),
  is_deleted        boolean not null default false,
  deletion_reason   text check (deletion_reason in ('death', 'shifted', 'repetition')),

  -- the roll prints exactly one of father / husband / mother / other
  relation_type     text check (relation_type in ('father', 'husband', 'mother', 'other')),

  -- Devanagari, exactly as printed (this is the display value)
  name_hi              text,
  relation_name_hi     text,

  -- readable romanisation (display + English-ish search)
  name_latin           text,
  relation_name_latin  text,

  -- lossy fuzzy keys (primary match columns)
  name_key             text,
  relation_name_key    text,

  -- vowel-free skeletons (widest recall, never used for ranking)
  name_skeleton          text,
  relation_name_skeleton text,

  -- one blob so a single search box can span name + relation + house
  search_blob       text,

  photo_path        text,                    -- '/photos/1_3_57.jpg' (part 3 only)
  source_file       text not null,
  page_no           int  not null,
  box_no            int,

  raw               jsonb not null default '{}'::jsonb,
  confidence        real,
  needs_review      boolean not null default false,
  created_at        timestamptz not null default now()
);

-- Columns added after the table first shipped. Stated as alters so this file
-- stays re-runnable against an existing database, not just a fresh one.
alter table public.voters add column if not exists page_image text;
comment on column public.voters.page_image is
  'Scan of the whole printed page this elector sits on — one image per page.';
comment on column public.voters.house_no is 'deprecated: no longer extracted';

create index if not exists voters_part_idx     on public.voters (part_id, serial_no);
create index if not exists voters_epic_idx     on public.voters (upper(epic_no));
create index if not exists voters_age_idx      on public.voters (age);
create index if not exists voters_gender_idx   on public.voters (gender);
create index if not exists voters_house_idx    on public.voters (house_no);
create index if not exists voters_skel_idx     on public.voters (name_skeleton);
create index if not exists voters_rel_skel_idx on public.voters (relation_name_skeleton);
create index if not exists voters_review_idx   on public.voters (needs_review) where needs_review;

-- Trigram indexes drive the fuzzy search. gin_trgm_ops works on Devanagari
-- too: pg_trgm slices Unicode characters, it is not English-specific.
create index if not exists voters_name_key_trgm on public.voters using gin (name_key gin_trgm_ops);
create index if not exists voters_name_hi_trgm  on public.voters using gin (name_hi gin_trgm_ops);
create index if not exists voters_rel_key_trgm  on public.voters using gin (relation_name_key gin_trgm_ops);
create index if not exists voters_rel_hi_trgm   on public.voters using gin (relation_name_hi gin_trgm_ops);
create index if not exists voters_blob_trgm     on public.voters using gin (search_blob gin_trgm_ops);

-- ------------------------------------------------------------------- search

-- The caller passes the query already normalised by packages/normalize:
--   q_raw      what the user typed
--   q_hi       Devanagari form (empty when they typed Latin)
--   q_key      folded fuzzy key
--   q_skeleton vowel-free skeleton
-- Postgres refuses to replace a function whose return type changed, so drop
-- every existing overload first. That keeps this migration re-runnable as the
-- returned column list evolves.
do $drop$
declare sig text;
begin
  for sig in
    select oid::regprocedure::text
    from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'search_voters'
  loop
    execute 'drop function if exists ' || sig;
  end loop;
end
$drop$;

create or replace function public.search_voters(
  q_raw      text,
  q_hi       text default '',
  q_key      text default '',
  q_skeleton text default '',
  f_relation text default '',   -- normalised key of a father/husband name
  f_gender   text default null,
  f_age_min  int  default null,
  f_age_max  int  default null,
  f_part     text default null,
  lim        int  default 60,
  off        int  default 0
)
returns table (
  id text, name_hi text, name_latin text,
  relation_type text, relation_name_hi text, relation_name_latin text,
  house_no text, age int, gender text, epic_no text,
  ward text, part_no text, serial_no int, section_label text,
  is_deleted boolean, photo_path text, page_image text, page_no int,
  score real, matched_on text
)
language sql
stable
as $fn$
  with scored as (
    select
      v.*,
      (
        greatest(
          -- an exact EPIC number is never ambiguous, so it outranks everything
          case when v.epic_no is not null and upper(v.epic_no) = upper(trim(q_raw))
               then 2.0 else 0 end,
          -- so is the roll id itself, e.g. someone pasting '1_3_57'
          case when v.id = trim(q_raw) then 2.0 else 0 end,
          case when q_key <> '' then similarity(v.name_key, q_key) else 0 end,
          case when q_hi  <> '' then similarity(v.name_hi,  q_hi) * 0.98 else 0 end,
          case when q_key <> '' then similarity(v.relation_name_key, q_key) * 0.80 else 0 end,
          case when q_hi  <> '' then similarity(v.relation_name_hi,  q_hi)  * 0.78 else 0 end,
          -- skeleton agreement is a weak signal on its own; it exists to keep
          -- Surendra/Surender-style pairs from dropping out entirely
          case when q_skeleton <> '' and v.name_skeleton = q_skeleton then 0.55 else 0 end
        )
        -- small nudge so names that start with what was typed sort first
        + case when q_key <> '' and v.name_key like q_key || '%' then 0.15 else 0 end
        -- deleted electors are still searchable, just never at the top
        - case when v.is_deleted then 0.20 else 0 end
      )::real as score,
      case
        when v.epic_no is not null and upper(v.epic_no) = upper(trim(q_raw)) then 'epic'
        when v.id = trim(q_raw) then 'id'
        when q_key <> ''
             and similarity(v.name_key, q_key) >= similarity(v.relation_name_key, q_key)
          then 'name'
        else 'relation'
      end as matched_on
    from public.voters v
    where
      (f_gender  is null or v.gender  = f_gender)
      and (f_age_min is null or v.age >= f_age_min)
      and (f_age_max is null or v.age <= f_age_max)
      and (f_part    is null or v.part_no = f_part)
      -- Father/husband filter, when the user fills that box separately.
      -- pg_trgm's % operator alone is too generous here: "lal" is shared by half
      -- the roll, so "शंकर लाल स्वामी" squeaked past a filter for "रामेश्वर लाल".
      -- Keep % so the GIN index is still used, then insist on a real score.
      and (
        f_relation = ''
        or (v.relation_name_key % f_relation
            and similarity(v.relation_name_key, f_relation) >= 0.45)
      )
      and (
        trim(q_raw) = ''
        or (q_key      <> '' and v.name_key              % q_key)
        or (q_key      <> '' and v.relation_name_key     % q_key)
        or (q_hi       <> '' and v.name_hi               % q_hi)
        or (q_hi       <> '' and v.relation_name_hi      % q_hi)
        or (q_skeleton <> '' and v.name_skeleton          = q_skeleton)
        or (q_skeleton <> '' and v.relation_name_skeleton = q_skeleton)
        or (v.epic_no  is not null and upper(v.epic_no) = upper(trim(q_raw)))
        or (v.id = trim(q_raw))
        or (v.house_no is not null and v.house_no = trim(q_raw))
      )
  )
  select id, name_hi, name_latin,
         relation_type, relation_name_hi, relation_name_latin,
         house_no, age, gender, epic_no,
         ward, part_no, serial_no, section_label,
         is_deleted, photo_path, page_image, page_no,
         score, matched_on
  from scored
  where score > 0 or trim(q_raw) = ''
  order by score desc, part_no asc, serial_no asc
  limit least(coalesce(lim, 60), 200)
  offset greatest(coalesce(off, 0), 0);
$fn$;

-- --------------------------------------------------------------------- access

alter table public.voters      enable row level security;
alter table public.voter_parts enable row level security;

-- Public site: anonymous visitors may read, nobody may write. The importer
-- runs with the service-role key, which bypasses RLS.
drop policy if exists voters_public_read on public.voters;
drop policy if exists parts_public_read  on public.voter_parts;

create policy voters_public_read on public.voters
  for select to anon, authenticated using (true);
create policy parts_public_read on public.voter_parts
  for select to anon, authenticated using (true);
