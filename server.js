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
// HAC raw course name formats seen in Frisco ISD:
//   "ELA12200B - 2    English 2 Adv S2"
//   "MTH4SB301A - 1  AP Calculus AB S1"
//   "CSC21100A - 3   AP Computer Science A S1"
//   "SST85300A - 2   AP World History S1"
//   "SCI34500B - 4   Chemistry Adv S2"
//   "PE  Athletics"     (no code, already clean)
//
// Strategy: AGGRESSIVELY strip any leading course-code block, defined as
// one or more "tokens" that look like codes (all-caps+digits, or pure digits)
// followed by optional " - DIGIT(s)" section number, then whitespace.
// Everything after that whitespace is the human name.
// ─────────────────────────────────────────────────────────────────────────────
function cleanName(raw) {
  if (!raw) return '';
  let name = raw.trim();

  // Pattern: CODE[A-Z]? OPTIONAL_SPACE - OPTIONAL_SPACE DIGIT(s) TWO+SPACES REST
  // Handles: "SST85300A - 2    Social Studies..." and "MTH4SB301A - 1  AP Calc..."
  // The key is: dept-code is all uppercase letters+digits, ends with optional letter,
  // then " - N " or just "  " (two+ spaces) separator before the real name.
  const m = name.match(
    /^[A-Z]{1,6}[0-9][A-Z0-9]*[A-Z]?\s*(?:-\s*\d+)?\s{2,}(.+)$/
  );
  if (m) {
    name = m[1].trim();
  } else {
    // Fallback: if the string starts with a code token (letters+digits) followed
    // by a single space + dash + space pattern, strip it
    const m2 = name.match(/^[A-Z]{2,6}\d{3,}[A-Z]?\s*-\s*\d+\s+(.+)$/);
    if (m2) name = m2[1].trim();
  }

  // Strip trailing semester marker " S1" or " S2" (case-insensitive)
  name = name.replace(/\s+S[12]\s*$/i, '').trim();

  // Strip trailing period/section marker " - Per 3" or " Period 2"
  name = name.replace(/\s*[-–]?\s*(period|per)\s*\d+\s*$/i, '').trim();

  // Collapse any internal double-spaces left over
  name = name.replace(/\s{2,}/g, ' ').trim();

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

  // ── Find the main grade table ─────────────────────────────────────────
  // From the diagnose output we know the real table ID is plnMain_dgReportCard.
  // Fall back through a list of known selectors for other HAC versions.
  let $table = $('#plnMain_dgReportCard');
  if (!$table.length) $table = $('#plnMain_dgRCDetails');
  if (!$table.length) $table = $('table.sg-asp-table').first();
  if (!$table.length) $table = $('#plnMain table').first();
  if (!$table.length) $table = $('table').first();

  // ── Read header row → build colMap ───────────────────────────────────
  // Real header (from diagnose):
  //  col 0  Course
  //  col 1  Description   ← actual class name lives here
  //  col 2  Period
  //  col 3  Teacher
  //  col 4  Room
  //  col 5  Att.Credit
  //  col 6  Ern.Credit
  //  col 7  Q1
  //  col 8  Q2
  //  col 9  SEM1
  //  col 10 Q3
  //  col 11 Q4
  //  col 12 SEM2
  //  col 13 FIN  ...
  const headerCells = [];
  $table.find('tr').first().find('th, td').each((i, el) => {
    headerCells.push($(el).text().trim().toUpperCase());
  });
  console.log('[RC headers]', headerCells);

  // Map quarter labels → column index using the real header text.
  // We match against exact labels first, then broader patterns as fallback.
  const QUARTER_LABELS = {
    q1: [ /^Q1$/, /^QUARTER\s*1$/, /^MP\s*1$/, /^1$/, /NINE.?WEEKS.?1/, /SIX.?WEEKS.?1/ ],
    q2: [ /^Q2$/, /^QUARTER\s*2$/, /^MP\s*2$/, /^2$/, /NINE.?WEEKS.?2/, /SIX.?WEEKS.?2/ ],
    q3: [ /^Q3$/, /^QUARTER\s*3$/, /^MP\s*3$/, /^3$/, /NINE.?WEEKS.?3/, /SIX.?WEEKS.?3/ ],
    q4: [ /^Q4$/, /^QUARTER\s*4$/, /^MP\s*4$/, /^4$/, /NINE.?WEEKS.?4/, /SIX.?WEEKS.?4/ ],
  };

  const colMap   = {};   // { q1: 7, q2: 8, q3: 10, q4: 11 }
  const usedCols = new Set();

  for (const [q, patterns] of Object.entries(QUARTER_LABELS)) {
    for (let i = 0; i < headerCells.length; i++) {
      if (usedCols.has(i)) continue;
      if (patterns.some(re => re.test(headerCells[i]))) {
        colMap[q] = i;
        usedCols.add(i);
        break;
      }
    }
  }

  // Also note where Description (name) column is — default col 1
  let nameCol = headerCells.indexOf('DESCRIPTION');
  if (nameCol === -1) nameCol = 1; // safe fallback

  // Positional fallback if header matching got < 2 quarters
  if (Object.keys(colMap).length < 2) {
    console.warn('[RC] < 2 quarter cols matched by header, using positional scan');
    const numericCols = [];
    $table.find('tr').each((ri, row) => {
      if (ri === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 8) return;
      // Look for a row that starts with a course code in col 0
      const code = $(cells[0]).text().trim();
      if (!/^[A-Z]{2,}[\dA-Z]{2,}/.test(code)) return;
      cells.each((ci, cell) => {
        if (ci < 2) return; // skip code + description cols
        const txt = $(cell).text().trim();
        if (/^\d{2,3}(\.\d+)?$/.test(txt)) {
          const n = parseFloat(txt);
          if (n >= 40 && n <= 100) numericCols.push(ci);
        }
      });
      return false; // only check first data row
    });
    console.log('[RC] positional numeric cols:', numericCols);
    ['q1','q2','q3','q4'].forEach((q, i) => {
      if (colMap[q] === undefined && numericCols[i] !== undefined) {
        colMap[q] = numericCols[i];
      }
    });
  }

  console.log('[RC colMap]', colMap, '| nameCol:', nameCol);

  // ── Parse every data row ──────────────────────────────────────────────
  // result: Map< courseCode, { name, sem, q1, q2, q3, q4 } >
  //   courseCode = col 0 text (e.g. "MTH45300A - 3")
  //   name       = col 1 Description, stripped of trailing " S1"/" S2"
  //   sem        = 'A' (sem1 course), 'B' (sem2 course), or null (year-long)
  const result = new Map();

  $table.find('tr').each((ri, row) => {
    if (ri === 0) return; // skip header

    const cells = $(row).find('td');
    if (cells.length < 8) return;

    const courseCode = $(cells[0]).text().trim();
    if (!courseCode || !/^[A-Z]{2,}[\dA-Z]{2,}/.test(courseCode)) return;

    // ── Real class name from Description column ──────────────────────
    let displayName = $(cells[nameCol]).text().trim();
    // Strip trailing " S1" or " S2"
    displayName = displayName.replace(/\s+S[12]\s*$/i, '').trim();
    if (!displayName) displayName = cleanName(courseCode); // last resort

    // ── Semester from course code suffix (A = sem1, B = sem2) ────────
    const semMatch = courseCode.match(/^[A-Z]{2,}[\dA-Z]*?([AB])\s*[-\s]/i);
    const sem = semMatch ? semMatch[1].toUpperCase() : null;

    // ── Read grade columns ────────────────────────────────────────────
    const entry = { name: displayName, sem, q1: null, q2: null, q3: null, q4: null };

    for (const [q, colIdx] of Object.entries(colMap)) {
      const cell = cells[colIdx];
      if (!cell) continue;
      const txt = $(cell).text().trim();
      if (/^\d{2,3}(\.\d{1,2})?$/.test(txt)) {
        const n = parseFloat(txt);
        if (n >= 0 && n <= 100) entry[q] = n;
      }
    }

    if (Object.values(entry).some((v, k) => k !== 'name' && k !== 'sem' && v !== null)) {
      result.set(courseCode, entry);
    }
  });

  console.log('[RC parseAll]', result.size, 'rows |',
    'q1:', [...result.values()].filter(r => r.q1 !== null).length,
    'q2:', [...result.values()].filter(r => r.q2 !== null).length,
    'q3:', [...result.values()].filter(r => r.q3 !== null).length,
    'q4:', [...result.values()].filter(r => r.q4 !== null).length,
  );

  return result; // Map<courseCode, { name, sem, q1, q2, q3, q4 }>
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
    //   ELA12200A → "English 2 Adv" with Q1 & Q2 grades (Q3/Q4 blank)
    //   ELA12200B → "English 2 Adv" with Q3 & Q4 grades (Q1/Q2 blank)
    //
    // rcRows now carries { name, sem, q1, q2, q3, q4 } where:
    //   name = already-clean Description column value (e.g. "English 2 Adv")
    //   sem  = 'A' (sem1), 'B' (sem2), or null (year-long)
    //
    function liveFor(displayName) {
      const target = normKey(displayName);
      for (const [k, v] of liveGrades) {
        if (normKey(cleanName(k)) === target || normKey(k) === target) return v;
      }
      return null;
    }

    const merged = new Map(); // baseKey → { name, q1, q2, q3, q4 }

    rcRows.forEach(({ name, sem, q1, q2, q3, q4 }) => {
      if (!name || name.length < 2) return;

      const key = courseBaseKey(name); // already clean — no need to re-clean

      if (!merged.has(key)) {
        merged.set(key, { name, q1: null, q2: null, q3: null, q4: null });
      }
      const entry = merged.get(key);

      if (sem === 'A') {
        // Semester 1 course: contributes Q1 and Q2
        if (q1 !== null) entry.q1 = q1;
        if (q2 !== null) entry.q2 = q2;
      } else if (sem === 'B') {
        // Semester 2 course: contributes Q3 and Q4
        if (q3 !== null) entry.q3 = q3;
        if (q4 !== null) entry.q4 = q4;
        if (entry.q4 === null) entry.q4 = liveFor(name);
      } else {
        // Year-long: take whatever is populated
        if (q1 !== null) entry.q1 = q1;
        if (q2 !== null) entry.q2 = q2;
        if (q3 !== null) entry.q3 = q3;
        if (q4 !== null) entry.q4 = q4;
        if (entry.q4 === null) entry.q4 = liveFor(name);
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
        quarterMap: Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.value])),
        quarterLabels: Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.label])),
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
// TRANSCRIPT — URL + course name expansion lookup
// ─────────────────────────────────────────────────────────────────────────────
const TRANSCRIPT_URL = `${HAC_BASE}/HomeAccess/Content/Student/Transcript.aspx`;

