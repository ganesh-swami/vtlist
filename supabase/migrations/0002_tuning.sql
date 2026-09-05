-- optional: search tuning.
-- Needs privileges the anon/service roles do not have on every plan. If this
-- file fails to apply, nothing breaks — pg_trgm just keeps its stricter 0.3
-- default and very long compound names recall slightly less.

-- pg_trgm's `%` operator defaults to a 0.3 similarity floor; 0.25 recalls more
-- of the long Hindi compound names without pulling in obvious noise.
alter database postgres set pg_trgm.similarity_threshold = 0.25;
