// Soccer Stats: standings, playoffs, notifications, and the offline copy of league data.
// Loaded after stats.js and before the main script in index.html; these are plain globals it calls.

// ---------- Standings ----------
// Regular-season finished matches only. 3 points for a win, 1 for a draw. Ranked by points, then goal difference,
// goals scored, and points in the matches between the tied teams.
function standings(teams, games) {
  const rows = Object.fromEntries(teams.map(t => [t.id, { team: t, gp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, form: [] }]));
  const h2h = {};   // "a|b" → points a took from matches against b
  const done = games.filter(g => g.status === 'final' && (g.stage || 'regular') === 'regular' && rows[g.homeId] && rows[g.awayId])
    .sort((a, b) => a.created - b.created);
  for (const g of done) {
    for (const [us, them] of [[g.homeId, g.awayId], [g.awayId, g.homeId]]) {
      const r = rows[us], a = score(g, us), b = score(g, them);
      r.gp++; r.gf += a; r.ga += b;
      const res = a > b ? 'W' : a < b ? 'L' : 'D';
      r[res.toLowerCase()]++;
      r.form.push({ res, g });
      h2h[`${us}|${them}`] = (h2h[`${us}|${them}`] || 0) + (res === 'W' ? 3 : res === 'D' ? 1 : 0);
    }
  }
  const list = Object.values(rows).map(r => {
    r.pts = r.w * 3 + r.d;
    r.diff = r.gf - r.ga;
    let n = 0; const last = r.form.at(-1)?.res;
    for (let i = r.form.length - 1; i >= 0 && r.form[i].res === last; i--) n++;
    r.streak = last ? `${last}${n}` : '—';
    return r;
  });
  return list.sort((a, b) => (b.pts - a.pts) || (b.diff - a.diff) || (b.gf - a.gf)
    || ((h2h[`${b.team.id}|${a.team.id}`] || 0) - (h2h[`${a.team.id}|${b.team.id}`] || 0)) || a.team.name.localeCompare(b.team.name));
}

function renderStandings() {
  const s = viewSeason(), table = standings(seasonTeams(), seasonGames());
  const hasPlayoffs = !!s?.playoffs;
  app.innerHTML = `
    <div class="row"><h1>Standings</h1>
      ${db.playoffsReady && (hasPlayoffs || canEdit()) ? `<a class="btn small" href="#/playoffs">🏆 Playoffs</a>` : ''}
      <button class="small" onclick="exportStandings()" title="Download as a spreadsheet">⬇ CSV</button></div>
    ${seasonPicker('pickSeason')}
    <p class="muted">Regular-season matches. 3 points for a win, 1 for a draw. Ties are split by goal difference, goals scored, then head-to-head.</p>
    ${table.length ? `<div class="card"><div class="table-wrap"><table class="standings">
      <thead><tr><th>#</th><th class="l">Team</th><th title="Matches played">P</th><th title="Won">W</th><th title="Drawn">D</th><th title="Lost">L</th>
        <th title="Goals for">GF</th><th title="Goals against">GA</th><th title="Goal difference">GD</th><th title="Points">Pts</th>
        <th class="l">Last 5</th><th title="Current streak">Strk</th></tr></thead>
      <tbody>${table.map((r, i) => `<tr class="${r.team.players.some(p => p.userId === me()) ? 'me' : ''}">
        <td>${i + 1}</td>
        <td class="l"><a href="#/team/${r.team.id}" style="color:inherit"><span class="dot" style="background:${teamBg(r.team)}"></span>${esc(r.team.name)}</a></td>
        <td>${r.gp}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
        <td>${r.gf}</td><td>${r.ga}</td><td>${r.diff > 0 ? '+' : ''}${r.diff}</td><td><b>${r.pts}</b></td>
        <td class="l"><span class="form">${r.form.slice(-5).map(f => `<a href="#/box/${f.g.id}" class="form-${f.res}" title="${f.res === 'W' ? 'Win' : f.res === 'L' ? 'Loss' : 'Draw'}">${f.res}</a>`).join('')}</span></td>
        <td>${r.streak}</td></tr>`).join('')}</tbody>
    </table></div></div>` : '<p class="muted">No teams yet.</p>'}`;
}

