// Soccer Stats: the live match tracker (lineups, kickoff and halves, goals, shots, cards, subs, undo).
// Loaded before the main script in index.html; these are plain globals it calls.

const ui = { gameId: null, teamId: null };

// League setting: how many players each team has on the pitch at once.
const onFieldMax = () => db.settings?.onField || 11;

// Where a match is up to, worked out from its plays (so Undo only has to remove the last play):
//   pre → before kickoff;  play → a half is being played;  break → half time;  done → full time.
// on[team] is who's on the pitch (null = no lineup recorded, so the whole roster shows), gk[team] the goalkeeper.
function matchState(g) {
  const tids = [g.homeId, g.awayId];
  const planned = tid => g.lineup?.[tid]?.on?.length ? [...g.lineup[tid].on] : null;
  const s = { phase: 'pre', period: 0, kickoffAt: null, len: halfLen(), on: {}, gk: {}, yellows: {}, sentOff: new Set() };
  for (const tid of tids) { s.on[tid] = planned(tid); s.gk[tid] = g.lineup?.[tid]?.gk || null; }
  for (const e of g.events) {
    const tid = e.teamId;
    switch (e.type) {
      case 'kickoff':
        s.phase = 'play'; s.period = e.detail?.period || s.period + 1; s.kickoffAt = e.t; s.len = e.detail?.len || halfLen();
        for (const t of tids) { s.on[t] = e.played?.[t]?.length ? [...e.played[t]] : null; s.gk[t] = e.detail?.gk?.[t] || null; }
        break;
      case 'half': s.phase = 'break'; break;
      case 'full': s.phase = 'done'; break;
      case 'sub': {
        const list = s.on[tid] || [];
        s.on[tid] = list.filter(id => id !== e.targetId);
        if (e.playerId && !s.on[tid].includes(e.playerId)) s.on[tid].push(e.playerId);
        if (!s.on[tid].length) s.on[tid] = null;
        if (e.targetId && e.targetId === s.gk[tid]) s.gk[tid] = e.playerId || null;
        break;
      }
      case 'red':
        s.sentOff.add(e.playerId);
        if (s.on[tid]) s.on[tid] = s.on[tid].filter(id => id !== e.playerId);
        if (s.gk[tid] === e.playerId) s.gk[tid] = null;
        break;
      case 'yellow': s.yellows[e.playerId] = (s.yellows[e.playerId] || 0) + 1; break;
      case 'gk': s.gk[tid] = e.playerId; break;
    }
  }
  // At half time, the second half's lineup is the planned one (copied when half time was called, then edited).
  if (s.phase === 'break') for (const tid of tids) if (g.lineup?.[tid]) { s.on[tid] = planned(tid); s.gk[tid] = g.lineup[tid].gk || null; }
  return s;
}
const stateNow = () => matchState(game(ui.gameId));
const otherTeam = (g, tid) => (tid === g.homeId ? g.awayId : g.homeId);

// A team's roster split into who's on the pitch and who's on the bench. With no lineup, everyone is "on".
function splitRoster(g, tid, st = matchState(g)) {
  const players = team(tid).players, on = st.on[tid];
  if (!on) return { on: players, bench: [], hasLineup: false };
  return { on: on.map(id => players.find(p => p.id === id)).filter(Boolean), bench: players.filter(p => !on.includes(p.id)), hasLineup: true };
}

// ---------- Play log ----------
const LABEL = {
  kickoff: 'Kickoff', half: 'Half time', full: 'Full time', goal: 'Goal', own_goal: 'Own goal', shot: 'Shot', corner: 'Corner',
  foul: 'Foul', offside: 'Offside', yellow: 'Yellow card', red: 'Red card', sub: 'Sub', gk: 'Goalkeeper', shootout: 'Penalty shootout'
};
const shotText = e => (e.detail?.pen ? (e.detail?.on ? 'penalty saved' : 'penalty missed') : e.detail?.on ? 'saved' : e.detail?.blk ? 'blocked' : 'off target');

