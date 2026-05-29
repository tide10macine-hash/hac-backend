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

function extractFormFields($) {
  return {
    __EVENTTARGET:        $('input[name="__EVENTTARGET"]').val()        || '',
    __EVENTARGUMENT:      $('input[name="__EVENTARGUMENT"]').val()      || '',
    __VIEWSTATE:          $('input[name="__VIEWSTATE"]').val()          || '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').val() || '',
    __EVENTVALIDATION:    $('input[name="__EVENTVALIDATION"]').val()    || '',
  };
}

// ── Clean course name ────────────────────────────────────────────────────────
// Input:  "ELA12200B - 2    English 2 Adv S2"
// Output: "English 2 Adv"   (strips code prefix AND trailing S1/S2)
function cleanName(raw) {
  if (!raw) return '';
  let name = raw.trim();

  // Strip course-code prefix: "ELA12200B - 2    " or "MTH45300A - 3  "
  // Pattern: LETTERS+DIGITS+OPTIONAL_LETTER SPACE* - SPACE* DIGIT(s) SPACE(s) REST
  const m = name.match(/^[A-Z]{2,4}\d{4,}[A-Z]?\s*-\s*\d+\s{1,}(.+)$/);
  if (m) name = m[1].trim();

  // Strip trailing semester marker: " S1", " S2", " S1 ", " S2 "
  name = name.replace(/\s+S[12]\s*$/i, '').trim();

  return name;
}

// ── Semester from course code ────────────────────────────────────────────────
// "ELA12200A" → 'A' (first semester),  "ELA12200B" → 'B' (second semester)
function courseSemester(rawCode) {
  // The letter just before " - " indicates semester: A = sem1, B = sem2
  const m = rawCode.match(/^[A-Z]{2,4}\d{4,}([AB])\s*-/i);
  if (m) return m[1].toUpperCase(); // 'A' or 'B'
  // Fallback: check if name contains "S1" or "S2"
  if (/ S1\b/i.test(rawCode)) return 'A';
  if (/ S2\b/i.test(rawCode)) return 'B';
  return null; // year-long course
}

// ── Base key for merging A/B courses ────────────────────────────────────────
// "English 2 Adv" (same for both S1 and S2 variants)
function courseBaseKey(cleanedName) {
  return cleanedName.toLowerCase().trim();
}

// ── Student info ─────────────────────────────────────────────────────────────
function parseStudentInfo(html) {
  const $ = cheerio.load(html);

  // Try every plausible ID pattern HAC uses
  let name = '';
  $('*').each((_, el) => {
    const id = $(el).attr('id') || '';
    if (/student.*name|reg.*name|lblname/i.test(id)) {
      const t = $(el).text().trim();
      if (t.length > 2) { name = t; return false; }
    }
  });

  // Also try table cells labelled "Student Name"
  if (!name) {
    $('td, th, label, span').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt.toLowerCase() === 'student name') {
        const val = $(el).closest('tr').find('td, span, div').last().text().trim();
        if (val && val.length > 2) { name = val; return false; }
      }
    });
  }

  let grade = '';
  $('*').each((_, el) => {
    const id = $(el).attr('id') || '';
    if (/grade.*level|lblgrade/i.test(id)) {
      const t = $(el).text().trim();
      if (t.length > 0) { grade = t; return false; }
    }
  });

  let campus = '';
  $('*').each((_, el) => {
    const id = $(el).attr('id') || '';
    if (/campus|school|building/i.test(id)) {
      const t = $(el).text().trim();
      if (t.length > 2 && t.length < 60) { campus = t; return false; }
    }
  });

  return { name, grade, campus };
}

// ── Parse ONE report card page ───────────────────────────────────────────────
// Returns Map<rawCourseName, grade>
// When a period is selected in the dropdown, HAC shows only that period's
// grade column populated — all others blank. We grab the FIRST numeric cell.
function parseRCGrades(html) {
  const $ = cheerio.load(html);
  const grades = new Map();

  // Find the main table — try specific selectors first, then any table
  let rows = $('#plnMain table tr');
  if (!rows.length) rows = $('table.sg-asp-table tr');
  if (!rows.length) rows = $('table tr');

  rows.each((_, row) => {
    const $row = $(row);
    if ($row.find('th').length) return;

    const cells = $row.find('td');
    if (cells.length < 2) return;

    const rawName = $(cells[0]).text().trim();
    if (!rawName || rawName.length < 6) return;

    // Must look like a course row: contains dept code pattern
    // e.g. "ELA12200B - 2    English 2 Adv S2"
    if (!/^[A-Z]{2,4}\d{3,}/.test(rawName)) return;

    // Find FIRST non-empty cell (after col 0) with a grade value 40–100
    let grade = null;
    for (let i = 1; i < cells.length; i++) {
      const txt = $(cells[i]).text().trim();
      if (/^\d{2,3}(\.\d+)?$/.test(txt)) {
        const n = parseFloat(txt);
        if (n >= 40 && n <= 100) { grade = n; break; }
      }
    }

    if (grade !== null) grades.set(rawName, grade);
  });

  return grades;
}