// ---------- Playoffs ----------
// A single-elimination bracket stored on the season as { size, seeds: [teamId, …] } (seed 1 first).
// Round 1 pairs seeds the standard way (1 v 8, 4 v 5, 2 v 7, 3 v 6 …). Missing seeds are byes: the higher seed
// goes straight through. Each later-round game is created once both of its teams are known.
// How playoff games count toward player stats, chosen when the bracket is set up (stored with it).
const PLAYOFF_STATS = {
  combined: ['Count with the regular season', 'Playoff stats add into each player’s season totals.'],
  separate: ['Keep them separate', 'Season totals stay regular season only. Playoff stats get their own Playoffs tab on Leaders.'],
  both: ['Both', 'Season totals include the playoffs, and a Playoffs tab also shows playoff-only stats.'],
  none: ['Don’t keep stats', 'Playoff games still get scores and play-by-play, but no player stats are counted.']
};
const playoffStatsMode = seasonId => db.seasons.find(s => s.id === seasonId)?.playoffs?.stats || 'combined';   // older brackets: combined
const isPlayoff = g => g.stage === 'playoff';
// Does this game count toward season totals (and all-time)? Toward the separate playoff stats?
const countsInSeason = g => !isPlayoff(g) || ['combined', 'both'].includes(playoffStatsMode(g.seasonId));
const countsInPlayoffs = g => isPlayoff(g) && ['separate', 'both'].includes(playoffStatsMode(g.seasonId));
const playoffStatsKept = g => !isPlayoff(g) || playoffStatsMode(g.seasonId) !== 'none';
const hasPlayoffTab = seasonId => ['separate', 'both'].includes(playoffStatsMode(seasonId))
  && db.games.some(g => g.seasonId === seasonId && isPlayoff(g) && g.status !== 'scheduled');

function playoffStatsOptions(current) {
  return `<div class="options">${Object.entries(PLAYOFF_STATS).map(([k, [title, text]]) => `
    <label class="card option"><input type="radio" name="pstats" value="${k}" ${k === current ? 'checked' : ''} onchange="playoffStats = this.value">
      <span><b>${title}</b><div class="muted">${text}</div></span></label>`).join('')}</div>`;
}

function seedOrder(size) {
  let o = [1, 2];
  while (o.length < size) { const n = o.length * 2 + 1; o = o.flatMap(s => [s, n - s]); }
  return o;
}
const roundName = (r, rounds) => (r === rounds ? 'Final' : r === rounds - 1 ? 'Semifinals' : r === rounds - 2 ? 'Quarterfinals' : `Round ${r}`);

function bracketOf(season) {
  const def = season?.playoffs;
  if (!def) return null;
  const rounds = Math.log2(def.size), order = seedOrder(def.size);
  const games = db.games.filter(g => g.seasonId === season.id && g.stage === 'playoff');
  const matches = {};
  const winnerOf = m => {
    if (!m) return null;
    const [a, b] = m.teams;
    if (m.round === 1 && (a == null) !== (b == null)) return a ?? b;   // bye
    if (!m.game || m.game.status !== 'final') return null;
    const sa = score(m.game, m.game.homeId), sb = score(m.game, m.game.awayId), pens = shootoutOf(m.game);   // level: decided on penalties
    if (sa === sb) return pens && pens[m.game.homeId] !== pens[m.game.awayId] ? (pens[m.game.homeId] > pens[m.game.awayId] ? m.game.homeId : m.game.awayId) : null;
    return sa > sb ? m.game.homeId : m.game.awayId;
  };
  const list = [];
  for (let r = 1; r <= rounds; r++) {
    const count = def.size / 2 ** r;
    for (let m = 1; m <= count; m++) {
      const slot = `R${r}M${m}`;
      const teams = r === 1
        ? [def.seeds[order[2 * m - 2] - 1] ?? null, def.seeds[order[2 * m - 1] - 1] ?? null]
        : [winnerOf(matches[`R${r - 1}M${2 * m - 1}`]), winnerOf(matches[`R${r - 1}M${2 * m}`])];
      const match = { slot, round: r, m, teams, game: games.find(g => g.bracketSlot === slot) || null,
        seeds: r === 1 ? [order[2 * m - 2], order[2 * m - 1]] : null };
      match.bye = r === 1 && (teams[0] == null || teams[1] == null);
      match.winner = winnerOf(match);
      matches[slot] = match; list.push(match);
    }
  }
  const final = matches[`R${rounds}M1`];
  return { def, rounds, matches: list, champion: final?.winner || null };
}

