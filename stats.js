// Soccer Stats: the stats engine and the charts.
// Loaded before the main script in index.html; everything here is a plain global the page calls.

// ---------- Match clock ----------
// A match is recorded as halves: a 'kickoff' play starts each one (with its length in minutes), 'half' ends the
// first and 'full' ends the match. Plays get their match minute from the half they happened in, e.g. 23' or 45+2'.
const halfLen = () => Math.round((db.settings?.timeCap || 90) / 2);   // the league's match length, split in two

function periodsOf(g) {
  const out = [];
  for (const e of g.events) {
    if (e.type === 'kickoff') out.push({ p: e.detail?.period || out.length + 1, start: e.t, end: null, len: e.detail?.len || halfLen() });
    else if ((e.type === 'half' || e.type === 'full') && out.length && out.at(-1).end == null) out.at(-1).end = e.t;
  }
  return out;
}

// { label: "45+2'", n: 45.5 } for a moment in the match (n is for sorting and charts).
function minuteAt(periods, t) {
  let cur = null;
  for (const p of periods) if (p.start <= t) cur = p;
  if (!cur) return { label: '', n: 0 };
  const base = (cur.p - 1) * cur.len;
  if (cur.end != null && t > cur.end) return { label: cur.p === 1 ? 'HT' : 'FT', n: base + cur.len };
  const m = Math.floor((t - cur.start) / 60000) + 1;
  return m > cur.len ? { label: `${base + cur.len}+${m - cur.len}'`, n: base + cur.len + 0.5 } : { label: `${base + m}'`, n: base + m };
}

// ---------- Stats engine ----------
const ZERO = () => ({
  gp: 0, gs: 0, sb: 0, min: 0,                              // appearances, starts, off the bench, minutes
  g: 0, a: 0, sh: 0, sot: 0, pg: 0, pmiss: 0, og: 0,        // goals, assists, shots, on target, penalty goals, penalties missed, own goals
  fc: 0, off: 0, yc: 0, rc: 0,                              // fouls, offsides, yellow and red cards
  gkGp: 0, gkMin: 0, sv: 0, gc: 0, cs: 0                    // in goal: games, minutes, saves, goals conceded, clean sheets
});
const TEAM_ZERO = () => ({ gf: 0, g: 0, ga: 0, sh: 0, sot: 0, corners: 0, fouls: 0, offsides: 0, yc: 0, rc: 0, cs: 0, pens: 0, pensScored: 0 });
const isGoal = e => e.type === 'goal' || e.type === 'own_goal';

