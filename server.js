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
const SCHED_URL = `${HAC_BASE}/HomeAccess/Content/Student/Classes.aspx`;
const TRANSCRIPT_URL = `${HAC_BASE}/HomeAccess/Content/Student/Transcript.aspx`;
const STAFF_API = process.env.STAFF_API || 'https://resources.friscoisd.org/api/CampusStaffDirectory/directory';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function makeClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar, withCredentials: true, maxRedirects: 10, timeout: 30000,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  }));
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
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

// ── COURSE NAME CLEANING ─────────────────────────────────────────────────────
function cleanName(raw) {
  if (!raw) return '';
  let name = raw.trim();
  const m = name.match(/^[A-Z]{1,6}[0-9][A-Z0-9]*[A-Z]?\s*(?:-\s*\d+)?\s{2,}(.+)$/);
  if (m) { name = m[1].trim(); }
  else {
    const m2 = name.match(/^[A-Z]{2,6}\d{3,}[A-Z]?\s*-\s*\d+\s+(.+)$/);
    if (m2) name = m2[1].trim();
  }
  name = name.replace(/\s+S[12]\s*$/i, '').trim();
  name = name.replace(/\s*[-–]?\s*(period|per)\s*\d+\s*$/i, '').trim();
  name = name.replace(/\s{2,}/g, ' ').trim();
  return name;
}

