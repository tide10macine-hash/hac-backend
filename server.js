const express = require('express');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const HAC_BASE    = 'https://hac.friscoisd.org';
const LOGIN_URL   = `${HAC_BASE}/HomeAccess/Account/LogOn`;
const RC_URL      = `${HAC_BASE}/HomeAccess/Content/Student/ReportCards.aspx`;
const CW_URL      = `${HAC_BASE}/HomeAccess/Content/Student/Assignments.aspx`;
const INFO_URL    = `${HAC_BASE}/HomeAccess/Content/Student/Registration.aspx`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ── Make a cookie-aware axios client ──
function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    maxRedirects: 10,
    timeout: 25000,
    headers: HEADERS,
  }));
}

// ── GET login page → extract CSRF token ──
async function getToken(client) {
  const res = await client.get(LOGIN_URL);
  const $ = cheerio.load(res.data);
  const token = $('input[name="__RequestVerificationToken"]').val();
  if (!token) throw new Error('Could not load HAC login page.');
  return token;
}

// ── POST login ──
async function login(client, username, password) {
  const token = await getToken(client);

  const body = new URLSearchParams({
    '__RequestVerificationToken': token,
    'SCKTY00328510CustomEnabled': 'False',
    'SCKTY00436568CustomEnabled': 'False',
    'Database': '10',
    'VerificationOption': 'UsernamePassword',
    'LogOnDetails.UserName': username,
    'LogOnDetails.Password': password,
  });

  const res = await client.post(LOGIN_URL, body.toString(), {
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': LOGIN_URL },
  });

  const $ = cheerio.load(res.data);
  // If still on login page with an error message → bad credentials
  const errorMsg = $('.validation-summary-errors, .login-error, #ErrorMessage').text().trim();
  const stillOnLogin = res.request?.path?.includes('LogOn') || res.config?.url?.includes('LogOn');
  if (stillOnLogin && errorMsg) throw new Error('Incorrect username or password.');
  // Secondary check: logged-in pages always have a logout link
  const hasLogout = $('a[href*="LogOff"], a[href*="logoff"]').length > 0;
  if (stillOnLogin && !hasLogout) throw new Error('Incorrect username or password.');
}

// ── Parse Report Card page → Q1/Q2/Q3/Q4 per course ──
function parseReportCard(html) {
  const $ = cheerio.load(html);
  const courses = [];

  // HAC report card: one big table, header row has "1st Six Weeks", "2nd Six Weeks" etc.
  // OR "1st", "2nd", "3rd", "4th" — varies by district config
  let headers = [];

  $('table tr').each((i, row) => {
    const cells = $(row).find('th, td');
    if (!cells.length) return;

    // Detect header row by presence of <th> elements or grade-period keywords
    const isHeader = $(row).find('th').length > 0 ||
      cells.first().text().trim().toLowerCase() === 'course';

    if (isHeader) {
      headers = [];
      cells.each((_, c) => headers.push($(c).text().trim().toLowerCase()));
      return;
    }

    if (!headers.length) return;

    const vals = [];
    cells.each((_, c) => vals.push($(c).text().trim()));
    if (!vals[0] || vals[0].length < 3) return; // skip empty/short rows

    function col(...pats) {
      for (const p of pats) {
        const idx = headers.findIndex(h => h.includes(p));
        if (idx >= 0) return idx;
      }
      return -1;
    }

    function grade(v) {
      if (!v) return null;
      const s = v.toString().trim();
      if (!s || s === '-' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'ng') return null;
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    }

    const iQ1 = col('1st', 'q1', 'first', 'six weeks 1', '6wks 1');
    const iQ2 = col('2nd', 'q2', 'second', 'six weeks 2', '6wks 2');
    const iQ3 = col('3rd', 'q3', 'third', 'six weeks 3', '6wks 3');
    const iQ4 = col('4th', 'q4', 'fourth', 'six weeks 4', '6wks 4');

    const entry = {
      name:  vals[0],
      q1avg: iQ1 >= 0 ? grade(vals[iQ1]) : null,
      q2avg: iQ2 >= 0 ? grade(vals[iQ2]) : null,
      q3avg: iQ3 >= 0 ? grade(vals[iQ3]) : null,
      q4avg: iQ4 >= 0 ? grade(vals[iQ4]) : null,
    };

    if ([entry.q1avg, entry.q2avg, entry.q3avg, entry.q4avg].some(v => v !== null)) {
      courses.push(entry);
    }
  });

  return courses;
}

