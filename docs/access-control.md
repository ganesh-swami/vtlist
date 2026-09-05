# Access control

The site requires a login. There is no public sign-up — accounts are created by
an operator:

```bash
node --env-file-if-exists=.env.local packages/ingest/src/create-user.ts \
  someone@example.com 'their-password'
```

Re-running it for an email that already exists resets that password instead of
erroring, so it doubles as the password-reset tool.

## Three layers, in the order that matters

**1. Row-level security** — `supabase/migrations/0004_require_login.sql`

The `anon` role has no `SELECT` on `voters` or `voter_parts`, and no `EXECUTE`
on `search_voters()`. This is the layer that actually protects the data: the
publishable key is compiled into every browser bundle, so anyone can obtain it.
Without a session the database answers `permission denied for table voters` —
not an empty result set.

`search_voters()` is `SECURITY INVOKER` (the default), so it reads through the
caller's own policies rather than the definer's. A function that ran as its
owner would have handed anonymous callers the whole roll.

**2. The route guard** — `apps/web/proxy.ts`

Refreshes the session cookie, then bounces browsers to `/login` and answers
`/api/*` with **401 JSON rather than a redirect**. A redirect would hand a
`fetch` a page of HTML with status 200, which the client would read as a
successful empty result — indistinguishable from a search with no matches.

It calls `supabase.auth.getUser()`, which revalidates against Supabase, rather
than reading the cookie's claims. That is the difference between a guard and a
suggestion.

Next.js 16 renamed the `middleware` convention to `proxy`; the file must be
`proxy.ts` and the export must be named `proxy`.

**3. The image route** — `apps/web/app/api/image/[...path]/route.ts`

Page scans and elector photos live in `data/images/`, deliberately **not** in
`apps/web/public/`. Anything under `public/` is served by the static handler
before any application code runs, so a page scan showing 27 people's names,
ages and photographs would have been fetchable by URL, login or no login.

The route resolves the requested path and then confirms the result is still
inside `data/images/`, which is what stops `../../.env.local` from being served.

## Verified behaviour

|                                    | signed out | signed in |
| ---------------------------------- | ---------- | --------- |
| `/`                                | 307 → /login | 200 |
| `/api/search?q=गणेश`               | 401        | 200, 60 results |
| `/api/image/pages/1_1_p003.jpg`    | 401        | 200, image/jpeg |
| `/api/image/photos/1_3_1.jpg`      | 401        | 200, image/jpeg |
| `/api/image/../../.env.local`      | 401        | 404 |
| direct table read with the publishable key | `permission denied` | rows |

## Deploying

`data/` is gitignored, so the images do not travel with the repo. Either include
them in the deployment (Next's `outputFileTracingIncludes`) or move them to a
private Supabase Storage bucket and hand out signed URLs — the stored paths are
derived from the row id, so switching is a one-line change in `cli.ts`.
