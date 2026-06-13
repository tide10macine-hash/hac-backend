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

const HAC_BASE  = process.env.HAC_BASE || 'https://hac.friscoisd.org';
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
// The student's own text content (excluding nested children), whitespace-collapsed.
function ownText($, el) {
  return $(el).clone().children().remove().end().text().trim().replace(/\s+/g, ' ');
}
// HAC renders the name as "LASTNAME, FIRSTNAME [MIDDLE]" — a strong signal.
const HAC_NAME_RE = /^[A-Z][A-Za-z.'\-]+,\s*[A-Z][A-Za-z.'\- ]+$/;

function parseStudentInfo(html) {
  const $ = cheerio.load(html);
  let name = '', grade = '', campus = '';

  // 1) Elements whose id clearly identifies the student name.
  const nameIdRe = /regstudentname|studentname|student.*name|chooser.*name|banner.*name|lblname/i;
  $('[id]').each((_, el) => {
    if (name) return;
    if (!nameIdRe.test($(el).attr('id') || '')) return;
    const t = $(el).text().trim().replace(/\s+/g, ' ');
    if (t && t.length >= 3 && t.length <= 60 && /[A-Za-z]/.test(t)) name = t;
  });

  // 2) HAC top banner / student chooser (present on every authenticated page).
  if (!name) {
    $('#sg-banner-chooser, .sg-banner-chooser, .sg-banner-chooser-current, [class*="chooser"], [class*="sg-banner"]').each((_, el) => {
      if (name) return;
      const t = $(el).text().trim().replace(/\s+/g, ' ');
      if (HAC_NAME_RE.test(t) && t.length <= 60) name = t;
    });
  }

  // 3) "Student Name" label → adjacent value cell.
  if (!name) {
    $('td, th, label, span, div').each((_, el) => {
      if (name) return;
      if (ownText($, el).toLowerCase() !== 'student name') return;
      const val = ($(el).closest('tr').find('td').last().text().trim()
                || $(el).next().text().trim() || '').replace(/\s+/g, ' ');
      if (val && val.length > 2 && val.length <= 60) name = val;
    });
  }

  // 4) Last resort: the first "Lastname, Firstname" string on the page.
  if (!name) {
    $('span, div, td, h1, h2, h3, a').each((_, el) => {
      if (name) return;
      const t = ownText($, el);
      if (HAC_NAME_RE.test(t) && t.length <= 45) name = t;
    });
  }

  // Grade level
  $('[id]').each((_, el) => {
    if (grade) return;
    if (!/grade.*level|lblgrade|gradelevel/.test(($(el).attr('id') || '').toLowerCase())) return;
    const t = $(el).text().trim();
    if (t && t.length < 30) grade = t;
  });

  // Campus / building
  $('[id]').each((_, el) => {
    if (campus) return;
    if (!/campus|building|school/.test(($(el).attr('id') || '').toLowerCase())) return;
    const t = $(el).text().trim();
    if (t && t.length > 2 && t.length < 50) campus = t;
  });

  return { name, grade, campus };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN API ROUTE
// ─────────────────────────────────────────────────────────────────────────────
// Fetch + merge all grade data for one logged-in session → { student, courses, _debug }.
async function getGradesData(client) {
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

    // Build quarterMap: map allPeriods dropdown options → q1/q2/q3/q4
    // Same matching logic as parseAllQuartersFromPage header matching
    const Q_PATTERNS = {
      q1: [ /^1$/, /quarter\s*1\b/i, /\bmp\s*1\b/i, /\b1st\b/i, /nine.?weeks.?1\b/i, /six.?weeks.?1\b/i, /^q1$/i ],
      q2: [ /^2$/, /quarter\s*2\b/i, /\bmp\s*2\b/i, /\b2nd\b/i, /nine.?weeks.?2\b/i, /six.?weeks.?2\b/i, /^q2$/i ],
      q3: [ /^3$/, /quarter\s*3\b/i, /\bmp\s*3\b/i, /\b3rd\b/i, /nine.?weeks.?3\b/i, /six.?weeks.?3\b/i, /^q3$/i ],
      q4: [ /^4$/, /quarter\s*4\b/i, /\bmp\s*4\b/i, /\b4th\b/i, /nine.?weeks.?4\b/i, /six.?weeks.?4\b/i, /^q4$/i ],
    };
    const quarterMap = {};
    const usedQVals  = new Set();
    for (const [q, pats] of Object.entries(Q_PATTERNS)) {
      const match = allPeriods.find(p => !usedQVals.has(p.value) && pats.some(re => re.test(p.label.trim())));
      if (match) { quarterMap[q] = match; usedQVals.add(match.value); }
    }
    // Positional fallback: assign remaining periods in order to unfilled quarters
    const unmatched = allPeriods.filter(p => !usedQVals.has(p.value));
    ['q1','q2','q3','q4'].filter(q => !quarterMap[q]).forEach((q, i) => {
      if (unmatched[i]) { quarterMap[q] = unmatched[i]; usedQVals.add(unmatched[i].value); }
    });
    console.log('[quarterMap]', Object.entries(quarterMap).map(([q,p])=>`${q}="${p.label}"(${p.value})`).join(' '));

    // Fetch Assignments page dropdown to map quarter labels → assignment period values
    // RC uses values like "1","2","3","4" but Assignments page uses "1-2026","2-2026" etc.
    let assignPeriodMap = {}; // { '1': '1-2026', '2': '2-2026', ... } keyed by RC label
    try {
      const cwInitRes = await client.get(CW_URL, {
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      const $cw = cheerio.load(cwInitRes.data);
      $cw('#plnMain_ddlReportCardRuns option').each((_, el) => {
        const val   = $cw(el).attr('value') || '';
        const lbl   = $cw(el).text().trim();
        if (val && val !== 'ALL') assignPeriodMap[lbl] = val;
      });
      console.log('[assignPeriodMap]', JSON.stringify(assignPeriodMap));
    } catch (e) {
      console.error('[assignPeriodMap]', e.message);
    }


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
    // Fallback: the report card page (already loaded) carries the student name in
    // its header banner — use it if the Registration page didn't yield one.
    if (!student.name || !student.grade) {
      try {
        const s2 = parseStudentInfo(rcRes.data);
        if (!student.name)   student.name   = s2.name;
        if (!student.grade)  student.grade  = s2.grade;
        if (!student.campus) student.campus = s2.campus;
      } catch (_) { /* ignore */ }
    }
    console.log('[student]', JSON.stringify(student));

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

    courses.sort((a, b) => a.name.localeCompare(b.name));
    console.log('[result]', courses.length, 'courses');

    return {
      student,
      courses,
      _debug: {
        allPeriods,
        quarterMap: Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.value])),
        quarterLabels: Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.label])),
        assignQuarterMap: Object.fromEntries(
          Object.entries(quarterMap).map(([q,p]) => [q, assignPeriodMap[p.label] || p.value])
        ),
        rcRowCount: rcRows.size,
        mergedCount: courses.length,
        liveCount: liveGrades.size,
        sampleRows: [...rcRows.entries()].slice(0, 4).map(([k, v]) => ({ raw: k, ...v })),
      },
    };
}

