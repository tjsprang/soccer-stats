-- Player photos: replacing or removing a photo also needs permission to read the stored file.
-- (Photos are already public to view; this adds the matching permission for the storage API.)
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

create policy "Anyone can read player photos" on storage.objects for select to anon, authenticated
  using (bucket_id = 'player-photos');