// The latest plays, newest first (the tracker and the live box score), or the whole match in order (its timeline).
function playLog(g, limit, emptyText, oldestFirst = false) {
  const periods = periodsOf(g), recent = oldestFirst ? g.events.slice(-limit) : g.events.slice(-limit).reverse();
  if (!recent.length) return `<div class="muted">${emptyText}</div>`;
  const who = id => (id ? esc(pname(id)) : '<span class="muted">unknown</span>');
  const scoreAt = e => { const i = g.events.indexOf(e), s = { ...g, events: g.events.slice(0, i + 1) }; return `${score(s, g.homeId)}–${score(s, g.awayId)}`; };
  const detail = e => {
    switch (e.type) {
      case 'goal': return `${who(e.playerId)}${e.detail?.pen ? ' <span class="muted">(pen)</span>' : ''}${e.assistId ? ` <span class="muted">from ${who(e.assistId)}</span>` : ''} · <b>${scoreAt(e)}</b>`;
      case 'own_goal': return `${who(e.playerId)} <span class="muted">(for ${esc(team(e.teamId)?.name || '')})</span> · <b>${scoreAt(e)}</b>`;
      case 'shot': return `${who(e.playerId)} <span class="muted">${shotText(e)}</span>`;
      case 'sub': return `${e.playerId ? `<span style="color:var(--good)">▲</span> ${who(e.playerId)}` : ''} ${e.targetId ? `<span style="color:var(--bad)">▼</span> ${who(e.targetId)}` : ''}`;
      case 'corner': return esc(team(e.teamId)?.name || '');
      case 'gk': return `🧤 ${who(e.playerId)}`;
      case 'red': return `${who(e.playerId)}${e.detail?.second ? ' <span class="muted">(second yellow)</span>' : ''}`;
      case 'kickoff': return e.detail?.period === 2 ? '2nd half' : '1st half';
      case 'half': case 'full': return `<b>${scoreAt(e)}</b>`;
      case 'shootout': { const sc = e.detail?.score || {}; return `<b>${sc[g.homeId] ?? 0}–${sc[g.awayId] ?? 0}</b>`; }
      default: return e.playerId ? who(e.playerId) : '';
    }
  };
  return `<ul class="log">${recent.map(e => `
    <li><span class="time">${minuteAt(periods, e.t).label || '–'}</span>
      <span>${e.teamId ? `<span class="dot" style="background:${teamBg(team(e.teamId))}"></span>` : ''}
      <span class="tag ${e.type}">${LABEL[e.type] || e.type}</span> ${detail(e)}</span></li>`).join('')}
  </ul>`;
}

// Words for a play, e.g. "Goal Sam from Jordan" (the Undo message).
function describePlay(e) {
  const n = id => (id ? player(id).name : 'someone');
  switch (e.type) {
    case 'goal': return `Goal ${n(e.playerId)}${e.assistId ? ` from ${n(e.assistId)}` : ''}`;
    case 'own_goal': return `Own goal by ${n(e.playerId)}`;
    case 'shot': return `Shot by ${n(e.playerId)} (${shotText(e)})`;
    case 'sub': return `Sub${e.playerId ? ` ${n(e.playerId)} on` : ''}${e.targetId ? ` ${n(e.targetId)} off` : ''}`;
    case 'corner': return `Corner to ${team(e.teamId)?.name || 'a team'}`;
    case 'gk': return `${n(e.playerId)} in goal`;
    case 'kickoff': case 'half': case 'full': case 'shootout': return LABEL[e.type];
    default: return `${LABEL[e.type]} ${n(e.playerId)}`;
  }
}

// ---------- Match clock ----------
function matchClockHtml(g, st) {
  if (g.status !== 'live') return '';
  if (st.phase === 'play') {
    const base = (st.period - 1) * st.len;
    return `<div class="clock">⏱ <b data-match-clock="${st.kickoffAt}" data-base="${base}" data-len="${st.len}"></b>
      · ${st.period === 1 ? '1st' : '2nd'} half</div>`;
  }
  return `<div class="clock">${st.phase === 'break' ? `⏸ Half time · paused at ${st.len}:00` : st.phase === 'done' ? 'Full time' : 'Not kicked off yet'}</div>`;
}
const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function tickClocks() {
  for (const el of document.querySelectorAll('[data-match-clock]')) {
    const ms = Date.now() - +el.dataset.matchClock, base = +el.dataset.base, len = +el.dataset.len;
    el.textContent = ms < len * 60000 ? mmss(ms + base * 60000) : `${base + len}:00 +${mmss(ms - len * 60000)}`;
    el.classList.toggle('cap-hit', ms >= len * 60000);
  }
}
setInterval(tickClocks, 1000);