async function fetchPeriod(client, periodValue) {
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

function parseCurrentClasses(html) {
  const $ = cheerio.load(html);
  const classes = new Map();
  $('.AssignmentClass').each((_, el) => {
    const name = $(el).find('.sg-header-heading, a.sg-header-link').first().text().trim();
    const sub  = $(el).find('.sg-header-subheading').first().text().trim();
    const m    = sub.match(/([\d.]+)/);
    const avg  = m ? parseFloat(m[1]) : null;
    if (name && avg !== null) classes.set(name, avg);
  });
  return classes;
}

function normKey(s) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Main API ─────────────────────────────────────────────────────────────────
app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();

  try {
    await login(client, username, password);

    // 1. Get report card page — find all period dropdown options
    const rcInitRes = await client.get(RC_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $rcInit = cheerio.load(rcInitRes.data);

    const allPeriods = [];
    $rcInit('#plnMain_ddlRCRuns option').each((_, el) => {
      const value = $rcInit(el).attr('value');
      const label = $rcInit(el).text().trim();
      if (value && label) allPeriods.push({ value, label });
    });

    console.log('Periods:', allPeriods.map(p => `"${p.label}"=${p.value}`).join(', '));

    // 2. Map periods → Q1/Q2/Q3/Q4 by label matching then by position
    const quarterMap = {};
    const used = new Set();

    // First pass: match by label content
    for (let qi = 0; qi < 4; qi++) {
      const q   = `q${qi + 1}`;
      const num = String(qi + 1);
      const found = allPeriods.find(p =>
        !used.has(p.value) && (
          p.label === num ||
          p.label.toLowerCase() === `quarter ${num}` ||
          p.label.toLowerCase() === `mp${num}` ||
          p.label.toLowerCase() === `mp ${num}` ||
          new RegExp(`\\b${num}\\b`).test(p.label)
        )
      );
      if (found) { quarterMap[q] = found; used.add(found.value); }
    }

    // Second pass: fill gaps by position
    let pos = 0;
    for (let qi = 0; qi < 4; qi++) {
      const q = `q${qi + 1}`;
      if (!quarterMap[q]) {
        while (pos < allPeriods.length && used.has(allPeriods[pos].value)) pos++;
        if (pos < allPeriods.length) {
          quarterMap[q] = allPeriods[pos];
          used.add(allPeriods[pos].value);
          pos++;
        }
      }
    }

    console.log('Quarter map:', Object.entries(quarterMap).map(([q,p])=>`${q}="${p.label}"`).join(', '));

    // 3. Which period is currently displayed?
    const selectedVal = $rcInit('#plnMain_ddlRCRuns option[selected]').attr('value')
                     || allPeriods.at(-1)?.value;

    // 4. Fetch each quarter
    const quarterGrades = {}; // { q1: Map<rawName,grade>, ... }
    for (const [q, period] of Object.entries(quarterMap)) {
      try {
        const html = period.value === selectedVal
          ? rcInitRes.data
          : (await new Promise(r => setTimeout(r, 600)), await fetchPeriod(client, period.value));
        quarterGrades[q] = parseRCGrades(html);
        console.log(`${q} "${period.label}": ${quarterGrades[q].size} rows`);
      } catch (e) {
        console.error(`${q} error:`, e.message);
        quarterGrades[q] = new Map();
      }
    }

    // 5. Live grades
    let liveGrades = new Map();
    try {
      liveGrades = parseCurrentClasses((await client.get(CW_URL)).data);
    } catch (e) { console.error('Live grades error:', e.message); }

    // 6. Student info
    let student = { name: '', grade: '', campus: '' };
    try {
      student = parseStudentInfo((await client.get(INFO_URL)).data);
    } catch (e) { console.error('Student info error:', e.message); }

    // 7. Build course list
    // KEY INSIGHT: courses come in A/B pairs:
    //   MTH45300A = Math Sem1 → Q1 and Q2 grades live here
    //   MTH45300B = Math Sem2 → Q3 and Q4 grades live here
    // We merge them into ONE row keyed by clean name (without S1/S2).

    // Collect all raw names
    const allRaw = new Set();
    Object.values(quarterGrades).forEach(m => m.forEach((_, k) => allRaw.add(k)));
    liveGrades.forEach((_, k) => allRaw.add(k));

    // Build per-rawName grade lookup
    function gradeFor(q, rawName) {
      const m = quarterGrades[q];
      if (!m) return null;
      if (m.has(rawName)) return m.get(rawName);
      // fuzzy match
      const nk = normKey(cleanName(rawName));
      for (const [k, v] of m) {
        if (normKey(cleanName(k)) === nk) return v;
      }
      return null;
    }

    function liveFor(rawName) {
      if (liveGrades.has(rawName)) return liveGrades.get(rawName);
      const nk = normKey(cleanName(rawName));
      for (const [k, v] of liveGrades) {
        if (normKey(cleanName(k)) === nk) return v;
      }
      return null;
    }

    // Group raw names by base course key + semester (A or B)
    // merged[baseKey] = { name, semA: {rawName, q1, q2}, semB: {rawName, q3, q4} }
    const merged = new Map();

    allRaw.forEach(rawName => {
      const name = cleanName(rawName);
      if (!name || name.length < 3) return;

      const sem = courseSemester(rawName); // 'A', 'B', or null
      const key = courseBaseKey(name);

      if (!merged.has(key)) merged.set(key, { name, q1: null, q2: null, q3: null, q4: null });
      const entry = merged.get(key);

      if (sem === 'A' || sem === null) {
        // Semester A courses hold Q1 and Q2
        const q1 = gradeFor('q1', rawName);
        const q2 = gradeFor('q2', rawName);
        if (q1 !== null) entry.q1 = q1;
        if (q2 !== null) entry.q2 = q2;
        // If still no Q1/Q2 from report card, check live (less likely but possible)
      }

      if (sem === 'B' || sem === null) {
        // Semester B courses hold Q3 and Q4
        const q3 = gradeFor('q3', rawName);
        const q4 = gradeFor('q4', rawName) ?? liveFor(rawName);
        if (q3 !== null) entry.q3 = q3;
        if (q4 !== null) entry.q4 = q4;
      }

      // Year-long (sem===null): try all quarters
      if (sem === null) {
        entry.q1 = entry.q1 ?? gradeFor('q1', rawName);
        entry.q2 = entry.q2 ?? gradeFor('q2', rawName);
        entry.q3 = entry.q3 ?? gradeFor('q3', rawName);
        entry.q4 = entry.q4 ?? gradeFor('q4', rawName) ?? liveFor(rawName);
      }
    });

    const courses = [];
    merged.forEach(({ name, q1, q2, q3, q4 }) => {
      if ([q1, q2, q3, q4].every(v => v === null)) return;
      courses.push({ name, q1avg: q1, q2avg: q2, q3avg: q3, q4avg: q4 });
    });

    // Fallback: live only
    if (!courses.length && liveGrades.size > 0) {
      liveGrades.forEach((avg, rawName) => {
        const name = cleanName(rawName);
        if (name) courses.push({ name, q1avg: null, q2avg: null, q3avg: null, q4avg: avg });
      });
    }

    if (!courses.length)
      return res.status(404).json({ error: 'No grade data found.' });

    res.json({ student, courses });

  } catch (err) {
    console.error('Error:', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown error.' });
  }
});

app.get('/',           (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));

// ── DIAGNOSTIC: dump raw HAC page structure ──────────────────────────────────
app.post('/api/diagnose', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();
  try {
    await login(client, username, password);

    // Get report card page
    const rcRes = await client.get(RC_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $rc = cheerio.load(rcRes.data);

    // 1. Dropdown options
    const periods = [];
    $rc('#plnMain_ddlRCRuns option').each((_, el) => {
      periods.push({ value: $rc(el).attr('value'), label: $rc(el).text().trim(), selected: !!$rc(el).attr('selected') });
    });

    // 2. First 3 data rows of the RC table (raw cell text)
    const tableRows = [];
    $rc('table tr').each((ri, row) => {
      if (ri > 10) return false;
      const cells = [];
      $rc(row).find('td, th').each((_, td) => cells.push($rc(td).text().trim().substring(0, 40)));
      if (cells.length > 1) tableRows.push(cells);
    });

    // 3. All element IDs on Registration page that might contain name/grade
    const infoRes = await client.get(INFO_URL);
    const $info = cheerio.load(infoRes.data);
    const infoIds = [];
    $info('[id]').each((_, el) => {
      const id  = $info(el).attr('id');
      const txt = $info(el).text().trim().substring(0, 60);
      if (txt && txt.length > 1 && txt.length < 60 && !/[\n\r]{2}/.test(txt)) {
        infoIds.push({ id, text: txt });
      }
    });

    // 4. Live classwork raw HTML snippet
    const cwRes = await client.get(CW_URL);
    const $cw = cheerio.load(cwRes.data);
    const cwClasses = [];
    $cw('.AssignmentClass').each((i, el) => {
      if (i > 4) return false;
      cwClasses.push({
        heading:    $cw(el).find('.sg-header-heading, a.sg-header-link').first().text().trim(),
        subheading: $cw(el).find('.sg-header-subheading').first().text().trim(),
      });
    });

    res.json({ periods, tableRows, infoIds, cwClasses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