// Create any playoff games whose two teams are now known. Safe to call any time (admins only).
function advanceBracket(season = activeSeason()) {
  const b = bracketOf(season);
  if (!b || !canEdit()) return;
  for (const m of b.matches) {
    if (m.bye || m.game || !m.teams[0] || !m.teams[1]) continue;
    const g = { id: uid(), homeId: m.teams[0], awayId: m.teams[1], created: Date.now(), status: 'scheduled', events: [],
      seasonId: season.id, stage: 'playoff', bracketSlot: m.slot, when: localDateTime(new Date()), field: 1, round: m.round };
    db.games.push(g); saveGame(g);
  }
}

let playoffSize = null, playoffStats = 'both';
function renderPlayoffs() {
  const s = viewSeason();
  if (!db.playoffsReady) { app.innerHTML = '<h1>Playoffs</h1><p class="msg error">Playoffs need a database update (supabase/008_playoffs.sql).</p>'; return; }
  const b = bracketOf(s);
  if (!b) {
    const table = standings(seasonTeams(), seasonGames());
    if (!canEdit()) { app.innerHTML = `<div class="row"><h1>Playoffs</h1><a class="btn small" href="#/standings">← Standings</a></div>${seasonPicker('pickSeason')}<p class="muted">No playoffs have been set up for ${esc(s?.name || 'this season')}.</p>`; return; }
    const n = Math.min(16, table.length);
    playoffSize = Math.min(Math.max(2, playoffSize || Math.min(8, n)), n);
    app.innerHTML = `
      <div class="row"><h1>Set up playoffs</h1><a class="btn small" href="#/standings">← Standings</a></div>
      ${n < 2 ? '<p class="muted">You need at least two teams.</p>' : `
      <div class="card">
        <label class="field">How many teams make the playoffs?
          <select onchange="playoffSize = +this.value; renderPlayoffs()">${Array.from({ length: n - 1 }, (_, i) => i + 2).map(k =>
            `<option value="${k}" ${k === playoffSize ? 'selected' : ''}>${k} teams</option>`).join('')}</select></label>
        <p class="muted">Seeded from the current standings. ${playoffSize & (playoffSize - 1) ? 'Top seeds get a first-round bye.' : ''}</p>
        <ol class="seed-list">${table.slice(0, playoffSize).map(r => `<li><span class="dot" style="background:${teamBg(r.team)}"></span>${esc(r.team.name)}
          <span class="muted">${r.pts} pts · W${r.w} D${r.d} L${r.l}</span></li>`).join('')}</ol>
        <h3 style="margin:18px 0 8px">Player stats in the playoffs</h3>
        ${playoffStatsOptions(playoffStats)}
        <button class="primary" style="width:100%;margin-top:14px" onclick="createPlayoffs()">Create bracket</button>
      </div>`}`;
    return;
  }
  const byRound = r => b.matches.filter(m => m.round === r);
  const teamLine = (m, i) => {
    const tid = m.teams[i], t = tid && team(tid), g = m.game;
    const pens = g && shootoutOf(g), sc = g && g.status !== 'scheduled' && tid ? `${score(g, tid)}${pens ? ` (${pens[tid] ?? 0})` : ''}` : '';
    const seed = m.seeds ? `<span class="seed">${m.seeds[i] <= b.def.seeds.length ? m.seeds[i] : ''}</span>` : '';
    return `<div class="bteam ${m.winner && m.winner === tid ? 'won' : ''}">${seed}${t ? `<span class="dot" style="background:${teamBg(t)}"></span>${esc(t.name)}`
      : `<span class="muted">${m.bye && m.round === 1 ? 'Bye' : 'TBD'}</span>`}<b>${sc}</b></div>`;
  };
  const card = m => {
    if (m.bye) return `<div class="bmatch bye">${teamLine(m, 0)}${teamLine(m, 1)}</div>`;
    const g = m.game, href = g ? (g.status === 'live' && canTrack(g) ? `#/game/${g.id}` : `#/box/${g.id}`) : null;
    const status = !g ? '' : g.status === 'live' ? '<span class="badge live">LIVE</span>' : g.status === 'final' ? (m.winner ? '' : '<span class="badge live">LEVEL</span>') : '';
    return `<div class="bmatch">${href ? `<a href="${href}">` : '<div>'}${teamLine(m, 0)}${teamLine(m, 1)}${href ? '</a>' : '</div>'}
      <div class="bfoot">${status}${g && g.status === 'scheduled' && canEdit() ? `<button class="small primary" onclick="startScheduled('${g.id}')">Start</button>` : ''}</div></div>`;
  };
  const ties = b.matches.some(m => m.game?.status === 'final' && !m.winner);
  app.innerHTML = `
    <div class="row"><h1>Playoffs</h1><a class="btn small" href="#/standings">← Standings</a></div>
    ${seasonPicker('pickSeason')}
    ${b.champion ? `<div class="card champion">🏆 <b>${esc(team(b.champion).name)}</b> won ${esc(s.name)}!</div>` : ''}
    ${ties ? '<p class="msg error">A playoff match ended level with no penalty shootout, so no one can advance. Reopen it and record the shootout.</p>' : ''}
    <div class="bracket">${Array.from({ length: b.rounds }, (_, i) => i + 1).map(r => `
      <div class="bround"><div class="bround-name">${roundName(r, b.rounds)}</div>${byRound(r).map(card).join('')}</div>`).join('')}
    </div>
    <p class="muted" style="margin-top:14px">Player stats: <b>${PLAYOFF_STATS[playoffStatsMode(s.id)][0]}</b>. ${PLAYOFF_STATS[playoffStatsMode(s.id)][1]}</p>
    ${canEdit() ? `<div class="row" style="margin-top:4px">
      <button class="small" onclick="changePlayoffStatsSheet()">Change how stats count</button>
      <button class="small" onclick="resetPlayoffs()">Reset playoffs</button></div>` : ''}`;
}

