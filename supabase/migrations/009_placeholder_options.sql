-- Add options column to placeholders table.
-- Allows landlords to define a restricted list of allowed values for text
-- placeholders. The column is nullable — existing placeholders are unaffected.

alter table placeholders
  add column if not exists options text[];
