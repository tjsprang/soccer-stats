-- Pass-by-pass tracking: pulls, pickups, every completed pass, and stalls.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check check (type in (
  'goal', 'd', 'throwaway', 'drop', 'callahan', 'half',   -- existing
  'pull', 'pickup', 'pass', 'stall'                       -- new
));

-- The receiver of a pass (player_id is the thrower).
alter table public.events add column target_id text;
alter table public.events
  add constraint events_target_fkey foreign key (target_id, league_id) references public.players(id, league_id);

-- Extra details, e.g. { "ob": true } for an out-of-bounds pull, or a group id for plays recorded together.
alter table public.events add column detail jsonb;

-- Which team pulled to start the game (the other team pulls to start the second half).
alter table public.games add column first_pull text;
alter table public.games
  add constraint games_first_pull_fkey foreign key (first_pull, league_id) references public.teams(id, league_id);