function changePlayoffStatsSheet() {
  playoffStats = playoffStatsMode(activeSeason().id);
  openSheet(`<h3>Player stats in the playoffs</h3>
    ${playoffStatsOptions(playoffStats)}
    <div class="actions" style="margin-top:12px">
      <button onclick="closeSheet()">Cancel</button>
      <button class="goal" onclick="savePlayoffStats()">Save</button>
    </div>`);
}

async function savePlayoffStats() {
  const s = activeSeason(), def = { ...s.playoffs, stats: playoffStats };
  const { data, error } = await sb.rpc('set_season_playoffs', { p_season_id: s.id, p_playoffs: def });
  if (error) return toast(dbErrorText(error));
  s.playoffs = data.playoffs;
  toast(`Playoff stats: ${PLAYOFF_STATS[playoffStats][0]}.`);
  closeSheet(); renderPlayoffs();
}

async function createPlayoffs() {
  const s = activeSeason(), table = standings(seasonTeams(), seasonGames());
  const seeds = table.slice(0, playoffSize).map(r => r.team.id);
  let size = 2; while (size < seeds.length) size *= 2;
  const def = { size, seeds, stats: playoffStats };
  const { data, error } = await sb.rpc('set_season_playoffs', { p_season_id: s.id, p_playoffs: def });
  if (error) return toast(dbErrorText(error));
  s.playoffs = data.playoffs;
  advanceBracket(s);
  toast('Bracket created! First-round games are on the Games page, ready to start.');
  renderPlayoffs();
}