app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const data = await getGradesData(client);
    if (!data.courses.length)
      return res.status(404).json({ error: 'No grade data found. Try again or check your login.' });
    res.json(data);
  } catch (err) {
    console.error('[/api/grades]', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown server error.' });
  }
});

// ── Bootstrap: ONE login, all three pages fetched concurrently ───────────────
// The frontend calls this once at sign-in so grades, every quarter's assignments,
// and the transcript are all ready up front — no extra logins, no lazy round-trips.
app.post('/api/bootstrap', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
  } catch (err) {
    const status = err.message?.includes('username or password') ? 401 : 500;
    return res.status(status).json({ error: err.message || 'Login failed.' });
  }

  const [gradesR, assignR, transcriptR] = await Promise.allSettled([
    getGradesData(client),
    getAssignmentsData(client),
    getTranscriptData(client),
  ]);

  const out = { errors: {} };

  if (gradesR.status === 'fulfilled') {
    out.student = gradesR.value.student;
    out.courses = gradesR.value.courses;
    out._debug  = gradesR.value._debug;
  } else {
    console.error('[bootstrap] grades:', gradesR.reason?.message);
    out.courses = [];
    out.errors.grades = gradesR.reason?.message || 'failed';
  }

  if (assignR.status === 'fulfilled') {
    out.assignByClass = assignR.value.byClass;
    out.periodOpts    = assignR.value.periodOpts;
    out._assignDebug  = assignR.value._debug;
  } else {
    console.error('[bootstrap] assignments:', assignR.reason?.message);
    out.assignByClass = {};
    out.errors.assignments = assignR.reason?.message || 'failed';
  }

  if (transcriptR.status === 'fulfilled') {
    out.transcript = transcriptR.value;
  } else {
    console.error('[bootstrap] transcript:', transcriptR.reason?.message);
    out.errors.transcript = transcriptR.reason?.message || 'failed';
  }

  res.json(out);
});