// Everything that happened in one match, minute by minute.
function analyzeGame(g) {
  const other = t => (t === g.homeId ? g.awayId : g.homeId);
  const players = {}, P = id => players[id] || (players[id] = ZERO());
  const tids = [g.homeId, g.awayId];
  const teams = Object.fromEntries(tids.map(t => [t, TEAM_ZERO()]));
  const periods = periodsOf(g);
  const score = Object.fromEntries(tids.map(t => [t, 0]));
  const goals = [], flows = [];
  // Who's on the pitch and in goal as the match goes, and since when (for minutes).
  const on = Object.fromEntries(tids.map(t => [t, new Set()])), gk = {}, since = {}, gkSince = {};
  const appeared = Object.fromEntries(tids.map(t => [t, new Set()])), started = Object.fromEntries(tids.map(t => [t, new Set()]));
  const lineupKnown = Object.fromEntries(tids.map(t => [t, false]));
  const gkMs = Object.fromEntries(tids.map(t => [t, {}]));   // team → keeper → ms in goal
  let running = null;   // the current half, while it's being played
  // A match left running for hours (someone forgot Full time) only counts its half plus 30 minutes.
  const clamp = t => (running ? Math.min(t, running.start + (running.len + 30) * 60000) : t);
  const leave = (pid, t) => { if (since[pid] != null) { P(pid).min += Math.max(0, clamp(t) - since[pid]) / 60000; since[pid] = null; } };
  const gkOut = (tid, t) => {
    const k = gk[tid];
    if (k && gkSince[tid] != null) gkMs[tid][k] = (gkMs[tid][k] || 0) + Math.max(0, clamp(t) - gkSince[tid]);
    gkSince[tid] = null;
  };
  const gkIn = (tid, pid, t) => { gk[tid] = pid || null; gkSince[tid] = running && pid ? t : null; if (pid) appeared[tid].add(pid); };
  const stopClock = t => { for (const tid of tids) { for (const pid of on[tid]) leave(pid, t); gkOut(tid, t); } running = null; };

  for (const e of g.events) {
    const tid = e.teamId, opp = tid && other(tid);
    switch (e.type) {
      case 'kickoff': {
        if (running) stopClock(e.t);
        running = periods.find(p => p.start === e.t) || { start: e.t, len: halfLen(), p: 1 };
        for (const t of tids) {
          const ids = e.played?.[t] || [];
          on[t] = new Set(ids);
          if (ids.length) lineupKnown[t] = true;
          for (const pid of ids) { since[pid] = e.t; appeared[t].add(pid); if (running.p === 1) started[t].add(pid); }
          gkIn(t, e.detail?.gk?.[t], e.t);
        }
        break;
      }
      case 'half': case 'full': if (running) stopClock(e.t); break;
      case 'sub':
        if (e.targetId) { if (running) leave(e.targetId, e.t); on[tid].delete(e.targetId); }
        if (e.playerId) {
          on[tid].add(e.playerId); appeared[tid].add(e.playerId); lineupKnown[tid] = true;
          if (running) since[e.playerId] = e.t;
          if (!started[tid].has(e.playerId)) P(e.playerId).sb++;
        }
        // The keeper coming off: whoever replaces them goes in goal.
        if (e.targetId && e.targetId === gk[tid]) { gkOut(tid, e.t); gkIn(tid, e.playerId, e.t); }
        break;
      case 'red':
        P(e.playerId).rc++; teams[tid].rc++;
        if (running) leave(e.playerId, e.t);
        on[tid].delete(e.playerId);
        if (gk[tid] === e.playerId) { gkOut(tid, e.t); gk[tid] = null; }
        break;
      case 'gk': gkOut(tid, e.t); gkIn(tid, e.playerId, e.t); break;
      case 'yellow': P(e.playerId).yc++; teams[tid].yc++; break;
      case 'foul': if (e.playerId) P(e.playerId).fc++; teams[tid].fouls++; break;
      case 'offside': if (e.playerId) P(e.playerId).off++; teams[tid].offsides++; break;
      case 'corner': teams[tid].corners++; break;
      case 'shot': {
        teams[tid].sh++;
        if (e.playerId) { P(e.playerId).sh++; if (e.detail?.on) P(e.playerId).sot++; }
        if (e.detail?.on) { teams[tid].sot++; if (gk[opp]) P(gk[opp]).sv++; }
        if (e.detail?.pen) { teams[tid].pens++; if (e.playerId) P(e.playerId).pmiss++; }
        break;
      }
      case 'goal': case 'own_goal': {
        const own = e.type === 'own_goal';
        score[tid]++; teams[tid].gf++; teams[opp].ga++;
        if (own) { if (e.playerId) P(e.playerId).og++; }
        else {
          teams[tid].g++; teams[tid].sh++; teams[tid].sot++;   // g: goals by their own players (gf also counts own goals)
          if (e.playerId) { const s = P(e.playerId); s.g++; s.sh++; s.sot++; if (e.detail?.pen) s.pg++; }
          if (e.assistId) { P(e.assistId).a++; flows.push({ a: e.assistId, g: e.playerId }); }
          if (e.detail?.pen) { teams[tid].pens++; teams[tid].pensScored++; }
        }
        if (gk[opp]) P(gk[opp]).gc++;
        goals.push({ t: e.t, min: minuteAt(periods, e.t), team: tid, type: e.type, scorerId: e.playerId || null,
          assistId: e.assistId || null, pen: !!e.detail?.pen, score: [score[g.homeId], score[g.awayId]] });
        break;
      }
    }
    // Anyone who did something on the pitch played (an own goal is by the other team's player).
    const ptid = e.type === 'own_goal' ? opp : tid;
    if (ptid && appeared[ptid] && e.type !== 'sub' && e.type !== 'gk') for (const pid of [e.playerId, e.assistId]) if (pid) appeared[ptid].add(pid);
  }
  if (running) stopClock(g.status === 'final' ? (g.events.at(-1)?.t ?? Date.now()) : Date.now());   // live: minutes so far
  // Keepers: games and minutes in goal; a clean sheet goes to the keeper who played most of the match in goal.
  for (const tid of tids) {
    for (const [pid, ms] of Object.entries(gkMs[tid])) { P(pid).gkMin += ms / 60000; P(pid).gkGp++; }
    const main = Object.entries(gkMs[tid]).sort((x, y) => y[1] - x[1])[0]?.[0];
    if (g.status === 'final' && periods.length && teams[tid].ga === 0) { teams[tid].cs++; if (main) P(main).cs++; }
  }
  return { g, players, teams, periods, goals, flows, score, appeared, started, lineupKnown };
}