async function resetPlayoffs() {
  const s = activeSeason(), games = db.games.filter(g => g.seasonId === s.id && g.stage === 'playoff');
  const played = games.filter(g => g.status !== 'scheduled').length;
  if (!confirm(`Remove the bracket and its ${games.length} playoff game${games.length === 1 ? '' : 's'}${played ? ` (${played} already played, with their stats)` : ''}?`)) return;
  const { error } = await sb.rpc('set_season_playoffs', { p_season_id: s.id, p_playoffs: null });
  if (error) return toast(dbErrorText(error));
  s.playoffs = null;
  const ids = games.map(g => g.id);
  db.games = db.games.filter(g => !ids.includes(g.id));
  persist(ids.length && { del: 'games', vals: ids });
  renderPlayoffs();
}

// ---------- End of the season (on the Games page) ----------
// Once the regular season is over: playoffs, then ending the season and the Hall of Fame.
// "Over" means every scheduled regular-season game has been played. Leagues that don't use the schedule
// creator can't be detected that way, so they get a small "Season over?" link at the bottom instead.
function seasonStatusCard() {
  const s = activeSeason();
  if (!s || viewingPast()) return '';
  const games = db.games.filter(inActiveSeason);
  const regular = games.filter(g => (g.stage || 'regular') === 'regular');
  const usedSchedule = regular.some(g => g.round != null);
  const regularDone = usedSchedule && regular.length && regular.every(g => g.status === 'final');
  const b = db.playoffsReady ? bracketOf(s) : null;
  const admin = canEdit();

  if (b?.champion) {
    const champ = team(b.champion);
    return `<div class="card season-card champion-card">
      <div class="season-card-title">🏆 ${esc(champ.name)} won ${esc(s.name)}!</div>
      <div class="row">
        <a class="btn small" href="#/playoffs">View bracket</a>
        ${admin ? `<a class="btn small" href="#/hof">🏆 Induct into the Hall of Fame</a>
          <button class="small primary" onclick="openNewSeason()">🏁 End season & start the next one</button>` : ''}
      </div></div>`;
  }
  if (b) {
    const left = b.matches.filter(m => !m.bye && !m.winner).length;
    return `<div class="card season-card">
      <div class="season-card-title">🏆 Playoffs are on</div>
      <div class="muted">${left} game${left === 1 ? '' : 's'} left in the bracket.</div>
      <div class="row" style="margin-top:8px"><a class="btn small primary" href="#/playoffs">View bracket</a></div></div>`;
  }
  if (!regularDone || !admin) return '';
  return `<div class="card season-card">
    <div class="season-card-title">🎉 The regular season is complete!</div>
    <div class="muted">All ${regular.length} regular-season games have been played. What’s next?</div>
    <div class="row" style="margin-top:8px">
      ${db.playoffsReady ? '<a class="btn small primary" href="#/playoffs">🏆 Set up playoffs</a>' : ''}
      <button class="small" onclick="openNewSeason()">🏁 End season</button>
      ${db.seasonsReady ? '<a class="btn small" href="#/hof">🏆 Hall of Fame</a>' : ''}
    </div></div>`;
}

