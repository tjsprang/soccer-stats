// Soccer Stats: public links, player photos and bios, availability, and CSV export.
// Loaded after league.js and before the main script in index.html; these are plain globals it calls.

// ---------- Public, read-only links ----------
// "#/view/<league id>" opens a league read-only, no account needed (if its admins made it public).
const publicLink = id => `${location.origin}${location.pathname}#/view/${id}`;
const isPublicView = () => mode === 'public';

function enterPublic(id) {
  if (league?.id !== id) { unsubscribeLeague(); db = emptyDb(); dataLeagueId = null; loadError = null; viewSeasonId = null; }
  league = { id, name: league?.id === id ? league.name : 'League' };
  mode = 'public';
  try { sessionStorage.setItem('soccer-public', JSON.stringify(league)); } catch {}
  location.hash = '#/games';
}

function leavePublic() {
  try { sessionStorage.removeItem('soccer-public'); } catch {}
  try { league = JSON.parse(localStorage.getItem('soccer-league')); mode = localStorage.getItem('soccer-mode'); } catch { league = null; mode = null; }
  unsubscribeLeague(); db = emptyDb(); dataLeagueId = null;
  location.hash = '#/';
  route();
}

function publicBanner() {
  if (!isPublicView()) return '';
  return `<div class="card public-banner">👀 You’re viewing <b>${esc(league.name)}</b> publicly. Scores update live.
    ${session ? '<button class="small" onclick="leavePublic()">Back to my leagues</button>'
      : '<button class="small primary" onclick="leavePublic()">Sign in</button>'}</div>`;
}

function publicLinkCard() {
  if (!db.publicReady) return '';
  const link = publicLink(league.id);
  return `<h2>Public link</h2>
    <div class="card">
      <label class="option" style="padding:0;cursor:pointer">
        <input type="checkbox" ${db.isPublic ? 'checked' : ''} onchange="setPublic(this.checked)">
        <span><b>Anyone with the link can view</b><div class="muted">Scores, live games, standings, leaders, teams and player pages, with no account needed.
          Nothing can be changed from the link, and emails, claims and availability stay private.</div></span>
      </label>
      ${db.isPublic ? `<div class="row" style="margin-top:12px">
        <input readonly value="${esc(link)}" onfocus="this.select()">
        <button class="small" onclick="copyLink()">Copy</button>
        ${navigator.share ? '<button class="small" onclick="shareLink()">Share</button>' : ''}
      </div>` : ''}
    </div>`;
}

async function setPublic(on) {
  const { data, error } = await sb.rpc('set_league_public', { p_league_id: league.id, p_public: on });
  if (error) return toast(dbErrorText(error));
  db.isPublic = data.is_public;
  toast(on ? 'Public link is on. Share it with anyone.' : 'Public link is off. The link no longer works.');
  route();
}
async function copyLink() {
  try { await navigator.clipboard.writeText(publicLink(league.id)); toast('Link copied.'); }
  catch { toast('Couldn’t copy. Select the link and copy it yourself.'); }
}
function shareLink() { navigator.share({ title: league.name, text: `${league.name} scores and stats`, url: publicLink(league.id) }).catch(() => {}); }

// ---------- Player photos and bios ----------
// One profile per person (their all-time identity), so it follows them from season to season.
const profileOf = personId => db.profiles?.[personId] || null;
function photoUrl(personId) {
  const p = profileOf(personId);
  return p?.photo_path ? `${SUPABASE_URL}/storage/v1/object/public/player-photos/${p.photo_path}?v=${Date.parse(p.updated_at) || 0}` : null;
}
// A round photo, or the player's initials on their team colour.
function avatar(p, size = 36) {
  const url = p?.personId && photoUrl(p.personId);
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`;
  if (url) return `<img class="avatar" src="${esc(url)}" alt="" style="${style}" loading="lazy">`;
  const initials = (p?.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="avatar" style="${style};background:${teamBg(p?.team || teamOf(p?.id))}">${esc(initials)}</span>`;
}
const canEditPerson = p => db.profilesReady && !isPublicView() && (isAdmin() || (p.userId && p.userId === me()));

