-- Create a public `legal` bucket to serve static legal documents
-- (e.g. the privacy policy required by the Custom GPT OAuth action).
-- Objects in this bucket are publicly readable without authentication.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'legal',
  'legal',
  true,
  1048576,                                   -- 1 MB max per file
  array['text/html', 'text/plain', 'application/pdf']
)
on conflict (id) do nothing;

-- Public read: anyone can download objects from the legal bucket.
create policy if not exists "legal: public read"
  on storage.objects
  for select
  using (bucket_id = 'legal');

-- Authenticated write: only service-role callers can upload/update/delete.
-- In practice, updates are done via the Supabase dashboard or CLI.
create policy if not exists "legal: service role write"
  on storage.objects
  for all
  using (bucket_id = 'legal' and auth.role() = 'service_role')
  with check (bucket_id = 'legal' and auth.role() = 'service_role');
