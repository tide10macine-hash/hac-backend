const express = require('express');
const axios   = require('axios');
const { wrapper }   = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const HAC_BASE  = 'https://hac.friscoisd.org';
const LOGIN_URL = `${HAC_BASE}/HomeAccess/Account/LogOn`;
const RC_URL    = `${HAC_BASE}/HomeAccess/Content/Student/ReportCards.aspx`;
const CW_URL    = `${HAC_BASE}/HomeAccess/Content/Student/Assignments.aspx`;
const INFO_URL  = `${HAC_BASE}/HomeAccess/Content/Student/Registration.aspx`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar, withCredentials: true, maxRedirects: 10, timeout: 30000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────────────────────
async function login(client, username, password) {
  const getRes = await client.get(LOGIN_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const $ = cheerio.load(getRes.data);
  const tok = $('input[name="__RequestVerificationToken"]').val();
  if (!tok) throw new Error('Could not load HAC — site may be down.');

  const body = new URLSearchParams({
    '__RequestVerificationToken': tok,
    'SCKTY00328510CustomEnabled': 'False',
    'SCKTY00436568CustomEnabled': 'False',
    'Database': '10',
    'VerificationOption': 'UsernamePassword',
    'LogOnDetails.UserName': username,
    'LogOnDetails.Password': password,
  });

  const postRes = await client.post(LOGIN_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: LOGIN_URL,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const $p = cheerio.load(postRes.data);
  const errText = $p('.validation-summary-errors li, #ErrorMessage').text().trim().toLowerCase();
  if (errText && (errText.includes('invalid') || errText.includes('incorrect')))
    throw new Error('Incorrect username or password.');

  const finalUrl = postRes.request?.res?.responseUrl || '';
  const hasLogout = $p('a[href*="LogOff"], a[href*="logoff"]').length > 0;
  const hasMain   = $p('#plnMain, .sg-banner, .sg-header').length > 0;
  if (finalUrl.toLowerCase().includes('logon') && !hasLogout && !hasMain)
    throw new Error('Incorrect username or password.');
}

// ─────────────────────────────────────────────────────────────────────────────
// COURSE NAME CLEANING
//
// Input examples:
//   "ELA12200B - 2    English 2 Adv S2"
//   "MTH4SB301A - 1  AP Calculus AB S1"
//   "CSC21100A - 3  AP Computer Science A S1"
//   "PE  Athletics"
// ─────────────────────────────────────────────────────────────────────────────
function cleanName(raw) {
  if (!raw) return '';
  let name = raw.trim();

  // Strip "DEPTCODE - SECTION  " prefix
  const m1 = name.match(/^[A-Z]{2,5}[\dA-Z]{3,}[A-Z]?\s*-\s*\d+\s{1,}(.+)$/i);
  if (m1) {
    name = m1[1].trim();
  } else {
    const m2 = name.match(/^[A-Z]{2,5}\d{3,}[A-Z]?\s{2,}(.+)$/i);
    if (m2) name = m2[1].trim();
  }

  // Strip trailing " S1" or " S2"
  name = name.replace(/\s+S[12]\s*$/i, '').trim();
  // Strip trailing period/section " - Per 3"
  name = name.replace(/\s*[-–]?\s*(period|per)\s*\d+\s*$/i, '').trim();

  return name;
}

// 'A' = semester 1 course, 'B' = semester 2 course, null = year-long
function courseSemester(rawCode) {
  const m = rawCode.match(/^[A-Z]{2,5}[\dA-Z]*?([AB])\s*[-\s]/i);
  if (m) return m[1].toUpperCase();
  if (/ S1\b/i.test(rawCode)) return 'A';
  if (/ S2\b/i.test(rawCode)) return 'B';
  return null;
}

function courseBaseKey(cleanedName) {
  return cleanedName.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normKey(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE REPORT CARD — reads ALL quarters from a single page load
//
// HAC's report card table looks like this:
//
//   | Course Name       | [Q1 col] | [Q2 col] | [Sem1 col] | [Q3 col] | [Q4 col] | [Sem2 col] |
//   | ELA12200A - 2 ... |    92    |    93    |     92.5   |          |          |            |
//   | ELA12200B - 2 ... |          |          |            |    91    |    95    |     93     |
//
// The header row contains the period labels (e.g. "1", "2", "3", "4" or
// "Quarter 1" etc.).  We map those headers to Q1/Q2/Q3/Q4 by matching the
// same patterns used for the dropdown, then read each course row at those
// column indices.
//
// This is far more reliable than fetching the page 4 times via the dropdown,
// because the dropdown just highlights columns — all grades are present in
// a single load.
// ─────────────────────────────────────────────────────────────────────────────
function parseAllQuartersFromPage(html) {
  const $ = cheerio.load(html);

  // ── Find the main grade table ──────────────────────────────────────────
  // HAC uses a few different table IDs/classes across versions
  let $table = $('#plnMain_dgRCDetails');
  if (!$table.length) $table = $('table.sg-asp-table').first();
  if (!$table.length) $table = $('#plnMain table').first();
  if (!$table.length) $table = $('table').first();

  // ── Read header row to map column index → quarter label ───────────────
  const headerCells = [];
  $table.find('tr').first().find('th, td').each((i, el) => {
    headerCells.push($(el).text().trim());
  });
  console.log('[RC header cells]', headerCells);

  // Map each header cell to q1/q2/q3/q4 (skip semester/exam/final columns)
  // We look for cells whose text matches a quarter-like label.
  const QUARTER_PATTERNS = [
    { q: 'q1', tests: [ /^1$/, /quarter\s*1\b/i, /\bmp\s*1\b/i, /\b1st\b/i, /nine.?weeks.?1\b/i, /six.?weeks.?1\b/i, /^q1$/i ] },
    { q: 'q2', tests: [ /^2$/, /quarter\s*2\b/i, /\bmp\s*2\b/i, /\b2nd\b/i, /nine.?weeks.?2\b/i, /six.?weeks.?2\b/i, /^q2$/i ] },
    { q: 'q3', tests: [ /^3$/, /quarter\s*3\b/i, /\bmp\s*3\b/i, /\b3rd\b/i, /nine.?weeks.?3\b/i, /six.?weeks.?3\b/i, /^q3$/i ] },
    { q: 'q4', tests: [ /^4$/, /quarter\s*4\b/i, /\bmp\s*4\b/i, /\b4th\b/i, /nine.?weeks.?4\b/i, /six.?weeks.?4\b/i, /^q4$/i ] },
  ];

  // colMap: { q1: colIndex, q2: colIndex, ... }
  const colMap = {};
  const usedCols = new Set();

  for (const { q, tests } of QUARTER_PATTERNS) {
    for (let i = 0; i < headerCells.length; i++) {
      if (usedCols.has(i)) continue;
      if (tests.some(re => re.test(headerCells[i]))) {
        colMap[q] = i;
        usedCols.add(i);
        break;
      }
    }
  }

  // Positional fallback: if header matching failed, try the dropdown-based
  // mapping approach — look at the period dropdown to understand which column
  // index corresponds to each quarter based on the currently-selected option.
  // As a last resort, assume columns 1,2,3,4 are Q1–Q4 (skipping col 0 = name).
  if (Object.keys(colMap).length < 2) {
    console.log('[RC] header matching found < 2 quarters, trying positional fallback');
    // Find numeric/grade-looking columns by scanning first data row
    const numericCols = [];
    $table.find('tr').each((ri, row) => {
      if (ri === 0) return; // skip header
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const rawName = $(cells[0]).text().trim();
      if (!/^[A-Z]{2,5}[\dA-Z]{3,}/.test(rawName)) return;
      // Found first data row — find all numeric columns
      cells.each((ci, cell) => {
        if (ci === 0) return;
        const txt = $(cell).text().trim();
        if (/^\d{2,3}(\.\d{1,2})?$/.test(txt)) {
          const n = parseFloat(txt);
          if (n >= 40 && n <= 100) numericCols.push(ci);
        }
      });
      return false; // stop after first data row
    });
    console.log('[RC] numeric cols in first row:', numericCols);
    // Map first 4 numeric columns to q1–q4
    ['q1','q2','q3','q4'].forEach((q, i) => {
      if (!colMap[q] && numericCols[i] !== undefined) colMap[q] = numericCols[i];
    });
  }

  console.log('[RC colMap]', colMap);

  // ── Read each data row at the mapped column indices ────────────────────
  // result: Map< rawCourseName, { q1, q2, q3, q4 } >
  const result = new Map();

  $table.find('tr').each((ri, row) => {
    if (ri === 0) return; // skip header

    const cells = $(row).find('td');
    if (cells.length < 2) return;

    const rawName = $(cells[0]).text().trim();
    if (!rawName || rawName.length < 4) return;
    if (!/^[A-Z]{2,5}[\dA-Z]{3,}/.test(rawName)) return;

    const entry = { q1: null, q2: null, q3: null, q4: null };

    for (const [q, colIdx] of Object.entries(colMap)) {
      const cell = cells[colIdx];
      if (!cell) continue;
      const txt = $(cell).text().trim();
      if (/^\d{2,3}(\.\d{1,2})?$/.test(txt)) {
        const n = parseFloat(txt);
        if (n >= 0 && n <= 100) entry[q] = n;
      }
    }

    // Only add if at least one grade was found
    if (Object.values(entry).some(v => v !== null)) {
      result.set(rawName, entry);
    }
  });

  console.log('[RC parseAll]', result.size, 'rows,', 
    'q1:', [...result.values()].filter(r => r.q1 !== null).length,
    'q2:', [...result.values()].filter(r => r.q2 !== null).length,
    'q3:', [...result.values()].filter(r => r.q3 !== null).length,
    'q4:', [...result.values()].filter(r => r.q4 !== null).length
  );

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE LIVE CLASSWORK GRADES (Assignments page — current in-progress grades)
// ─────────────────────────────────────────────────────────────────────────────
function parseLiveGrades(html) {
  const $ = cheerio.load(html);
  const classes = new Map();
  $('.AssignmentClass').each((_, el) => {
    const name = $(el).find('.sg-header-heading, a.sg-header-link').first().text().trim();
    const sub  = $(el).find('.sg-header-subheading').first().text().trim();
    const m    = sub.match(/([\d.]+)/);
    const avg  = m ? parseFloat(m[1]) : null;
    if (name && avg !== null && avg >= 0 && avg <= 100) classes.set(name, avg);
  });
  return classes;
}

// ─────────────────────────────────────────────────────────────────────────────
// STUDENT INFO
// ─────────────────────────────────────────────────────────────────────────────
function parseStudentInfo(html) {
  const $ = cheerio.load(html);
  let name = '', grade = '', campus = '';

  $('[id]').each((_, el) => {
    const id = ($(el).attr('id') || '').toLowerCase();
    const t  = $(el).text().trim();
    if (!t || t.length > 80) return;
    if (!name && /student.*name|reg.*name|lblname/.test(id)) name = t;
    if (!grade && /grade.*level|lblgrade/.test(id)) grade = t;
    if (!campus && /campus|school|building/.test(id) && t.length > 2 && t.length < 60) campus = t;
  });

  if (!name) {
    $('td, th, label, span').each((_, el) => {
      if ($(el).text().trim().toLowerCase() === 'student name') {
        const val = $(el).closest('tr').find('td').last().text().trim();
        if (val && val.length > 2) { name = val; return false; }
      }
    });
  }

  return { name, grade, campus };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN API ROUTE
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();

  try {
    await login(client, username, password);

    // ── 1. Single report card page load — parse ALL quarters at once ──────
    const rcRes = await client.get(RC_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });

    // rcRows: Map< rawCourseName, { q1, q2, q3, q4 } >
    const rcRows = parseAllQuartersFromPage(rcRes.data);

    // Debug: also capture dropdown options for logging
    const $rc = cheerio.load(rcRes.data);
    const allPeriods = [];
    $rc('#plnMain_ddlRCRuns option, select[name*="ddlRCRuns"] option').each((_, el) => {
      const value = $rc(el).attr('value');
      const label = $rc(el).text().trim();
      if (value !== undefined && label) allPeriods.push({ value, label });
    });
    console.log('[periods available]', allPeriods.map(p => `"${p.label}"`).join(', '));

    // ── 2. Live grades (current in-progress quarter) ──────────────────────
    let liveGrades = new Map();
    try {
      liveGrades = parseLiveGrades((await client.get(CW_URL)).data);
      console.log('[live]', liveGrades.size, 'classes');
    } catch (err) {
      console.error('[live]', err.message);
    }

    // ── 3. Student info ───────────────────────────────────────────────────
    let student = { name: '', grade: '', campus: '' };
    try {
      student = parseStudentInfo((await client.get(INFO_URL)).data);
    } catch (err) {
      console.error('[student info]', err.message);
    }

    // ── 4. Merge A/B course pairs into unified rows ───────────────────────
    //
    // HAC splits each course into two rows:
    //   ELA12200A → English 2 Adv (holds Q1 & Q2, Q3/Q4 are blank)
    //   ELA12200B → English 2 Adv (holds Q3 & Q4, Q1/Q2 are blank)
    //
    // We merge both using the cleaned course name as the key.
    //
    function liveFor(rawName) {
      if (liveGrades.has(rawName)) return liveGrades.get(rawName);
      const target = normKey(cleanName(rawName));
      for (const [k, v] of liveGrades) {
        if (normKey(cleanName(k)) === target) return v;
      }
      return null;
    }

    const merged = new Map(); // baseKey → { name, q1, q2, q3, q4 }

    rcRows.forEach(({ q1, q2, q3, q4 }, rawName) => {
      const cleaned = cleanName(rawName);
      if (!cleaned || cleaned.length < 2) return;

      const sem = courseSemester(rawName); // 'A', 'B', or null
      const key = courseBaseKey(cleaned);

      if (!merged.has(key)) {
        merged.set(key, { name: cleaned, q1: null, q2: null, q3: null, q4: null });
      }
      const entry = merged.get(key);

      // Prefer longer display name
      if (cleaned.length > entry.name.length) entry.name = cleaned;

      if (sem === 'A') {
        // Semester 1 course: takes Q1 and Q2
        if (q1 !== null) entry.q1 = q1;
        if (q2 !== null) entry.q2 = q2;
      } else if (sem === 'B') {
        // Semester 2 course: takes Q3 and Q4
        if (q3 !== null) entry.q3 = q3;
        if (q4 !== null) entry.q4 = q4;
        // Fall back to live grade for Q4 if report card doesn't have it yet
        if (entry.q4 === null) entry.q4 = liveFor(rawName);
      } else {
        // Year-long course: take whatever columns have data
        if (q1 !== null) entry.q1 = q1;
        if (q2 !== null) entry.q2 = q2;
        if (q3 !== null) entry.q3 = q3;
        if (q4 !== null) entry.q4 = q4;
        if (entry.q4 === null) entry.q4 = liveFor(rawName);
      }
    });

    // ── 5. Fallback: if RC parsed nothing, use live grades only ───────────
    let courses = [];
    merged.forEach(({ name, q1, q2, q3, q4 }) => {
      if ([q1, q2, q3, q4].every(v => v === null)) return;
      courses.push({ name, q1avg: q1, q2avg: q2, q3avg: q3, q4avg: q4 });
    });

    if (!courses.length && liveGrades.size > 0) {
      console.log('[fallback] using live grades only');
      liveGrades.forEach((avg, rawName) => {
        const name = cleanName(rawName) || rawName;
        courses.push({ name, q1avg: null, q2avg: null, q3avg: null, q4avg: avg });
      });
    }

    if (!courses.length)
      return res.status(404).json({ error: 'No grade data found. Try again or check your login.' });

    courses.sort((a, b) => a.name.localeCompare(b.name));

    console.log('[result]', courses.length, 'courses:');
    courses.forEach(c =>
      console.log(`  ${c.name}: Q1=${c.q1avg ?? '—'} Q2=${c.q2avg ?? '—'} Q3=${c.q3avg ?? '—'} Q4=${c.q4avg ?? '—'}`)
    );

    res.json({
      student,
      courses,
      _debug: {
        allPeriods,
        rcRowCount: rcRows.size,
        mergedCount: courses.length,
        liveCount: liveGrades.size,
        sampleRows: [...rcRows.entries()].slice(0, 4).map(([k, v]) => ({ raw: k, ...v })),
      },
    });

  } catch (err) {
    console.error('[/api/grades]', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTIC ENDPOINT — dumps raw table structure for debugging
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/diagnose', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();
  try {
    await login(client, username, password);
    const rcRes = await client.get(RC_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $ = cheerio.load(rcRes.data);

    // Dropdown options
    const periods = [];
    $('#plnMain_ddlRCRuns option, select[name*="ddlRCRuns"] option').each((_, el) => {
      periods.push({ value: $(el).attr('value'), label: $(el).text().trim(), selected: !!$(el).attr('selected') });
    });

    // First 12 rows of every table on the page
    const tables = [];
    $('table').each((ti, table) => {
      const rows = [];
      $(table).find('tr').each((ri, row) => {
        if (ri > 12) return false;
        const cells = [];
        $(row).find('td, th').each((_, td) => cells.push($(td).text().trim().substring(0, 50)));
        if (cells.length) rows.push(cells);
      });
      if (rows.length) tables.push({ tableIndex: ti, id: $(table).attr('id') || '', rows });
    });

    res.json({ periods, tables });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC + HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/',           (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GradeFlow server → http://localhost:${PORT}`));