const COURSE_LOOKUP = {
  // Math
  'ALG 1':'Algebra 1','ALG 2':'Algebra 2','GEOM':'Geometry',
  'APCALCAB':'AP Calculus AB','APCALCBC':'AP Calculus BC',
  'AP Precalculus':'AP Precalculus','PRECALC':'Pre-Calculus',
  'STATS':'Statistics','APSTATS':'AP Statistics',
  // Science
  'BIO':'Biology','APBIO':'AP Biology','CHEM':'Chemistry',
  'Chemistry':'Chemistry','APCHEM':'AP Chemistry',
  'APPHYS1':'AP Physics 1','APPHYS2':'AP Physics 2',
  'APPHYSC':'AP Physics C: Mechanics','PHYS':'Physics',
  // English
  'ENG 1':'English 1','ENG 2':'English 2','ENG 3':'English 3','ENG 4':'English 4',
  'APLANG':'AP Language & Composition','APLIT':'AP Literature & Composition',
  // Social Studies
  'APHUMGEOW':'AP Human Geography','APWHIST':'AP World History',
  'APUSHIST':'AP US History','APGOV':'AP Government & Politics',
  'APECON':'AP Economics','APPSYCH':'AP Psychology',
  'APSEM':'AP Seminar','APRES':'AP Research',
  'APSPALAN':'AP Spanish Language & Culture',
  // Language
  'SPAN 3':'Spanish 3','SPAN 4':'Spanish 4',
  'LOTE Level I - Spanish':'Spanish I','LOTE Level II - Spanish':'Spanish II',
  // CS / Tech
  'APTACSAM':'AP Computer Science A (S1)','APTACSAL':'AP Computer Science A (S2)',
  'APCSA':'AP Computer Science A',
  'TACS1':'Computer Science I','TACS2':'Computer Science II',
  'AP Computer Science 1 WL':'AP Computer Science 1',
  // Other
  'PROFCOMM':'Professional Communications','HLTHED1':'Health Education',
  'SS RES3':'Student Success (S1)','SS RES4':'Student Success (S2)',
};