// ---------- The tracker screen ----------
function renderTracker(g) {
  ui.gameId = g.id;
  const h = team(g.homeId), a = team(g.awayId), st = matchState(g), an = analyze([g]);
  if (ui.teamId !== g.homeId && ui.teamId !== g.awayId) ui.teamId = g.homeId;
  const t = team(ui.teamId), dot = x => `<span class="dot" style="background:${teamBg(x)}"></span>`;
  const statLine = p => {
    const s = statsOf(an, p.id), bits = [s.g && `${s.g}G`, s.a && `${s.a}A`, s.sh && `${s.sh} sh`].filter(Boolean).join(' ');
    return `${Math.round(s.min)}′${bits ? ` · ${bits}` : ''}`;
  };
  const badges = (p, tid) => `${st.gk[tid] === p.id ? '🧤 ' : ''}${st.sentOff.has(p.id) ? '🟥 ' : st.yellows[p.id] ? '🟨 ' : ''}`;
  const btn = (p, tid, onclick, cls = '') => `<button class="player ${cls}" onclick="${onclick}" ${st.sentOff.has(p.id) && cls === 'bench-btn' ? 'disabled' : ''}>
    <span class="num">#${esc(p.number)}</span>${badges(p, tid)}${esc(p.name)}<span class="line">${statLine(p)}</span></button>`;
  const lineupBar = `<div class="row lineup-bar">
    <span class="muted">${[h, a].map(x => { const r = splitRoster(g, x.id, st);
      return `${esc(x.name)}: <b>${r.hasLineup ? `${r.on.length}/${onFieldMax()}` : 'no lineup'}</b>${st.gk[x.id] ? ` · 🧤 ${esc(player(st.gk[x.id]).name)}` : ''}`; }).join('<br>')}</span>
    <button class="small" style="flex:0 0 auto" onclick="openLineup()">👥 Lineup</button></div>`;

  let panel = '';
  if (st.phase === 'pre' || st.phase === 'break') {
    const second = st.phase === 'break';
    panel = `<div class="card phase">
      <div class="phase-head">${second ? `⏸ Half time · ${score(g, h.id)}–${score(g, a.id)}` : 'Before kickoff'}</div>
      <div class="muted">${second ? 'The match clock and minutes played are paused. Make any half-time changes in the lineup, then start the second half to resume.'
        : `Pick each team’s starting ${onFieldMax()} and goalkeeper. Lineups are used for minutes played, appearances and goalkeeper stats.`}</div>
      ${lineupBar}
      <button class="primary" style="width:100%;margin-top:6px" onclick="kickOff()">⚽ ${second ? 'Start the 2nd half' : 'Kick off'}</button>
    </div>`;
  } else if (st.phase === 'play') {
    const r = splitRoster(g, t.id, st), style = `--team:${t.color};--team2:${t.color2 || t.color}`;
    panel = `
      <div class="tabs">${[h, a].map(x => `<button class="team-tab ${x.id === t.id ? 'on' : ''}" style="--c:${x.color}"
        onclick="ui.teamId = '${x.id}'; route()">${esc(x.name)}</button>`).join('')}</div>
      ${lineupBar}
      <div class="muted" style="margin-bottom:8px">Tap a player to record a goal, shot, card, foul or sub.</div>
      <div class="players" style="${style}">${r.on.map(p => btn(p, t.id, `playerSheet('${p.id}')`)).join('')}</div>
      <div class="play-actions">
        <button class="goal" onclick="goalSheet()">⚽ Goal…</button>
        <button onclick="shotSheet()">🎯 Shot…</button>
        <button onclick="recordTeamPlay('corner')">⛳ Corner</button>
        <button onclick="penaltySheet()">Penalty…</button>
      </div>
      ${r.bench.length ? `<div class="muted" style="margin:14px 0 8px">Bench · tap to bring someone on</div>
        <div class="players bench" style="${style}">${r.bench.map(p => btn(p, t.id, `subOnSheet('${p.id}')`, 'bench-btn')).join('')}</div>` : ''}`;
  } else {
    const tied = score(g, h.id) === score(g, a.id);
    panel = `<div class="card phase">
      <div class="phase-head">Full time · ${score(g, h.id)}–${score(g, a.id)}</div>
      ${isPlayoff(g) && tied && !shootoutOf(g) ? '<div class="muted">A playoff match needs a winner. Record the penalty shootout.</div>' : ''}
      ${shootoutOf(g) ? `<div class="muted">Penalties: ${shootoutText(g)}</div>` : ''}
      <div class="row" style="margin-top:10px">
        ${tied ? '<button onclick="shootoutSheet()">🥅 Penalty shootout…</button>' : ''}
        <button class="primary" onclick="finishGame()">Finish match</button></div>
    </div>`;
  }

  app.innerHTML = `
    ${isPractice(g) ? practiceLabel(g) : ''}
    <div class="card scoreboard">
      <div class="team"><span class="dot" style="background:${teamBg(h)}"></span>${esc(h.name)}</div>
      <div>
        <div class="nums">${score(g, h.id)}–${score(g, a.id)}</div>
        ${matchClockHtml(g, st)}
      </div>
      <div class="team"><span class="dot" style="background:${teamBg(a)}"></span>${esc(a.name)}</div>
    </div>
    ${st.phase === 'play' ? `<div class="row clock-controls">
      ${st.period === 1 ? '<button onclick="halfTime()">⏸ Half time</button>' : ''}
      <button onclick="fullTime()">🏁 Full time</button></div>` : ''}
    ${panel}
    <h2>Recent plays</h2>
    <div class="card">${playLog(g, 8, 'Plays will show up here.')}</div>
    <div class="row">
      <button onclick="undo()" ${g.events.length ? '' : 'disabled'}>↶ Undo</button>
      <a class="btn" href="#/box/${g.id}">Box score</a>
      ${st.phase === 'break' ? '<button onclick="fullTime()">🏁 End at half time</button>' : ''}
    </div>
    ${isPractice(g) && st.phase !== 'play' ? '<div class="row" style="margin-top:10px"><button onclick="editSides()">⇄ Sides</button></div>' : ''}`;
  tickClocks();
}