function courseBaseKey(n) { return n.toLowerCase().replace(/\s+/g, ' ').trim(); }
function normKey(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// ── PARSE REPORT CARD ────────────────────────────────────────────────────────
function parseAllQuartersFromPage(html) {
  const $ = cheerio.load(html);
  let $table = $('#plnMain_dgReportCard');
  if (!$table.length) $table = $('#plnMain_dgRCDetails');
  if (!$table.length) $table = $('table.sg-asp-table').first();
  if (!$table.length) $table = $('#plnMain table').first();
  if (!$table.length) $table = $('table').first();

  const headerCells = [];
  $table.find('tr').first().find('th, td').each((i, el) => {
    headerCells.push($(el).text().trim().toUpperCase());
  });

  const QUARTER_LABELS = {
    q1: [/^Q1$/, /^QUARTER\s*1$/, /^MP\s*1$/, /^1$/, /NINE.?WEEKS.?1/, /SIX.?WEEKS.?1/],
    q2: [/^Q2$/, /^QUARTER\s*2$/, /^MP\s*2$/, /^2$/, /NINE.?WEEKS.?2/, /SIX.?WEEKS.?2/],
    q3: [/^Q3$/, /^QUARTER\s*3$/, /^MP\s*3$/, /^3$/, /NINE.?WEEKS.?3/, /SIX.?WEEKS.?3/],
    q4: [/^Q4$/, /^QUARTER\s*4$/, /^MP\s*4$/, /^4$/, /NINE.?WEEKS.?4/, /SIX.?WEEKS.?4/],
  };

  const colMap = {}, usedCols = new Set();
  for (const [q, patterns] of Object.entries(QUARTER_LABELS)) {
    for (let i = 0; i < headerCells.length; i++) {
      if (usedCols.has(i)) continue;
      if (patterns.some(re => re.test(headerCells[i]))) { colMap[q] = i; usedCols.add(i); break; }
    }
  }

  let nameCol = headerCells.indexOf('DESCRIPTION');
  if (nameCol === -1) nameCol = 1;

  if (Object.keys(colMap).length < 2) {
    const numericCols = [];
    $table.find('tr').each((ri, row) => {
      if (ri === 0) return;
      const cells = $(row).find('td');
      if (cells.length < 8) return;
      if (!/^[A-Z]{2,}[\dA-Z]{2,}/.test($(cells[0]).text().trim())) return;
      cells.each((ci, cell) => {
        if (ci < 2) return;
        const txt = $(cell).text().trim();
        if (/^\d{2,3}(\.\d+)?$/.test(txt)) {
          const n = parseFloat(txt);
          if (n >= 40 && n <= 100) numericCols.push(ci);
        }
      });
      return false;
    });
    ['q1','q2','q3','q4'].forEach((q, i) => {
      if (colMap[q] === undefined && numericCols[i] !== undefined) colMap[q] = numericCols[i];
    });
  }

  const result = new Map();
  $table.find('tr').each((ri, row) => {
    if (ri === 0) return;
    const cells = $(row).find('td');
    if (cells.length < 8) return;
    const courseCode = $(cells[0]).text().trim();
    if (!courseCode || !/^[A-Z]{2,}[\dA-Z]{2,}/.test(courseCode)) return;
    let displayName = $(cells[nameCol]).text().trim().replace(/\s+S[12]\s*$/i, '').trim();
    if (!displayName) displayName = cleanName(courseCode);
    const semMatch = courseCode.match(/^[A-Z]{2,}[\dA-Z]*?([AB])\s*[-\s]/i);
    const sem = semMatch ? semMatch[1].toUpperCase() : null;
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
    if (Object.values(entry).some((v, k) => k !== 'name' && k !== 'sem' && v !== null))
      result.set(courseCode, entry);
  });

  return result;
}

// ── PARSE LIVE GRADES ────────────────────────────────────────────────────────
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

// ── PARSE STUDENT INFO ───────────────────────────────────────────────────────
function parseStudentInfo(html) {
  const $ = cheerio.load(html);
  const clean = t => (t || '').trim().replace(/\s+/g, ' ');
  const isLabel = t => !t || /:\s*$/.test(t) || t.length < 2;
  let name   = clean($('#plnMain_lblRegStudentName').text());
  let grade  = clean($('#plnMain_lblGrade').text());
  let campus = clean($('#plnMain_lblBuildingName').text());
  if (isLabel(name)) {
    name = '';
    $('[id]').each((_, el) => {
      if (name) return;
      const id = $(el).attr('id') || '';
      if (/label$/i.test(id) || !/regstudentname|lblstudentname|lblname/i.test(id)) return;
      const t = clean($(el).text());
      if (!isLabel(t) && t.length <= 60 && /[A-Za-z]/.test(t)) name = t;
    });
  }
  if (isLabel(grade)) {
    grade = '';
    $('[id]').each((_, el) => {
      if (grade) return;
      const id = $(el).attr('id') || '';
      if (/label$/i.test(id) || !/lblgrade$|gradelevel/i.test(id)) return;
      const t = clean($(el).text());
      if (!isLabel(t) && t.length < 30) grade = t;
    });
  }
  if (isLabel(campus)) {
    campus = '';
    $('[id]').each((_, el) => {
      if (campus) return;
      const id = $(el).attr('id') || '';
      if (/label$/i.test(id) || !/buildingname|campus/i.test(id)) return;
      const t = clean($(el).text());
      if (!isLabel(t) && t.length > 2 && t.length < 50) campus = t;
    });
  }
  return {
    name:   isLabel(name)   ? '' : name,
    grade:  isLabel(grade)  ? '' : grade,
    campus: isLabel(campus) ? '' : campus,
  };
}

// ── GET GRADES DATA (reusable with an existing client) ───────────────────────
async function getGradesData(client) {
  const rcRes = await client.get(RC_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const rcRows = parseAllQuartersFromPage(rcRes.data);

  const $rc = cheerio.load(rcRes.data);
  const allPeriods = [];
  $rc('#plnMain_ddlRCRuns option, select[name*="ddlRCRuns"] option').each((_, el) => {
    const value = $rc(el).attr('value');
    const label = $rc(el).text().trim();
    if (value !== undefined && label) allPeriods.push({ value, label });
  });

  const Q_PATTERNS = {
    q1: [/^1$/, /quarter\s*1\b/i, /\bmp\s*1\b/i, /\b1st\b/i, /nine.?weeks.?1\b/i],
    q2: [/^2$/, /quarter\s*2\b/i, /\bmp\s*2\b/i, /\b2nd\b/i, /nine.?weeks.?2\b/i],
    q3: [/^3$/, /quarter\s*3\b/i, /\bmp\s*3\b/i, /\b3rd\b/i, /nine.?weeks.?3\b/i],
    q4: [/^4$/, /quarter\s*4\b/i, /\bmp\s*4\b/i, /\b4th\b/i, /nine.?weeks.?4\b/i],
  };
  const quarterMap = {}, usedQVals = new Set();
  for (const [q, pats] of Object.entries(Q_PATTERNS)) {
    const match = allPeriods.find(p => !usedQVals.has(p.value) && pats.some(re => re.test(p.label.trim())));
    if (match) { quarterMap[q] = match; usedQVals.add(match.value); }
  }
  const unmatched = allPeriods.filter(p => !usedQVals.has(p.value));
  ['q1','q2','q3','q4'].filter(q => !quarterMap[q]).forEach((q, i) => {
    if (unmatched[i]) { quarterMap[q] = unmatched[i]; usedQVals.add(unmatched[i].value); }
  });

  let assignPeriodMap = {};
  try {
    const cwInitRes = await client.get(CW_URL, {
      headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    const $cw = cheerio.load(cwInitRes.data);
    $cw('#plnMain_ddlReportCardRuns option').each((_, el) => {
      const val = $cw(el).attr('value') || '';
      const lbl = $cw(el).text().trim();
      if (val && val !== 'ALL') assignPeriodMap[lbl] = val;
    });
  } catch (e) { console.error('[assignPeriodMap]', e.message); }

  let liveGrades = new Map();
  try {
    liveGrades = parseLiveGrades((await client.get(CW_URL)).data);
  } catch (err) { console.error('[live]', err.message); }

  let student = { name: '', grade: '', campus: '' };
  try {
    student = parseStudentInfo((await client.get(INFO_URL)).data);
  } catch (err) { console.error('[student info]', err.message); }

  function liveFor(displayName) {
    const target = normKey(displayName);
    for (const [k, v] of liveGrades) {
      if (normKey(cleanName(k)) === target || normKey(k) === target) return v;
    }
    return null;
  }

  const merged = new Map();
  rcRows.forEach(({ name, sem, q1, q2, q3, q4 }) => {
    if (!name || name.length < 2) return;
    const key = courseBaseKey(name);
    if (!merged.has(key)) merged.set(key, { name, q1: null, q2: null, q3: null, q4: null });
    const entry = merged.get(key);
    if (sem === 'A') {
      if (q1 !== null) entry.q1 = q1;
      if (q2 !== null) entry.q2 = q2;
    } else if (sem === 'B') {
      if (q3 !== null) entry.q3 = q3;
      if (q4 !== null) entry.q4 = q4;
      if (entry.q4 === null) entry.q4 = liveFor(name);
    } else {
      if (q1 !== null) entry.q1 = q1;
      if (q2 !== null) entry.q2 = q2;
      if (q3 !== null) entry.q3 = q3;
      if (q4 !== null) entry.q4 = q4;
      if (entry.q4 === null) entry.q4 = liveFor(name);
    }
  });

  let courses = [];
  merged.forEach(({ name, q1, q2, q3, q4 }) => {
    if ([q1, q2, q3, q4].every(v => v === null)) return;
    courses.push({ name, q1avg: q1, q2avg: q2, q3avg: q3, q4avg: q4 });
  });
  if (!courses.length && liveGrades.size > 0) {
    liveGrades.forEach((avg, rawName) => {
      const name = cleanName(rawName) || rawName;
      courses.push({ name, q1avg: null, q2avg: null, q3avg: null, q4avg: avg });
    });
  }
  courses.sort((a, b) => a.name.localeCompare(b.name));

  return {
    student, courses,
    _debug: {
      allPeriods,
      quarterMap:       Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.value])),
      quarterLabels:    Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, p.label])),
      assignQuarterMap: Object.fromEntries(Object.entries(quarterMap).map(([q,p]) => [q, assignPeriodMap[p.label] || p.value])),
      rcRowCount: rcRows.size,
      mergedCount: courses.length,
      liveCount: liveGrades.size,
    },
  };
}

