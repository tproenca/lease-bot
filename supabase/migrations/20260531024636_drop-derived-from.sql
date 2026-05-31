-- Drop the denormalized derived_from column from placeholders.
-- The base field name is now computed on the fly from derived_formula
-- using the regex /^[a-z_][a-z0-9_]*/i so no data is lost.
ALTER TABLE public.placeholders DROP COLUMN IF EXISTS derived_from;