// Add up many matches. Scheduled ones are skipped.
function analyze(games) {
  const out = { players: {}, teams: {}, flows: [], games: [] };
  const P = id => out.players[id] || (out.players[id] = ZERO());
  for (const g of games) {
    if (g.status === 'scheduled') continue;
    const r = analyzeGame(g);
    out.games.push(r);
    for (const [id, s] of Object.entries(r.players)) { const t = P(id); for (const k in s) t[k] += s[k]; }
    for (const [tid, s] of Object.entries(r.teams)) {
      const t = out.teams[tid] || (out.teams[tid] = { ...TEAM_ZERO(), w: 0, d: 0, l: 0, gp: 0 });
      for (const k in s) t[k] += s[k];
      t.gp++;
      if (g.status === 'final') {
        const us = r.score[tid], them = r.score[tid === g.homeId ? g.awayId : g.homeId];
        if (us > them) t.w++; else if (us < them) t.l++; else t.d++;
      }
    }
    // Appearances: who was on the pitch. A team with no lineup recorded counts its whole roster (like a paper scoresheet).
    for (const tid of [g.homeId, g.awayId]) {
      const ids = new Set(r.appeared[tid]);
      if (!r.lineupKnown[tid]) for (const p of team(tid)?.players || []) ids.add(p.id);
      for (const id of ids) { P(id).gp++; if (r.started[tid].has(id)) P(id).gs++; }
    }
    out.flows.push(...r.flows);
  }
  for (const s of Object.values(out.players)) finishPlayer(s);
  return out;
}

// Derived numbers (null = can't be calculated yet, shown as *).
function finishPlayer(s) {
  s.ga = s.g + s.a;
  s.acc = s.sh ? s.sot / s.sh : null;
  s.conv = s.sh ? s.g / s.sh : null;
  s.svp = s.sv + s.gc ? s.sv / (s.sv + s.gc) : null;
  s.gaa = s.gkMin >= 1 ? (s.gc * 90) / s.gkMin : null;
  s.minPG = s.gp && s.min ? s.min / s.gp : null;
  const per90 = v => (s.min >= 1 ? (v * 90) / s.min : null);
  s.g90 = per90(s.g); s.a90 = per90(s.a); s.ga90 = per90(s.ga); s.sh90 = per90(s.sh);
  s.minPerGA = s.ga && s.min ? s.min / s.ga : null;
  return s;
}
const statsOf = (a, id) => a.players[id] || finishPlayer(ZERO());

// ---------- Stat columns ----------
const fmtPct = v => (v == null ? '*' : `${Math.round(v * 100)}%`);
const fmtDec = v => (v == null ? '*' : v.toFixed(2));
const fmtInt = v => (v == null ? '*' : Math.round(v));
const STAT_CATS = {
  summary: { label: 'Summary', cols: [
    ['gp', 'Apps', 'Appearances'], ['min', 'Min', 'Minutes played', fmtInt], ['g', 'G', 'Goals'], ['a', 'A', 'Assists'],
    ['ga', 'G+A', 'Goals plus assists'], ['sh', 'Sh', 'Shots'], ['sot', 'SoT', 'Shots on target'], ['yc', 'YC', 'Yellow cards'], ['rc', 'RC', 'Red cards']] },
  attack: { label: 'Attacking', cols: [
    ['g', 'Goals', 'Goals'], ['a', 'Ast', 'Assists'], ['ga', 'G+A', 'Goals plus assists'], ['sh', 'Shots', 'Shots, including goals'],
    ['sot', 'On tgt', 'Shots on target, including goals'], ['acc', 'Acc %', 'Shot accuracy: on target ÷ shots', fmtPct],
    ['conv', 'Conv %', 'Conversion: goals ÷ shots', fmtPct], ['pg', 'Pen', 'Penalty goals'], ['pmiss', 'Pen ✗', 'Penalties missed or saved']] },
  discipline: { label: 'Discipline', cols: [
    ['fc', 'Fouls', 'Fouls committed'], ['yc', 'YC', 'Yellow cards'], ['rc', 'RC', 'Red cards'], ['off', 'Offside', 'Times caught offside'],
    ['og', 'OG', 'Own goals']] },
  keeping: { label: 'Goalkeeping', cols: [
    ['gkGp', 'GP', 'Matches in goal'], ['gkMin', 'Min', 'Minutes in goal', fmtInt], ['sv', 'Saves', 'Saves'],
    ['gc', 'GA', 'Goals conceded while in goal'], ['svp', 'Save %', 'Saves ÷ shots on target faced', fmtPct],
    ['cs', 'CS', 'Clean sheets'], ['gaa', 'GAA', 'Goals conceded per 90 minutes in goal', fmtDec]] },
  time: { label: 'Playing time', cols: [
    ['gp', 'Apps', 'Appearances'], ['gs', 'Starts', 'Started the match'], ['sb', 'Sub', 'Came on as a substitute'],
    ['min', 'Min', 'Minutes played', fmtInt], ['minPG', 'Min/app', 'Minutes per appearance', fmtInt]] },
  per90: { label: 'Per 90', cols: [
    ['g90', 'G', 'Goals per 90 minutes', fmtDec], ['a90', 'A', 'Assists per 90 minutes', fmtDec],
    ['ga90', 'G+A', 'Goals plus assists per 90 minutes', fmtDec], ['sh90', 'Sh', 'Shots per 90 minutes', fmtDec],
    ['minPerGA', 'Min/G+A', 'Minutes per goal or assist', fmtInt]] }
};
let statCat = 'summary';