// ── ASSIGNMENTS ──────────────────────────────────────────────────────────────
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
      if (/overall average/i.test(assignName)) return;
      if (scoreRaw.includes('%') && !scoreRaw.includes('/') && !parseFloat(scoreRaw)) return;
      const score = parseFloat(scoreRaw);
      const total = parseFloat(totalRaw);
      assignments.push({ dateDue, name: assignName, category,
        score: isNaN(score) ? null : score,
        total: isNaN(total) ? null : total,
        raw: scoreRaw });
    });
    classes.push({ name: displayName, rawName: rawHeading, assignments });
  });
  return classes;
}

function findRunSelect($page) {
  let $sel = $page('#plnMain_ddlReportCardRuns');
  if (!$sel.length) $sel = $page('select[name*="ReportCardRun"]');
  if (!$sel.length) $sel = $page('select[name*="RCRun"]');
  if (!$sel.length) {
    $page('select').each((_, el) => {
      if ($sel.length) return;
      const opts = $page(el).find('option').map((__, o) => ($page(o).attr('value') || '').trim()).get();
      if (opts.filter(v => /^\d+(-\d{2,4})?$/.test(v)).length >= 2) $sel = $page(el);
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
  const selected = $sel.find('option[selected]').attr('value') || $sel.val() || (options[0] && options[0].value) || '';
  return { name, options, selected };
}

function buildPostBody($page, opts = {}) {
  const fd = {};
  $page('input[type="hidden"]').each((_, el) => {
    const name = $page(el).attr('name');
    if (name) fd[name] = $page(el).val() || '';
  });
  $page('select').each((_, el) => {
    const name = $page(el).attr('name');
    if (!name) return;
    const sel = $page(el).find('option[selected]').attr('value');
    fd[name] = sel !== undefined ? sel : ($page(el).val() || '');
  });
  for (const k of Object.keys(fd)) {
    if (/ddlClasses$|ddlCompetencies$/i.test(k)) fd[k] = 'ALL';
    if (/ddlOrderBy$/i.test(k)) fd[k] = 'Class';
  }
  fd['__EVENTTARGET']   = opts.eventTarget || '';
  fd['__EVENTARGUMENT'] = opts.eventArg    || '';
  if (opts.set) Object.assign(fd, opts.set);
  return new URLSearchParams(fd).toString();
}

function runMirrorFields($page) {
  const names = [];
  $page('input[type="hidden"]').each((_, el) => {
    const n = $page(el).attr('name') || '';
    if (/hdn.*ReportCardRun/i.test(n)) names.push(n);
  });
  return names;
}

function looksLikeDelta(text) {
  return typeof text === 'string' && /^\s*\d+\|[^|]*\|/.test(text.slice(0, 60));
}

function extractHtmlFromDelta(text) {
  let html = '', i = 0;
  while (i < text.length) {
    const p1 = text.indexOf('|', i);             if (p1 < 0) break;
    const len = parseInt(text.slice(i, p1), 10); if (Number.isNaN(len)) break;
    const p2 = text.indexOf('|', p1 + 1);        if (p2 < 0) break;
    const p3 = text.indexOf('|', p2 + 1);        if (p3 < 0) break;
    const type    = text.slice(p1 + 1, p2);
    const content = text.slice(p3 + 1, p3 + 1 + len);
    if (type === 'updatePanel') html += content;
    i = p3 + 1 + len + 1;
  }
  return html || text;
}

function countAssignments(classes) {
  return classes.reduce((s, c) => s + c.assignments.length, 0);
}

async function fetchPeriodData(client, runName, periodValue) {
  const diag = { used: 'none', attempts: [] };
  const freshRes = await client.get(CW_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: HAC_BASE },
  });
  const $fresh = cheerio.load(freshRes.data);
  const mirrors   = runMirrorFields($fresh);
  const mirrorSet = Object.fromEntries(mirrors.map(n => [n, periodValue]));
  const withRun   = { [runName]: periodValue, ...mirrorSet };

  const strategies = [
    { name: 'dropdown+mirrors', opts: { eventTarget: runName, set: withRun } },
    { name: 'dropdown',         opts: { eventTarget: runName, set: { [runName]: periodValue } } },
  ];

  let classes = [];
  for (const strat of strategies) {
    let raw;
    try {
      const r = await client.post(CW_URL, buildPostBody($fresh, strat.opts), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': CW_URL,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      raw = String(r.data);
    } catch (e) { diag.attempts.push({ strategy: strat.name, error: e.message }); continue; }

    const html = looksLikeDelta(raw) ? extractHtmlFromDelta(raw) : raw;
    const c    = parseAssignments(html);
    diag.attempts.push({ strategy: strat.name, blocks: c.length, assignments: countAssignments(c) });
    if (countAssignments(c) > 0) { classes = c; diag.used = strat.name; break; }
    if (c.length > classes.length) classes = c;
  }
  return { classes, diag };
}

async function getAssignmentsData(client) {
  const initRes = await client.get(CW_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', Referer: HAC_BASE },
  });
  const $init = cheerio.load(initRes.data);
  const runSel = findRunSelect($init);
  if (!runSel || !runSel.options.length) throw new Error('No grading periods found on assignments page.');

  const { name: runName, options: periodOpts, selected: defaultSelected } = runSel;
  console.log('[asgn] runName=' + runName + ' default=' + defaultSelected + ' periods:', periodOpts.map(p => p.label + '=' + p.value).join(', '));

  const allData = {};
  const debugPerPeriod = [];

  await Promise.all(periodOpts.map(async p => {
    if (p.value === defaultSelected) {
      allData[p.value] = parseAssignments(initRes.data);
      debugPerPeriod.push({ value: p.value, label: p.label, used: 'default', blocks: allData[p.value].length, assignments: countAssignments(allData[p.value]) });
      return;
    }
    try {
      const { classes, diag } = await fetchPeriodData(client, runName, p.value);
      allData[p.value] = classes;
      debugPerPeriod.push({ value: p.value, label: p.label, ...diag, blocks: classes.length, assignments: countAssignments(classes) });
    } catch (e) {
      console.error('[asgn] period ' + p.value + ' failed:', e.message);
      allData[p.value] = [];
      debugPerPeriod.push({ value: p.value, label: p.label, used: 'error', error: e.message });
    }
  }));

  const sortedPeriods = [...periodOpts].sort((a, b) => {
    const na = parseInt(a.value, 10) || parseInt(a.label, 10) || 0;
    const nb = parseInt(b.value, 10) || parseInt(b.label, 10) || 0;
    return na - nb;
  });
  const quarterMapping = {};
  sortedPeriods.forEach((p, i) => { const q = ['q1','q2','q3','q4'][i]; if (q) quarterMapping[q] = p.value; });

  const byClass = {};
  for (const [q, periodVal] of Object.entries(quarterMapping)) {
    (allData[periodVal] || []).forEach(cls => {
      if (!byClass[cls.name]) byClass[cls.name] = {};
      byClass[cls.name][q] = cls.assignments;
    });
  }

  console.log('[asgn] byClass courses:', Object.keys(byClass).length, 'quarterMapping:', JSON.stringify(quarterMapping));
  return { periodOpts, byClass, _debug: { runName, defaultSelected, quarterMapping, perPeriod: debugPerPeriod } };
}

// ── TRANSCRIPT ───────────────────────────────────────────────────────────────
const COURSE_LOOKUP = {
  'ALG 1':'Algebra 1','ALG 2':'Algebra 2','GEOM':'Geometry',
  'APCALCAB':'AP Calculus AB','APCALCBC':'AP Calculus BC','AP Precalculus':'AP Precalculus',
  'BIO':'Biology','APBIO':'AP Biology','CHEM':'Chemistry','Chemistry':'Chemistry',
  'APPHYS1':'AP Physics 1','APPHYS2':'AP Physics 2','APPHYSC':'AP Physics C: Mechanics',
  'ENG 1':'English 1','ENG 2':'English 2','ENG 3':'English 3','ENG 4':'English 4',
  'APLANG':'AP Language & Composition','APLIT':'AP Literature & Composition',
  'APHUMGEOW':'AP Human Geography','APWHIST':'AP World History',
  'APUSHIST':'AP US History','APGOV':'AP Government & Politics',
  'APECON':'AP Economics','APPSYCH':'AP Psychology','APSEM':'AP Seminar','APRES':'AP Research',
  'APSPALAN':'AP Spanish Language & Culture',
  'SPAN 3':'Spanish 3','SPAN 4':'Spanish 4',
  'LOTE Level I - Spanish':'Spanish I','LOTE Level II - Spanish':'Spanish II',
  'APTACSAM':'AP Computer Science A (S1)','APTACSAL':'AP Computer Science A (S2)',
  'APCSA':'AP Computer Science A','TACS1':'Computer Science I','TACS2':'Computer Science II',
  'AP Computer Science 1 WL':'AP Computer Science 1',
  'PROFCOMM':'Professional Communications','HLTHED1':'Health Education',
  'SS RES3':'Student Success (S1)','SS RES4':'Student Success (S2)',
};
function expandCourseName(raw) { return COURSE_LOOKUP[raw && raw.trim()] || (raw && raw.trim()) || raw; }

function parseTranscript(html) {
  const $ = cheerio.load(html);
  const gpa = { weighted: null, college: null, rank: null };
  $('#plnMain_rpTranscriptGroup_tblCumGPAInfo tr').each((ri, row) => {
    if (ri === 0) return;
    const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
    const label = (cells[0] || '').toLowerCase();
    if (label.includes('weighted')) { if (cells[1]) gpa.weighted = cells[1]; if (cells[2]) gpa.rank = cells[2]; }
    else if (label.includes('4.0') || label.includes('college')) { if (cells[1]) gpa.college = cells[1]; }
  });
  const allYears = [], allBuildings = [];
  $('td').each((_, el) => {
    const txt = $(el).text().trim();
    if (/^\d{4}-\d{4}$/.test(txt)) allYears.push(txt);
    if (/high school|middle school|summer/i.test(txt) && txt.length < 60) allBuildings.push(txt);
  });
  const years = [];
  let idx = 0;
  while (true) {
    const $ct = $(`#plnMain_rpTranscriptGroup_dgCourses_${idx}`);
    if (!$ct.length) break;
    const grade  = $(`#plnMain_rpTranscriptGroup_lblGradeValue_${idx}`).text().trim();
    const credit = $(`#plnMain_rpTranscriptGroup_LblTCreditValue_${idx}`).text().trim();
    const courses = [];
    $ct.find('tr').each((ri, row) => {
      if (ri === 0) return;
      const cells = $(row).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length < 4) return;
      const code = cells[0], rawName = cells[1];
      if (!code || !rawName) return;
      const sem1 = cells[2] !== '' ? parseFloat(cells[2]) : null;
      const sem2 = cells[3] !== '' ? parseFloat(cells[3]) : null;
      const fin  = cells[4] !== '' ? parseFloat(cells[4]) : null;
      const cred = cells[5] !== '' ? parseFloat(cells[5]) : null;
      if (sem1 === null && sem2 === null && fin === null) return;
      courses.push({ code, name: expandCourseName(rawName), sem1, sem2, fin, credit: cred });
    });
    years.push({ year: allYears[idx] || '', grade, building: allBuildings[idx] || '', totalCredit: parseFloat(credit) || 0, courses });
    idx++;
  }
  years.sort((a, b) => (a.year || '').localeCompare(b.year || ''));
  return { gpa, years };
}

