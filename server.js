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
    jar,
    withCredentials: true,
    maxRedirects: 10,
    timeout: 30000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  }));
}

async function login(client, username, password) {
  // Step 1: GET login page to grab the CSRF token
  const getRes = await client.get(LOGIN_URL, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  });

  const $get = cheerio.load(getRes.data);
  const token = $get('input[name="__RequestVerificationToken"]').val();
  if (!token) throw new Error('Could not load HAC — site may be down.');

  // Step 2: POST credentials
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

  // Check for explicit error messages on the page
  const errText = $post('.validation-summary-errors li, #ErrorMessage, .error').text().trim().toLowerCase();
  if (errText && (errText.includes('invalid') || errText.includes('incorrect') || errText.includes('failed'))) {
    throw new Error('Incorrect username or password.');
  }

  // If we're still on the login page AND there's no welcome/student content → bad creds
  const onLoginPage = finalUrl.includes('LogOn') || finalUrl.includes('logon');
  const hasStudentContent = $post('.sg-banner, .sg-header, #plnMain, nav.sg-banner').length > 0;
  const hasLogout = $post('a[href*="LogOff"], a[href*="logoff"], a[href*="LogOut"]').length > 0;

  if (onLoginPage && !hasStudentContent && !hasLogout) {
    throw new Error('Incorrect username or password.');
  }

  // Success — session cookie is stored in jar automatically
  return postRes;
}

function parseReportCard(html) {
  const $ = cheerio.load(html);
  const courses = [];
  let headers = [];

  $('table tr').each((_, row) => {
    const $row = $(row);
    const cells = $row.find('th, td');
    if (!cells.length) return;

    const isHeader = $row.find('th').length > 0;
    if (isHeader) {
      headers = [];
      cells.each((_, c) => headers.push($(c).text().trim().toLowerCase()));
      return;
    }
    if (!headers.length) return;

    const vals = [];
    cells.each((_, c) => vals.push($(c).text().trim()));
    if (!vals[0] || vals[0].length < 2) return;

    function col(...pats) {
      for (const p of pats) {
        const i = headers.findIndex(h => h.includes(p));
        if (i >= 0) return i;
      }
      return -1;
    }

    function grade(v) {
      if (!v) return null;
      const s = String(v).trim();
      if (!s || ['-', 'n/a', 'ng', ''].includes(s.toLowerCase())) return null;
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    }

    const iQ1 = col('1st', 'q1', 'first');
    const iQ2 = col('2nd', 'q2', 'second');
    const iQ3 = col('3rd', 'q3', 'third');
    const iQ4 = col('4th', 'q4', 'fourth');

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

function parseCurrentClasses(html) {
  const $ = cheerio.load(html);
  const classes = [];
  $('.AssignmentClass').each((_, el) => {
    const name = $(el).find('.sg-header-heading, a.sg-header-link').first().text().trim();
    const sub  = $(el).find('.sg-header-subheading').first().text().trim();
    const m    = sub.match(/([\d.]+)/);
    const avg  = m ? parseFloat(m[1]) : null;
    if (name) classes.push({ name, avg });
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

function cleanName(raw) {
  if (!raw) return '';
  const m = raw.match(/^[A-Z0-9]+\s*-\s*\d+\s+(.+)$/);
  return m ? m[1].trim() : raw.trim();
}

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

    let rcCourses = [];
    if (rcRes.status === 'fulfilled') {
      try { rcCourses = parseReportCard(rcRes.value.data); } catch(e) { console.error('RC:', e.message); }
    }

    let currClasses = [];
    if (cwRes.status === 'fulfilled') {
      try { currClasses = parseCurrentClasses(cwRes.value.data); } catch(e) { console.error('CW:', e.message); }
    }

    let student = { name: '', grade: '', campus: '' };
    if (infoRes.status === 'fulfilled') {
      try { student = parseStudentInfo(infoRes.value.data); } catch(e) {}
    }

    const liveMap = {};
    currClasses.forEach(c => { liveMap[cleanName(c.name).toLowerCase()] = c.avg; });

    let courses = [];

    if (rcCourses.length > 0) {
      courses = rcCourses.map(c => {
        const name = cleanName(c.name);
        const live = liveMap[name.toLowerCase()] ?? null;
        const q4   = c.q4avg ?? live;
        return { name, q1avg: c.q1avg, q2avg: c.q2avg, q3avg: c.q3avg, q4avg: q4, avg: q4 };
      }).filter(c => c.name && [c.q1avg, c.q2avg, c.q3avg, c.q4avg].some(v => v !== null));
    }

    if (!courses.length && currClasses.length > 0) {
      courses = currClasses.map(c => ({
        name: cleanName(c.name), q1avg: null, q2avg: null, q3avg: null, q4avg: c.avg, avg: c.avg,
      })).filter(c => c.name && c.avg !== null);
    }

    if (!courses.length) return res.status(404).json({ error: 'No grade data found.' });

    res.json({ student, courses, _debug: { rcFound: rcCourses.length, cwFound: currClasses.length } });

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
