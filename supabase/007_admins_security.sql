-- Managing admins, limiting league-password guesses, and deleting leagues.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

-- ----- Admins can see each other (by email) -----
alter table public.league_admins add column user_email text;
update public.league_admins a set user_email = u.email from auth.users u where u.id = a.user_id;

create policy "League admins can see their co-admins"
  on public.league_admins for select to authenticated using (public.is_league_admin(league_id));

-- New leagues record the creator's email too (same as 006, plus user_email).
create or replace function public.create_league(p_name text, p_password text)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'League name must be at least 2 characters.'; end if;
  if char_length(coalesce(p_password, '')) < 4 then raise exception 'League password must be at least 4 characters.'; end if;
  if exists (select 1 from public.leagues where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A league with that name already exists.';
  end if;
  insert into public.leagues (name, created_by) values (trim(p_name), auth.uid()) returning * into l;
  insert into public.league_secrets (league_id, password_hash)
    values (l.id, extensions.crypt(p_password, extensions.gen_salt('bf')));
  insert into public.league_admins (league_id, user_id, user_email) values (l.id, auth.uid(), auth.jwt() ->> 'email');
  insert into public.seasons (league_id, name, number) values (l.id, 'Season 1', 1);
  return l;
end;
$$;

-- ----- Joining, with a limit on wrong passwords -----
-- Wrong guesses are recorded here. Nobody can read this table; only join_league uses it.
create table public.join_attempts (
  id bigint generated always as identity primary key,
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  at timestamptz not null default now()
);
create index join_attempts_recent on public.join_attempts (league_id, at);
alter table public.join_attempts enable row level security;

-- join_league now returns { ok, league } or { ok: false, error } instead of raising an error,
-- so a wrong guess can be recorded (an error would undo the record).
drop function public.join_league(uuid, text);
create function public.join_league(p_league_id uuid, p_password text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
  mine int;
  everyone int;
  per_user constant int := 5;     -- wrong guesses allowed per person per league…
  per_league constant int := 30;  -- …and in total per league…
  win constant interval := '15 minutes';   -- …in this window
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'error', 'You must be signed in.'); end if;
  select * into l from public.leagues where id = p_league_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'League not found.'); end if;

  select count(*) filter (where user_id = auth.uid()), count(*) into mine, everyone
    from public.join_attempts where league_id = p_league_id and at > now() - win;
  if mine >= per_user or everyone >= per_league then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong passwords. Wait 15 minutes, then try again.');
  end if;

  if not exists (
    select 1 from public.league_secrets s
    where s.league_id = p_league_id
      and s.password_hash = extensions.crypt(coalesce(p_password, ''), s.password_hash)
  ) then
    insert into public.join_attempts (league_id, user_id) values (p_league_id, auth.uid());
    return jsonb_build_object('ok', false, 'error',
      'Incorrect league password.' || case when per_user - mine - 1 <= 2
        then ' ' || (per_user - mine - 1) || ' tr' || case when per_user - mine - 1 = 1 then 'y' else 'ies' end || ' left.' else '' end);
  end if;

  insert into public.league_admins (league_id, user_id, user_email) values (p_league_id, auth.uid(), auth.jwt() ->> 'email')
    on conflict (league_id, user_id) do update set user_email = excluded.user_email;
  delete from public.join_attempts where league_id = p_league_id and user_id = auth.uid();
  return jsonb_build_object('ok', true, 'league', to_jsonb(l));
end;
$$;
revoke execute on function public.join_league(uuid, text) from public, anon;
grant execute on function public.join_league(uuid, text) to authenticated;

-- ----- Removing admins, leaving, and changing the password -----
-- Any admin can remove another admin, except the league's creator (who can only remove themselves).
-- A league always keeps at least one admin.
create or replace function public.remove_league_admin(p_league_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  creator uuid;
begin
  if not public.is_league_admin(p_league_id) then raise exception 'Only league admins can do this.'; end if;
  select created_by into creator from public.leagues where id = p_league_id;
  if p_user_id = creator and p_user_id <> auth.uid() then
    raise exception 'The league’s creator can’t be removed by someone else.';
  end if;
  if (select count(*) from public.league_admins where league_id = p_league_id) <= 1 then
    raise exception 'A league needs at least one admin. Add another admin first, or delete the league.';
  end if;
  delete from public.league_admins where league_id = p_league_id and user_id = p_user_id;
end;
$$;

create or replace function public.change_league_password(p_league_id uuid, p_password text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_league_admin(p_league_id) then raise exception 'Only league admins can change the password.'; end if;
  if char_length(coalesce(p_password, '')) < 4 then raise exception 'League password must be at least 4 characters.'; end if;
  update public.league_secrets set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf'))
    where league_id = p_league_id;
  delete from public.join_attempts where league_id = p_league_id;   -- fresh start for the new password
end;
$$;

-- ----- Deleting a league (and everything in it) -----
create or replace function public.delete_league(p_league_id uuid, p_confirm_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if not public.is_league_admin(p_league_id) then raise exception 'Only league admins can delete a league.'; end if;
  select * into l from public.leagues where id = p_league_id;
  if lower(trim(coalesce(p_confirm_name, ''))) <> lower(trim(l.name)) then
    raise exception 'The name didn’t match, so nothing was deleted.';
  end if;
  -- Plays and games first (plays point at players), then the league takes everything else with it.
  delete from public.events where league_id = p_league_id;
  delete from public.games where league_id = p_league_id;
  delete from public.leagues where id = p_league_id;
end;
$$;

revoke execute on function public.remove_league_admin(uuid, uuid) from public, anon;
revoke execute on function public.change_league_password(uuid, text) from public, anon;
revoke execute on function public.delete_league(uuid, text) from public, anon;
grant execute on function public.remove_league_admin(uuid, uuid) to authenticated;
grant execute on function public.change_league_password(uuid, text) to authenticated;
grant execute on function public.delete_league(uuid, text) to authenticated;