let photoDraft = null;   // { blob, preview } of a newly picked photo, before saving
function editProfile(pid) {
  const p = allPlayers().find(x => x.id === pid), prof = profileOf(p.personId) || {};
  photoDraft = null;
  openSheet(`
    <h3>Edit ${esc(p.name)}’s profile</h3>
    <div class="row" style="align-items:center;gap:14px">
      <span id="photo-preview">${avatar(p, 72)}</span>
      <span style="display:flex;flex-direction:column;gap:6px;flex:1">
        <label class="btn small" style="text-align:center">📷 Choose photo<input type="file" accept="image/*" hidden onchange="pickPhoto(this.files[0])"></label>
        ${prof.photo_path ? `<button class="small" onclick="removePhoto('${pid}')">Remove photo</button>` : ''}
      </span>
    </div>
    <label class="field" style="margin-top:12px">Position
      <input id="prof-pos" list="positions" maxlength="30" value="${esc(prof.position || '')}" placeholder="e.g. Goalkeeper, Defender, Midfielder, Forward">
      <datalist id="positions"><option>Goalkeeper</option><option>Defender</option><option>Midfielder</option><option>Forward</option><option>Winger</option><option>Striker</option></datalist></label>
    <label class="field" style="margin-top:10px">Bio
      <textarea id="prof-bio" maxlength="400" rows="4" placeholder="A few words about this player">${esc(prof.bio || '')}</textarea></label>
    <div class="msg error" id="prof-msg"></div>
    <div class="actions" style="margin-top:10px">
      <button onclick="closeSheet()">Cancel</button>
      <button class="goal" id="prof-save" onclick="saveProfile('${pid}')">Save</button>
    </div>`);
}

// Shrink the photo on the phone (a square, 400px) before uploading: fast on a field connection.
async function pickPhoto(file) {
  if (!file) return;
  try {
    const img = await createImageBitmap(file);
    const side = Math.min(img.width, img.height), c = document.createElement('canvas');
    c.width = c.height = 400;
    c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 400, 400);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    photoDraft = { blob, preview: URL.createObjectURL(blob) };
    document.getElementById('photo-preview').innerHTML = `<img class="avatar" src="${photoDraft.preview}" style="width:72px;height:72px">`;
  } catch { document.getElementById('prof-msg').textContent = 'That picture couldn’t be read. Try a different one.'; }
}

async function saveProfile(pid) {
  const p = allPlayers().find(x => x.id === pid), btn = document.getElementById('prof-save'), msg = document.getElementById('prof-msg');
  const prof = profileOf(p.personId) || {};
  const row = { league_id: league.id, person_id: p.personId, bio: document.getElementById('prof-bio').value.trim() || null,
    position: document.getElementById('prof-pos').value.trim() || null, photo_path: prof.photo_path || null, updated_at: new Date().toISOString() };
  if (photoDraft) {
    // Photos need a connection (they're too big to keep in the offline queue).
    btn.disabled = true; btn.textContent = 'Uploading…';
    const path = `${league.id}/${p.personId}.jpg`;
    const { error } = await sb.storage.from('player-photos').upload(path, photoDraft.blob, { upsert: true, contentType: 'image/jpeg' });
    if (error) { btn.disabled = false; btn.textContent = 'Save'; msg.textContent = `Photo upload failed: ${error.message}`; return; }
    row.photo_path = path;
  }
  db.profiles[p.personId] = row;
  persist({ upsert: 'person_profiles', rows: [row] });
  closeSheet(); route();
}

async function removePhoto(pid) {
  const p = allPlayers().find(x => x.id === pid), prof = profileOf(p.personId);
  if (!prof?.photo_path || !confirm('Remove this photo?')) return;
  const { error } = await sb.storage.from('player-photos').remove([prof.photo_path]);
  if (error) return toast(`Couldn’t remove the photo: ${error.message}`);
  const row = { ...prof, photo_path: null, updated_at: new Date().toISOString() };
  db.profiles[p.personId] = row;
  persist({ upsert: 'person_profiles', rows: [row] });
  closeSheet(); route();
}

// ---------- Availability for upcoming games ----------
const availOf = (gid, pid) => db.avail?.find(a => a.game_id === gid && a.player_id === pid)?.status || null;
const canSetAvail = p => db.availReady && !isPublicView()
  && (isAdmin() || (p.userId && p.userId === me()) || (typeof managesTeam === 'function' && managesTeam(teamOf(p.id)?.id)));
const AVAIL = { yes: '✓ In', maybe: '? Maybe', no: '✗ Out' };

