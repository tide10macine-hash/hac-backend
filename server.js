const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');

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
    headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  });
  const $get = cheerio.load(getRes.data);
  const token = $get('input[name="__RequestVerificationToken"]').val();
  if (!token) throw new Error('Could not load HAC — site may be down.');

  const body = new URLSearchParams({
    '__RequestVerificationToken': token,
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
      'Referer': LOGIN_URL,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const finalUrl = postRes.request?.res?.responseUrl || postRes.config?.url || '';
  const $post = cheerio.load(postRes.data);
  const errText = $post('.validation-summary-errors li, #ErrorMessage').text().trim().toLowerCase();
  if (errText && (errText.includes('invalid') || errText.includes('incorrect'))) {
    throw new Error('Incorrect username or password.');
  }
  const onLoginPage = finalUrl.includes('LogOn') || finalUrl.includes('logon');
  const hasContent  = $post('.sg-banner, .sg-header, #plnMain').length > 0;
  const hasLogout   = $post('a[href*="LogOff"], a[href*="logoff"]').length > 0;
  if (onLoginPage && !hasContent && !hasLogout) throw new Error('Incorrect username or password.');
}

// Extract ASP.NET hidden form fields from a loaded cheerio page
function extractFormFields($) {
  return {
    __EVENTTARGET:        $('input[name="__EVENTTARGET"]').val() || '',
    __EVENTARGUMENT:      $('input[name="__EVENTARGUMENT"]').val() || '',
    __VIEWSTATE:          $('input[name="__VIEWSTATE"]').val() || '',
    __VIEWSTATEGENERATOR: $('input[name="__VIEWSTATEGENERATOR"]').val() || '',
    __EVENTVALIDATION:    $('input[name="__EVENTVALIDATION"]').val() || '',
  };
}

// Get all dropdown options for reporting periods
function getReportingPeriods($) {
  const periods = [];
  $('#plnMain_ddlRCRuns option').each((_, el) => {
    const value = $(el).attr('value');
    const label = $(el).text().trim();
    if (value && label) periods.push({ value, label });
  });
  return periods;
}

// Parse grades from ONE report card page
// Returns { rawCourseName: gradeNumber }
function parseRCGrades(html) {
  const $ = cheerio.load(html);
  const grades = {};

  // HAC report card: the main table has class sg-asp-table or is inside sg-content-grid
  // Each data row: first cell = course name, other cells = grades for that period
  // The "average" for the selected period is in a specific column
  // Strategy: find rows with a numeric grade (50-100) in any non-first cell

  $('table tr').each((rowIdx, row) => {
    const $row = $(row);
    // Skip header rows
    if ($row.find('th').length > 0) return;

    const cells = $row.find('td');
    if (cells.length < 2) return;

    const courseName = $(cells[0]).text().trim();
    if (!courseName || courseName.length < 5) return;
    // Must look like a course code: letters+numbers
    if (!courseName.match(/^[A-Z]{2,3}\d/)) return;

    // Find the average grade — look for a cell with class containing "avg" or just a numeric value
    // The report card for a single period shows just one grade column
    let avg = null;

    // Try cells with explicit avg class first
    $row.find('td[class*="avg"], td[class*="Avg"], td[class*="grade"]').each((_, td) => {
      const txt = $(td).text().trim();
      const n = parseFloat(txt);
      if (!isNaN(n) && n >= 0 && n <= 100) { avg = n; return false; }
    });

    // If no avg class found, take the last numeric cell that looks like a grade
    if (avg === null) {
      cells.each((cellIdx, td) => {
        if (cellIdx === 0) return;
        const txt = $(td).text().trim();
        if (txt.match(/^\d{2,3}(\.\d+)?$/) && parseFloat(txt) <= 100) {
          avg = parseFloat(txt);
        }
      });
    }

    if (avg !== null) {
      grades[courseName] = avg;
    }
  });

  return grades;
}

// Fetch report card page for a specific period by posting the dropdown change
// IMPORTANT: each postback returns a NEW page with NEW form fields — we re-parse them each time
async function fetchPeriod(client, periodValue) {
  // First GET the page fresh to get current form state
  const getRes = await client.get(RC_URL, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Referer': RC_URL }
  });
  const $ = cheerio.load(getRes.data);
  const fields = extractFormFields($);

  // Now POST the dropdown change
  const body = new URLSearchParams({
    ...fields,
    '__EVENTTARGET':   'ctl00$plnMain$ddlRCRuns',
    '__EVENTARGUMENT': '',
    'ctl00$plnMain$ddlRCRuns': periodValue,
  });

  const postRes = await client.post(RC_URL, body.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': RC_URL,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  return postRes.data;
}

// Parse classwork page for live averages
function parseCurrentClasses(html) {
  const $ = cheerio.load(html);
  const classes = {};
  $('.AssignmentClass').each((_, el) => {
    const name = $(el).find('.sg-header-heading, a.sg-header-link').first().text().trim();
    const sub  = $(el).find('.sg-header-subheading').first().text().trim();
    const m    = sub.match(/([\d.]+)/);
    const avg  = m ? parseFloat(m[1]) : null;
    if (name && avg !== null) classes[name] = avg;
  });
  return classes;
}

function parseStudentInfo(html) {
  const $ = cheerio.load(html);
  const name   = $('[id*="StudentName"],[id*="lblName"]').first().text().trim();
  const grade  = $('[id*="GradeLevel"],[id*="lblGrade"]').first().text().trim();
  const campus = $('[id*="BuildingName"],[id*="lblCampus"],[id*="lblSchool"]').first().text().trim();
  return { name, grade, campus };
}

// Strip course code prefix: "MTH45300A - 3    AP Calculus AB S1" → "AP Calculus AB S1"
function cleanName(raw) {
  if (!raw) return '';
  // Pattern: CODE - PERIOD    NAME
  const m = raw.match(/^[A-Z0-9]+\s*-\s*\d+\s{2,}(.+)$/) ||
            raw.match(/^[A-Z0-9]+\s*-\s*\d+\s+(.+)$/);
  return m ? m[1].trim() : raw.trim();
}

function normKey(s) {
  return cleanName(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();

  try {
    await login(client, username, password);

    // Get initial report card page to find available periods
    const rcInitRes = await client.get(RC_URL, {
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
    const $rcInit  = cheerio.load(rcInitRes.data);
    const periods  = getReportingPeriods($rcInit);

    console.log('Periods:', periods.map(p => `${p.label}=${p.value}`).join(', '));

    // Which period is currently selected?
    const selectedVal   = $rcInit('#plnMain_ddlRCRuns option[selected]').attr('value') || periods[periods.length-1]?.value;
    const selectedLabel = periods.find(p => p.value === selectedVal)?.label || String(periods.length);

    // Parse initial page (currently selected period)
    const periodGrades = {};
    periodGrades[selectedLabel] = parseRCGrades(rcInitRes.data);
    console.log(`Period ${selectedLabel}: ${Object.keys(periodGrades[selectedLabel]).length} courses`);

    // Fetch each other period (re-GET the page each time to get fresh form fields)
    for (const period of periods) {
      if (period.value === selectedVal) continue;
      try {
        await new Promise(r => setTimeout(r, 500)); // be polite
        const html = await fetchPeriod(client, period.value);
        periodGrades[period.label] = parseRCGrades(html);
        console.log(`Period ${period.label}: ${Object.keys(periodGrades[period.label]).length} courses`);
      } catch (e) {
        console.error(`Period ${period.label} error:`, e.message);
        periodGrades[period.label] = {};
      }
    }

    // Live current classes
    let liveGrades = {};
    try {
      const cwRes = await client.get(CW_URL);
      liveGrades = parseCurrentClasses(cwRes.data);
      console.log(`Live classes: ${Object.keys(liveGrades).length}`);
    } catch(e) { console.error('CW error:', e.message); }

    // Student info
    let student = { name: '', grade: '', campus: '' };
    try {
      const infoRes = await client.get(INFO_URL);
      student = parseStudentInfo(infoRes.data);
    } catch(e) {}

    // Build merged course list
    const allRawNames = new Set();
    Object.values(periodGrades).forEach(pg => Object.keys(pg).forEach(n => allRawNames.add(n)));
    Object.keys(liveGrades).forEach(n => allRawNames.add(n));

    const courses = [];
    allRawNames.forEach(rawName => {
      const name = cleanName(rawName);
      if (!name || name.length < 3) return;

      const q1 = periodGrades['1']?.[rawName] ?? null;
      const q2 = periodGrades['2']?.[rawName] ?? null;
      const q3 = periodGrades['3']?.[rawName] ?? null;
      const q4 = periodGrades['4']?.[rawName]
              ?? liveGrades[rawName]
              ?? liveGrades[Object.keys(liveGrades).find(k => normKey(k) === normKey(rawName)) || '']
              ?? null;

      if ([q1, q2, q3, q4].every(v => v === null)) return;
      courses.push({ name, q1avg: q1, q2avg: q2, q3avg: q3, q4avg: q4, avg: q4 ?? q3 ?? q2 ?? q1 });
    });

    // Fallback to live only
    if (!courses.length && Object.keys(liveGrades).length > 0) {
      Object.entries(liveGrades).forEach(([rawName, avg]) => {
        courses.push({ name: cleanName(rawName), q1avg: null, q2avg: null, q3avg: null, q4avg: avg, avg });
      });
    }

    if (!courses.length) return res.status(404).json({ error: 'No grade data found.' });

    res.json({
      student,
      courses,
      _debug: {
        periods,
        periodCounts: Object.fromEntries(Object.entries(periodGrades).map(([k,v]) => [k, Object.keys(v).length])),
        liveCount: Object.keys(liveGrades).length,
      }
    });

  } catch (err) {
    console.error('Error:', err.message);
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown error.' });
  }
});

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
