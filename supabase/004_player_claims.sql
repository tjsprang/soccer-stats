-- Claiming a player: a signed-in user asks to be linked to a player on a roster,
-- and a league admin approves or denies it.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

-- The account a player is linked to (null = unclaimed). One claimed player per person per league.
alter table public.players add column user_id uuid references auth.users(id) on delete set null;
create unique index players_one_claim_per_league on public.players (league_id, user_id) where user_id is not null;

create table public.player_claims (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  player_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,                 -- shown to admins so they know who is asking
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  foreign key (player_id, league_id) references public.players(id, league_id) on delete cascade
);
create index player_claims_league on public.player_claims (league_id, status);
create unique index player_claims_one_pending on public.player_claims (league_id, user_id) where status = 'pending';

alter table public.player_claims enable row level security;

-- You can see your own claims; league admins can see every claim in their league.
create policy "See own claims, or all claims in leagues you run"
  on public.player_claims for select to authenticated
  using (user_id = auth.uid() or public.is_league_admin(league_id));
-- No insert/update/delete policies: all changes go through the functions below.

create or replace function public.request_claim(p_player_id text)
returns public.player_claims
language plpgsql security definer set search_path = ''
as $$
declare
  pl public.players;
  c public.player_claims;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select * into pl from public.players where id = p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  if pl.user_id = auth.uid() then raise exception 'You’ve already claimed this player.'; end if;
  if pl.user_id is not null then raise exception 'Someone has already claimed this player.'; end if;
  if exists (select 1 from public.players where league_id = pl.league_id and user_id = auth.uid()) then
    raise exception 'You’ve already claimed a player in this league.';
  end if;
  if exists (select 1 from public.player_claims where league_id = pl.league_id and user_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a claim waiting for approval in this league.';
  end if;
  insert into public.player_claims (league_id, player_id, user_id, user_email)
    values (pl.league_id, pl.id, auth.uid(), auth.jwt() ->> 'email')
    returning * into c;
  return c;
end;
$$;

create or replace function public.cancel_claim(p_claim_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.player_claims where id = p_claim_id and user_id = auth.uid() and status = 'pending';
end;
$$;

create or replace function public.decide_claim(p_claim_id uuid, p_approve boolean)
returns public.player_claims
language plpgsql security definer set search_path = ''
as $$
declare
  c public.player_claims;
begin
  select * into c from public.player_claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found.'; end if;
  if not public.is_league_admin(c.league_id) then raise exception 'Only league admins can approve or deny claims.'; end if;
  if c.status <> 'pending' then raise exception 'This claim has already been handled.'; end if;

  if p_approve then
    if exists (select 1 from public.players where id = c.player_id and user_id is not null and user_id <> c.user_id) then
      raise exception 'Someone else has already claimed this player.';
    end if;
    if exists (select 1 from public.players where league_id = c.league_id and user_id = c.user_id and id <> c.player_id) then
      raise exception 'This person has already claimed a different player in this league.';
    end if;
    update public.players set user_id = c.user_id where id = c.player_id;
    update public.player_claims set status = 'approved', decided_at = now() where id = c.id returning * into c;
    -- Anyone else waiting on the same player is turned down.
    update public.player_claims set status = 'denied', decided_at = now()
      where player_id = c.player_id and status = 'pending';
  else
    update public.player_claims set status = 'denied', decided_at = now() where id = c.id returning * into c;
  end if;
  return c;
end;
$$;

-- Unlink a player from its account: the player themselves, or a league admin.
create or replace function public.release_player(p_player_id text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pl public.players;
begin
  select * into pl from public.players where id = p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  if pl.user_id is distinct from auth.uid() and not public.is_league_admin(pl.league_id) then
    raise exception 'Only the claimed player or a league admin can do this.';
  end if;
  update public.players set user_id = null where id = p_player_id;
end;
$$;

revoke execute on function public.request_claim(text) from public, anon;
revoke execute on function public.cancel_claim(uuid) from public, anon;
revoke execute on function public.decide_claim(uuid, boolean) from public, anon;
revoke execute on function public.release_player(text) from public, anon;
grant execute on function public.request_claim(text) to authenticated;
grant execute on function public.cancel_claim(uuid) to authenticated;
grant execute on function public.decide_claim(uuid, boolean) to authenticated;
grant execute on function public.release_player(text) to authenticated;

-- Live: admins see new requests straight away, players see approvals.
alter publication supabase_realtime add table public.player_claims;
