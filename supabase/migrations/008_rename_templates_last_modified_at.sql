-- Migration: rename drive_last_modified_at → last_modified_at and drop created_at
-- on the templates table. Drive timestamps are sufficient; created_at is unused.

alter table templates
  rename column drive_last_modified_at to last_modified_at;

alter table templates
  drop column if exists created_at;
