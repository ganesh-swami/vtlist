-- optional: search tuning.
-- pg_trgm's `%` operator defaults to a 0.3 similarity floor; 0.25 recalls more
-- of the long Hindi compound names without pulling in obvious noise.
--
-- ALTER DATABASE needs superuser, which Supabase does not grant, so the setting
-- is applied per-role instead — `anon` and `authenticated` are the roles the
-- website's RPC actually runs as. If even this is refused nothing breaks: the
-- stricter 0.3 default simply recalls a little less.
do $tune$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    begin
      execute format('alter role %I set pg_trgm.similarity_threshold = 0.25', r);
    exception when others then
      raise notice 'could not tune %: %', r, sqlerrm;
    end;
  end loop;
end
$tune$;
