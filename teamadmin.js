// Soccer Stats: team admins (captains who manage one team in a league) and team registration requests.
// Loaded before the main script in index.html; these are plain globals it calls.

// ---------- Who can do what ----------
const isTeamMode = () => mode === 'team';
const myTeamIds = () => (db.teamAdmins || []).filter(a => a.user_id === me()).map(a => a.team_id);
// League admins manage every team; team admins (in Team Admin mode) manage their own, in the current season.
const managesTeam = tid => !viewingPast() && (isAdmin() || (isTeamMode() && myTeamIds().includes(tid)));
// Tracking (starting, recording, reopening) a game: only games in the current season.
// A practice scrimmage (practice.js) belongs to one team, so that team's admins track it.
const canTrack = g => !!g && !viewingPast() && inActiveSeason(g)
  && (canEdit() || (isTeamMode() && (isPractice(g) ? managesTeam(g.practiceTeam) : managesTeam(g.homeId) || managesTeam(g.awayId))));
const myTeamsThisSeason = () => seasonTeams().filter(t => myTeamIds().includes(t.id));
const teamAdminsOf = tid => (db.teamAdmins || []).filter(a => a.team_id === tid);

// ---------- Team Admin home (from the main menu) ----------
async function renderTeamAdminHome() {
  app.innerHTML = '<h1>Team Admin</h1><p class="muted">Loading your teams…</p>';
  const [mine, reqs] = await Promise.all([
    sb.from('team_admins').select('team_id, league_id, teams(id, name, color, season_id)').eq('user_id', me()),
    sb.from('team_requests').select('*').eq('user_id', me()).order('created_at', { ascending: false }).limit(20)
  ]);
  if (location.hash !== '#/teamadmin') return;
  if (mine.error) { app.innerHTML = `<h1>Team Admin</h1><p class="msg error">${esc(dbErrorText(mine.error))}</p>`; return; }
  // Only teams in each league's current season.
  const leagueIds = [...new Set(mine.data.map(r => r.league_id))];
  const [leagues, seasons] = leagueIds.length ? await Promise.all([
    sb.from('leagues').select('id, name, border_colors, sport').in('id', leagueIds),
    sb.from('seasons').select('id, league_id').eq('status', 'active').in('league_id', leagueIds)
  ]) : [{ data: [] }, { data: [] }];
  const activeIds = new Set((seasons.data || []).map(s => s.id));
  const teams = mine.data.filter(r => r.teams && activeIds.has(r.teams.season_id))
    .map(r => ({ ...r.teams, league: (leagues.data || []).find(l => l.id === r.league_id) })).filter(t => t.league?.sport === 'soccer');
  teams.forEach(t => (leagueCache[t.league.id] = t.league));
  const pending = (reqs.data || []).filter(r => r.status === 'pending');
  const recent = (reqs.data || []).filter(r => r.status !== 'pending').slice(0, 3);
  app.innerHTML = `
    <h1>Team Admin</h1>
    <p class="muted">Run your own team in a league: its roster, its games and stats, and its players’ claims and availability.</p>
    ${teams.length ? `<h2>Your teams</h2>${teams.map(t => `
      <a class="card game-link" href="#/games" style="${borderStyle(t.league.border_colors)}" onclick="enterLeague(leagueCache['${t.league.id}'], 'team'); return false">
        <span><b><span class="dot" style="background:${teamBg(t)}"></span>${esc(t.name)}</b><br><span class="muted">${esc(t.league.name)}</span></span>
        <span class="muted">Open →</span></a>`).join('')}` : ''}
    ${pending.length ? `<h2>Waiting for approval</h2>${pending.map(r => `<div class="card game-link">
      <span>${r.kind === 'new' ? `Add <b>${esc(r.name)}</b> (${r.roster.length} player${r.roster.length === 1 ? '' : 's'})` : 'Manage an existing team'}
        <div class="muted" style="font-size:13px">Sent ${timeAgo(Date.parse(r.created_at))}</div></span>
      <button class="small" onclick="cancelTeamRequest('${r.id}')">Cancel</button></div>`).join('')}` : ''}
    ${recent.map(r => `<p class="muted" style="font-size:13px">${r.status === 'approved' ? '✅' : '✗'} Your request to ${r.kind === 'new' ? `add ${esc(r.name)}` : 'manage a team'} was ${r.status}.</p>`).join('')}
    <h2>${teams.length ? 'Add another team' : 'Get started'}</h2>
    <p class="muted">Find your league, then register your team (with its roster) or ask to manage a team that’s already there. A league admin approves it.</p>
    <input id="q" placeholder="Search leagues by name" oninput="searchLeagues('team')" autocomplete="off">
    <div id="results" style="margin-top:12px"></div>`;
  searchLeagues('team');
}