function expandCourseName(raw) {
  if (!raw) return raw;
  return COURSE_LOOKUP[raw.trim()] || raw.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE TRANSCRIPT PAGE
// Returns { gpa, years }
//   gpa:   { weighted, college, rank }
//   years: [{ year, grade, building, totalCredit, courses: [{code,name,sem1,sem2,fin,credit}] }]
// ─────────────────────────────────────────────────────────────────────────────
function parseTranscript(html) {
  const $ = cheerio.load(html);

  // ── GPA & Rank from plnMain_rpTranscriptGroup_tblCumGPAInfo ──────────
  const gpa = { weighted: null, college: null, rank: null };
  $('#plnMain_rpTranscriptGroup_tblCumGPAInfo tr').each((ri, row) => {
    if (ri === 0) return;
    const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    const label = (cells[0] || '').toLowerCase();
    if (label.includes('weighted')) {
      if (cells[1]) gpa.weighted = cells[1];
      if (cells[2]) gpa.rank     = cells[2];
    } else if (label.includes('4.0') || label.includes('college')) {
      if (cells[1]) gpa.college = cells[1];
    }
  });

  // ── Year groups — plnMain_rpTranscriptGroup_dgCourses_0, _1, _2 ... ──
  // Collect all year strings and building strings from the page in order
  // so we can index them by group number.
  const allYears     = [];
  const allBuildings = [];
  $('td').each((_, el) => {
    const txt = $(el).text().trim();
    if (/^\d{4}-\d{4}$/.test(txt))                        allYears.push(txt);
    if (/high school|middle school|summer/i.test(txt) && txt.length < 60) allBuildings.push(txt);
  });

  const years = [];
  let idx = 0;
  while (true) {
    const $ct = $(`#plnMain_rpTranscriptGroup_dgCourses_${idx}`);
    if (!$ct.length) break;

    const grade  = $(`#plnMain_rpTranscriptGroup_lblGradeValue_${idx}`).text().trim();
    const credit = $(`#plnMain_rpTranscriptGroup_LblTCreditValue_${idx}`).text().trim();
    const year   = allYears[idx]     || '';
    const building = allBuildings[idx] || '';

    // Parse course rows (skip header row ri=0)
    const courses = [];
    $ct.find('tr').each((ri, row) => {
      if (ri === 0) return;
      const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length < 4) return;
      const code    = cells[0];
      const rawName = cells[1];
      if (!code || !rawName) return;
      const sem1   = cells[2] !== '' ? parseFloat(cells[2]) : null;
      const sem2   = cells[3] !== '' ? parseFloat(cells[3]) : null;
      const fin    = cells[4] !== '' ? parseFloat(cells[4]) : null;
      const cred   = cells[5] !== '' ? parseFloat(cells[5]) : null;
      // Skip rows with no grades at all (e.g. in-progress S2 not yet graded)
      if (sem1 === null && sem2 === null && fin === null) return;
      courses.push({
        code,
        name:   expandCourseName(rawName),
        sem1,
        sem2,
        fin,
        credit: cred,
      });
    });

    years.push({ year, grade, building, totalCredit: parseFloat(credit) || 0, courses });
    idx++;
  }

  years.sort((a, b) => (a.year || '').localeCompare(b.year || ''));
  return { gpa, years };
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/transcript
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/transcript', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const tRes = await client.get(TRANSCRIPT_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const transcript = parseTranscript(tRes.data);
    if (!transcript.years.length)
      return res.status(404).json({ error: 'No transcript data found.' });
    console.log('[transcript] GPA:', transcript.gpa, '| years:', transcript.years.length);
    res.json(transcript);
  } catch (err) {
    console.error('[/api/transcript]', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/diagnose-transcript  (keep for debugging)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/diagnose-transcript', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const tRes = await client.get(TRANSCRIPT_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $ = cheerio.load(tRes.data);
    const tables = [];
    $('table').each((ti, table) => {
      const rows = [];
      $(table).find('tr').each((ri, row) => {
        if (ri > 30) return false;
        const cells = [];
        $(row).find('td, th').each((_, td) => cells.push($(td).text().trim().substring(0, 80)));
        if (cells.some(c => c.length)) rows.push(cells);
      });
      if (rows.length) tables.push({ tableIndex: ti, id: $(table).attr('id') || '', rows });
    });
    res.json({ tables });
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

// ─────────────────────────────────────────────────────────────────────────────
// PARSE ASSIGNMENTS PAGE — all classes, all assignment rows
//
// HAC structure on Assignments.aspx:
//   .AssignmentClass          — one block per class
//     .sg-header-heading / a.sg-header-link  — class name
//     .sg-header-subheading                  — "Period X  |  Teacher  |  Avg: XX.X"
//     table.sg-asp-table-data-odd/even        — assignment rows
//       tr  — one row per assignment
//         td[0] Date Due
//         td[1] Date Assigned
//         td[2] Assignment name (may have <a>)
//         td[3] Category
//         td[4] Score
//         td[5] Total Points
// ─────────────────────────────────────────────────────────────────────────────
function parseAssignments(html) {
  const $ = cheerio.load(html);
  const classes = [];

  $('.AssignmentClass').each((_, classEl) => {
    const $cls = $(classEl);

    // Class name
    const name = $cls.find('.sg-header-heading, a.sg-header-link').first().text().trim();
    if (!name) return;

    // Subheading: "Period 1  |  TEACHER NAME  |  Student Avg: 97.50"
    const sub = $cls.find('.sg-header-subheading').first().text().trim();
    const avgMatch = sub.match(/avg[:\s]*([\d.]+)/i);
    const avg = avgMatch ? parseFloat(avgMatch[1]) : null;

    // Assignments table rows
    const assignments = [];
    $cls.find('table tr').each((ri, row) => {
      const $row = $(row);
      // Skip header rows
      if ($row.find('th').length > 0) return;
      const cells = $row.find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length < 5) return;

      const dateDue      = cells[0] || '';
      const dateAssigned = cells[1] || '';
      const assignName   = cells[2] || '';
      const category     = cells[3] || '';
      const scoreRaw     = cells[4] || '';
      const totalRaw     = cells[5] || '';

      if (!assignName || assignName.toLowerCase() === 'assignment') return;

      // Parse score — could be "100.0", "100.0 / 100.0", "INC", "--", etc.
      let score = null, total = null;
      const scoreNum = parseFloat(scoreRaw);
      const totalNum = parseFloat(totalRaw);
      if (!isNaN(scoreNum)) score = scoreNum;
      if (!isNaN(totalNum)) total = totalNum;

      assignments.push({ dateDue, dateAssigned, name: assignName, category, score, total });
    });

    classes.push({ name, avg, subheading: sub, assignments });
  });

  return classes;
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/assignments  — returns all assignments for the current/selected marking period
// Query params: ?period=VALUE  (the dropdown value from RC runs, e.g. "1", "2" etc.)
// Without period param: returns current classwork page as-is (current quarter)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/assignments', async (req, res) => {
  const { username, password, period } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();
  try {
    await login(client, username, password);

    let html;
    if (period) {
      // HAC Assignments page also has a marking period dropdown
      // First GET to get the form fields and available options
      const getRes = await client.get(CW_URL, {
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      const $init = cheerio.load(getRes.data);

      // Find the marking period dropdown on the assignments page
      // It's usually named "ctl00$plnMain$ddlReportCardRuns" or similar
      const ddlName = $init('select[name*="ddlReportCard"], select[name*="ddlMarking"], select[name*="ddlPeriod"]').attr('name')
                   || 'ctl00$plnMain$ddlReportCardRuns';

      const selectedVal = $init(`select[name="${ddlName}"] option[selected]`).attr('value') || '';

      // If already the right period, use current HTML
      if (selectedVal === period) {
        html = getRes.data;
      } else {
        // POST to switch period
        const fields = {
          __EVENTTARGET:        $init('input[name="__EVENTTARGET"]').val()        || 'ctl00$plnMain$ddlReportCardRuns',
          __EVENTARGUMENT:      $init('input[name="__EVENTARGUMENT"]').val()      || '',
          __VIEWSTATE:          $init('input[name="__VIEWSTATE"]').val()          || '',
          __VIEWSTATEGENERATOR: $init('input[name="__VIEWSTATEGENERATOR"]').val() || '',
          __EVENTVALIDATION:    $init('input[name="__EVENTVALIDATION"]').val()    || '',
          [ddlName]: period,
        };
        const postRes = await client.post(CW_URL, new URLSearchParams(fields).toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: CW_URL,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        html = postRes.data;
      }
    } else {
      const getRes = await client.get(CW_URL, {
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      html = getRes.data;
    }

    // Also grab the available period options so the client can show a switcher
    const $page = cheerio.load(html);
    const periods = [];
    $page('select[name*="ddlReportCard"] option, select[name*="ddlMarking"] option, select[name*="ddlPeriod"] option').each((_, el) => {
      periods.push({
        value:    $page(el).attr('value'),
        label:    $page(el).text().trim(),
        selected: !!$page(el).attr('selected'),
      });
    });

    const classes = parseAssignments(html);
    if (!classes.length)
      return res.status(404).json({ error: 'No assignment data found.' });

    console.log('[assignments] period:', period || 'current', '| classes:', classes.length);
    res.json({ periods, classes });

  } catch (err) {
    console.error('[/api/assignments]', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});