function statCatTabs(onchange) {
  return `<div class="cat-tabs" role="tablist">${Object.entries(STAT_CATS).map(([k, c]) =>
    `<button role="tab" aria-selected="${k === statCat}" class="${k === statCat ? 'on' : ''}"
      onclick="statCat = '${k}'; ${onchange}">${c.label}</button>`).join('')}</div>`;
}

// Columns for statTable(): the name column plus the current category's stats.
function statCols(nameCol) {
  return [nameCol, ...STAT_CATS[statCat].cols.map(([k, h, title, f]) => ({ k, h, title, f: f ? r => f(r[k]) : null }))];
}

// ---------- Charts ----------
// Hand-drawn SVG, sized to the screen so text stays readable. Colours come from the --series-* tokens.
// The page's content width minus its own padding (2 × 16px) and the card's padding and border (2 × 15px).
const chartWidth = () => Math.max(240, Math.min(660, (document.getElementById('app')?.clientWidth || 360) - 62));
const niceStep = max => (max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : 20);
const niceMax = v => { const s = niceStep(Math.max(v, 1)); return Math.max(s, Math.ceil(Math.max(v, 1) / s) * s); };
const attr = s => esc(s).replace(/\n/g, '&#10;');
const matchLength = r => (r.periods.length ? Math.max(...r.periods.map(p => p.p * p.len)) : halfLen() * 2);

