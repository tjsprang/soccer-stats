-- League border colours (1 colour = solid border, 2–4 = multicoloured blend).
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

alter table public.leagues
  add column border_colors text[]
  check (border_colors is null or array_length(border_colors, 1) between 1 and 4);

-- Only admins of a league can change its border. Pass null to remove it.
create or replace function public.set_league_border(p_league_id uuid, p_colors text[])
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
  c text;
begin
  if not exists (
    select 1 from public.league_admins where league_id = p_league_id and user_id = auth.uid()
  ) then
    raise exception 'Only admins of this league can change its border.';
  end if;

  if p_colors is not null then
    if coalesce(array_length(p_colors, 1), 0) not between 1 and 4 then
      raise exception 'Pick between 1 and 4 colours.';
    end if;
    foreach c in array p_colors loop
      if c !~ '^#[0-9a-fA-F]{6}$' then
        raise exception 'Invalid colour: %', c;
      end if;
    end loop;
  end if;

  update public.leagues set border_colors = p_colors where id = p_league_id returning * into l;
  return l;
end;
$$;

revoke execute on function public.set_league_border(uuid, text[]) from public, anon;
grant execute on function public.set_league_border(uuid, text[]) to authenticated;
