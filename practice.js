// Soccer Stats: practice scrimmages. A team splits its own roster into two sides (Bibs and Shirts) and tracks
// the scrimmage with the normal live tracker. Practices live in db.practice, apart from db.games, so they never
// reach standings, leaders, the Hall of Fame or public links. Only the team's players, its team admins and the
// league's admins can see them (supabase/016_practice.sql).
// Loaded before the main script in index.html; these are plain globals it calls.

// The sides are stored as "dark" and "light" (the database names them that way); here they're bibs and shirts.
const SIDES = { dark: { name: 'Bibs', color: 'var(--side-dark)' }, light: { name: 'Shirts', color: 'var(--side-light)' } };
const isPractice = g => g?.stage === 'practice';
const teamPractices = tid => db.practice.filter(g => g.practiceTeam === tid).sort((a, b) => b.created - a.created);

// A practice game's sides are named after it: "<gameId>:dark" and "<gameId>:light". This builds one as a
// team-shaped object (name, colour, players) so the tracker, box score and stats treat it like any team.
function practiceSide(id) {
  const [gid, side] = String(id ?? '').split(':');
  const g = SIDES[side] && db.practice.find(x => x.id === gid);
  if (!g) return undefined;
  const real = db.teams.find(t => t.id === g.practiceTeam);
  const mine = new Set(g.sides?.[side] || []), other = new Set(g.sides?.[side === 'dark' ? 'light' : 'dark'] || []);
  // Someone now sitting out still shows on the side they recorded plays for, so their stats aren't hidden.
  const playedHere = pid => g.events.some(e => (e.teamId === id && (e.playerId === pid || e.targetId === pid || e.assistId === pid))
    || e.played?.[id]?.includes(pid));
  return {
    id, name: SIDES[side].name, color: SIDES[side].color, color2: null, seasonId: real?.seasonId, practiceOf: g.practiceTeam,
    players: (real?.players || []).filter(p => mine.has(p.id) || (!other.has(p.id) && playedHere(p.id)))
  };
}

// Who sees a team's practices: league admins, its team admins, and its claimed players. The database enforces
// this; here it decides whether to show the Practice tab at all.
const canSeePractice = tid => db.practiceReady && !isPublicView()
  && (isAdmin() || myTeamIds().includes(tid) || !!team(tid)?.players.some(p => p.userId && p.userId === me()) || teamPractices(tid).length > 0);
const canStartPractice = tid => db.practiceReady && managesTeam(tid) && inActiveSeason(team(tid) || {});

// ---------- Choosing sides ----------
// A draft while the pop-up is open: { tid, gameId (null for a new scrimmage), dark: [ids], light: [ids] }.
let sidesDraft = null;

function splitEvenly(ids) {
  const order = shuffled(ids);
  return { dark: order.filter((_, i) => i % 2 === 0), light: order.filter((_, i) => i % 2 === 1) };
}

function newScrimmage(tid) {
  const t = team(tid);
  if (!t || t.players.length < 2) return alert('Add at least two players to the roster first.');
  sidesDraft = { tid, gameId: null, ...splitEvenly(t.players.map(p => p.id)) };
  renderSidesSheet();
}

function editSides() {
  const g = game(ui.gameId), st = matchState(g);
  if (st.phase === 'play') return alert('Change sides at half time (or before kickoff).');
  sidesDraft = { tid: g.practiceTeam, gameId: g.id, dark: [...(g.sides?.dark || [])], light: [...(g.sides?.light || [])] };
  renderSidesSheet();
}

function shuffleSides() {
  Object.assign(sidesDraft, splitEvenly([...sidesDraft.dark, ...sidesDraft.light]));   // sitting-out players stay out
  renderSidesSheet();
}

function setSide(pid, side) {
  sidesDraft.dark = sidesDraft.dark.filter(x => x !== pid);
  sidesDraft.light = sidesDraft.light.filter(x => x !== pid);
  if (side !== 'out') sidesDraft[side].push(pid);
  renderSidesSheet();
}