// ---------- Recording plays ----------
// Plays recorded together (a second yellow and its red, or a lineup change's subs) share a group id, so one Undo removes them all.
function play(type, fields = {}) {
  const g = game(ui.gameId), e = { id: uid(), t: Date.now(), type, ...fields };
  g.events.push(e); saveEvent(g, e);
  return e;
}

// A yes/no question in the app's own pop-up. (Browser confirm() boxes can be blocked or silently cancelled,
// for example in an installed app or an embedded browser, which would leave the button doing nothing.)
let sheetYes = null;
function askSheet(title, text, yesLabel, onYes) {
  sheetYes = onYes;
  openSheet(`
    <h3>${title}</h3>
    ${text ? `<p class="muted" style="margin-top:0">${text}</p>` : ''}
    <div class="actions">
      <button onclick="closeSheet()">Cancel</button>
      <button class="goal" onclick="const yes = sheetYes; sheetYes = null; closeSheet(); yes()">${yesLabel}</button>
    </div>`);
}

function kickOff(sure = false) {
  const g = game(ui.gameId), st = matchState(g), tids = [g.homeId, g.awayId];
  if (!sure && st.period === 0 && !tids.some(tid => st.on[tid])) return askSheet('Kick off without lineups?',
    'You can still record goals, shots and cards, but not minutes played, subs or goalkeeper stats.', '⚽ Kick off', () => kickOff(true));
  const played = {}, gk = {};
  for (const tid of tids) { if (st.on[tid]) played[tid] = st.on[tid]; if (st.gk[tid]) gk[tid] = st.gk[tid]; }
  play('kickoff', { played, detail: { period: st.period + 1, len: halfLen(), gk } });
  route();
}

function halfTime(sure = false) {
  const g = game(ui.gameId);
  if (!sure) return askSheet(`Half time at ${score(g, g.homeId)}–${score(g, g.awayId)}?`, '', 'Half time', () => halfTime(true));
  play('half');
  // The second half starts with whoever finished the first (changes can be made in the lineup).
  const st = matchState({ ...g, lineup: null });
  g.lineup = Object.fromEntries([g.homeId, g.awayId].map(tid => [tid, { on: st.on[tid] || [], gk: st.gk[tid] }]));
  saveGame(g); route();
}