async function cancelTeamRequest(id) {
  if (!confirm('Cancel this request?')) return;
  const { error } = await sb.rpc('cancel_team_request', { p_id: id });
  if (error) return toast(dbErrorText(error));
  renderTeamAdminHome();
}

// ---------- Registering a team, or asking to manage one ----------
let teamForm = null;   // { leagueId, name, color, rosterText }
async function renderTeamRequest(leagueId) {
  // Look the league up for its name and minimum roster size (search results don't include the minimum).
  if (leagueCache[leagueId]?.min_roster === undefined) {
    const { data } = await sb.from('leagues').select('*').eq('id', leagueId).maybeSingle();
    if (data) leagueCache[leagueId] = data;
  }
  const l = leagueCache[leagueId];
  teamMin = l?.min_roster || 0;
  app.innerHTML = `<h1>${esc(l?.name || 'League')}</h1><p class="muted">Loading teams…</p>`;
  const { data: season } = await sb.from('seasons').select('id, name').eq('league_id', leagueId).eq('status', 'active').maybeSingle();
  const { data: teams } = season ? await sb.from('teams').select('id, name, color').eq('season_id', season.id).order('name') : { data: [] };
  if (!location.hash.startsWith('#/teamadmin/')) return;
  if (teamForm?.leagueId !== leagueId) teamForm = { leagueId, name: '', color: '#3b82f6', color2: null, rosterText: '' };
  const roster = parseRoster(teamForm.rosterText);
  app.innerHTML = `
    <div class="row"><h1>${esc(l?.name || 'League')}</h1><a class="btn small" href="#/teamadmin">← Back</a></div>
    <p class="muted">${season ? esc(season.name) : ''}</p>

    <h2>Register a new team</h2>
    <div class="card">
      <div class="row">
        <input id="tr-name" placeholder="Team name" maxlength="60" value="${esc(teamForm.name)}" oninput="teamForm.name = this.value">
        <input type="color" value="${esc(teamForm.color)}" oninput="teamForm.color = this.value; previewRequestColor()" aria-label="Main colour">
        ${teamForm.color2 ? `<input type="color" value="${esc(teamForm.color2)}" oninput="teamForm.color2 = this.value; previewRequestColor()" aria-label="Second colour">` : ''}
      </div>
      <label class="color2-toggle">
        <input type="checkbox" ${teamForm.color2 ? 'checked' : ''} onchange="teamForm.color2 = this.checked ? (teamForm.color2 || '#ffffff') : null; renderTeamRequest('${leagueId}')">
        Two colours <span class="dot big-dot" id="request-color-preview" style="background:${teamBg(teamForm)}"></span></label>
      ${teamMin ? `<p class="muted" style="margin:10px 0 0">This league needs at least <b>${teamMin} players</b> on a team’s roster.</p>` : ''}
      <label class="field" style="margin-top:12px">Roster: one player per line, with their number first if you like
        <textarea id="tr-roster" rows="8" placeholder="12 Jordan Smith&#10;7 Sam Lee&#10;Casey Brown" oninput="teamForm.rosterText = this.value; updateRosterCount()">${esc(teamForm.rosterText)}</textarea></label>
      <div class="muted" id="roster-count" style="font-size:13px;margin-top:4px">${rosterCountText(roster.length)}</div>
      <div class="msg error" id="tr-msg"></div>
      <button class="primary" style="width:100%;margin-top:10px" onclick="submitNewTeam()">Send to the league admins</button>
    </div>

    ${teams?.length ? `<h2>Or manage a team that’s already there</h2>
      ${teams.map(t => `<div class="card game-link"><span><span class="dot" style="background:${teamBg(t)}"></span><b>${esc(t.name)}</b></span>
        <button class="small" onclick="requestManage('${leagueId}', '${t.id}', this)">Ask to manage</button></div>`).join('')}` : ''}`;
}

