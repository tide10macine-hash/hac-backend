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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── HTTP client with cookie jar ──────────────────────────────────────────────
function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar, withCredentials: true, maxRedirects: 10, timeout: 30000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  }));
}

// ── Login ────────────────────────────────────────────────────────────────────
async function login(client, username, password) {
  const getRes = await client.get(LOGIN_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const $   = cheerio.load(getRes.data);
  const tok = $('input[name="__RequestVerificationToken"]').val();
  if (!tok) throw new Error('Could not load HAC login page — site may be down.');

  const body = new URLSearchParams({
    '__RequestVerificationToken':  tok,
    'SCKTY00328510CustomEnabled':  'False',
    'SCKTY00436568CustomEnabled':  'False',
    'Database':                    '10',
    'VerificationOption':          'UsernamePassword',
    'LogOnDetails.UserName':       username,
    'LogOnDetails.Password':       password,
  });

  const postRes = await client.post(LOGIN_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      LOGIN_URL,
      'Accept':       'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const $p      = cheerio.load(postRes.data);
  const errText = $p('.validation-summary-errors li, #ErrorMessage').text().trim().toLowerCase();
  if (errText && (errText.includes('invalid') || errText.includes('incorrect')))
    throw new Error('Incorrect username or password.');

  const finalUrl  = postRes.request?.res?.responseUrl || '';
  const onLogin   = finalUrl.toLowerCase().includes('logon');
  const hasLogout = $p('a[href*="LogOff"], a[href*="logoff"]').length > 0;
  const hasMain   = $p('#plnMain, .sg-banner, .sg-header').length > 0;
  if (onLogin && !hasLogout && !hasMain)
    throw new Error('Incorrect username or password.');
}

// ── ASP.NET form fields ──────────────────────────────────────────────────────
function extractFormFields($) {
  return {
    __EVENTTARGET:        $('input[name="__EVENTTARGET"]').val()        || '',
    __EVENTARGUMENT:      $('input[name="__EVENTARGUMENT"]').val()      || '',
    __VIEWSTATE:          $('input[name="__VIEWSTATE"]').val()          || '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').val() || '',
    __EVENTVALIDATION:    $('input[name="__EVENTVALIDATION"]').val()    || '',
  };
}

// ── Strip course-code prefix ─────────────────────────────────────────────────
// "ELA12200B - 2    English 2 Adv S2"  →  "English 2 Adv S2"
// "MTH45300A - 3    AP Calculus AB S1" →  "AP Calculus AB S1"
function cleanName(raw) {
  if (!raw) return '';
  const m = raw.match(/^[A-Z0-9]+-\s*\d+\s{2,}(.+)$/) ||  // two or more spaces after period#
            raw.match(/^[A-Z0-9]+\s+-\s+\d+\s+(.+)$/);     // spaces around dash
  return m ? m[1].trim() : raw.trim();
}

// ── Student info ─────────────────────────────────────────────────────────────
function parseStudentInfo(html) {
  const $ = cheerio.load(html);

  // HAC Registration page uses ids like "plnMain_lblRegStudentName" etc.
  // Try several known patterns
  const nameEl =
    $('[id$="StudentName"], [id$="lblName"], [id*="RegStudent"]').first().text().trim() ||
    $('span:contains("Name")').closest('tr').find('td').last().text().trim() ||
    '';

  const gradeEl =
    $('[id$="GradeLevel"], [id$="lblGrade"], [id*="Grade"]').first().text().trim() || '';

  const campusEl =
    $('[id$="BuildingName"], [id$="lblCampus"], [id$="lblSchool"], [id*="Campus"], [id*="School"]')
      .first().text().trim() || '';

  return { name: nameEl, grade: gradeEl, campus: campusEl };
}

// ── Parse ONE report card page ───────────────────────────────────────────────
//
// HAC's report card table looks like:
//
//  | Course Description         | MP1 | MP2 | MP3 | MP4 | Exam | Sem | Exam | Sem | Cit | Cit | Cit | Cit |
//  | ELA12200B - 2  English ... | 99  |     |     |     |      |     |      |     |     |     |     |     |
//
// When a specific period is selected via the dropdown, ONLY that period's column
// has a grade; all others are blank.  So we just find the FIRST non-empty numeric
// cell after the course-name cell — that is the grade for the selected period.
//
// Returns Map<rawCourseName, grade>
function parseRCGrades(html) {
  const $      = cheerio.load(html);
  const grades = new Map();

  // The report card table is inside #plnMain or has class sg-asp-table
  const table = $('#plnMain table, table.sg-asp-table').first();
  const rows  = table.length ? table.find('tr') : $('table tr');

  rows.each((_, row) => {
    const $row = $(row);
    if ($row.find('th').length) return; // header row

    const cells = $row.find('td');
    if (cells.length < 2) return;

    // First cell = course code + name
    const rawName = $(cells[0]).text().trim();
    if (!rawName || rawName.length < 6) return;

    // Must contain a course-code pattern like "ELA12200B" or "MTH453"
    if (!/[A-Z]{2,4}\d{4,}/.test(rawName) && !/ - \d/.test(rawName)) return;

    // Find the first non-empty cell after col 0 that holds a grade (40-100)
    let grade = null;
    for (let i = 1; i < cells.length; i++) {
      const txt = $(cells[i]).text().trim();
      if (/^\d{2,3}(\.\d+)?$/.test(txt)) {
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

// ── Fetch a specific reporting period ────────────────────────────────────────
// Each postback must re-GET the page first to get fresh ASP.NET form tokens,
// then POST the dropdown change.
async function fetchPeriod(client, periodValue) {
  const getRes = await client.get(RC_URL, {
    headers: {
      Accept:  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: RC_URL,
    },
  });
  const $      = cheerio.load(getRes.data);
  const fields = extractFormFields($);

  const body = new URLSearchParams({
    ...fields,
    '__EVENTTARGET':             'ctl00$plnMain$ddlRCRuns',
    '__EVENTARGUMENT':           '',
    'ctl00$plnMain$ddlRCRuns':   periodValue,
  });

  const postRes = await client.post(RC_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer:        RC_URL,
      Accept:         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  return postRes.data;
}

// ── Parse live classwork averages ─────────────────────────────────────────────
function parseCurrentClasses(html) {
  const $       = cheerio.load(html);
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

// ── Normalise a cleaned name for fuzzy matching ───────────────────────────────
function normKey(s) {
  return s.toLowerCase()
          .replace(/\s+s[12]\s*$/i, '')  // strip trailing S1 / S2
          .replace(/\s+/g, ' ')
          .trim();
}

// ── Main API route ────────────────────────────────────────────────────────────
app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();

  try {
    await login(client, username, password);

    // ── 1. Get report card page and discover all periods ──────────────────
    const rcInitRes = await client.get(RC_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $rcInit = cheerio.load(rcInitRes.data);

    // Collect dropdown options: [{value, label}, ...]
    const allPeriods = [];
    $rcInit('#plnMain_ddlRCRuns option').each((_, el) => {
      const value = $rcInit(el).attr('value');
      const label = $rcInit(el).text().trim();
      if (value && label) allPeriods.push({ value, label });
    });

    console.log('All periods found:', allPeriods.map(p => `"${p.label}"=${p.value}`).join(', '));

    // ── 2. Map periods to Q1/Q2/Q3/Q4 by position ─────────────────────────
    // HAC always lists periods chronologically: period 1 = Q1, 2 = Q2, etc.
    // We take the first 4 (there may be more for semester exams etc.)
    // Label matching: if label contains "1"→Q1, "2"→Q2 etc.; fallback to index.
    const quarterMap = {};  // quarterMap['q1'] = { value, label }

    if (allPeriods.length >= 4) {
      // Try to identify which label corresponds to which quarter
      // by looking for "1", "2", "3", "4" inside the label text.
      const matched = [false, false, false, false];
      ['q1','q2','q3','q4'].forEach((q, qi) => {
        const target = String(qi + 1);
        const found  = allPeriods.find((p, pi) =>
          !matched[pi] &&
          (p.label === target ||
           p.label.toLowerCase().includes(`quarter ${target}`) ||
           p.label.toLowerCase().includes(`mp${target}`) ||
           p.label.toLowerCase().includes(`mp ${target}`) ||
           p.label.endsWith(target))
        );
        if (found) {
          quarterMap[q] = found;
          matched[allPeriods.indexOf(found)] = true;
        }
      });

      // Fallback: if matching failed, just use positional order (1st=Q1, 2nd=Q2 …)
      if (!quarterMap['q1'] && allPeriods.length >= 1) quarterMap['q1'] = allPeriods[0];
      if (!quarterMap['q2'] && allPeriods.length >= 2) quarterMap['q2'] = allPeriods[1];
      if (!quarterMap['q3'] && allPeriods.length >= 3) quarterMap['q3'] = allPeriods[2];
      if (!quarterMap['q4'] && allPeriods.length >= 4) quarterMap['q4'] = allPeriods[3];
    } else {
      // Fewer than 4 periods — map what we have
      allPeriods.slice(0, 4).forEach((p, i) => {
        quarterMap[`q${i+1}`] = p;
      });
    }

    console.log('Quarter mapping:',
      Object.entries(quarterMap).map(([q,p]) => `${q}→"${p.label}"(${p.value})`).join(', '));

    // ── 3. Determine which period is currently shown ───────────────────────
    const selectedVal = $rcInit('#plnMain_ddlRCRuns option[selected]').attr('value')
                     || allPeriods[allPeriods.length - 1]?.value;

    // ── 4. Fetch each quarter's page ──────────────────────────────────────
    const quarterGrades = {};  // quarterGrades['q1'] = Map<rawName, grade>

    for (const [q, period] of Object.entries(quarterMap)) {
      try {
        let html;
        if (period.value === selectedVal) {
          // Already have this page
          html = rcInitRes.data;
        } else {
          await new Promise(r => setTimeout(r, 600)); // polite delay
          html = await fetchPeriod(client, period.value);
        }
        quarterGrades[q] = parseRCGrades(html);
        console.log(`${q} ("${period.label}"): ${quarterGrades[q].size} courses`);
      } catch (e) {
        console.error(`${q} fetch error:`, e.message);
        quarterGrades[q] = new Map();
      }
    }

    // ── 5. Live classwork (current Q4 live grade, supplements report card) ──
    let liveGrades = new Map();
    try {
      const cwRes = await client.get(CW_URL);
      liveGrades  = parseCurrentClasses(cwRes.data);
      console.log(`Live classes: ${liveGrades.size}`);
    } catch (e) { console.error('Classwork error:', e.message); }

    // ── 6. Student info ───────────────────────────────────────────────────
    let student = { name: '', grade: '', campus: '' };
    try {
      const infoRes = await client.get(INFO_URL);
      student = parseStudentInfo(infoRes.data);
    } catch (e) { console.error('Info error:', e.message); }

    // ── 7. Build merged course list ───────────────────────────────────────
    // Collect all raw course names from every quarter + live
    const allRaw = new Set();
    Object.values(quarterGrades).forEach(m => m.forEach((_, k) => allRaw.add(k)));
    liveGrades.forEach((_, k) => allRaw.add(k));

    // Helper: look up grade across all sources for a raw course name
    function findGrade(map, rawName) {
      if (map.has(rawName)) return map.get(rawName);
      // Fuzzy: match by normalised clean name
      const nk = normKey(cleanName(rawName));
      for (const [k, v] of map) {
        if (normKey(cleanName(k)) === nk) return v;
      }
      return null;
    }

    const courses = [];
    allRaw.forEach(rawName => {
      const name = cleanName(rawName);
      if (!name || name.length < 3) return;

      const q1 = findGrade(quarterGrades['q1'] || new Map(), rawName);
      const q2 = findGrade(quarterGrades['q2'] || new Map(), rawName);
      const q3 = findGrade(quarterGrades['q3'] || new Map(), rawName);
      // Q4: prefer report card; fall back to live classwork
      const q4 = findGrade(quarterGrades['q4'] || new Map(), rawName)
              ?? findGrade(liveGrades, rawName);

      if ([q1, q2, q3, q4].every(v => v === null)) return;

      courses.push({
        name,
        q1avg: q1,
        q2avg: q2,
        q3avg: q3,
        q4avg: q4,
        avg:   q4 ?? q3 ?? q2 ?? q1,
      });
    });

    // Fallback: if report card scraped nothing, use live classes only
    if (!courses.length && liveGrades.size > 0) {
      liveGrades.forEach((avg, rawName) => {
        const name = cleanName(rawName);
        if (name) courses.push({ name, q1avg: null, q2avg: null, q3avg: null, q4avg: avg, avg });
      });
    }

    if (!courses.length)
      return res.status(404).json({ error: 'No grade data found. Check your credentials.' });

    res.json({
      student,
      courses,
      _debug: {
        allPeriods,
        quarterMap: Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.label])),
        quarterCounts: Object.fromEntries(
          Object.entries(quarterGrades).map(([q, m]) => [q, m.size])
        ),
        liveCount: liveGrades.size,
      },
    });

  } catch (err) {
    console.error('Fatal error:', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown error.' });
  }
});

app.get('/',           (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