function setAvailability(gid, pid, status) {
  const current = availOf(gid, pid);
  db.avail = db.avail.filter(a => !(a.game_id === gid && a.player_id === pid));
  if (current === status) persist({ del: 'availability', col: 'game_id', vals: [gid], match: { player_id: pid } });   // tap again to clear
  else {
    const row = { league_id: league.id, game_id: gid, player_id: pid, status, updated_at: new Date().toISOString() };
    db.avail.push(row);
    persist({ upsert: 'availability', rows: [row] });
  }
  if (sheet.classList.contains('open') && document.getElementById('avail-sheet')) availabilitySheet(gid); else route();
}

function availCounts(g, tid) {
  const c = { yes: 0, maybe: 0, no: 0 };
  for (const p of team(tid).players) { const s = availOf(g.id, p.id); if (s) c[s]++; }
  return c;
}

// Under an upcoming game: your own In / Maybe / Out, and (for admins) the counts per team.
function availabilityLine(g) {
  if (!db.availReady || g.status !== 'scheduled' || isPublicView()) return '';
  const mine = [g.homeId, g.awayId].flatMap(tid => team(tid).players).find(p => p.userId && p.userId === me());
  const counts = tid => { const c = availCounts(g, tid); return `${esc(team(tid).name)}: <b>${c.yes}</b> in${c.maybe ? ` · ${c.maybe} maybe` : ''}${c.no ? ` · ${c.no} out` : ''}`; };
  return `<div class="avail-line">
    ${mine ? `<span class="avail-buttons"><span class="muted">You:</span>${Object.entries(AVAIL).map(([k, label]) =>
      `<button class="small ${availOf(g.id, mine.id) === k ? `on-${k}` : ''}" onclick="setAvailability('${g.id}', '${mine.id}', '${k}')">${label}</button>`).join('')}</span>` : ''}
    ${isAdmin() || managesTeam(g.homeId) || managesTeam(g.awayId) ? `<button class="small" onclick="availabilitySheet('${g.id}')">👥 ${counts(g.homeId)} · ${counts(g.awayId)}</button>` : ''}
  </div>`;
}

function availabilitySheet(gid) {
  const g = game(gid);
  openSheet(`<div id="avail-sheet">
    <h3>Who’s coming?</h3>
    <p class="muted" style="margin-top:0">${esc(team(g.homeId).name)} vs ${esc(team(g.awayId).name)} · ${g.when ? fmtWhen(g.when) : ''}. Tap to set; tap again to clear.</p>
    ${[g.homeId, g.awayId].map(tid => `<h4><span class="dot" style="background:${teamBg(team(tid))}"></span>${esc(team(tid).name)}</h4>
      ${team(tid).players.map(p => `<div class="avail-row"><span>#${esc(p.number)} ${esc(p.name)}</span>
        <span class="avail-buttons">${Object.entries(AVAIL).map(([k, label]) =>
          `<button class="small ${availOf(gid, p.id) === k ? `on-${k}` : ''}" ${canSetAvail(p) ? `onclick="setAvailability('${gid}', '${p.id}', '${k}')"` : 'disabled'}>${label}</button>`).join('')}</span></div>`).join('')}`).join('')}
    <button style="width:100%;margin-top:12px" onclick="closeSheet()">Done</button></div>`);
}

// ---------- CSV export ----------
function csv(rows) {
  const cell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map(r => r.map(cell).join(',')).join('\r\n');
}
function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));   // BOM so Excel reads accents
  a.download = filename.replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-');
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const fileStem = what => `${league.name}-${what}-${new Date().toISOString().slice(0, 10)}`;

// Every stat column, once each, in category order.
const ALL_STAT_COLS = Object.values(STAT_CATS).flatMap(c => c.cols).filter((c, i, all) => all.findIndex(x => x[0] === c[0]) === i);
const statCell = (c, s) => (c[3] === fmtPct ? (s[c[0]] == null ? '' : Math.round(s[c[0]] * 1000) / 10)
  : c[3] ? (s[c[0]] == null ? '' : Math.round(s[c[0]] * 100) / 100) : s[c[0]]);