// For leagues without a schedule: a quiet way to reach the same things.
function seasonOverLink() {
  const s = activeSeason();
  if (!s || !canEdit() || viewingPast()) return '';
  const regular = db.games.filter(g => inActiveSeason(g) && (g.stage || 'regular') === 'regular');
  if (regular.some(g => g.round != null) || !regular.some(g => g.status === 'final')) return '';   // the card above handles scheduled seasons
  if (db.playoffsReady && bracketOf(s)) return '';
  return `<p class="muted season-over">Season over?
    ${db.playoffsReady ? '<a href="#/playoffs">Set up playoffs</a> ·' : ''}
    <a href="#/games" onclick="openNewSeason(); return false">End ${esc(s.name)}</a> ·
    <a href="#/hof">Hall of Fame</a></p>`;
}

// ---------- Notifications (in the app) ----------
// Kept on this device per account. While the app is open (or installed and in the background), they can
// also show as phone notifications once allowed.
const notesKey = () => `soccer-notes:${session?.user.id}`;
function loadNotes() { try { return JSON.parse(localStorage.getItem(notesKey())) || []; } catch { return []; } }
function saveNotes(n) { try { localStorage.setItem(notesKey(), JSON.stringify(n.slice(0, 50))); } catch {} }

function notify(text, link = '') {
  const notes = loadNotes();
  notes.unshift({ id: uid(), at: Date.now(), text, link, league: league?.name || '', read: false });
  saveNotes(notes);
  updateBell();
  toast(text);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const opts = { body: league?.name || '', icon: 'icon-192.png', tag: text, data: { link } };
    navigator.serviceWorker?.getRegistration().then(r => (r ? r.showNotification(text, opts) : new Notification(text, opts))).catch(() => {});
  }
}

function updateBell() {
  const el = document.getElementById('bell-count');
  if (!el) return;
  const n = session ? loadNotes().filter(x => !x.read).length : 0;
  el.textContent = n > 9 ? '9+' : n || '';
  el.style.display = n ? '' : 'none';
}

function openNotes() {
  const notes = loadNotes();
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  openSheet(`
    <h3>🔔 Notifications</h3>
    ${perm === 'default' ? '<button class="small" style="margin-bottom:10px" onclick="askNotifyPermission()">Turn on phone alerts</button>' : ''}
    ${perm === 'denied' ? '<p class="muted" style="font-size:13px">Phone alerts are blocked for this site in your browser settings.</p>' : ''}
    ${notes.length ? `<div class="notes">${notes.map(n => `
      <a class="note ${n.read ? '' : 'unread'}" href="${n.link || '#/'}" onclick="closeSheet()">
        <span>${esc(n.text)}</span><span class="muted">${esc(n.league)} · ${timeAgo(n.at)}</span></a>`).join('')}</div>`
      : '<p class="muted">Nothing yet. You’ll see claim requests, games going live, final scores and more here.</p>'}
    <div class="actions" style="margin-top:12px">
      ${notes.length ? '<button onclick="clearNotes()">Clear all</button>' : ''}
      <button class="${notes.length ? '' : 'full'}" onclick="closeSheet()">Close</button>
    </div>`);
  saveNotes(notes.map(n => ({ ...n, read: true })));
  updateBell();
}
function clearNotes() { saveNotes([]); updateBell(); closeSheet(); }
async function askNotifyPermission() {
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Phone alerts are on for this device.' : 'Phone alerts stay off.');
  openNotes();
}
function timeAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString();
}

// ---------- Offline copy of league data ----------
// The last loaded league is kept in IndexedDB, so the app can open (read-only until back online, with any
// new plays queued) without signal.
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('soccer-stats', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('leagues');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function saveSnapshot(id, data) {
  try {
    const d = await idb();
    d.transaction('leagues', 'readwrite').objectStore('leagues').put({ data, at: Date.now(), user: session?.user.id }, id);
  } catch {}
}
async function loadSnapshot(id) {
  try {
    const d = await idb();
    return await new Promise(res => {
      const r = d.transaction('leagues').objectStore('leagues').get(id);
      r.onsuccess = () => res(r.result?.user === session?.user.id ? r.result : null); r.onerror = () => res(null);
    });
  } catch { return null; }
}
