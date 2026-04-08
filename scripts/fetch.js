/**
 * DGPT Pick'em — Data Fetcher
 * Runs as a GitHub Action on a schedule.
 *
 * Handles:
 *   1. Standings — fetches DGPT MPO standings from StatMando
 *   2. Results   — fetches live leaderboard or previous event results
 *   3. Picks     — auto-manages draft windows, detects winners, updates scores
 *   4. Schedule  — keeps event status current based on dates
 *
 * Usage:
 *   node scripts/fetch.js                — run everything
 *   node scripts/fetch.js --standings    — standings only
 *   node scripts/fetch.js --results      — results only
 *   node scripts/fetch.js --picks        — picks/draft management only
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const ARGS         = process.argv.slice(2);
const DO_ALL       = ARGS.length === 0;
const DO_STANDINGS = DO_ALL || ARGS.includes('--standings');
const DO_RESULTS   = DO_ALL || ARGS.includes('--results');
const DO_PICKS     = DO_ALL || ARGS.includes('--picks');

const BANNED       = ['Gannon Buhr'];
const PTS_PER_WEEK = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DGPTPickem/1.0)', 'Accept': 'text/html,application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (e) { console.error(`Could not read ${file}:`, e.message); return null; }
}

function writeJson(file, data) {
  const out = JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2);
  fs.writeFileSync(path.join(DATA_DIR, file), out);
  console.log(`✓ Written: ${file}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();
}

function formatDateRange(start, end) {
  const s = new Date(start + 'T12:00:00'), e = new Date(end + 'T12:00:00');
  const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${m[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
}

function today() { return new Date().toISOString().slice(0, 10); }

// ── Draft Resolution ──────────────────────────────────────────────────────────

function resolveDraft(week) {
  const { first_pick, leo, joe } = week;
  const second = first_pick === 'leo' ? 'joe' : 'leo';
  const order  = [first_pick, second, second, first_pick];
  const pools  = { leo: [...(leo.draft8 || [])], joe: [...(joe.draft8 || [])] };
  const taken  = new Set();
  const result = { leo: [], joe: [] };

  for (const picker of order) {
    const pick = pools[picker].find(p => !taken.has(p) && !BANNED.includes(p));
    if (pick) { result[picker].push(pick); taken.add(pick); }
  }

  // Forced picks: Leo's forced6 → Joe's roster, Joe's forced6 → Leo's roster
  const leoForced = (leo.forced6 || []).find(p => !taken.has(p) && !BANNED.includes(p));
  const joeForced = (joe.forced6 || []).find(p => !taken.has(p) && !BANNED.includes(p));

  week.leo.resolved_picks = result.leo;
  week.joe.resolved_picks = result.joe;
  week.leo.forced_pick    = joeForced || null;
  week.joe.forced_pick    = leoForced || null;

  console.log(`  Draft resolved — Leo: ${result.leo.join(', ')} +${joeForced}`);
  console.log(`  Draft resolved — Joe: ${result.joe.join(', ')} +${leoForced}`);
  return week;
}

// ── Picks & Draft Management ──────────────────────────────────────────────────

async function managePicks() {
  console.log('Managing picks and draft windows...');
  const picks    = readJson('picks.json');
  const schedule = readJson('schedule.json');
  const results  = readJson('results.json');
  if (!picks || !schedule) return;

  const now     = new Date();
  const todayStr = today();
  let   changed = false;

  for (const week of picks.weeks) {
    if (week.status === 'done') continue;

    const event = schedule.events.find(e => e.week === week.week);
    if (!event) continue;

    // ── 1. Auto-open draft window on Monday ──
    if (week.draft_open && todayStr >= week.draft_open && todayStr <= week.draft_close && week.status === 'upcoming') {
      console.log(`  Week ${week.week}: draft window open`);
    }

    // ── 2. Auto-close draft window Wednesday midnight & resolve draft ──
    if (week.draft_close && todayStr > week.draft_close && week.status === 'upcoming') {
      console.log(`  Week ${week.week}: draft window closed — resolving draft`);

      // If only one submitted, use what we have; if neither, leave empty
      const leoReady = week.leo.submitted && week.leo.draft8.length > 0;
      const joeReady = week.joe.submitted && week.joe.draft8.length > 0;

      if (leoReady || joeReady) {
        resolveDraft(week);
      }
      week.status = 'locked';
      changed = true;
      console.log(`  Week ${week.week}: status → locked`);
    }

    // ── 3. Detect tournament winner and record result ──
    if ((week.status === 'locked' || week.status === 'upcoming') && event.end <= todayStr) {
      // Tournament has ended — check if we have a winner
      const winner = event.winner_mpo || results?.previous?.winner;

      if (winner && !week.winner) {
        console.log(`  Week ${week.week}: tournament ended, winner = ${winner}`);

        const leoPicks = [...(week.leo.resolved_picks || []), week.leo.forced_pick].filter(Boolean);
        const joePicks = [...(week.joe.resolved_picks || []), week.joe.forced_pick].filter(Boolean);

        let winningTeam = null;
        if (leoPicks.includes(winner)) winningTeam = 'leo';
        else if (joePicks.includes(winner)) winningTeam = 'joe';

        const pts = week.points_available || PTS_PER_WEEK;

        week.winner       = winner;
        week.winning_team = winningTeam;
        week.status       = 'done';

        if (winningTeam) {
          week.result          = winningTeam;
          week.points_awarded  = pts;
          picks.season_score[winningTeam] = (picks.season_score[winningTeam] || 0) + pts;
          picks.season_score.rollover = 0;

          // Reset next week's points_available to base
          const next = picks.weeks.find(w => w.week === week.week + 1);
          if (next) next.points_available = PTS_PER_WEEK;

          console.log(`  ${winningTeam.toUpperCase()} wins ${pts} pts! Season: Leo ${picks.season_score.leo} – Joe ${picks.season_score.joe}`);
        } else {
          // Push — roll over
          week.result         = 'push';
          week.points_awarded = 0;
          week.rolled_to      = week.week + 1;
          picks.season_score.rollover = (picks.season_score.rollover || 0) + pts;

          const next = picks.weeks.find(w => w.week === week.week + 1);
          if (next) {
            next.points_available = PTS_PER_WEEK + picks.season_score.rollover;
            console.log(`  Push — ${picks.season_score.rollover} pts rolled to Week ${week.week + 1}`);
          }
        }
        changed = true;
      }
    }

    // ── 4. Auto-add next week to picks.json if missing ──
    const nextWeekNum  = week.week + 1;
    const nextInPicks  = picks.weeks.find(w => w.week === nextWeekNum);
    const nextInSched  = schedule.events.find(e => e.week === nextWeekNum);

    if (week.status === 'done' && !nextInPicks && nextInSched) {
      const prevFirstPick = week.first_pick;
      const nextFirstPick = prevFirstPick === 'leo' ? 'joe' : 'leo';
      picks.weeks.push({
        week:             nextWeekNum,
        event:            nextInSched.name,
        location:         nextInSched.location,
        points_available: PTS_PER_WEEK + (picks.season_score.rollover || 0),
        first_pick:       nextFirstPick,
        status:           'upcoming',
        result:           null,
        winner:           null,
        winning_team:     null,
        points_awarded:   0,
        rolled_to:        null,
        draft_open:       nextInSched.draft_open  || null,
        draft_close:      nextInSched.draft_close || null,
        leo: { submitted: false, draft8: [], forced6: [], resolved_picks: [], forced_pick: null },
        joe: { submitted: false, draft8: [], forced6: [], resolved_picks: [], forced_pick: null }
      });
      changed = true;
      console.log(`  Auto-added Week ${nextWeekNum}: ${nextInSched.name} — ${nextFirstPick} picks first`);
    }
  }

  // ── 5. Keep schedule event statuses current ──
  let schedChanged = false;
  for (const event of schedule.events) {
    if (event.status === 'done') continue;
    const start = event.start;
    const end   = event.end;
    if (end < todayStr && event.status !== 'done') {
      event.status = 'done'; schedChanged = true;
      console.log(`  Schedule: ${event.name} → done`);
    } else if (start <= todayStr && end >= todayStr && event.status !== 'live') {
      event.status = 'live'; schedChanged = true;
      console.log(`  Schedule: ${event.name} → live`);
    }
  }

  if (changed)      writeJson('picks.json', picks);
  if (schedChanged) writeJson('schedule.json', schedule);
  if (!changed && !schedChanged) console.log('  No pick/schedule changes needed.');
}

// ── Standings ─────────────────────────────────────────────────────────────────

async function fetchStandings() {
  console.log('Fetching DGPT MPO standings from StatMando...');
  const current = readJson('standings.json');
  const banned  = current?.standings?.filter(p => p.banned).map(p => p.name) || BANNED;

  try {
    const res = await get('https://statmando.com/rankings/dgpt/mpo');
    if (res.status !== 200) { console.warn(`StatMando returned ${res.status} — keeping existing`); return; }

    const rows = [];
    const tableMatch = res.body.match(/<table[\s\S]*?<\/table>/i);
    if (!tableMatch) { console.warn('No table found in StatMando response'); return; }

    const rowRegex  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let match;

    while ((match = rowRegex.exec(tableMatch[0])) !== null) {
      const cells = [];
      let cell;
      const rowHtml = match[1];
      while ((cell = cellRegex.exec(rowHtml)) !== null) cells.push(stripTags(cell[1]));

      if (cells.length >= 4 && !isNaN(parseInt(cells[0]))) {
        const rank = parseInt(cells[0]);
        const name = cells[2] || cells[1] || '';
        const pts  = parseFloat((cells[3] || '0').replace(/,/g, '')) || 0;
        if (name && rank <= 50) {
          const existing = current?.standings?.find(p => p.name === name);
          const initials = name.split(' ').map(w => w[0]).filter(Boolean).join('').slice(0,2).toUpperCase();
          rows.push({
            rank,
            name,
            initials:  existing?.initials  || initials,
            sponsor:   existing?.sponsor   || '',
            pts,
            wins:      existing?.wins      || 0,
            top10:     existing?.top10     || 0,
            banned:    banned.includes(name)
          });
        }
      }
    }

    if (rows.length < 5) { console.warn(`Only ${rows.length} standings rows — keeping existing`); return; }

    writeJson('standings.json', { season: 2026, division: 'MPO', standings: rows });
    console.log(`✓ Standings: ${rows.length} players`);

  } catch (e) { console.error('Standings error:', e.message); }
}

// ── Results ───────────────────────────────────────────────────────────────────

async function fetchResults() {
  console.log('Fetching results...');
  const schedule = readJson('schedule.json');
  const current  = readJson('results.json');
  const picks    = readJson('picks.json');
  if (!schedule) return;

  const now      = new Date();
  const todayStr = today();

  // Live event: started and not yet ended (+1 day buffer)
  const liveEvent = schedule.events.find(e => {
    const start = new Date(e.start + 'T00:00:00');
    const end   = new Date(e.end   + 'T23:59:59');
    end.setDate(end.getDate() + 1);
    return now >= start && now <= end;
  });

  // Most recent completed event
  const prevEvent = schedule.events
    .filter(e => e.status === 'done' || e.end < todayStr)
    .sort((a, b) => b.end.localeCompare(a.end))[0];

  let liveData = {
    active: false, event_id: null, event_name: null, location: null,
    current_round: null, total_rounds: null, round_status: null, holes_complete: null, leaderboard: []
  };
  let prevData = current?.previous || {};

  // ── Fetch live leaderboard ──
  if (liveEvent) {
    const scoreId = liveEvent.dgpt_scores_id || liveEvent.pdga_id;
    if (scoreId) {
      try {
        const url = `https://www.pdga.com/apps/tournament/live-api/live-results-access-public.php?TournID=${scoreId}&Division=MPO&Round=0&Type=results`;
        const res = await get(url);
        if (res.status === 200) {
          const json = JSON.parse(res.body);
          const players = json?.data?.scores || [];
          if (players.length > 0) {
            const leaderboard = players.slice(0, 50).map((p, i) => ({
              rank:  p.Place || i + 1,
              name:  `${p.FirstName} ${p.LastName}`.trim(),
              thru:  p.Thru || 'F',
              score: p.RunningTotal !== undefined ? (p.RunningTotal > 0 ? `+${p.RunningTotal}` : p.RunningTotal === 0 ? 'E' : `${p.RunningTotal}`) : 'E'
            }));
            liveData = {
              active: true,
              event_id: liveEvent.id,
              event_name: liveEvent.name,
              location: liveEvent.location,
              current_round: json?.data?.RoundNumber || 1,
              total_rounds: json?.data?.TotalRounds || 3,
              round_status: 'in_progress',
              holes_complete: null,
              leaderboard
            };
            console.log(`✓ Live leaderboard: ${leaderboard.length} players, R${liveData.current_round}`);

            // Check if tournament is complete (all players thru = F, final round)
            const allDone = leaderboard.every(p => p.thru === 'F');
            if (allDone && liveData.current_round >= liveData.total_rounds) {
              console.log(`  Tournament complete — winner: ${leaderboard[0].name}`);
              // Update schedule with winner
              liveEvent.winner_mpo = leaderboard[0].name;
              liveEvent.status = 'done';
              const sched = readJson('schedule.json');
              const ev = sched.events.find(e => e.id === liveEvent.id);
              if (ev) { ev.winner_mpo = leaderboard[0].name; ev.status = 'done'; writeJson('schedule.json', sched); }
            }
          }
        }
      } catch (e) {
        console.warn('PDGA Live API failed, trying DGPT page...');
        // Fallback to DGPT scores page scrape
        if (liveEvent.dgpt_scores_id) {
          try {
            const url = `https://www.dgpt.com/event-scores/?id=${liveEvent.dgpt_scores_id}&division=MPO`;
            const res = await get(url);
            if (res.status === 200) {
              const lb = parseLeaderboardHTML(res.body);
              if (lb.length > 0) {
                liveData = {
                  active: true, event_id: liveEvent.id, event_name: liveEvent.name,
                  location: liveEvent.location, current_round: extractRound(res.body),
                  total_rounds: 3, round_status: 'in_progress', holes_complete: null, leaderboard: lb
                };
              }
            }
          } catch(e2) { console.error('DGPT fallback failed:', e2.message); }
        }
      }
    } else {
      // No score ID yet — show event as upcoming/active
      liveData = {
        active: true, event_id: liveEvent.id, event_name: liveEvent.name,
        location: liveEvent.location, current_round: 1, total_rounds: 3,
        round_status: 'pending', holes_complete: 0, leaderboard: []
      };
    }
  }

  // ── Fetch/update previous event results ──
  if (prevEvent) {
    const needsUpdate = !prevData.event_id || prevData.event_id !== prevEvent.id;
    const scoreId = prevEvent.dgpt_scores_id || prevEvent.pdga_id;

    if (needsUpdate && scoreId) {
      try {
        await sleep(1000);
        const url = `https://www.pdga.com/apps/tournament/live-api/live-results-access-public.php?TournID=${scoreId}&Division=MPO&Round=0&Type=results`;
        const res = await get(url);
        if (res.status === 200) {
          const json    = JSON.parse(res.body);
          const players = json?.data?.scores || [];
          if (players.length > 0) {
            const lb = players.slice(0, 20).map((p, i) => ({
              rank:  p.Place || i + 1,
              name:  `${p.FirstName} ${p.LastName}`.trim(),
              score: p.RunningTotal !== undefined ? (p.RunningTotal > 0 ? `+${p.RunningTotal}` : p.RunningTotal === 0 ? 'E' : `${p.RunningTotal}`) : 'E'
            }));
            const winner = lb[0].name;

            // Determine winner team from picks
            const weekPicks  = picks?.weeks?.find(w => w.event === prevEvent.name || schedule.events.find(e => e.week === w.week && e.id === prevEvent.id));
            const leoPicks   = weekPicks ? [...(weekPicks.leo.resolved_picks || []), weekPicks.leo.forced_pick].filter(Boolean) : [];
            const joePicks   = weekPicks ? [...(weekPicks.joe.resolved_picks || []), weekPicks.joe.forced_pick].filter(Boolean) : [];
            const winnerTeam = leoPicks.includes(winner) ? 'leo' : joePicks.includes(winner) ? 'joe' : null;

            prevData = {
              event_id: prevEvent.id, event_name: prevEvent.name, location: prevEvent.location,
              date: formatDateRange(prevEvent.start, prevEvent.end),
              winner, winner_team: winnerTeam, leaderboard: lb
            };
            console.log(`✓ Previous results: ${winner} won (${winnerTeam || 'push'})`);
          }
        }
      } catch (e) { console.warn('Previous results fetch failed:', e.message); }
    } else if (needsUpdate && prevEvent.winner_mpo) {
      prevData = {
        ...(current?.previous || {}),
        event_id: prevEvent.id, event_name: prevEvent.name,
        location: prevEvent.location, date: formatDateRange(prevEvent.start, prevEvent.end),
        winner: prevEvent.winner_mpo
      };
    }
  }

  writeJson('results.json', { live: liveData, previous: prevData });
}

// ── HTML Parsers (fallback) ───────────────────────────────────────────────────

function parseLeaderboardHTML(html) {
  const rows = [];
  const rowRegex  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cell;
    while ((cell = cellRegex.exec(match[1])) !== null) cells.push(stripTags(cell[1]));
    if (cells.length >= 3 && !isNaN(parseInt(cells[0])) && parseInt(cells[0]) <= 100) {
      rows.push({ rank: parseInt(cells[0]), name: cells[1] || '', thru: cells[2] || 'F', score: cells[cells.length-1] || 'E' });
    }
  }
  return rows.filter(r => r.name && r.name.length > 2).slice(0, 50);
}

function extractRound(html) {
  const m = html.match(/Round\s+(\d)/i);
  return m ? parseInt(m[1]) : 1;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('DGPT Pick\'em — Data Fetch', new Date().toISOString());
  if (DO_STANDINGS) await fetchStandings();
  if (DO_RESULTS)   { await sleep(500);  await fetchResults(); }
  if (DO_PICKS)     { await sleep(500);  await managePicks();  }
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
