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
  const onLogin  = finalUrl.toLowerCase().includes('logon');
  const hasLogout = $p('a[href*="LogOff"], a[href*="logoff"]').length > 0;
  const hasMain   = $p('#plnMain, .sg-banner, .sg-header').length > 0;
  if (onLogin && !hasLogout && !hasMain)
    throw new Error('Incorrect username or password.');
}

// ─────────────────────────────────────────────────────────────────────────────
// COURSE NAME CLEANING
//
// HAC raw course name formats we handle:
//   "ELA12200B - 2    English 2 Adv S2"
//   "MTH4SB301A - 1  AP Calculus AB S1"
//   "CSC21100A - 3  AP Computer Science A S1"
//   "PE  Athletics"  (no code prefix)
//   "English 2 Adv"  (already clean)
// ─────────────────────────────────────────────────────────────────────────────
function cleanName(raw) {
  if (!raw) return '';
  let name = raw.trim();

  // Pattern 1: "LETTERS+DIGITS+[A-Z] - NUMBER  CourseName"
  // Capture everything after the "CODE - NUM  " prefix
  const m1 = name.match(/^[A-Z]{2,5}\d{3,}[A-Z]?\s*-\s*\d+\s{1,}(.+)$/i);
  if (m1) {
    name = m1[1].trim();
  } else {
    // Pattern 2: "LETTERS+DIGITS+[A-Z]  CourseName" (dash-less)
    const m2 = name.match(/^[A-Z]{2,5}\d{3,}[A-Z]?\s{2,}(.+)$/i);
    if (m2) name = m2[1].trim();
  }

  // Strip trailing semester marker: " S1", " S2" (case-insensitive)
  name = name.replace(/\s+S[12]\s*$/i, '').trim();

  // Strip trailing period/section numbers like "  Period 3" or " - Per 2"
  name = name.replace(/\s*[-–]?\s*(period|per)\s*\d+\s*$/i, '').trim();

  return name;
}

// Detect if a raw code ends in A (sem 1) or B (sem 2)
function courseSemester(rawCode) {
  // "MTH45300A - " → A, "MTH45300B - " → B
  const m = rawCode.match(/^[A-Z]{2,5}\d{3,}([AB])\s*[-\s]/i);
  if (m) return m[1].toUpperCase();
  if (/ S1\b/i.test(rawCode)) return 'A';
  if (/ S2\b/i.test(rawCode)) return 'B';
  return null;
}