// ── Parse current classwork page → live averages ──
function parseCurrentClasses(html) {
  const $ = cheerio.load(html);
  const classes = [];

  $('.AssignmentClass').each((_, el) => {
    const heading = $(el).find('.sg-header-heading, a.sg-header-link').first().text().trim();
    const subhead = $(el).find('.sg-header-subheading').first().text().trim();
    // subhead looks like "Student Average: 98.50" or just "98.50"
    const match = subhead.match(/([\d.]+)/);
    const avg = match ? parseFloat(match[1]) : null;
    if (heading) classes.push({ name: heading, avg });
  });

  return classes;
}

// ── Parse student info ──
function parseStudentInfo(html) {
  const $ = cheerio.load(html);
  const name   = $('[id*="StudentName"], [id*="lblName"]').first().text().trim()
               || $('h1, h2').first().text().trim();
  const grade  = $('[id*="GradeLevel"], [id*="lblGrade"]').first().text().trim();
  const campus = $('[id*="BuildingName"], [id*="lblCampus"], [id*="lblSchool"]').first().text().trim();
  return { name, grade, campus };
}

// ── Clean raw course name like "MTH45300B - 3    AP Calculus AB S2" → "AP Calculus AB S2" ──
function cleanCourseName(raw) {
  if (!raw) return '';
  const m = raw.match(/^[A-Z0-9]+\s*-\s*\d+\s+(.+)$/);
  return m ? m[1].trim() : raw.trim();
}

// ── /api/grades endpoint ──
app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const client = makeClient();

  try {
    await login(client, username, password);

    const [rcRes, cwRes, infoRes] = await Promise.allSettled([
      client.get(RC_URL),
      client.get(CW_URL),
      client.get(INFO_URL),
    ]);

    // Parse report card
    let rcCourses = [];
    if (rcRes.status === 'fulfilled') {
      try { rcCourses = parseReportCard(rcRes.value.data); } catch (e) { console.error('RC parse:', e.message); }
    }

    // Parse current classes (live average)
    let currClasses = [];
    if (cwRes.status === 'fulfilled') {
      try { currClasses = parseCurrentClasses(cwRes.value.data); } catch (e) { console.error('CW parse:', e.message); }
    }

    // Student info
    let student = { name: '', grade: '', campus: '' };
    if (infoRes.status === 'fulfilled') {
      try { student = parseStudentInfo(infoRes.value.data); } catch (e) {}
    }

    // Build live-grade lookup keyed by cleaned name
    const liveMap = {};
    currClasses.forEach(c => {
      liveMap[cleanCourseName(c.name).toLowerCase()] = c.avg;
    });

    // Merge: report card gives Q1/Q2/Q3, current classes gives live Q4
    let courses = [];

    if (rcCourses.length > 0) {
      courses = rcCourses.map(c => {
        const cleaned = cleanCourseName(c.name);
        const live    = liveMap[cleaned.toLowerCase()] ?? null;
        const q4      = c.q4avg ?? live;
        return { name: cleaned, q1avg: c.q1avg, q2avg: c.q2avg, q3avg: c.q3avg, q4avg: q4, avg: q4 };
      }).filter(c => c.name && [c.q1avg, c.q2avg, c.q3avg, c.q4avg].some(v => v !== null));
    }

    // If report card gave nothing, fall back to current classes only
    if (!courses.length && currClasses.length > 0) {
      courses = currClasses.map(c => ({
        name: cleanCourseName(c.name), q1avg: null, q2avg: null, q3avg: null, q4avg: c.avg, avg: c.avg,
      })).filter(c => c.name && c.avg !== null);
    }

    if (!courses.length) return res.status(404).json({ error: 'No grade data found.' });

    res.json({
      student,
      courses,
      _debug: { rcFound: rcCourses.length, cwFound: currClasses.length }
    });

  } catch (err) {
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown error.' });
  }
});

// ── Serve the frontend HTML ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