// "12 Jordan Smith", "#7 Sam", "Casey Brown", "Riley, 23" → { number, name }
function parseRoster(text) {
  return (text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    let m = line.match(/^#?(\d{1,3})[\s.,:\-)]+(.+)$/);
    if (m) return { number: m[1], name: m[2].trim() };
    m = line.match(/^(.+?)[\s,]+#?(\d{1,3})$/);
    if (m) return { number: m[2], name: m[1].trim() };
    return { number: '', name: line };
  }).filter(p => p.name).map(p => ({ ...p, name: p.name.slice(0, 60) }));
}
function previewRequestColor() {
  const el = document.getElementById('request-color-preview');
  if (el) el.style.background = teamBg(teamForm);
}

let teamMin = 0;   // the league's minimum roster size (0 = none)
const rosterCountText = n => `${n} player${n === 1 ? '' : 's'}${teamMin
  ? (n >= teamMin ? ' ✓' : ` · <b style="color:var(--bad)">${teamMin - n} more needed</b>`) : ''}`;
function updateRosterCount() {
  document.getElementById('roster-count').innerHTML = rosterCountText(parseRoster(teamForm.rosterText).length);
}

async function submitNewTeam() {
  const msg = document.getElementById('tr-msg');
  const roster = parseRoster(teamForm.rosterText);
  if (!teamForm.name.trim()) return (msg.textContent = 'Give your team a name.');
  if (roster.length < teamMin) return (msg.textContent = `This league needs at least ${teamMin} players on a roster. Add ${teamMin - roster.length} more.`);
  const args = { p_league_id: teamForm.leagueId, p_kind: 'new', p_team_id: null, p_name: teamForm.name.trim(), p_color: teamForm.color, p_roster: roster };
  let { error } = await sb.rpc('submit_team_request', { ...args, p_color2: teamForm.color2 || null });
  // Before supabase/014 the function has no second-colour option: send it without (the team admin can add it later).
  if (error && /schema cache|does not exist|function/i.test(error.message) && !error.message.includes('already')) ({ error } = await sb.rpc('submit_team_request', args));
  if (error) return (msg.textContent = dbErrorText(error));
  toast(`Sent! A league admin will review ${teamForm.name.trim()}. You’ll see it under Your teams once it’s approved.`);
  teamForm = null; location.hash = '#/teamadmin';
}

async function requestManage(leagueId, teamId, btn) {
  btn.disabled = true;
  const { error } = await sb.rpc('submit_team_request', { p_league_id: leagueId, p_kind: 'manage', p_team_id: teamId,
    p_name: null, p_color: null, p_roster: [] });
  if (error) { btn.disabled = false; return toast(dbErrorText(error)); }
  toast('Request sent to the league admins.');
  location.hash = '#/teamadmin';
}

// ---------- League admins: reviewing team requests ----------
function teamRequestsCard() {
  if (!isAdmin() || !db.teamAdminsReady) return '';
  const pending = (db.teamRequests || []).filter(r => r.status === 'pending');
  if (!pending.length) return '';
  return `<div class="card" style="border:2px solid var(--accent)">
    <b>🔔 Team request${pending.length === 1 ? '' : 's'} (${pending.length})</b>
    ${pending.map(r => `<div class="claim-row">
      <span>${r.kind === 'new'
        ? `<b>${esc(r.user_email || 'Someone')}</b> wants to add <b><span class="dot" style="background:${teamBg(r)}"></span>${esc(r.name)}</b>
           <details><summary class="muted">${r.roster.length} player${r.roster.length === 1 ? '' : 's'}</summary>
           <div class="muted" style="font-size:13px">${r.roster.map(p => `${p.number ? `#${esc(p.number)} ` : ''}${esc(p.name)}`).join(' · ') || 'No players yet'}</div></details>`
        : `<b>${esc(r.user_email || 'Someone')}</b> wants to manage <b>${esc(team(r.team_id)?.name || 'a team')}</b>`}</span>
      <span class="row">
        <button class="small" onclick="decideTeamRequest('${r.id}', false, this)">Deny</button>
        <button class="small primary" onclick="decideTeamRequest('${r.id}', true, this)">Approve</button>
      </span></div>`).join('')}
  </div>`;
}

async function decideTeamRequest(id, approve, btn) {
  btn.disabled = true;
  const { data, error } = await sb.rpc('decide_team_request', { p_id: id, p_approve: approve });
  if (error) { btn.disabled = false; toast(dbErrorText(error)); return; }
  toast(approve ? (data.kind === 'new' ? `${data.name} was added with its roster.` : 'Approved. They can now manage that team.') : 'Request denied.');
  dataLeagueId = null; route();   // reload the league (the new team, roster and team admins)
}

// League admins: who manages each team (shown on the Teams page), with a way to remove them.
function teamAdminsLine(t) {
  if (!db.teamAdminsReady) return '';
  const admins = teamAdminsOf(t.id);
  if (!admins.length) return '';
  return `<div class="muted team-admins">Team admin${admins.length === 1 ? '' : 's'}: ${admins.map(a => `${esc(a.user_email || 'someone')}${isAdmin()
    ? ` <button class="link-btn" onclick="removeTeamAdmin('${t.id}', '${a.user_id}')" aria-label="Remove">✕</button>` : ''}`).join(', ')}</div>`;
}

function removeTeamAdmin(tid, uid_) {
  const a = teamAdminsOf(tid).find(x => x.user_id === uid_);
  if (!confirm(`Stop ${a?.user_email || 'this person'} from managing ${team(tid).name}?`)) return;
  db.teamAdmins = db.teamAdmins.filter(x => !(x.team_id === tid && x.user_id === uid_));
  persist({ del: 'team_admins', col: 'team_id', vals: [tid], match: { user_id: uid_ } });
  route();
}