// A column with a 4px rounded top and a square base.
function colPath(x, y, w, h) {
  const r = Math.min(4, h, w / 2);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function legend(items) {
  return `<div class="legend">${items.map(([cls, text]) =>
    `<span><i class="swatch ${cls}"></i>${esc(text)}</span>`).join('')}</div>`;
}

function tableTwin(head, rows) {
  return `<details class="table-twin"><summary>Show as table</summary><div class="table-wrap"><table>
    <thead><tr>${head.map((h, i) => `<th class="${i ? '' : 'l'}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((v, i) => `<td class="${i ? '' : 'l'}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div></details>`;
}

// A goal in words, e.g. "Sam (pen)" or "Own goal (Riley)".
const goalText = gl => (gl.type === 'own_goal' ? `Own goal${gl.scorerId ? ` (${player(gl.scorerId).name})` : ''}`
  : `${gl.scorerId ? player(gl.scorerId).name : 'Goal'}${gl.pen ? ' (pen)' : ''}`);

// The score through the match: a step line per team, rising at each goal's minute.
function scoreChart(r) {
  const g = r.g, goals = r.goals;
  if (!goals.length) return '';
  const h = team(g.homeId), a = team(g.awayId);
  const W = chartWidth(), H = 200, pad = { l: 26, r: 30, t: 14, b: 30 };
  const maxX = Math.max(matchLength(r), Math.ceil(goals.at(-1).min.n)), maxY = niceMax(Math.max(...goals.at(-1).score));
  const x = m => pad.l + (W - pad.l - pad.r) * (m / maxX);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);
  const step = niceStep(maxY);
  const series = [[h, 0, 'series-1'], [a, 1, 'series-2']];
  const end = g.status === 'final' ? maxX : Math.min(maxX, Math.max(goals.at(-1).min.n, minuteAt(r.periods, Date.now()).n));
  const lineOf = idx => {
    let v = 0;
    const pts = [[0, 0]];
    for (const gl of goals) if (gl.score[idx] !== v) { pts.push([gl.min.n, v], [gl.min.n, gl.score[idx]]); v = gl.score[idx]; }
    pts.push([end, v]);
    return pts.map(([m, s]) => `${x(m).toFixed(1)},${y(s).toFixed(1)}`).join(' ');
  };
  const last = goals.at(-1).score, endY = series.map(([, idx]) => y(last[idx]));
  const labelEnds = Math.abs(endY[0] - endY[1]) >= 14;
  const ticks = [...new Set([0, ...r.periods.map(p => p.p * p.len)])];
  const tip = gl => `${gl.min.label} ${team(gl.team).name}: ${goalText(gl)}${gl.assistId ? `, assisted by ${player(gl.assistId).name}` : ''}\n${h.name} ${gl.score[0]} – ${gl.score[1]} ${a.name}`;
  return `<div class="card chart">
    <div class="chart-title">Score by minute</div>
    ${legend([['series-1', `${h.name} ${last[0]}`], ['series-2', `${a.name} ${last[1]}`]])}
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score by minute: ${attr(h.name)} ${last[0]}, ${attr(a.name)} ${last[1]}">
      ${Array.from({ length: maxY / step + 1 }, (_, i) => i * step).map(v => `
        <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      ${ticks.map(m => `<text class="tick" x="${x(m)}" y="${H - pad.b + 16}" text-anchor="middle">${m}'</text>`).join('')}
      ${r.periods.length > 1 ? `<line class="axis" x1="${x(r.periods[0].len)}" x2="${x(r.periods[0].len)}" y1="${pad.t}" y2="${H - pad.b}"/>
        <text class="tick" x="${x(r.periods[0].len) + 4}" y="${pad.t + 10}">HT</text>` : ''}
      ${series.map(([, idx, cls]) => `<polyline class="line ${cls}" points="${lineOf(idx)}"/>`).join('')}
      ${goals.map(gl => { const idx = gl.team === g.homeId ? 0 : 1;
        return `<circle class="dot ${series[idx][2]}" cx="${x(gl.min.n)}" cy="${y(gl.score[idx])}" r="4"/>
          <circle class="hit" tabindex="0" cx="${x(gl.min.n)}" cy="${y(gl.score[idx])}" r="12" data-tip="${attr(tip(gl))}"/>`; }).join('')}
      ${labelEnds ? series.map(([, idx], k) => `<text class="end-label" x="${x(end) + 8}" y="${endY[k] + 4}">${last[idx]}</text>`).join('') : ''}
    </svg>
    ${tableTwin(['Minute', 'Team', 'Goal', h.name, a.name], goals.map(gl => [gl.min.label, team(gl.team).name, goalText(gl), gl.score[0], gl.score[1]]))}
  </div>`;
}

// When goals come: scored and conceded in six slices of the match (0–15', 16–30', … for 90-minute matches).
function goalTimesChart(results, tid) {
  const goals = results.flatMap(r => r.goals.map(gl => ({ ...gl, full: matchLength(r) })));
  if (!goals.length) return '';
  const slice = gl => Math.min(5, Math.max(0, Math.floor(((gl.min.n - 0.01) / gl.full) * 6)));
  const len = halfLen() * 2;
  const rows = Array.from({ length: 6 }, (_, i) => ({ label: `${Math.round((len * i) / 6) + (i ? 1 : 0)}–${Math.round((len * (i + 1)) / 6)}'`,
    us: goals.filter(gl => gl.team === tid && slice(gl) === i).length, them: goals.filter(gl => gl.team !== tid && slice(gl) === i).length }));
  const W = chartWidth(), H = 200, pad = { l: 30, r: 10, t: 12, b: 42 };
  const maxY = niceMax(Math.max(...rows.map(r => Math.max(r.us, r.them)))), step = niceStep(maxY);
  const band = (W - pad.l - pad.r) / rows.length, bw = Math.min(24, band * 0.32);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);
  const base = y(0);
  return `<div class="card chart">
    <div class="chart-title">When goals come</div>
    ${legend([['series-1', 'Scored'], ['series-2', 'Conceded']])}
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Goals scored and conceded by time in the match">
      ${Array.from({ length: maxY / step + 1 }, (_, i) => i * step).map(v => `
        <line class="${v ? 'grid' : 'axis'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="tick" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      ${rows.map((r, i) => {
        const cx = pad.l + band * i + band / 2;
        return [[r.us, 'series-1', cx - bw - 1, `${r.label}: ${r.us} scored`], [r.them, 'series-2', cx + 1, `${r.label}: ${r.them} conceded`]]
          .map(([v, cls, bx, t]) => `<path class="bar ${cls}" d="${colPath(bx, y(v), bw, base - y(v))}"/>
            <rect class="hit" tabindex="0" x="${bx - 2}" y="${pad.t}" width="${bw + 4}" height="${base - pad.t}" data-tip="${attr(t)}"/>`).join('')
          + `<text class="tick" x="${cx}" y="${base + 16}" text-anchor="middle">${r.label}</text>`;
      }).join('')}
      <text class="tick" x="${pad.l + (W - pad.l - pad.r) / 2}" y="${H - 6}" text-anchor="middle">Minute of the match</text>
    </svg>
    ${tableTwin(['Minutes', 'Scored', 'Conceded'], rows.map(r => [r.label, r.us, r.them]))}
  </div>`;
}

// Two teams side by side, one row per stat (box scores).
function compareBars(h, a, rows) {
  return `<div class="card"><div class="chart-title">Match stats</div>
    <div class="compare-head"><span><span class="dot" style="background:${teamBg(h)}"></span>${esc(h.name)}</span>
      <span>${esc(a.name)} <span class="dot" style="background:${teamBg(a)};margin:0 0 0 4px"></span></span></div>
    ${rows.map(([label, x, y]) => { const t = x + y || 1;
      return `<div class="compare-row"><b>${x}</b><span class="compare-label">${esc(label)}</span><b>${y}</b>
        <span class="compare-track"><i class="s1" style="width:${(x / t) * 100}%"></i><i class="s2" style="width:${(y / t) * 100}%"></i></span></div>`; }).join('')}
  </div>`;
}

// Who sets up whom: the most common assist → goal pairs.
function comboList(flows, title = 'Assist → goal') {
  const counts = {};
  for (const f of flows) if (f.a && f.g) { const k = `${f.a}|${f.g}`; counts[k] = (counts[k] || 0) + 1; }
  const list = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 8);
  if (!list.length) return '';
  return `<div class="card chart"><div class="chart-title">${esc(title)}</div>
    ${list.map(([k, n]) => { const [a, g] = k.split('|');
      return `<div class="hbar"><span class="hbar-name">${esc(player(a).name)} → ${esc(player(g).name)}</span>
        <span class="hbar-track"><i style="width:${(n / list[0][1]) * 100}%"></i></span><span class="hbar-val">${n}</span></div>`; }).join('')}
    <div class="muted" style="font-size:12px;margin-top:6px">Goals from each assist pairing.</div></div>`;
}

// Stat tiles: a label and a big number.
function tiles(items) {
  return `<div class="tiles">${items.map(([label, value, note]) => `
    <div class="tile"><span class="tile-label">${esc(label)}</span><b>${esc(value)}</b>${note ? `<span class="tile-note">${esc(note)}</span>` : ''}</div>`).join('')}</div>`;
}

// ---------- Hover / tap details for chart marks ----------
(function chartTooltips() {
  const tip = document.createElement('div');
  tip.id = 'chart-tip'; tip.setAttribute('role', 'tooltip');
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(tip));
  const hide = () => tip.classList.remove('show');
  let shownAt = 0;
  const show = (el, px, py) => {
    shownAt = Date.now();
    tip.textContent = el.dataset.tip;
    tip.classList.add('show');
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, px - r.width / 2));
    const top = py - r.height - 14 < 8 ? py + 18 : py - r.height - 14;
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  };
  document.addEventListener('pointermove', e => {
    const el = e.target.closest?.('[data-tip]');
    if (el && el.closest('.chart')) show(el, e.clientX, e.clientY); else if (tip.classList.contains('show')) hide();
  });
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest?.('[data-tip]');
    if (el && el.closest('.chart')) show(el, e.clientX, e.clientY); else hide();
  });
  document.addEventListener('focusin', e => {
    const el = e.target.closest?.('[data-tip]');
    if (el && el.closest('.chart')) { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); }
  });
  document.addEventListener('focusout', hide);
  // Scrolling moves the marks away from the tip, so hide it (but not for the scroll a keyboard focus itself causes).
  window.addEventListener('scroll', () => { if (Date.now() - shownAt > 300) hide(); }, { passive: true });
})();