function renderSidesSheet(msg = '') {
  const d = sidesDraft, t = team(d.tid);
  const where = pid => (d.dark.includes(pid) ? 'dark' : d.light.includes(pid) ? 'light' : 'out');
  const out = t.players.length - d.dark.length - d.light.length;
  openSheet(`
    <h3>${d.gameId ? 'Change sides' : `New scrimmage · ${esc(t.name)}`}</h3>
    <div class="muted">${d.gameId ? 'Move players between sides. Stats they’ve already recorded stay with them.'
      : 'Split the roster into two sides. Practice stats are only seen by your team and league admins, and never count toward league stats.'}</div>
    <div class="row side-summary">
      <span><span class="dot" style="background:${SIDES.dark.color}"></span>${SIDES.dark.name} <b>${d.dark.length}</b></span>
      <span><span class="dot" style="background:${SIDES.light.color}"></span>${SIDES.light.name} <b>${d.light.length}</b></span>
      ${out ? `<span class="muted">Sitting out <b>${out}</b></span>` : ''}
      <button class="small" onclick="shuffleSides()">🔀 Shuffle evenly</button>
    </div>
    <div class="msg error">${esc(msg)}</div>
    <div class="side-list">${t.players.map(p => `
      <div class="side-row"><span class="side-name">#${esc(p.number)} ${esc(p.name)}</span>
        <span class="side-pick">${[['dark', SIDES.dark.name], ['light', SIDES.light.name], ['out', 'Out']].map(([s, label]) =>
          `<button class="${s} ${where(p.id) === s ? 'on' : ''}" onclick="setSide('${p.id}', '${s}')">${label}</button>`).join('')}</span>
      </div>`).join('')}</div>
    <div class="actions" style="margin-top:12px">
      <button onclick="closeSheet()">Cancel</button>
      <button class="goal" onclick="${d.gameId ? 'saveSides()' : 'startScrimmage()'}">${d.gameId ? 'Save sides' : 'Start scrimmage'}</button>
    </div>`);
}

function startScrimmage() {
  const d = sidesDraft, t = team(d.tid);
  if (!d.dark.length || !d.light.length) return renderSidesSheet('Each side needs at least one player.');
  const id = uid();
  const g = { id, homeId: `${id}:dark`, awayId: `${id}:light`, stage: 'practice', practiceTeam: t.id,
    sides: { dark: d.dark, light: d.light }, created: Date.now(), status: 'live', events: [],
    seasonId: t.seasonId || activeSeason()?.id || null };
  db.practice.push(g); saveGame(g);
  sidesDraft = null; closeSheet();
  location.hash = `#/game/${id}`;
}

function saveSides() {
  const d = sidesDraft, g = game(d.gameId);
  if (!d.dark.length || !d.light.length) return renderSidesSheet('Each side needs at least one player.');
  g.sides = { dark: d.dark, light: d.light };
  // Anyone who switched sides comes out of their old side's lineup.
  if (g.lineup) for (const side of ['dark', 'light']) {
    const tid = `${g.id}:${side}`;
    const l = g.lineup[tid];
    if (l?.on) g.lineup[tid] = { on: l.on.filter(pid => d[side].includes(pid)), gk: d[side].includes(l.gk) ? l.gk : null };
  }
  sidesDraft = null; saveGame(g); route();
}

// ---------- Team page: Practice tab ----------
let practiceSort = 'g';
function sortPractice(k) { practiceSort = k; route(); }

function teamPageTabs(tid, on) {
  if (!canSeePractice(tid)) return '';
  return `<div class="tabs leader-tabs">
    <button class="${on === 'season' ? 'on' : ''}" onclick="location.hash = '#/team/${tid}'">League games</button>
    <button class="${on === 'practice' ? 'on' : ''}" onclick="location.hash = '#/practice/${tid}'">🏃 Practice</button></div>`;
}

