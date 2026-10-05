-- Leagues, league admins and league passwords.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

create extension if not exists pgcrypto with schema extensions;

-- Every signed-in user can search leagues by name.
create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 60),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index leagues_name_unique on public.leagues (lower(trim(name)));

-- League passwords are kept in their own table with no read access at all.
-- Only the create_league / join_league functions below can use it.
create table public.league_secrets (
  league_id uuid primary key references public.leagues(id) on delete cascade,
  password_hash text not null
);

-- Which users are admins of which leagues.
create table public.league_admins (
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (league_id, user_id)
);

alter table public.leagues enable row level security;
alter table public.league_secrets enable row level security;
alter table public.league_admins enable row level security;

create policy "Signed-in users can search leagues"
  on public.leagues for select to authenticated using (true);

create policy "Users can see their own admin memberships"
  on public.league_admins for select to authenticated using (user_id = auth.uid());

-- No insert/update/delete policies: all changes go through the functions below.

create or replace function public.create_league(p_name text, p_password text)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'League name must be at least 2 characters.';
  end if;
  if char_length(coalesce(p_password, '')) < 4 then
    raise exception 'League password must be at least 4 characters.';
  end if;
  if exists (select 1 from public.leagues where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A league with that name already exists.';
  end if;

  insert into public.leagues (name, created_by) values (trim(p_name), auth.uid()) returning * into l;
  insert into public.league_secrets (league_id, password_hash)
    values (l.id, extensions.crypt(p_password, extensions.gen_salt('bf')));
  insert into public.league_admins (league_id, user_id) values (l.id, auth.uid());
  return l;
end;
$$;

create or replace function public.join_league(p_league_id uuid, p_password text)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select * into l from public.leagues where id = p_league_id;
  if not found then
    raise exception 'League not found.';
  end if;

  if not exists (
    select 1 from public.league_secrets s
    where s.league_id = p_league_id
      and s.password_hash = extensions.crypt(coalesce(p_password, ''), s.password_hash)
  ) then
    raise exception 'Incorrect league password.';
  end if;

  insert into public.league_admins (league_id, user_id) values (p_league_id, auth.uid())
    on conflict do nothing;
  return l;
end;
$$;

revoke execute on function public.create_league(text, text) from public, anon;
revoke execute on function public.join_league(uuid, text) from public, anon;
grant execute on function public.create_league(text, text) to authenticated;
grant execute on function public.join_league(uuid, text) to authenticated;
