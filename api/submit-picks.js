/**
 * POST /api/submit-picks
 * Body: { user: 'leo'|'joe', week: 4, draft8: [...], forced6: [...] }
 * Reads picks.json from GitHub, updates the week, writes back.
 */

const GITHUB_OWNER = 'leopaduch';
const GITHUB_REPO  = 'dgpt-pickem';
const GITHUB_FILE  = 'data/picks.json';
const BRANCH       = 'main';

async function getFile() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${BRANCH}`,
    { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'User-Agent': 'dgpt-pickem' } }
  );
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status}`);
  const json = await res.json();
  return { content: JSON.parse(Buffer.from(json.content, 'base64').toString('utf8')), sha: json.sha };
}

async function putFile(content, sha, message) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
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

function resolveDraft(week) {
  const { first_pick, leo, joe } = week;
  const second_pick = first_pick === 'leo' ? 'joe' : 'leo';
  const banned = ['Gannon Buhr'];

  // Snake order: 1st, 2nd, 2nd, 1st
  const order = [first_pick, second_pick, second_pick, first_pick];
  const pools = { leo: [...(leo.draft8 || [])], joe: [...(joe.draft8 || [])] };
  const taken = new Set();
  const resolved = { leo: [], joe: [] };

  for (const picker of order) {
    const pool = pools[picker];
    const pick = pool.find(p => !taken.has(p) && !banned.includes(p));
    if (pick) { resolved[picker].push(pick); taken.add(pick); }
  }

  // Forced picks — each assigns their #1 available top-10 pick to the opponent
  const forcedPools = { leo: [...(leo.forced6 || [])], joe: [...(joe.forced6 || [])] };
  // Leo's forced6 goes to Joe, Joe's forced6 goes to Leo
  const leoForced = forcedPools.leo.find(p => !taken.has(p) && !banned.includes(p));
  const joeForced = forcedPools.joe.find(p => !taken.has(p) && !banned.includes(p));

  week.leo.resolved_picks = resolved.leo;
  week.joe.resolved_picks = resolved.joe;
  week.leo.forced_pick = joeForced || null; // Joe's forced6 → Leo's roster
  week.joe.forced_pick = leoForced || null; // Leo's forced6 → Joe's roster

  return week;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user, week: weekNum, draft8, forced6 } = req.body;

    // Validate
    if (!['leo', 'joe'].includes(user)) return res.status(400).json({ error: 'Invalid user' });
    if (!weekNum || !Array.isArray(draft8) || draft8.length !== 8)
      return res.status(400).json({ error: 'draft8 must be an array of 8 players' });
    if (!Array.isArray(forced6) || forced6.length !== 6)
      return res.status(400).json({ error: 'forced6 must be an array of 6 players' });

    const { content: picks, sha } = await getFile();
    const week = picks.weeks.find(w => w.week === weekNum);
    if (!week) return res.status(404).json({ error: `Week ${weekNum} not found` });
    if (week.status === 'done') return res.status(400).json({ error: 'Week is already complete' });

    // Save submission
    week[user].submitted = true;
    week[user].draft8 = draft8;
    week[user].forced6 = forced6;
    week[user].submitted_at = new Date().toISOString();

    // If both submitted, resolve the draft
    const bothSubmitted = week.leo.submitted && week.joe.submitted;
    if (bothSubmitted) {
      resolveDraft(week);
      week.status = 'locked';
    }

    picks.updated_at = new Date().toISOString();

    await putFile(picks, sha, `${user} submitted Week ${weekNum} picks`);

    return res.status(200).json({
      success: true,
      both_submitted: bothSubmitted,
      resolved: bothSubmitted ? {
        leo: week.leo.resolved_picks,
        joe: week.joe.resolved_picks,
        leo_forced: week.leo.forced_pick,
        joe_forced: week.joe.forced_pick
      } : null
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