function exportPlayerStats() {
  const allTime = leaderScope === 'all' && db.seasonsReady;
  let rows;
  if (allTime) {
    const people = allTimeStats(), seen = new Set();
    rows = allPlayers().filter(p => !seen.has(p.personId) && seen.add(p.personId))
      .map(p => [personEntries(p.personId).at(-1).name, personEntries(p.personId).at(-1).team.name, ...ALL_STAT_COLS.map(c => statCell(c, people[p.personId] || finishPlayer(ZERO())))]);
  } else {
    const playoffs = leaderPhase === 'playoffs';
    const an = analyze(seasonGames().filter(playoffs ? countsInPlayoffs : countsInSeason));
    rows = seasonTeams().flatMap(t => t.players.map(p => [p.name, t.name, ...ALL_STAT_COLS.map(c => statCell(c, statsOf(an, p.id)))]));
  }
  download(`${fileStem(allTime ? 'all-time-stats' : `${viewSeason()?.name || 'season'}-${leaderPhase === 'playoffs' ? 'playoff-' : ''}stats`)}.csv`,
    csv([['Player', 'Team', ...ALL_STAT_COLS.map(c => (c[3] === fmtPct ? `${c[2]} (%)` : c[2]))], ...rows]));
}

function exportStandings() {
  const table = standings(seasonTeams(), seasonGames());
  download(`${fileStem(`${viewSeason()?.name || 'season'}-standings`)}.csv`, csv([
    ['Rank', 'Team', 'Played', 'Won', 'Drawn', 'Lost', 'Goals for', 'Goals against', 'Goal difference', 'Points', 'Streak'],
    ...table.map((r, i) => [i + 1, r.team.name, r.gp, r.w, r.d, r.l, r.gf, r.ga, r.diff, r.pts, r.streak])]));
}

function exportGames(allSeasons = false) {
  const games = (allSeasons ? db.games : seasonGames()).filter(g => g.status !== 'scheduled').sort((a, b) => a.created - b.created);
  download(`${fileStem(allSeasons ? 'all-matches' : 'matches')}.csv`, csv([
    ['Season', 'Date', 'Stage', 'Home', 'Home score', 'Away', 'Away score', 'Penalties', 'Status'],
    ...games.map(g => [seasonName(g.seasonId), new Date(g.created).toLocaleDateString(), g.stage === 'playoff' ? 'Playoff' : 'Regular',
      team(g.homeId)?.name, score(g, g.homeId), team(g.awayId)?.name, score(g, g.awayId),
      shootoutOf(g) ? `${shootoutOf(g)[g.homeId] ?? 0}-${shootoutOf(g)[g.awayId] ?? 0}` : '', g.status])]));
}

function exportPlays(gid) {
  const g = game(gid), h = team(g.homeId), a = team(g.awayId), periods = periodsOf(g);
  const n = id => (id ? player(id).name : '');
  const note = e => (e.type === 'shot' ? shotText(e) : e.type === 'goal' && e.detail?.pen ? 'penalty'
    : e.type === 'red' && e.detail?.second ? 'second yellow' : e.type === 'kickoff' ? `half ${e.detail?.period || 1}` : '');
  const rows = []; let hs = 0, as = 0;
  for (const e of g.events) {
    if (isGoal(e) && e.teamId === g.homeId) hs++;
    if (isGoal(e) && e.teamId === g.awayId) as++;
    rows.push([minuteAt(periods, e.t).label, LABEL[e.type] || e.type, team(e.teamId)?.name || '', n(e.playerId),
      e.type === 'sub' ? n(e.targetId) : n(e.assistId), note(e), `${hs}-${as}`]);
  }
  download(`${fileStem(`${h.name}-vs-${a.name}-timeline`)}.csv`,
    csv([['Minute', 'Play', 'Team', 'Player (on, for subs)', 'Assist / off', 'Note', `Score (${h.name}-${a.name})`], ...rows]));
}

function exportBoxScore(gid) {
  const g = game(gid), an = analyze([g]);
  const rows = [g.homeId, g.awayId].flatMap(tid => team(tid).players.map(p => [team(tid).name, p.number, p.name, ...ALL_STAT_COLS.map(c => statCell(c, statsOf(an, p.id)))]));
  download(`${fileStem(`${team(g.homeId).name}-vs-${team(g.awayId).name}-box-score`)}.csv`,
    csv([['Team', '#', 'Player', ...ALL_STAT_COLS.map(c => (c[3] === fmtPct ? `${c[2]} (%)` : c[2]))], ...rows]));
}