function courseBaseKey(cleanedName) {
  return cleanedName.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normKey(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
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

  // Fallback: scan table cells for "Student Name" label
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
// PARSE REPORT CARD — one quarter at a time
//
// When you POST to RC_URL selecting a period dropdown value, HAC reloads the
// table showing that quarter's grades. We read the first valid numeric cell
// per row (skipping blank / dash cells).
// ─────────────────────────────────────────────────────────────────────────────
function parseRCGrades(html) {
  const $ = cheerio.load(html);
  const grades = new Map(); // rawName → grade (number)

  // Try several table selectors HAC uses across versions
  let rows = $('table#plnMain_dgRCDetails tr, table.sg-asp-table tr, #plnMain table tr');
  if (!rows.length) rows = $('table tr');

  rows.each((_, row) => {
    const $row = $(row);
    // Skip header rows
    if ($row.find('th').length) return;

    const cells = $row.find('td');
    if (cells.length < 2) return;

    const rawName = $(cells[0]).text().trim();
    if (!rawName || rawName.length < 4) return;

    // Row must start with a dept code like "ELA…", "MTH…", "SCI…", "CSC…", etc.
    // Be permissive: at least 2 capital letters followed by 3+ digits
    if (!/^[A-Z]{2,5}\d{3,}/.test(rawName)) return;

    // Scan all cells (skip col 0) for the first numeric grade 40–100
    let grade = null;
    for (let i = 1; i < cells.length; i++) {
      const txt = $(cells[i]).text().trim();
      // Accept "95", "95.5", "100"
      if (/^\d{2,3}(\.\d{1,2})?$/.test(txt)) {
        const n = parseFloat(txt);
        if (n >= 40 && n <= 100) { grade = n; break; }
      }
    }

    if (grade !== null) {
      grades.set(rawName, grade);
    }
  });

  return grades;
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH A SPECIFIC REPORT CARD PERIOD
// ─────────────────────────────────────────────────────────────────────────────
function extractFormFields($) {
  return {
    __EVENTTARGET:        $('input[name="__EVENTTARGET"]').val()        || '',
    __EVENTARGUMENT:      $('input[name="__EVENTARGUMENT"]').val()      || '',
    __VIEWSTATE:          $('input[name="__VIEWSTATE"]').val()          || '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').val() || '',
    __EVENTVALIDATION:    $('input[name="__EVENTVALIDATION"]').val()    || '',
  };
}

async function fetchPeriod(client, periodValue) {
  // Always re-GET the page first to grab a fresh VIEWSTATE before POSTing
  const getRes = await client.get(RC_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: RC_URL },
  });
  const $ = cheerio.load(getRes.data);
  const fields = extractFormFields($);

  const body = new URLSearchParams({
    ...fields,
    '__EVENTTARGET':           'ctl00$plnMain$ddlRCRuns',
    '__EVENTARGUMENT':         '',
    'ctl00$plnMain$ddlRCRuns': periodValue,
  });

  const postRes = await client.post(RC_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: RC_URL,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  return postRes.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE LIVE CLASSWORK GRADES (Assignments page)
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
// MAIN API ROUTE
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();

  try {
    await login(client, username, password);

    // ── 1. Load RC page, collect all period dropdown options ──────────────
    const rcInitRes = await client.get(RC_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $rcInit = cheerio.load(rcInitRes.data);

    const allPeriods = [];
    $rcInit('#plnMain_ddlRCRuns option, select[name*="ddlRCRuns"] option').each((_, el) => {
      const value = $rcInit(el).attr('value');
      const label = $rcInit(el).text().trim();
      if (value !== undefined && value !== '' && label) allPeriods.push({ value, label });
    });

    console.log('[periods]', allPeriods.map(p => `"${p.label}"=${p.value}`).join(' | '));

    // ── 2. Map periods → Q1/Q2/Q3/Q4 ─────────────────────────────────────
    //
    // HAC labels vary widely: "1", "Quarter 1", "MP1", "MP 1", "1st Six Weeks",
    // "Nine Weeks 1", "Six Weeks 1", "Semester 1", etc.
    // Strategy:
    //   Pass 1 — explicit pattern matching
    //   Pass 2 — fall back to positional assignment for unmatched quarters
    //
    const quarterMap = {};
    const usedVals   = new Set();

    const PATTERNS = [
      // Quarter / Marking Period / Nine Weeks
      { q: 'q1', tests: [ /^1$/, /quarter\s*1\b/i, /\bmp\s*1\b/i, /\b1st\b/, /nine\s*weeks\s*1\b/i, /six\s*weeks\s*1\b/i ] },
      { q: 'q2', tests: [ /^2$/, /quarter\s*2\b/i, /\bmp\s*2\b/i, /\b2nd\b/, /nine\s*weeks\s*2\b/i, /six\s*weeks\s*2\b/i ] },
      { q: 'q3', tests: [ /^3$/, /quarter\s*3\b/i, /\bmp\s*3\b/i, /\b3rd\b/, /nine\s*weeks\s*3\b/i, /six\s*weeks\s*3\b/i ] },
      { q: 'q4', tests: [ /^4$/, /quarter\s*4\b/i, /\bmp\s*4\b/i, /\b4th\b/, /nine\s*weeks\s*4\b/i, /six\s*weeks\s*4\b/i ] },
    ];

    for (const { q, tests } of PATTERNS) {
      const match = allPeriods.find(p =>
        !usedVals.has(p.value) && tests.some(re => re.test(p.label.trim()))
      );
      if (match) { quarterMap[q] = match; usedVals.add(match.value); }
    }

    // Positional fallback: assign remaining periods in order
    const unmatched = allPeriods.filter(p => !usedVals.has(p.value));
    const needFill  = ['q1','q2','q3','q4'].filter(q => !quarterMap[q]);
    needFill.forEach((q, i) => {
      if (unmatched[i]) { quarterMap[q] = unmatched[i]; usedVals.add(unmatched[i].value); }
    });

    console.log('[quarter map]', Object.entries(quarterMap).map(([q,p]) => `${q}="${p.label}"`).join(' | '));

    // Currently selected period value (the one HAC is already showing)
    const selectedVal = $rcInit('#plnMain_ddlRCRuns option[selected]').attr('value')
                     || $rcInit('select[name*="ddlRCRuns"] option[selected]').attr('value')
                     || allPeriods.at(-1)?.value;

    // ── 3. Fetch each quarter, parsing grades ─────────────────────────────
    const quarterGrades = {}; // { q1: Map<rawName,grade>, q2: …, … }

    for (const [q, period] of Object.entries(quarterMap)) {
      try {
        let html;
        if (period.value === selectedVal) {
          html = rcInitRes.data; // already loaded
        } else {
          // Small delay between requests to be polite
          await new Promise(r => setTimeout(r, 700));
          html = await fetchPeriod(client, period.value);
        }
        quarterGrades[q] = parseRCGrades(html);
        console.log(`[${q}] "${period.label}" → ${quarterGrades[q].size} grades`);
      } catch (err) {
        console.error(`[${q}] fetch error:`, err.message);
        quarterGrades[q] = new Map();
      }
    }

    // ── 4. Fetch live grades (assignments page = current quarter avg) ──────
    let liveGrades = new Map();
    try {
      const cwHtml = (await client.get(CW_URL)).data;
      liveGrades = parseLiveGrades(cwHtml);
      console.log('[live]', liveGrades.size, 'classes');
    } catch (err) {
      console.error('[live] error:', err.message);
    }

    // ── 5. Fetch student info ─────────────────────────────────────────────
    let student = { name: '', grade: '', campus: '' };
    try {
      student = parseStudentInfo((await client.get(INFO_URL)).data);
    } catch (err) {
      console.error('[student info] error:', err.message);
    }

    // ── 6. Merge all raw names → unified course records ───────────────────
    //
    // Key insight: Frisco ISD HAC uses A/B suffix for sem 1/sem 2:
    //   MTH45300A → Math, holds Q1 + Q2 grades
    //   MTH45300B → Math, holds Q3 + Q4 grades
    // We merge both into one row keyed by the cleaned course name.
    //
    const allRawNames = new Set();
    Object.values(quarterGrades).forEach(m => m.forEach((_, k) => allRawNames.add(k)));
    liveGrades.forEach((_, k) => allRawNames.add(k));

    // Quick lookup helpers
    function gradeFor(q, rawName) {
      const m = quarterGrades[q];
      if (!m) return null;
      if (m.has(rawName)) return m.get(rawName);
      // Try fuzzy match by cleaned name
      const target = normKey(cleanName(rawName));
      for (const [k, v] of m) {
        if (normKey(cleanName(k)) === target) return v;
      }
      return null;
    }

    function liveFor(rawName) {
      if (liveGrades.has(rawName)) return liveGrades.get(rawName);
      const target = normKey(cleanName(rawName));
      for (const [k, v] of liveGrades) {
        if (normKey(cleanName(k)) === target) return v;
      }
      return null;
    }

    // Build merged course map
    // merged[baseKey] = { name, q1, q2, q3, q4 }
    const merged = new Map();

    allRawNames.forEach(rawName => {
      const cleaned = cleanName(rawName);
      if (!cleaned || cleaned.length < 2) return;

      const sem = courseSemester(rawName); // 'A', 'B', or null
      const key = courseBaseKey(cleaned);

      if (!merged.has(key)) {
        merged.set(key, { name: cleaned, q1: null, q2: null, q3: null, q4: null });
      }
      const entry = merged.get(key);

      // Prefer a cleaner/longer display name (e.g. from B-course which has full name)
      if (cleaned.length > entry.name.length) entry.name = cleaned;

      if (sem === 'A' || sem === null) {
        // Semester A (or year-long) contributes Q1 and Q2
        const q1 = gradeFor('q1', rawName);
        const q2 = gradeFor('q2', rawName);
        if (q1 !== null) entry.q1 = q1;
        if (q2 !== null) entry.q2 = q2;
      }

      if (sem === 'B' || sem === null) {
        // Semester B (or year-long) contributes Q3 and Q4
        const q3 = gradeFor('q3', rawName);
        // Q4: try report card first, then live grades as fallback
        const q4 = gradeFor('q4', rawName) ?? liveFor(rawName);
        if (q3 !== null) entry.q3 = q3;
        if (q4 !== null) entry.q4 = q4;
      }

      // For year-long courses (null sem), also try the other quarters
      if (sem === null) {
        if (entry.q3 === null) entry.q3 = gradeFor('q3', rawName);
        if (entry.q4 === null) entry.q4 = gradeFor('q4', rawName) ?? liveFor(rawName);
        if (entry.q1 === null) entry.q1 = gradeFor('q1', rawName);
        if (entry.q2 === null) entry.q2 = gradeFor('q2', rawName);
      }
    });

    // Flatten to array, drop completely empty rows
    let courses = [];
    merged.forEach(({ name, q1, q2, q3, q4 }) => {
      if ([q1, q2, q3, q4].every(v => v === null)) return;
      courses.push({ name, q1avg: q1, q2avg: q2, q3avg: q3, q4avg: q4 });
    });

    // ── 7. Fallback: live-only if RC was empty ────────────────────────────
    if (!courses.length && liveGrades.size > 0) {
      console.log('[fallback] using live grades only');
      liveGrades.forEach((avg, rawName) => {
        const name = cleanName(rawName) || rawName;
        courses.push({ name, q1avg: null, q2avg: null, q3avg: null, q4avg: avg });
      });
    }

    if (!courses.length)
      return res.status(404).json({ error: 'No grade data found. Try again or check your login.' });

    // Sort alphabetically for consistent display
    courses.sort((a, b) => a.name.localeCompare(b.name));

    console.log('[result]', courses.length, 'courses');
    courses.forEach(c => console.log(` · ${c.name}: Q1=${c.q1avg} Q2=${c.q2avg} Q3=${c.q3avg} Q4=${c.q4avg}`));

    res.json({
      student,
      courses,
      _debug: {
        allPeriods,
        quarterMap: Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.label])),
        quarterCounts: Object.fromEntries(Object.entries(quarterGrades).map(([q,m]) => [q, m.size])),
        liveCount: liveGrades.size,
      },
    });

  } catch (err) {
    console.error('[/api/grades] error:', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown server error.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC + HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get('/',           (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GradeFlow server → http://localhost:${PORT}`));
