# Bikaner Ward 1 — voter roll search

Turns the Rajasthan SEC roll PDFs into a database you can search by name in
**Hindi, Hinglish, or English**, with each person's photo.

## How to run it

```bash
pnpm install

# 1. Put the roll PDFs in data/pdfs/, keeping the portal filenames
#    ("...Ward No-001-Part No-003.pdf" — ward and part are read from the name).

pnpm ingest migrate      # create the tables (already done once)
pnpm ingest probe        # check box detection before spending anything
pnpm ingest extract      # PDFs -> data/extracted/*.json + public/photos/*.jpg
pnpm ingest load         # push to Supabase
# or just: pnpm ingest all

pnpm dev                 # open http://localhost:3000
```

`pnpm ingest probe` writes overlay PNGs to `data/debug/`. Red boxes are the
detected elector boxes, blue boxes are the photo crops. If they sit on the
printed boxes, every page will crop correctly; if not, nudge `PHOTO_LEFT` /
`PHOTO_TOP` / `PHOTO_RIGHT` / `PHOTO_BOTTOM` / `BOX_HEADER_H` in `.env.local`.

## Keys you need in `.env.local`

| Key | Used by | Where to get it |
|---|---|---|
| `SUPABASE_DB_PASSWORD` | `ingest migrate` | Project Settings → Database |
| `SUPABASE_SERVICE_ROLE_KEY` | `ingest load` | Project Settings → API Keys → `service_role` |
| `ANTHROPIC_API_KEY` | `ingest extract` | console.anthropic.com |

The public Supabase keys the website uses live in `apps/web/.env.local`; the two
secrets above deliberately stay out of that directory so Next.js never sees them.


## Access control

The site requires a login — no public sign-up. Create an account with:

```bash
node --env-file-if-exists=.env.local packages/ingest/src/create-user.ts you@example.com 'password'
```

Enforcement is in three layers: row-level security in the database (the one
that matters — the publishable key ships to every browser), the route guard in
`apps/web/proxy.ts`, and an authenticated image route, because page scans must
not sit in `public/` where the static handler serves them before any auth code
runs. Details and the verification table: [docs/access-control.md](docs/access-control.md).

## How it works

**Ids.** Every row's id is its position on the roll: `{ward}_{part}_{serial}`,
e.g. `1_3_923`. The photo is `public/photos/1_3_923.jpg`. Same id, both places.

**Why names need an AI pass.** These PDFs have a text layer, but it uses a legacy
Devanagari font whose ToUnicode map is many-to-one — the single character र
stands in for र, व *and* the ा matra, so "भंवरलाल" extracts as "मनररलरल". That
collapse is lossy and no substitution table can undo it. So `packages/ingest`
reads the *structure* from the text layer (serial, EPIC, age, gender, relation
type, and the exact coordinates of every box — all perfect) and reads only the
*names* off the rendered page image. The text-layer facts then double as a free
correctness check on what came back; anything that disagrees is flagged
`needs_review` instead of being silently resolved.

**Why search works across scripts.** `packages/normalize` folds any name — from
Devanagari or from typed Hinglish — down to one lossy key, folding exactly the
things Indian names vary on (aspiration kh/k, retroflex vs dental ट/त, sibilants
श/ष/स, v/w, z/j, f/ph, long vs short vowels, and ngh/nh so Singh and सिंह agree).
The *same* code folds the stored name at import and the typed query at search
time, so Postgres only ever compares like with like. Verified end to end:

```
Ganesharam        → गणेशाराम        Bhanwarlal   → चेतन्यनारायण (via father भंवरलाल)
Sumer Singh       → सुमेर सिंह       भंवरलाल      → चेतन्यनारायण
Chaitanya Narayan → चेतन्यनारायण     IXQ0584201   → चेतन्यनारायण (exact EPIC)
```

Run `pnpm demo` to see the folding on 47 spellings of 14 names.

**Duplicates are kept.** Nothing is ever deduplicated by name. Two people called
राम लाल with the same father and age are two rows, because they are two roll
entries. The primary key only stops the same *roll position* being stored twice,
which is what makes re-running the importer safe.

**Deleted electors.** The roll's विलोपन सूची reprints entries that also appear in
the main list; those set `is_deleted` on the existing row rather than creating a
second one. They stay searchable, marked विलोपित, ranked below live entries.

## Layout

```
packages/normalize   script-folding rules — used by BOTH the importer and the site
packages/ingest      PDF -> JSON -> photos -> Supabase
supabase/migrations  schema + the search_voters() function
apps/web             the search page
data/                PDFs, extracted JSON, debug overlays (all gitignored)
```
