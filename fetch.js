/**
 * DGPT Pick'em — Data Fetcher
 * Runs as a GitHub Action on a schedule.
 * Fetches standings and live results from DGPT/PDGA and writes to /data/*.json
 *
 * Usage:
 *   node scripts/fetch.js              — fetch all data
 *   node scripts/fetch.js --standings  — standings only
 *   node scripts/fetch.js --results    — results only
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARGS = process.argv.slice(2);
const DO_STANDINGS = ARGS.length === 0 || ARGS.includes('--standings');
const DO_RESULTS = ARGS.length === 0 || ARGS.includes('--results');

// ── Helpers ──────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DGPTPickem/1.0)',
        'Accept': 'application/json, text/html',
      }
    };
    https.get(url, options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (e) {
    console.error(`Could not read ${file}:`, e.message);
    return null;
  }
}

function writeJson(file, data) {
  const out = JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2);
  fs.writeFileSync(path.join(DATA_DIR, file), out);
  console.log(`✓ Written: ${file}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Standings ─────────────────────────────────────────────────────────────────
// Fetches from DGPT full standings page and parses MPO top 50

async function fetchStandings() {
  console.log('Fetching DGPT MPO standings...');
  const current = readJson('standings.json');
  const banned = current?.standings?.filter(p => p.banned).map(p => p.name) || ['Gannon Buhr'];

  try {
    const res = await get('https://www.dgpt.com/full-standings/');
    if (res.status !== 200) {
      console.warn(`Standings fetch returned ${res.status} — keeping existing data`);
      return;
    }

    // Parse the standings table from HTML
    const rows = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&#\d+;/g,'').trim();

    let match;
    let rank = 0;
    while ((match = rowRegex.exec(res.body)) !== null) {
      const row = match[1];
      const cells = [];
      let cell;
      while ((cell = cellRegex.exec(row)) !== null) {
        cells.push(stripTags(cell[1]));
      }
      if (cells.length >= 3 && cells[0] && !isNaN(parseInt(cells[0]))) {
        rank++;
        const name = cells[1] || '';
        const pts = parseInt((cells[2] || '0').replace(/,/g, '')) || 0;
        if (name && rank <= 50) {
          const initials = name.split(' ').map(w => w[0]).filter(Boolean).join('').slice(0,2).toUpperCase();
          const existing = current?.standings?.find(p => p.name === name);
          rows.push({
            rank,
            name,
            initials: existing?.initials || initials,
            sponsor: existing?.sponsor || '',
            pts,
            wins: existing?.wins || 0,
            top10: existing?.top10 || 0,
            banned: banned.includes(name)
          });
        }
      }
    }

    if (rows.length < 5) {
      console.warn('Standings parse returned fewer than 5 rows — keeping existing data');
      return;
    }

    writeJson('standings.json', {
      season: 2026,
      division: 'MPO',
      standings: rows
    });

  } catch (e) {
    console.error('Standings fetch error:', e.message);
  }
}

// ── Results ───────────────────────────────────────────────────────────────────
// Checks schedule for active/recent event and fetches leaderboard

async function fetchResults() {
  console.log('Fetching results...');
  const schedule = readJson('schedule.json');
  const current = readJson('results.json');
  if (!schedule) return;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Find live event (started but not yet ended + 1 day buffer)
  const liveEvent = schedule.events.find(e => {
    const start = new Date(e.start);
    const end = new Date(e.end);
    end.setDate(end.getDate() + 1); // buffer
    return now >= start && now <= end;
  });

  // Find most recently completed event
  const doneEvents = schedule.events
    .filter(e => e.status === 'done' || (e.end && e.end < today))
    .sort((a, b) => b.end.localeCompare(a.end));
  const prevEvent = doneEvents[0];

  let liveData = { active: false, event_id: null, event_name: null, location: null,
    current_round: null, total_rounds: null, round_status: null, holes_complete: null, leaderboard: [] };
  let prevData = current?.previous || {};

  // Fetch live leaderboard if active
  if (liveEvent && liveEvent.dgpt_scores_id) {
    try {
      const url = `https://www.dgpt.com/event-scores/?id=${liveEvent.dgpt_scores_id}&division=MPO`;
      const res = await get(url);
      if (res.status === 200) {
        const leaderboard = parseLeaderboard(res.body);
        if (leaderboard.length > 0) {
          liveData = {
            active: true,
            event_id: liveEvent.id,
            event_name: liveEvent.name,
            location: liveEvent.location,
            current_round: extractCurrentRound(res.body),
            total_rounds: 3,
            round_status: 'in_progress',
            holes_complete: extractHolesComplete(res.body),
            leaderboard
          };
          console.log(`✓ Live leaderboard: ${leaderboard.length} players`);
        }
      }
    } catch (e) {
      console.error('Live fetch error:', e.message);
    }
  } else if (liveEvent) {
    // Event is live but no score ID yet — mark as active with no leaderboard
    liveData = {
      active: true,
      event_id: liveEvent.id,
      event_name: liveEvent.name,
      location: liveEvent.location,
      current_round: 1,
      total_rounds: 3,
      round_status: 'pending',
      holes_complete: 0,
      leaderboard: []
    };
  }

  // Fetch previous event results if winner not yet recorded
  if (prevEvent && (!prevData.event_id || prevData.event_id !== prevEvent.id)) {
    if (prevEvent.dgpt_scores_id) {
      try {
        await sleep(1000);
        const url = `https://www.dgpt.com/event-scores/?id=${prevEvent.dgpt_scores_id}&division=MPO`;
        const res = await get(url);
        if (res.status === 200) {
          const leaderboard = parseLeaderboard(res.body);
          if (leaderboard.length > 0) {
            const winner = leaderboard[0];
            prevData = {
              event_id: prevEvent.id,
              event_name: prevEvent.name,
              location: prevEvent.location,
              date: formatDateRange(prevEvent.start, prevEvent.end),
              winner: winner.name,
              winner_team: null, // resolved by app from picks.json
              leaderboard: leaderboard.slice(0, 20)
            };

            // Also update schedule.json winner
            prevEvent.winner_mpo = winner.name;
            prevEvent.status = 'done';
            writeJson('schedule.json', schedule);
            console.log(`✓ Previous results: winner = ${winner.name}`);
          }
        }
      } catch (e) {
        console.error('Previous results fetch error:', e.message);
      }
    } else {
      // No score ID — keep existing previous data but update metadata
      if (prevEvent.winner_mpo) {
        prevData = {
          ...(current?.previous || {}),
          event_id: prevEvent.id,
          event_name: prevEvent.name,
          winner: prevEvent.winner_mpo
        };
      }
    }
  }

  writeJson('results.json', { live: liveData, previous: prevData });
}

// ── HTML Parsers ──────────────────────────────────────────────────────────────

function parseLeaderboard(html) {
  const rows = [];
  const stripTags = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
  const rowRegex = /<tr[^>]*class="[^"]*player[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const cells = [];
    let cell;
    const rowHtml = match[1];
    while ((cell = cellRegex.exec(rowHtml)) !== null) {
      cells.push(stripTags(cell[1]));
    }
    if (cells.length >= 4) {
      const rank = parseInt(cells[0]) || rows.length + 1;
      const name = cells[1];
      const score = cells[cells.length - 1];
      if (name && name.length > 2) {
        rows.push({ rank, name, score, thru: cells[2] || 'F' });
      }
    }
  }

  // Fallback: generic table row parsing
  if (rows.length === 0) {
    const genericRow = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((match = genericRow.exec(html)) !== null) {
      const cells = [];
      let cell;
      const rowHtml = match[1];
      while ((cell = cellRegex.exec(rowHtml)) !== null) {
        cells.push(stripTags(cell[1]));
      }
      if (cells.length >= 3 && !isNaN(parseInt(cells[0])) && parseInt(cells[0]) <= 100) {
        rows.push({
          rank: parseInt(cells[0]),
          name: cells[1] || '',
          thru: cells[2] || 'F',
          score: cells[cells.length - 1] || 'E'
        });
      }
    }
  }

  return rows.filter(r => r.name && r.name.length > 2).slice(0, 50);
}

function extractCurrentRound(html) {
  const m = html.match(/Round\s+(\d)/i);
  return m ? parseInt(m[1]) : 1;
}

function extractHolesComplete(html) {
  const m = html.match(/Hole\s+(\d+)/i);
  return m ? parseInt(m[1]) : null;
}

function formatDateRange(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('DGPT Pick\'em — Data Fetch', new Date().toISOString());
  if (DO_STANDINGS) await fetchStandings();
  if (DO_RESULTS) { await sleep(500); await fetchResults(); }
  console.log('Done.');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
