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
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'legal: public read'
  ) then
    execute $policy$
      create policy "legal: public read"
        on storage.objects
        for select
        using (bucket_id = 'legal')
    $policy$;
  end if;
end;
$$;

-- Authenticated write: only service-role callers can upload/update/delete.
-- In practice, updates are done via the Supabase dashboard or CLI.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'legal: service role write'
  ) then
    execute $policy$
      create policy "legal: service role write"
        on storage.objects
        for all
        using (bucket_id = 'legal' and auth.role() = 'service_role')
        with check (bucket_id = 'legal' and auth.role() = 'service_role')
    $policy$;
  end if;
end;
$$;
