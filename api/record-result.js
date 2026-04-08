/**
 * POST /api/record-result
 * Body: { week: 4, winner: 'Player Name', admin_pin: '...' }
 * Records the tournament winner, determines winning team, updates season scores.
 */

const GITHUB_OWNER = 'leopaduch';
const GITHUB_REPO  = 'dgpt-pickem';
const BRANCH       = 'main';
const ADMIN_PIN    = process.env.ADMIN_PIN || 'dgpt2026';

async function getFile(path) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=${BRANCH}`,
    { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'dgpt-pickem' } }
  );
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status} for ${path}`);
  const json = await res.json();
  return { content: JSON.parse(Buffer.from(json.content, 'base64').toString('utf8')), sha: json.sha };
}

async function putFile(path, content, sha, message) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'dgpt-pickem', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
        sha,
        branch: BRANCH
      })
    }
  );
  if (!res.ok) { const err = await res.text(); throw new Error(`GitHub PUT failed: ${res.status} ${err}`); }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { week: weekNum, winner, admin_pin } = req.body;

    if (admin_pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });
    if (!weekNum || !winner) return res.status(400).json({ error: 'week and winner are required' });

    const { content: picks, sha } = await getFile('data/picks.json');
    const week = picks.weeks.find(w => w.week === weekNum);
    if (!week) return res.status(404).json({ error: `Week ${weekNum} not found` });
    if (week.status === 'done') return res.status(400).json({ error: 'Week already recorded' });

    // Determine winning team
    const leoPicks = [...(week.leo.resolved_picks || []), week.leo.forced_pick].filter(Boolean);
    const joePicks = [...(week.joe.resolved_picks || []), week.joe.forced_pick].filter(Boolean);
    let winningTeam = null;
    if (leoPicks.includes(winner)) winningTeam = 'leo';
    else if (joePicks.includes(winner)) winningTeam = 'joe';

    // Points
    const pts = week.points_available || 20;
    week.winner = winner;
    week.winning_team = winningTeam;
    week.status = 'done';

    if (winningTeam) {
      week.result = winningTeam;
      week.points_awarded = pts;
      picks.season_score[winningTeam] = (picks.season_score[winningTeam] || 0) + pts;
      picks.season_score.rollover = 0;

      // Find next week and reset rollover
      const nextWeek = picks.weeks.find(w => w.week === weekNum + 1);
      if (nextWeek) nextWeek.points_available = 20;
    } else {
      // Push — roll over to next week
      week.result = 'push';
      week.points_awarded = 0;
      week.rolled_to = weekNum + 1;
      picks.season_score.rollover = (picks.season_score.rollover || 0) + pts;

      const nextWeek = picks.weeks.find(w => w.week === weekNum + 1);
      if (nextWeek) nextWeek.points_available = 20 + picks.season_score.rollover;
    }

    picks.updated_at = new Date().toISOString();
    await putFile('data/picks.json', picks, sha, `Record Week ${weekNum} result: ${winner} (${winningTeam || 'push'})`);

    // Also update results.json previous event
    try {
      const { content: results, sha: rsha } = await getFile('data/results.json');
      const schedule = (await getFile('data/schedule.json')).content;
      const event = schedule.events.find(e => e.week === weekNum);
      if (event) {
        results.previous = {
          event_id: event.id,
          event_name: event.name,
          location: event.location,
          date: formatDateRange(event.start, event.end),
          winner,
          winner_team: winningTeam,
          leaderboard: results.previous?.leaderboard || []
        };
        results.updated_at = new Date().toISOString();
        await putFile('data/results.json', results, rsha, `Update results for Week ${weekNum}`);
      }
    } catch(e) {
      console.warn('Could not update results.json:', e.message);
    }

    return res.status(200).json({
      success: true,
      week: weekNum,
      winner,
      winning_team: winningTeam,
      points_awarded: winningTeam ? pts : 0,
      result: winningTeam || 'push',
      season_score: picks.season_score
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}

function formatDateRange(start, end) {
  const s = new Date(start + 'T12:00:00'), e = new Date(end + 'T12:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[s.getMonth()]} ${s.getDate()}–${e.getDate()}, ${s.getFullYear()}`;
}