async function getTranscriptData(client) {
  const tRes = await client.get(TRANSCRIPT_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  return parseTranscript(tRes.data);
}

// ── TEACHERS ─────────────────────────────────────────────────────────────────
function flipName(s) {
  s = (s || '').trim().replace(/\s+/g, ' ');
  const m = s.match(/^([^,]+),\s*(.+)$/);
  const ordered = m ? (m[2].trim() + ' ' + m[1].trim()) : s;
  return ordered.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

function parseTeachers(html) {
  const $ = cheerio.load(html);
  const out = [], seen = new Set();
  $('table').each((_, tbl) => {
    const $tbl = $(tbl);
    const headers = $tbl.find('tr').first().find('th, td').map((_, c) => $(c).text().trim().toLowerCase()).get();
    if (!headers.length) return;
    const idx = re => headers.findIndex(h => re.test(h));
    const tIdx = idx(/teacher|staff|instructor/);
    if (tIdx < 0) return;
    let cIdx = idx(/description|course\s*name|course\s*title/);
    if (cIdx < 0) cIdx = idx(/^course$|^class$|subject/);
    const pIdx = idx(/period/);
    const rIdx = idx(/room/);
    $tbl.find('tr').each((ri, row) => {
      if (ri === 0) return;
      const $cells = $(row).find('td');
      if ($cells.length <= tIdx) return;
      const cellAt = i => (i >= 0 && i < $cells.length) ? $($cells[i]) : null;
      const $t = cellAt(tIdx);
      let teacher = ($t ? $t.text().trim() : '').replace(/\s+/g, ' ');
      let email = '';
      const $mail = ($t || $(row)).find('a[href^="mailto:" i]').first();
      if ($mail.length) { email = ($mail.attr('href') || '').replace(/^mailto:/i, '').trim(); if (!teacher) teacher = $mail.text().trim(); }
      if (!teacher || /^teacher$/i.test(teacher)) return;
      let course = cIdx >= 0 && cellAt(cIdx) ? cellAt(cIdx).text().trim() : '';
      if (!course) {
        let best = '';
        $cells.each((i, c) => { if (i === tIdx || i === rIdx || i === pIdx) return; const t = $(c).text().trim(); if (t.length > best.length && /[A-Za-z]{3}/.test(t)) best = t; });
        course = best;
      }
      course = cleanName(course.replace(/\s+/g, ' ')) || course.replace(/\s+/g, ' ');
      const period = pIdx >= 0 && cellAt(pIdx) ? cellAt(pIdx).text().trim() : '';
      const key = teacher + '|' + course;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ course, teacher: flipName(teacher), email, period });
    });
  });
  return out;
}