function practiceTabHtml(t) {
  if (!db.practiceReady) return `<p class="muted">Practice scrimmages need a database update: run <code>supabase/016_practice.sql</code> in Supabase.</p>`;
  const games = teamPractices(t.id), an = analyze(games);
  practiceSort = sortKeyFor(practiceSort);
  const rows = sortRows(t.players.map(p => ({ ...p, team: t, ...statsOf(an, p.id) })).filter(r => r.gp), practiceSort);
  const live = games.filter(g => g.status === 'live'), done = games.filter(g => g.status === 'final');
  const goals = an.games.reduce((n, r) => n + r.goals.length, 0);
  return `
    <p class="muted">Scrimmages within the team. Only this team’s players and admins (and league admins) can see these,
      and they don’t count toward league stats.</p>
    ${canStartPractice(t.id) ? `<button class="primary" style="width:100%;margin-bottom:12px" onclick="newScrimmage('${t.id}')">+ New scrimmage</button>` : ''}
    ${games.length ? tiles([['Scrimmages', games.length], ['Goals', goals], ['Players', rows.length]]) : ''}
    ${live.length ? `<h2>Live now</h2>${live.map(gameCard).join('')}` : ''}
    ${rows.length ? `<h2>Practice stats</h2>${statCatTabs('route()')}
      <div class="card">${statTable(rows, statCols(playerNameCol(false)), practiceSort, 'sortPractice')}</div>${statFootnote}` : ''}
    ${done.length ? `<h2>Scrimmages</h2>${done.map(gameCard).join('')}` : ''}
    ${games.length ? '' : '<p class="muted">No scrimmages yet.</p>'}`;
}

// ---------- Player page: Practice tab ----------
let profileTab = 'season';
const practiceSideOf = (g, pid) => (g.sides?.dark?.includes(pid) ? g.homeId : g.sides?.light?.includes(pid) ? g.awayId
  : g.events.find(e => e.type !== 'own_goal' && (e.playerId === pid || e.targetId === pid))?.teamId || null);

// The player's scrimmages: ones they were on a side for, or recorded plays in.
const playerPractices = (pid, tid) => teamPractices(tid).filter(g => practiceSideOf(g, pid));

function profileTabs(p, t) {
  if (!canSeePractice(t.id) || !playerPractices(p.id, t.id).length) return '';
  return `<div class="tabs leader-tabs">
    <button class="${profileTab !== 'practice' ? 'on' : ''}" onclick="profileTab = 'season'; route()">League games</button>
    <button class="${profileTab === 'practice' ? 'on' : ''}" onclick="profileTab = 'practice'; route()">🏃 Practice</button></div>`;
}
const showingPracticeProfile = (p, t) => profileTab === 'practice' && !!profileTabs(p, t);

function practiceProfileHtml(p, t) {
  const games = playerPractices(p.id, t.id), s = statsOf(analyze(games), p.id);
  const rows = games.map(g => {
    // Everyone they played for: the sides of their plays plus where they are now. Switched mid-scrimmage = both.
    const played = new Set([practiceSideOf(g, p.id), ...g.events.filter(e => e.type !== 'own_goal' && (e.playerId === p.id || e.targetId === p.id)).map(e => e.teamId)]);
    const side = practiceSideOf(g, p.id), other = side === g.homeId ? g.awayId : g.homeId;
    const us = score(g, side), them = score(g, other), live = g.status === 'live' ? 'LIVE ' : '';
    return { gm: g, ...statsOf(analyze([g]), p.id), ...(played.size > 1
      ? { name: 'Both sides', result: `${live}${SIDES.dark.name} ${score(g, g.homeId)}–${score(g, g.awayId)} ${SIDES.light.name}` }
      : { name: `${team(side).name} side`, result: `${live || (us > them ? 'W ' : us < them ? 'L ' : 'D ')}${us}–${them}` }) };
  });
  return `
    <p class="muted">Practice scrimmages with ${esc(t.name)}. These don’t count toward league stats.</p>
    ${tiles([['Scrimmages', games.length], ['Goals', s.g], ['Assists', s.a], ['Shots', s.sh, `${s.sot} on target`],
      ['Minutes', fmtInt(s.min)], ...(s.gkMin ? [['Saves', s.sv, `${s.gc} conceded`]] : []),
      ['Cards', `${s.yc} 🟨 ${s.rc} 🟥`]])}
    <h2>Scrimmage by scrimmage</h2>
    ${statCatTabs('route()')}<div class="card">${statTable(rows, statCols(
      { k: 'name', h: 'Scrimmage', l: true, f: r => `<a href="#/box/${r.gm.id}">${esc(r.name)}</a>
        <div class="muted" style="font-size:12px">${esc(r.result)} · ${new Date(r.gm.created).toLocaleDateString()}</div>` }))}</div>
    ${statFootnote}`;
}

// A line on practice box scores and the tracker.
const practiceLabel = g => `<div class="muted practice-label">🏃 ${esc(team(g.practiceTeam)?.name || '')} practice scrimmage
  · only the team can see it · doesn’t count toward league stats</div>`;