function fullTime(sure = false) {
  const g = game(ui.gameId);
  if (!sure) return askSheet(`Full time at ${score(g, g.homeId)}–${score(g, g.awayId)}?`, 'This ends the match.', 'Full time', () => fullTime(true));
  play('full');
  if (isPlayoff(g) && score(g, g.homeId) === score(g, g.awayId)) return shootoutSheet();   // a playoff needs a winner
  finishGame();
}

function finishGame(sure = false) {
  const g = game(ui.gameId);
  if (!sure && isPlayoff(g) && score(g, g.homeId) === score(g, g.awayId) && !shootoutOf(g))
    return askSheet('Finish without a shootout?', 'This playoff match is level, so nobody can advance until a shootout is recorded.', 'Finish anyway', () => finishGame(true));
  if (!g.events.some(e => e.type === 'full')) play('full');
  g.status = 'final'; saveGame(g);
  if (isPlayoff(g)) advanceBracket();   // the winner moves on
  location.hash = `#/box/${ui.gameId}`;
}

// ---------- Player actions ----------
function playerSheet(pid) {
  const g = game(ui.gameId), st = matchState(g), tid = ui.teamId, p = player(pid);
  const isGk = st.gk[tid] === pid;
  openSheet(`
    <h3>#${esc(p.number)} ${esc(p.name)} <span class="muted">· ${esc(team(tid).name)}${isGk ? ' · 🧤' : ''}</span></h3>
    <div class="actions">
      <button class="goal full" onclick="assistSheet('${pid}')">⚽ Goal</button>
      <button onclick="recordShot('${pid}', { on: true })">🎯 Shot saved</button>
      <button onclick="recordShot('${pid}', {})">↗ Shot off target</button>
      <button onclick="recordShot('${pid}', { blk: true })">🧱 Shot blocked</button>
      <button onclick="foulSheet('${pid}')">Foul</button>
      <button onclick="recordPlayerPlay('offside', '${pid}')">🚩 Offside</button>
      <button onclick="recordCard('yellow', '${pid}')">🟨 ${st.yellows[pid] ? 'Second yellow (off)' : 'Yellow card'}</button>
      <button class="to" onclick="recordCard('red', '${pid}')">🟥 Red card</button>
      ${splitRoster(g, tid, st).hasLineup ? `<button onclick="subOffSheet('${pid}')">🔁 Sub off</button>` : ''}
      ${isGk ? '' : `<button onclick="makeKeeper('${pid}')">🧤 Put in goal</button>`}
      <button class="full" onclick="recordOwnGoal('${pid}')">Own goal (into their own net)</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

// Buttons for picking a player: who's on the pitch (or the whole roster, with no lineup).
function pickerButtons(tid, excludeId, onclick) {
  const { on } = splitRoster(game(ui.gameId), tid);
  return on.filter(p => p.id !== excludeId).map(p => `<button onclick="${onclick(p.id)}">#${esc(p.number)} ${esc(p.name)}</button>`).join('');
}

function goalSheet() {
  openSheet(`
    <h3>⚽ Goal for ${esc(team(ui.teamId).name)}! Who scored?</h3>
    <div class="actions">
      ${pickerButtons(ui.teamId, null, id => `assistSheet('${id}')`)}
      <button class="full" onclick="assistSheet(null)">Not sure who</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function assistSheet(pid) {
  openSheet(`
    <h3>⚽ Goal${pid ? ` by ${esc(player(pid).name)}` : ''}. Who assisted?</h3>
    <div class="actions">
      <button class="full goal" onclick="recordGoal(${pid ? `'${pid}'` : 'null'}, null)">No assist</button>
      ${pickerButtons(ui.teamId, pid, id => `recordGoal(${pid ? `'${pid}'` : 'null'}, '${id}')`)}
      <button class="full" onclick="recordGoal(${pid ? `'${pid}'` : 'null'}, null, true)">It was a penalty</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function recordGoal(pid, assistId, pen = false) {
  play('goal', { teamId: ui.teamId, playerId: pid, assistId, ...(pen ? { detail: { pen: true } } : {}) });
  route();
}

function recordOwnGoal(pid) {
  const g = game(ui.gameId);
  play('own_goal', { teamId: otherTeam(g, ui.teamId), playerId: pid });   // the goal counts for the other team
  route();
}

function shotSheet() {
  openSheet(`
    <h3>🎯 Shot by ${esc(team(ui.teamId).name)}. Who took it?</h3>
    <div class="actions">
      ${pickerButtons(ui.teamId, null, id => `shotResultSheet('${id}')`)}
      <button class="full" onclick="shotResultSheet(null)">Not sure who</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function shotResultSheet(pid) {
  const arg = pid ? `'${pid}'` : 'null';
  openSheet(`
    <h3>Shot${pid ? ` by ${esc(player(pid).name)}` : ''}</h3>
    <div class="actions">
      <button class="goal full" onclick="assistSheet(${arg})">⚽ Goal</button>
      <button onclick="recordShot(${arg}, { on: true })">🎯 Saved</button>
      <button onclick="recordShot(${arg}, {})">↗ Off target</button>
      <button class="full" onclick="recordShot(${arg}, { blk: true })">🧱 Blocked</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function recordShot(pid, detail) {
  play('shot', { teamId: ui.teamId, playerId: pid, ...(Object.keys(detail).length ? { detail } : {}) });
  route();
}

function penaltySheet() {
  openSheet(`
    <h3>Penalty to ${esc(team(ui.teamId).name)}. Who’s taking it?</h3>
    <div class="actions">
      ${pickerButtons(ui.teamId, null, id => `penaltyResultSheet('${id}')`)}
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function penaltyResultSheet(pid) {
  openSheet(`
    <h3>Penalty by ${esc(player(pid).name)}</h3>
    <div class="actions">
      <button class="goal full" onclick="recordGoal('${pid}', null, true)">⚽ Scored</button>
      <button onclick="recordShot('${pid}', { on: true, pen: true })">🧤 Saved</button>
      <button onclick="recordShot('${pid}', { pen: true })">↗ Missed</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function recordPlayerPlay(type, pid) { play(type, { teamId: ui.teamId, playerId: pid }); route(); }
function recordTeamPlay(type) { play(type, { teamId: ui.teamId }); toast(`${LABEL[type]} to ${team(ui.teamId).name}`); route(); }

function foulSheet(pid) {
  openSheet(`
    <h3>Foul by ${esc(player(pid).name)}</h3>
    <div class="actions">
      <button class="full" onclick="recordPlayerPlay('foul', '${pid}')">Just a foul</button>
      <button onclick="recordFoulCard('${pid}', 'yellow')">🟨 + Yellow card</button>
      <button class="to" onclick="recordFoulCard('${pid}', 'red')">🟥 + Red card</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function recordFoulCard(pid, card) {
  const grp = uid();
  play('foul', { teamId: ui.teamId, playerId: pid, detail: { grp } });
  recordCard(card, pid, grp);
}

// A second yellow is a red too (both recorded, so undo takes both away).
function recordCard(card, pid, grp = uid()) {
  const st = stateNow();
  if (card === 'yellow') {
    play('yellow', { teamId: ui.teamId, playerId: pid, detail: { grp } });
    if (st.yellows[pid]) { play('red', { teamId: ui.teamId, playerId: pid, detail: { grp, second: true } }); toast(`🟥 Second yellow: ${player(pid).name} is sent off.`); }
  } else {
    play('red', { teamId: ui.teamId, playerId: pid, detail: { grp } });
    toast(`🟥 ${player(pid).name} is sent off.`);
  }
  route();
}

function makeKeeper(pid) { play('gk', { teamId: ui.teamId, playerId: pid }); route(); }

// ---------- Substitutions ----------
function subOffSheet(pid) {
  const g = game(ui.gameId), st = matchState(g), bench = splitRoster(g, ui.teamId, st).bench.filter(p => !st.sentOff.has(p.id));
  openSheet(`
    <h3>🔁 ${esc(player(pid).name)} comes off. Who comes on?</h3>
    <div class="actions">
      ${bench.map(p => `<button onclick="recordSub('${p.id}', '${pid}')">#${esc(p.number)} ${esc(p.name)}</button>`).join('')}
      <button class="full" onclick="recordSub(null, '${pid}')">Nobody (play a player down)</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function subOnSheet(pid) {
  const g = game(ui.gameId), st = matchState(g), on = splitRoster(g, ui.teamId, st).on;
  openSheet(`
    <h3>🔁 ${esc(player(pid).name)} comes on. Who comes off?</h3>
    <div class="actions">
      ${on.map(p => `<button onclick="recordSub('${pid}', '${p.id}')">#${esc(p.number)} ${esc(p.name)}${st.gk[ui.teamId] === p.id ? ' 🧤' : ''}</button>`).join('')}
      ${on.length < onFieldMax() ? `<button class="full" onclick="recordSub('${pid}', null)">Nobody (they’re a player short)</button>` : ''}
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function recordSub(onId, offId) {
  play('sub', { teamId: ui.teamId, playerId: onId, targetId: offId });
  route();
}

// ---------- Lineup ----------
// A draft of both teams' lineups while the pop-up is open: { [teamId]: { on: [ids], gk: id } }.
let lineupDraft = null, lineupTeam = null;

function openLineup() {
  const g = game(ui.gameId), st = matchState(g);
  lineupDraft = Object.fromEntries([g.homeId, g.awayId].map(tid => [tid, { on: [...(st.on[tid] || [])], gk: st.gk[tid] }]));
  // Before kickoff with no lineup yet: start with the players who said they're coming (up to the limit).
  if (db.availReady && st.phase === 'pre') for (const tid of [g.homeId, g.awayId]) {
    if (!lineupDraft[tid].on.length) lineupDraft[tid].on = team(tid).players.filter(p => availOf(g.id, p.id) === 'yes').map(p => p.id).slice(0, onFieldMax());
  }
  lineupTeam = ui.teamId === g.awayId ? g.awayId : g.homeId;
  renderLineup();
}

function renderLineup(msg = '') {
  const g = game(ui.gameId), st = matchState(g), max = onFieldMax(), d = lineupDraft[lineupTeam], t = team(lineupTeam);
  const live = st.phase === 'play';
  openSheet(`
    <h3>Lineup</h3>
    <div class="tabs">${[g.homeId, g.awayId].map(tid => {
      const x = team(tid), on = tid === lineupTeam;
      return `<button class="team-tab ${on ? 'on' : ''}" style="--c:${x.color}"
        onclick="lineupTeam = '${tid}'; renderLineup()">${esc(x.name)} (${lineupDraft[tid].on.length})</button>`;
    }).join('')}</div>
    <div class="muted">${live ? 'Changes are recorded as substitutions at this minute.' : 'Tap players to put them in or take them out.'}
      <b style="color:var(--text)">${d.on.length} / ${max}</b> on the pitch.</div>
    <div class="msg error">${esc(msg)}</div>
    <div class="actions lineup">${t.players.map(p => {
      const av = db.availReady && st.phase === 'pre' ? availOf(g.id, p.id) : null, off = st.sentOff.has(p.id);
      return `<button class="${d.on.includes(p.id) ? 'in' : ''} ${av === 'no' ? 'out' : ''}" ${off ? 'disabled' : ''} onclick="toggleLineup('${p.id}')">
        ${d.on.includes(p.id) ? '✓ ' : ''}${d.gk === p.id ? '🧤 ' : ''}#${esc(p.number)} ${esc(p.name)}
        ${off ? '<span class="streak">Sent off</span>' : av ? `<span class="streak">${av === 'yes' ? 'Said they’re in' : av === 'maybe' ? 'Maybe coming' : 'Said they’re out'}</span>` : ''}</button>`;
    }).join('')}
    </div>
    ${d.on.length ? `<label class="field" style="margin-top:12px">🧤 Goalkeeper
      <select onchange="lineupDraft[lineupTeam].gk = this.value || null; renderLineup()">
        <option value="">No goalkeeper</option>
        ${d.on.map(id => `<option value="${id}" ${d.gk === id ? 'selected' : ''}>${esc(pname(id))}</option>`).join('')}
      </select></label>` : ''}
    <div class="actions" style="margin-top:12px">
      <button onclick="lineupDraft[lineupTeam] = { on: [], gk: null }; renderLineup()">Clear ${esc(t.name)}</button>
      <button class="goal" onclick="saveLineup()">Done</button>
      <button class="full" onclick="closeSheet()">Cancel</button>
    </div>`);
}

function toggleLineup(pid) {
  const d = lineupDraft[lineupTeam], i = d.on.indexOf(pid);
  if (i >= 0) { d.on.splice(i, 1); if (d.gk === pid) d.gk = null; }
  else if (d.on.length >= onFieldMax()) return renderLineup(`Only ${onFieldMax()} players can be on the pitch. Take someone out first.`);
  else { d.on.push(pid); if (!d.gk && d.on.length === 1) d.gk = pid; }
  renderLineup();
}

function saveLineup() {
  const g = game(ui.gameId), st = matchState(g);
  if (st.phase !== 'play') {   // before kickoff or at half time: just the plan
    g.lineup = Object.fromEntries([g.homeId, g.awayId].map(tid => [tid, { on: lineupDraft[tid].on, gk: lineupDraft[tid].on.includes(lineupDraft[tid].gk) ? lineupDraft[tid].gk : null }]));
    saveGame(g); return route();
  }
  // During play: the differences become substitutions (and a goalkeeper change), recorded together.
  const grp = uid();
  for (const tid of [g.homeId, g.awayId]) {
    const now = st.on[tid] || [], next = lineupDraft[tid].on;
    const ons = next.filter(id => !now.includes(id)), offs = now.filter(id => !next.includes(id));
    for (let i = 0; i < Math.max(ons.length, offs.length); i++)
      play('sub', { teamId: tid, playerId: ons[i] || null, targetId: offs[i] || null, detail: { grp } });
    const after = matchState(g), gk = next.includes(lineupDraft[tid].gk) ? lineupDraft[tid].gk : null;
    if (gk && after.gk[tid] !== gk) play('gk', { teamId: tid, playerId: gk, detail: { grp } });
  }
  route();
}

// ---------- Penalty shootouts (playoff matches level at full time) ----------
const shootoutOf = g => [...g.events].reverse().find(e => e.type === 'shootout')?.detail?.score || null;
const shootoutText = g => { const s = shootoutOf(g); return s ? `${team(g.homeId).name} ${s[g.homeId] ?? 0}–${s[g.awayId] ?? 0} ${team(g.awayId).name}` : ''; };
let shootDraft = null;

function shootoutSheet() {
  const g = game(ui.gameId), s = shootoutOf(g);
  shootDraft = shootDraft?.gameId === g.id ? shootDraft : { gameId: g.id, [g.homeId]: s?.[g.homeId] ?? 0, [g.awayId]: s?.[g.awayId] ?? 0 };
  const row = tid => `<div class="row" style="justify-content:space-between;margin:10px 0">
    <span><span class="dot" style="background:${teamBg(team(tid))}"></span><b>${esc(team(tid).name)}</b></span>
    <span class="stepper" style="margin:0;flex:0 0 auto">
      <button onclick="shootDraft['${tid}'] = Math.max(0, shootDraft['${tid}'] - 1); shootoutSheet()">−</button>
      <b>${shootDraft[tid]}</b>
      <button onclick="shootDraft['${tid}'] = Math.min(30, shootDraft['${tid}'] + 1); shootoutSheet()">+</button></span></div>`;
  openSheet(`
    <h3>🥅 Penalty shootout</h3>
    <p class="muted" style="margin-top:0">Penalties scored by each team. The goals don’t count toward the score or player stats.</p>
    ${row(g.homeId)}${row(g.awayId)}
    <div class="msg error" id="shoot-msg"></div>
    <div class="actions" style="margin-top:12px">
      <button onclick="closeSheet(); route()">Cancel</button>
      <button class="goal" onclick="saveShootout()">Save and finish</button>
    </div>`);
}

function saveShootout() {
  const g = game(ui.gameId);
  if (shootDraft[g.homeId] === shootDraft[g.awayId]) return (document.getElementById('shoot-msg').textContent = 'A shootout needs a winner.');
  play('shootout', { detail: { score: { [g.homeId]: shootDraft[g.homeId], [g.awayId]: shootDraft[g.awayId] } } });
  shootDraft = null; closeSheet();
  finishGame();
}

// ---------- Undo ----------
// Undo the last play (or the last group of plays recorded together). No confirmation: it's a quick fix
// that's easy to redo, and the message says what was removed.
function undo() {
  const g = game(ui.gameId), last = g.events.at(-1);
  if (!last) return;
  const grp = last.detail?.grp, batch = [];
  for (let i = g.events.length - 1; i >= 0; i--) {
    if (batch.length && !(grp && g.events[i].detail?.grp === grp)) break;
    batch.push(g.events[i]);
  }
  g.events.length -= batch.length;
  persist({ del: 'events', vals: batch.map(e => e.id) });
  toast(`Undone: ${batch.reverse().map(describePlay).join(' + ')}`);
  route();
}