async function getTeachersData(client) {
  const r = await client.get(SCHED_URL, {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  return parseTeachers(r.data);
}

// ── TEACHER PHOTOS ───────────────────────────────────────────────────────────
let _staffDirCache = null;
function _normName(s) { return (s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim(); }
function campusCandidates(campusName) {
  const list = ['reedy-high-school', 'reedy', 'reedyhighschool', 'Reedy High School'];
  const c = (campusName || '').trim();
  if (c) list.unshift(c, c.toLowerCase().replace(/\s+/g, '-'), c.toLowerCase().split(/\s+/)[0], c.toLowerCase().replace(/\s+/g, ''));
  return [...new Set(list.filter(Boolean))];
}

async function fetchStaffDirectory(campusName) {
  if (_staffDirCache && Date.now() - _staffDirCache.ts < 6 * 3600 * 1000) return _staffDirCache;
  for (const campus of campusCandidates(campusName)) {
    for (const directory of ['staff', 'Staff']) {
      try {
        const r = await axios.get(STAFF_API, {
          params: { campus, directory, pow: false }, timeout: 12000,
          headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, validateStatus: () => true,
        });
        let arr = r.data;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = null; } }
        if (!Array.isArray(arr) || !arr.some(s => s && s.Email && s.Photo)) continue;
        const byEmail = {}, byName = {};
        arr.forEach(s => {
          if (!s || !s.Photo) return;
          if (s.Email) byEmail[String(s.Email).toLowerCase().trim()] = s.Photo;
          const nm = _normName((s.FirstName || '') + ' ' + (s.LastName || ''));
          if (nm) byName[nm] = s.Photo;
        });
        _staffDirCache = { ts: Date.now(), byEmail, byName };
        return _staffDirCache;
      } catch (_) { /* try next */ }
    }
  }
  return null;
}

async function attachTeacherPhotos(teachers, campusName) {
  if (!teachers || !teachers.length) return teachers;
  let dir = null;
  try { dir = await fetchStaffDirectory(campusName); } catch (_) {}
  if (!dir) return teachers;
  teachers.forEach(t => {
    const email = (t.email || '').toLowerCase().trim();
    let photo = email && dir.byEmail[email];
    if (!photo) { const nm = _normName(t.teacher); if (nm && dir.byName[nm]) photo = dir.byName[nm]; }
    if (photo) t.photo = photo;
  });
  return teachers;
}

// ── /api/grades ──────────────────────────────────────────────────────────────
app.post('/api/grades', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const data = await getGradesData(client);
    if (!data.courses.length) return res.status(404).json({ error: 'No grade data found.' });
    res.json(data);
  } catch (err) {
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message || 'Unknown server error.' });
  }
});