// ── DEBUG (temporary): find where HAC exposes the student name ────────────────
function nameCandidates(html) {
  const $ = cheerio.load(html);
  const out = [];
  const push = (src, t) => { t = (t || '').trim().replace(/\s+/g, ' '); if (t && t.length <= 70) out.push({ src, text: t }); };
  push('title', $('title').text());
  $('[id]').each((_, el) => {
    const id = $(el).attr('id') || '';
    if (/name|student|chooser|banner|grade|campus/i.test(id)) push('id:' + id, $(el).text());
  });
  $('[class]').each((_, el) => {
    const c = $(el).attr('class') || '';
    if (/chooser|banner|student|name/i.test(c)) push('class:' + c.split(/\s+/)[0], ownText($, el));
  });
  $('*').each((_, el) => {
    if (out.length > 80) return;
    const t = ownText($, el);
    if (HAC_NAME_RE.test(t) && t.length <= 45) push('pattern', t);
  });
  const seen = new Set();
  return out.filter(o => { const k = o.src + '|' + o.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
}

app.post('/api/debug-name', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'creds required' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const grab = async (url) => { try { const r = await client.get(url); return { parsed: parseStudentInfo(r.data), candidates: nameCandidates(r.data) }; } catch (e) { return { error: e.message }; } };
    res.json({
      registration: await grab(INFO_URL),
      reportCard:   await grab(RC_URL),
      assignments:  await grab(CW_URL),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug-name', (_req, res) => {
  res.set('Content-Type', 'text/html').send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Student Name Debug</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:920px;color:#111}
input{padding:9px;margin:5px 0;width:280px;display:block;border:1px solid #ccc;border-radius:6px}
button{padding:9px 18px;margin-top:10px;border:0;border-radius:6px;background:#3d5aff;color:#fff;font-size:14px;cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;background:#0b1021;color:#bfe3ff;padding:14px;border-radius:8px;font-size:12px;margin-top:14px}</style>
</head><body><h2>Find the Student Name</h2>
<p>Runs against your account and shows where HAC exposes the name. Copy the whole result back to your developer.</p>
<input id="u" placeholder="HAC username" autocomplete="off">
<input id="p" type="password" placeholder="HAC password" autocomplete="off">
<button id="go">Run</button><pre id="out">(results appear here)</pre>
<script>document.getElementById('go').onclick=async function(){var o=document.getElementById('out');o.textContent='Running…';
try{var r=await fetch('/api/debug-name',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});
o.textContent=JSON.stringify(await r.json(),null,2);}catch(e){o.textContent='ERROR: '+e.message;}};</script>
</body></html>`);
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
async function getTranscriptData(client) {
  const tRes = await client.get(TRANSCRIPT_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  return parseTranscript(tRes.data);
}

app.post('/api/transcript', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const transcript = await getTranscriptData(client);
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
    const rawHeading = $cls.find('a.sg-header-heading, .sg-header-heading').first().text().trim();
    if (!rawHeading) return;
    const displayName = cleanName(rawHeading) || rawHeading;

    const assignments = [];
    $cls.find('table tr').each((ri, row) => {
      const $row = $(row);
      if ($row.find('th').length > 0) return;
      const cells = $row.find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length < 5) return;
      const dateDue    = (cells[0] || '').trim();
      const assignName = (cells[2] || '').replace(/\s+/g, ' ').trim();
      const category   = (cells[3] || '').trim();
      const scoreRaw   = (cells[4] || '').trim();
      const totalRaw   = (cells[5] || '').trim();
      if (!assignName || assignName === 'Assignment' || assignName === 'Date Due') return;
      // skip category-weight summary rows (e.g. "Assessment of Learning", "Course overall average is:")
      if (/overall average/i.test(assignName) || /^\d+(\.\d+)?$/.test(cells[1] || '') && /%/.test(scoreRaw)) return;
      if (scoreRaw.includes('%') && !scoreRaw.includes('/')) return;
      const score = parseFloat(scoreRaw);
      const total = parseFloat(totalRaw);
      assignments.push({
        dateDue,
        name:   assignName,
        category,
        score:  isNaN(score) ? null : score,
        total:  isNaN(total) ? null : total,
        raw:    scoreRaw,
      });
    });

    classes.push({ name: displayName, rawName: rawHeading, assignments });
  });

  console.log('[parseAssignments] blocks:', classes.length, 'assignments:', classes.reduce((s,c)=>s+c.assignments.length,0));
  return classes;
}

function parseAssignmentsFromHtml(html) {
  return parseAssignments(html);
}

// Find the "Report Card Run" <select> on the Assignments page.
// HAC's control name has varied (ddlReportCardRuns / ddlRCRuns), so locate it
// dynamically rather than hardcoding.  Returns { name, options[], selected }.
function findRunSelect($page) {
  let $sel = $page('#plnMain_ddlReportCardRuns');
  if (!$sel.length) $sel = $page('select[name*="ReportCardRun"]');
  if (!$sel.length) $sel = $page('select[name*="RCRun"]');
  if (!$sel.length) $sel = $page('select[id*="ReportCardRun"], select[id*="RCRun"]');
  // Last resort: the select whose option values look like grading-run codes
  // (e.g. "1", "4", "1-2026") and aren't the Classes/OrderBy dropdowns.
  if (!$sel.length) {
    $page('select').each((_, el) => {
      const opts = $page(el).find('option').map((__, o) => ($page(o).attr('value') || '').trim()).get();
      const looksLikeRuns = opts.filter(v => /^\d+(-\d{2,4})?$/.test(v)).length >= 2;
      if (looksLikeRuns && !$sel.length) $sel = $page(el);
    });
  }
  if (!$sel.length) return null;

  const name = $sel.attr('name') || '';
  const options = [];
  $sel.find('option').each((_, o) => {
    const value = ($page(o).attr('value') || '').trim();
    const label = $page(o).text().trim();
    if (value && value.toUpperCase() !== 'ALL') options.push({ value, label });
  });
  let selected = $sel.find('option[selected]').attr('value') || $sel.val() || (options[0] && options[0].value) || '';
  return { name, options, selected };
}

// Build a period-switch POST body that mirrors a real browser dropdown change:
// every hidden field + every other <select>'s currently-selected value, with the
// run dropdown overridden to the target period and __EVENTTARGET pointed at it.
// Pass `ajax = { scriptManager, updatePanel }` to additionally form a native
// ASP.NET AJAX async (delta) postback.
// Build an ASP.NET postback body from a page's current state, with overrides.
//   opts.eventTarget / eventArg → __EVENTTARGET / __EVENTARGUMENT
//   opts.set         → { fieldName: value, … } extra/overridden fields
//   opts.submitName  → name of a submit/image button to "click" (its value posted)
function buildPostBody($page, opts = {}) {
  const fd = {};

  // All hidden inputs (__VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION, hdn*…)
  $page('input[type="hidden"]').each((_, el) => {
    const name = $page(el).attr('name');
    if (name) fd[name] = $page(el).val() || '';
  });

  // Every <select>'s current value (run dropdown, ddlClasses, ddlOrderBy, …)
  $page('select').each((_, el) => {
    const name = $page(el).attr('name');
    if (!name) return;
    const sel = $page(el).find('option[selected]').attr('value');
    fd[name] = sel !== undefined ? sel : ($page(el).val() || '');
  });

  // Keep the filter dropdowns unrestricted so every class comes back.
  for (const k of Object.keys(fd)) {
    if (/ddlClasses$|ddlCompetencies$/i.test(k) && !fd[k]) fd[k] = 'ALL';
    if (/ddlOrderBy$/i.test(k) && !fd[k])                  fd[k] = 'Class';
  }

  fd['__EVENTTARGET']   = opts.eventTarget || '';
  fd['__EVENTARGUMENT'] = opts.eventArg    || '';
  if (opts.set) Object.assign(fd, opts.set);
  if (opts.submitName) {
    fd[opts.submitName] = opts.submitValue != null ? opts.submitValue : '';
    if (opts.imageButton) { fd[opts.submitName + '.x'] = '1'; fd[opts.submitName + '.y'] = '1'; }
  }

  return new URLSearchParams(fd).toString();
}

// HAC mirrors the run dropdown's value into hidden fields (hdnddlReportCardRuns1/2)
// via a JS onchange handler, and the server reads THOSE to pick the grading run.
// Return their names so we can set them alongside the <select>.
function runMirrorFields($page) {
  const names = [];
  $page('input[type="hidden"]').each((_, el) => {
    const n = $page(el).attr('name') || '';
    if (/hdn.*ReportCardRun/i.test(n)) names.push(n);
  });
  return names;
}

// Locate the "Refresh View" trigger (anchor __doPostBack target or submit button).
function findRefreshControl($page) {
  let found = null;
  $page('a[href*="__doPostBack"], [onclick*="__doPostBack"]').each((_, el) => {
    if (found) return;
    const label = ($page(el).text() + ' ' + ($page(el).attr('id') || '') + ' ' + ($page(el).attr('title') || '')).toLowerCase();
    if (!/refresh/.test(label)) return;
    const attr = $page(el).attr('href') || $page(el).attr('onclick') || '';
    const m = attr.match(/__doPostBack\('([^']*)'(?:,\s*'([^']*)')?\)/);
    if (m) found = { eventTarget: m[1], eventArg: m[2] || '' };
  });
  if (!found) {
    $page('input[type="submit"], input[type="button"], input[type="image"]').each((_, el) => {
      if (found) return;
      const label = (($page(el).attr('value') || '') + ' ' + ($page(el).attr('id') || '') + ' ' + ($page(el).attr('alt') || '')).toLowerCase();
      if (!/refresh/.test(label)) return;
      found = { submitName: $page(el).attr('name') || '', submitValue: $page(el).attr('value') || '', imageButton: ($page(el).attr('type') === 'image') };
    });
  }
  return found;
}

function countAssignments(classes) {
  return classes.reduce((s, c) => s + c.assignments.length, 0);
}

// ── ASP.NET AJAX partial-render (delta) helpers ──────────────────────────────
// An async postback responds with a length-prefixed, pipe-delimited stream:
//   <len>|<type>|<id>|<content>|<len>|<type>|<id>|<content>|…
// We detect it and concatenate the HTML from every `updatePanel` segment so the
// existing cheerio-based parser can read the assignment blocks unchanged.
function looksLikeDelta(text) {
  return typeof text === 'string' && /^\s*\d+\|[^|]*\|/.test(text.slice(0, 60));
}
function extractHtmlFromDelta(text) {
  let html = '', i = 0;
  while (i < text.length) {
    const p1 = text.indexOf('|', i);             if (p1 < 0) break;
    const len = parseInt(text.slice(i, p1), 10); if (Number.isNaN(len)) break;
    const p2 = text.indexOf('|', p1 + 1);        if (p2 < 0) break; // type
    const p3 = text.indexOf('|', p2 + 1);        if (p3 < 0) break; // id
    const type    = text.slice(p1 + 1, p2);
    const content = text.slice(p3 + 1, p3 + 1 + len);
    if (type === 'updatePanel') html += content;
    i = p3 + 1 + len + 1; // advance past content + trailing '|'
  }
  return html || text; // fall back to raw — cheerio can still find embedded tags
}

// Locate the ScriptManager UniqueID (needed to form an async postback) plus the
// UpdatePanel that wraps the run dropdown. Returns null on non-AJAX pages.
function findScriptManager(html, $page, runName) {
  const m = html.match(/_initialize\(\s*'([^']+)'/); // Sys.WebForms.PageRequestManager._initialize('ctl00$…$ScriptManager','…')
  if (!m) return null;
  let updatePanel = '';
  const $sel = $page('select').filter((_, el) => $page(el).attr('name') === runName).first();
  const id   = $sel.parents('[id*="UpdatePanel"]').first().attr('id');
  if (id) updatePanel = id.replace(/_/g, '$'); // client id → control UniqueID
  return { scriptManager: m[1], updatePanel };
}

// Build the ordered list of postback strategies for switching to `periodValue`.
// HAC reads the run from hidden mirror fields, so setting those (not just the
// <select>) is the key. We try the most-likely strategy first and stop as soon
// as one returns assignment rows.
function switchStrategies($fresh, runName, periodValue) {
  const mirrors    = runMirrorFields($fresh);
  const mirrorSet  = Object.fromEntries(mirrors.map(n => [n, periodValue]));
  const withRun    = { [runName]: periodValue, ...mirrorSet };
  const list = [
    { name: 'dropdown+mirrors', opts: { eventTarget: runName, set: withRun } },
    { name: 'dropdown',         opts: { eventTarget: runName, set: { [runName]: periodValue } } },
  ];
  const refresh = findRefreshControl($fresh);
  if (refresh) list.push({ name: 'refresh+mirrors', opts: { ...refresh, set: withRun } });
  return list;
}

// Fetch one grading period's assignments by switching the Report Card Run.
// Returns { classes, diag }. diag.attempts records every strategy tried.
async function fetchPeriodData(client, runName, periodValue) {
  const diag = { used: 'none', attempts: [] };

  // Fresh GET so __VIEWSTATE/__EVENTVALIDATION belong to the page we post from.
  const freshRes = await client.get(CW_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: HAC_BASE },
  });
  const $fresh = cheerio.load(freshRes.data);

  let classes = [];
  for (const strat of switchStrategies($fresh, runName, periodValue)) {
    let raw;
    try {
      const r = await client.post(CW_URL, buildPostBody($fresh, strat.opts), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer':      CW_URL,
          'Accept':       'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      raw = String(r.data);
    } catch (e) {
      diag.attempts.push({ strategy: strat.name, error: e.message });
      continue;
    }
    const html  = looksLikeDelta(raw) ? extractHtmlFromDelta(raw) : raw;
    const c     = parseAssignments(html);
    const after = findRunSelect(cheerio.load(html));
    diag.attempts.push({
      strategy: strat.name,
      selectedAfter: after ? after.selected : '?',
      blocks: c.length, assignments: countAssignments(c), rawLen: raw.length,
    });
    if (countAssignments(c) > 0) { classes = c; diag.used = strat.name; break; }
    if (c.length > classes.length) classes = c; // keep best-so-far if none have rows
  }

  if (countAssignments(classes) === 0) diag.flags = { note: 'no assignments from any strategy' };
  return { classes, diag };
}

// ─────────────────────────────────────────────────────────────────────────────
// /api/assignments — one login, then for each period: fresh GET → POST switch.
// A fresh GET before every POST ensures a clean __VIEWSTATE so ASP.NET accepts
// the period switch.  HAC periods are numeric (1=Q1, 2=Q2, 3=Q3, 4=Q4).
// ─────────────────────────────────────────────────────────────────────────────
// Fetch every grading period's assignments for one logged-in session.
// Returns { periodOpts, byClass, _debug }. Non-current periods are switched in
// PARALLEL for speed (each request is self-contained — it carries its own
// viewstate + run-mirror fields — so concurrent switches don't interfere).
async function getAssignmentsData(client) {
  const initRes = await client.get(CW_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: HAC_BASE },
  });
  const initHtml = initRes.data;
  const $init = cheerio.load(initHtml);

  const runSel = findRunSelect($init);
  if (!runSel || !runSel.options.length) throw new Error('No grading periods found on assignments page.');

  const runName         = runSel.name;       // e.g. ctl00$plnMain$ddlReportCardRuns
  const periodOpts      = runSel.options;     // [{ value, label }]
  const defaultSelected = runSel.selected;
  console.log('[asgn] runName=' + runName + ' default=' + defaultSelected
    + ' periods:', periodOpts.map(p => p.label + '=' + p.value).join(', '));

  const allData = {};
  const debugPerPeriod = [];

  await Promise.all(periodOpts.map(async (p) => {
    if (p.value === defaultSelected) {
      // Current period is already rendered in the initial GET — no POST needed.
      allData[p.value] = parseAssignments(initHtml);
      debugPerPeriod.push({ value: p.value, label: p.label, used: 'default',
        blocks: allData[p.value].length, assignments: countAssignments(allData[p.value]) });
      return;
    }
    try {
      const { classes, diag } = await fetchPeriodData(client, runName, p.value);
      allData[p.value] = classes;
      debugPerPeriod.push({ value: p.value, label: p.label, ...diag,
        blocks: classes.length, assignments: countAssignments(classes) });
    } catch (e) {
      console.error('[asgn] period ' + p.value + ' failed:', e.message);
      allData[p.value] = [];
      debugPerPeriod.push({ value: p.value, label: p.label, used: 'error', error: e.message });
    }
  }));

  // Map periods → q1/q2/q3/q4 by sorting on the leading integer of the period.
  const sortedPeriods = [...periodOpts].sort((a, b) => {
    const na = parseInt(a.value, 10) || parseInt(a.label, 10) || 0;
    const nb = parseInt(b.value, 10) || parseInt(b.label, 10) || 0;
    return na - nb;
  });
  const quarterMapping = {};
  sortedPeriods.forEach((p, i) => { const q = ['q1', 'q2', 'q3', 'q4'][i]; if (q) quarterMapping[q] = p.value; });
  console.log('[asgn] quarterMapping:', JSON.stringify(quarterMapping));

  // Build byClass: { cleanName: { q1: [...], q2: [...], ... } }
  const byClass = {};
  for (const [q, periodVal] of Object.entries(quarterMapping)) {
    (allData[periodVal] || []).forEach(cls => {
      if (!byClass[cls.name]) byClass[cls.name] = {};
      byClass[cls.name][q] = cls.assignments;
    });
  }

  return { periodOpts, byClass, _debug: { runName, defaultSelected, quarterMapping, perPeriod: debugPerPeriod } };
}

app.post('/api/assignments', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required.' });
  try {
    const client = makeClient();
    await login(client, username, password);
    res.json(await getAssignmentsData(client));
  } catch (err) {
    console.error('[/api/assignments]', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSE: Assignments page structure page structure
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/diagnose-assignments', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'creds required' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const getRes = await client.get(CW_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $ = cheerio.load(getRes.data);

    // All selects + their options
    const selects = [];
    $('select').each((_, el) => {
      const name = $(el).attr('name') || '';
      const id   = $(el).attr('id')   || '';
      const opts = [];
      $(el).find('option').each((__, o) => opts.push({ value: $(o).attr('value'), label: $(o).text().trim(), selected: !!$(o).attr('selected') }));
      selects.push({ name, id, opts });
    });

    // All AssignmentClass blocks — first one in detail
    const classes = [];
    $('.AssignmentClass').each((i, el) => {
      if (i > 2) return false;
      const heading    = $(el).find('.sg-header-heading, a.sg-header-link').first().text().trim();
      const subheading = $(el).find('.sg-header-subheading').first().text().trim();
      // First 3 rows of any tables inside
      const rows = [];
      $(el).find('table tr').each((ri, row) => {
        if (ri > 3) return false;
        const cells = $(row).find('td,th').map((_, td) => $(td).text().trim().substring(0, 40)).get();
        if (cells.length) rows.push(cells);
      });
      classes.push({ heading, subheading, rows });
    });

    // Raw HTML snippet of first AssignmentClass (500 chars)
    const firstBlock = $('.AssignmentClass').first().html() || '';

    res.json({ selects, classes, firstBlockSnippet: firstBlock.substring(0, 800) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DIAGNOSE: test period switch ─────────────────────────────────────
app.post('/api/diagnose-switch', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'creds required' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const initRes = await client.get(CW_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: HAC_BASE },
    });
    const $i = cheerio.load(initRes.data);

    const vs   = $i('input[name="__VIEWSTATE"]').val() || '';
    const vsg  = $i('input[name="__VIEWSTATEGENERATOR"]').val() || '';
    const ev   = $i('input[name="__EVENTVALIDATION"]').val() || '';
    const selectedNow = $i('#plnMain_ddlReportCardRuns option[selected]').attr('value') || '?';
    const blocks0 = $i('.AssignmentClass').length;

    // Now POST to switch to period "1-2026"
    const body = new URLSearchParams({
      '__EVENTTARGET': 'ctl00$plnMain$ddlReportCardRuns',
      '__EVENTARGUMENT': '',
      '__VIEWSTATE': vs,
      '__VIEWSTATEGENERATOR': vsg,
      '__EVENTVALIDATION': ev,
      'ctl00$plnMain$ddlReportCardRuns': '1-2026',
      'ctl00$plnMain$ddlClasses': 'ALL',
      'ctl00$plnMain$ddlCompetencies': 'ALL',
      'ctl00$plnMain$ddlOrderBy': 'Class',
    });

    const postRes = await client.post(CW_URL, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: CW_URL,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    const $p = cheerio.load(postRes.data);
    const selectedAfter = $p('#plnMain_ddlReportCardRuns option[selected]').attr('value') || '?';
    const blocks1 = $p('.AssignmentClass').length;

    // First class heading and first 2 assignment rows
    const firstClass = $p('.AssignmentClass').first();
    const heading = firstClass.find('a.sg-header-heading').first().text().trim();
    const rows = [];
    firstClass.find('table tr').each((ri, row) => {
      if (ri > 3) return false;
      rows.push($p(row).find('td,th').map((_, td) => $p(td).text().trim().substring(0,30)).get());
    });

    // Raw HTML of the select after POST
    const selectHtml = $p('#plnMain_ddlReportCardRuns').toString().substring(0, 400);

    res.json({
      beforeSwitch: { selectedNow, blocks0, vsLen: vs.length, evLen: ev.length },
      afterSwitch:  { selectedAfter, blocks1, heading, rows, selectHtml },
      redirectUrl:  postRes.request?.res?.responseUrl || '?',
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,3) });
  }
});