// ── /api/bootstrap (one login, all data) ────────────────────────────────────
app.post('/api/bootstrap', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
  } catch (err) {
    const status = err.message?.includes('username or password') ? 401 : 500;
    return res.status(status).json({ error: err.message || 'Login failed.' });
  }

  const [gradesR, assignR, transcriptR, teachersR] = await Promise.allSettled([
    getGradesData(client),
    getAssignmentsData(client),
    getTranscriptData(client),
    getTeachersData(client),
  ]);

  const out = { errors: {} };
  if (gradesR.status === 'fulfilled') {
    out.student = gradesR.value.student;
    out.courses  = gradesR.value.courses;
    out._debug   = gradesR.value._debug;
  } else { out.courses = []; out.errors.grades = gradesR.reason?.message; }

  if (assignR.status === 'fulfilled') {
    out.assignByClass = assignR.value.byClass;
  } else { out.assignByClass = {}; out.errors.assignments = assignR.reason?.message; }

  if (transcriptR.status === 'fulfilled') {
    out.transcript = transcriptR.value;
  } else { out.errors.transcript = transcriptR.reason?.message; }

  if (teachersR.status === 'fulfilled') {
    out.teachers = teachersR.value;
  } else { out.teachers = []; out.errors.teachers = teachersR.reason?.message; }

  if (out.teachers && out.teachers.length) {
    const campus = (gradesR.status === 'fulfilled' && gradesR.value.student && gradesR.value.student.campus) || '';
    try { await attachTeacherPhotos(out.teachers, campus); } catch (_) {}
  }

  if (!out.courses || !out.courses.length) return res.status(404).json({ error: out.errors.grades || 'No grade data found.' });
  res.json(out);
});

// ── /api/assignments ─────────────────────────────────────────────────────────
app.post('/api/assignments', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  try {
    const client = makeClient();
    await login(client, username, password);
    res.json(await getAssignmentsData(client));
  } catch (err) {
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── /api/transcript ──────────────────────────────────────────────────────────
app.post('/api/transcript', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const transcript = await getTranscriptData(client);
    if (!transcript.years.length) return res.status(404).json({ error: 'No transcript data found.' });
    res.json(transcript);
  } catch (err) {
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── /api/teachers ────────────────────────────────────────────────────────────
app.post('/api/teachers', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  const client = makeClient();
  try {
    await login(client, username, password);
    const teachers = await getTeachersData(client);
    try { await attachTeacherPhotos(teachers); } catch (_) {}
    res.json({ teachers });
  } catch (err) {
    const status = err.message?.includes('username or password') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ── STATIC + HEALTH ──────────────────────────────────────────────────────────
app.get('/',           (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GradeCheck server → http://localhost:${PORT}`));
