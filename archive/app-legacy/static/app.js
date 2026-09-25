'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const statuses = ['Idea', 'Planned', 'Printing', 'Done'];
const statusMeta = {Idea:'Concept', Planned:'Model chosen', Printing:'On the plate', Done:'Made'};
const jobStatuses = ['Queued', 'Printing', 'Succeeded', 'Failed', 'Cancelled'];
const finished = new Set(['Succeeded', 'Failed', 'Cancelled']);
const categories = ['Office', 'Home lab', 'Home', 'Creative'];
const categoryGlyph = {'Office':'▤', 'Home lab':'⌬', 'Home':'⌂', 'Creative':'✦'};
const materials = ['PLA', 'PLA Matte', 'PLA Silk', 'PLA-CF', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'Other'];
const plates = ['Textured PEI', 'Smooth PEI', 'Cool plate', 'Engineering plate', 'Other'];
const starterSteps = ['Measure the space and constraints', 'Choose or design a model', 'Check license, size and fit', 'Slice and save the project file', 'Test print', 'Install or hand it over'];
const views = ['projects', 'jobs', 'printer', 'filament', 'family'];
const themes = [['auto', 'Auto', 'Follows your system'], ['holo', 'Holo', 'Cyan and violet on deep navy'], ['nebula', 'Nebula', 'Pink and lavender on plum'], ['ember', 'Ember', 'Warm amber on charcoal'], ['terminal', 'Terminal', 'Phosphor green on black'], ['arctic', 'Arctic', 'Light, crisp blue'], ['sand', 'Sand', 'Light, warm paper']];
const printerStates = {IDLE:'Idle', PREPARE:'Preparing', RUNNING:'Printing', PAUSE:'Paused', FINISH:'Finished', FAILED:'Failed', SLICING:'Slicing', UNKNOWN:'Waiting for data'};

let state, route = parseRoute(), profile = 'all', status = 'All', query = '', editing = null, busy = false;
let printer = {configured:false}, aiInfo = {configured:false};

// ---------- Helpers ----------
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
const avatar = (p) => p ? `<span class="avatar ${esc(p.color)}" aria-hidden="true">${esc(initials(p.name))}</span>` : '';
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const byId = (list, id) => list.find(x => x.id === id);
const num = (v) => v === '' || v === undefined || v === null ? null : Number(v);
const starter = () => starterSteps.map(text => ({id:uuid(), text, done:false}));
const duration = (m) => m === null || m === undefined ? '—' : m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
const weight = (g) => g === null || g === undefined ? '—' : g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`;
const money = (v) => v === null || v === undefined ? '—' : v.toFixed(2);
const stamp = (iso) => iso ? new Date(iso).toLocaleString(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '';
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const fromLocalInput = (v) => v ? new Date(v).toISOString() : '';
const profileOf = (project) => project && byId(state.profiles, project.profileId);
const projectOf = (job) => byId(state.projects, job.projectId);
const spoolOf = (id) => id ? byId(state.spools, id) : null;
const ownedProjects = () => state.projects.filter(i => profile === 'all' || i.profileId === profile);
const ownedJobs = () => { const ids = new Set(ownedProjects().map(p => p.id)); return state.jobs.filter(j => ids.has(j.projectId)); };
const jobsFor = (projectId) => state.jobs.filter(j => j.projectId === projectId);
// The project list as currently filtered; the home grid and the detail sidebar show the same set.
const matches = (i, q) => `${i.title} ${i.description} ${i.category} ${i.notes} ${i.material}`.toLowerCase().includes(q.toLowerCase());
const listedProjects = () => {
  const items = ownedProjects().filter(i => (status === 'All' || i.status === status) && matches(i, query));
  return [...items.filter(i => i.pinned), ...items.filter(i => !i.pinned)];
};
const pinIcon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.8 1.4a1 1 0 0 1 1.4 0l3.4 3.4a1 1 0 0 1 0 1.4l-.7.7a1 1 0 0 1-1 .25l-2.2 2.2.3 2.6a1 1 0 0 1-.28.83l-.5.5a.7.7 0 0 1-1 0L6.7 10.8l-3.9 3.9a.6.6 0 0 1-.85-.85l3.9-3.9-2.5-2.5a.7.7 0 0 1 0-1l.5-.5a1 1 0 0 1 .83-.28l2.6.3 2.2-2.2a1 1 0 0 1 .25-1z"/></svg>';
// When a search matches outside the title, a short excerpt around the match explains why the row is listed.
function matchExcerpt(i, q) {
  if (!q || i.title.toLowerCase().includes(q.toLowerCase())) return '';
  for (const text of [i.description, i.notes, i.material, i.category]) {
    const at = (text || '').toLowerCase().indexOf(q.toLowerCase());
    if (at < 0) continue;
    const start = Math.max(0, at - 18), end = Math.min(text.length, at + q.length + 26);
    return `${start ? '…' : ''}${highlight(text.slice(start, end).replace(/\s+/g, ' '), q)}${end < text.length ? '…' : ''}`;
  }
  return '';
}
// Escapes text and wraps search matches in <mark>.
function highlight(text, q) {
  if (!q) return esc(text);
  const lower = text.toLowerCase(), needle = q.toLowerCase(), out = [];
  let at = 0, hit;
  while (needle && (hit = lower.indexOf(needle, at)) !== -1) { out.push(esc(text.slice(at, hit)), `<mark>${esc(text.slice(hit, hit + needle.length))}</mark>`); at = hit + needle.length; }
  out.push(esc(text.slice(at)));
  return out.join('');
}
// Shared view-transition names let a grid card morph into its sidebar row and back.
const vtName = (id) => `p-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const usedGrams = (jobs) => jobs.filter(j => ['Succeeded', 'Failed'].includes(j.status)).reduce((sum, j) => sum + (j.grams ?? 0), 0);
const printMinutes = (jobs) => jobs.filter(j => ['Succeeded', 'Failed'].includes(j.status)).reduce((sum, j) => sum + (j.actualMinutes ?? j.minutes ?? 0), 0);
function successRate(jobs) { const ok = jobs.filter(j => j.status === 'Succeeded').length, done = ok + jobs.filter(j => j.status === 'Failed').length; return done ? ok / done : null; }
function jobCost(job) { const s = spoolOf(job.spoolId); return s && s.cost !== null && job.grams !== null ? job.grams * s.cost / s.totalGrams : null; }
// Live printer data for a job linked to the print that is running now.
const liveFor = (job) => printer.connected && printer.printing && job.printerTask && printer.state?.task === job.printerTask ? printer.state : null;
function jobProgress(job) {
  if (job.status !== 'Printing') return null;
  const live = liveFor(job);
  if (live && live.percent !== null) return live.percent / 100;
  if (!job.startedAt || !job.minutes) return null;
  return Math.min(1, Math.max(0, (Date.now() - Date.parse(job.startedAt)) / (job.minutes * 60000)));
}
const sortJobs = (jobs) => [...jobs].sort((a, b) => (b.finishedAt || b.startedAt || b.createdAt).localeCompare(a.finishedAt || a.startedAt || a.createdAt));

function parseRoute() {
  const [, a = '', b = ''] = location.hash.match(/^#\/?([^/]*)\/?(.*)$/) || [];
  if (a === 'project' && b) return {view:'project', id:decodeURIComponent(b)};
  return {view:views.includes(a) ? a : 'projects'};
}
const go = (hash) => { if (location.hash === hash) { route = parseRoute(); render(); } else location.hash = hash; };

function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 3600); }
function showError(message) { $('#global-error').textContent = message; $('#global-error').hidden = false; }

function saveState(state) {
  const el = $('#save-state'); clearTimeout(saveState.timer);
  el.dataset.state = state;
  el.textContent = {saving:'Saving…', saved:'Saved', error:'Not saved', offline:'Workspace unavailable', idle:''}[state];
  if (state === 'saved') saveState.timer = setTimeout(() => saveState('idle'), 1800);
}
async function save(next) {
  saveState('saving');
  try {
    const response = await fetch('/api/state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(next)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save. Try again.');
    state = result;
    $('#global-error').hidden = true;
    saveState('saved');
    render();
  } catch (error) { saveState('error'); throw error; }
}

// Applies a change to a copy of the latest state and saves it.
async function commit(mutate, message) {
  if (busy || !state) return false;
  busy = true;
  try { const next = structuredClone(state); mutate(next); await save(next); if (message) toast(message); return true; }
  catch (error) { showError(error.message); return false; }
  finally { busy = false; }
}

// ---------- Shared fragments ----------
const statusPill = (s, live = false) => `<span class="status-pill ${esc(s)}${live ? ' live' : ''}"><i aria-hidden="true"></i>${esc(live ? 'Printing now' : s)}</span>`;
const progressBar = (s) => `<span class="card-progress ${esc(s)}" aria-hidden="true">${statuses.map((x, n) => `<i class="${n <= statuses.indexOf(s) ? 'on' : ''}"></i>`).join('')}</span>`;
const printerChip = () => `<a class="printer-chip" href="#/printer" data-printer-chip>${printerChipInner()}</a>`;
function printerChipInner() {
  const name = esc(printer.name || 'Bambu Lab X2D') + (printer.simulated ? ' <span class="sim-badge">Simulator</span>' : '');
  if (!printer.configured) return `<span class="pulse off" aria-hidden="true"></span>${name} <em>· not connected</em>`;
  if (!printer.connected) return `<span class="pulse off" aria-hidden="true"></span>${name} <em>· offline</em>`;
  const s = printer.state;
  if (!s) return `<span class="pulse" aria-hidden="true"></span>${name} <em>· connecting</em>`;
  const label = printerStates[s.gcodeState] || s.gcodeState;
  return `<span class="pulse ${printer.printing ? 'live' : 'idle'}" aria-hidden="true"></span>${name} <em>· ${esc(label)}${printer.printing && s.percent !== null ? ` ${s.percent}%` : ''}</em>`;
}
const tiles = (items, label) => `<dl class="pipeline" aria-label="${esc(label)}">${items.map(t => `<div class="stat t-${t.tone}"><dt>${esc(t.label)}<small>${esc(t.sub)}</small></dt><dd>${esc(t.value)}</dd><span class="bar" data-p="${t.p ?? 0}" aria-hidden="true"></span></div>`).join('')}</dl>`;
function hero({eyebrow, title, text, actions = '', extra = '', crumb = ''}) {
  $('#hero-copy').innerHTML = `${crumb}<div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${text ? `<p>${esc(text)}</p>` : ''}<div class="hero-actions">${actions}</div>${extra}`;
}
const swatch = (spool, fallback) => spool ? `<span class="swatch" data-swatch="${esc(spool.colorHex)}" aria-hidden="true"></span>` : fallback ? '<span class="swatch none" aria-hidden="true"></span>' : '';
function setVars(root = document) {
  $$('[data-p]', root).forEach(el => el.style.setProperty('--p', el.dataset.p));
  $$('[data-swatch]', root).forEach(el => el.style.setProperty('--swatch', el.dataset.swatch));
}
function updateProgress() {
  $$('[data-job-progress]').forEach(el => {
    const job = byId(state.jobs, el.dataset.jobProgress); if (!job) return;
    const p = jobProgress(job), bar = $('.bar', el), label = $('small', el), live = liveFor(job);
    el.classList.toggle('live', !!live);
    if (live && p !== null) { bar.style.setProperty('--p', p); label.textContent = `Live · ${Math.round(p * 100)}%${live.layer !== null ? ` · layer ${live.layer}/${live.totalLayers ?? '?'}` : ''}${live.remainingMinutes !== null ? ` · ${duration(live.remainingMinutes)} left` : ''}`; return; }
    if (p === null) { bar.style.setProperty('--p', 0); label.textContent = job.startedAt ? `Started ${stamp(job.startedAt)} · add an estimate to see progress` : 'Started'; return; }
    bar.style.setProperty('--p', p);
    const left = job.minutes * (1 - p);
    label.textContent = p >= 1 ? `Estimate reached · started ${stamp(job.startedAt)}` : `${Math.round(p * 100)}% (estimated) · ~${duration(left)} left`;
  });
  if (route.view === 'project') focusStage();
}

const jobTone = {Queued:'Idea', Printing:'Printing', Succeeded:'Done', Failed:'Failed', Cancelled:'Cancelled'};
function jobCard(job, {showProject = true} = {}) {
  const project = projectOf(job), spool = spoolOf(job.spoolId), owner = profileOf(project), id = esc(job.id);
  const specs = [job.material || spool?.material, job.layerHeight && `${job.layerHeight} mm`, job.nozzle && `${job.nozzle} nozzle`, job.plate, job.infill !== null && `${job.infill}% infill`, job.supports && job.supports !== 'None' && `${job.supports} supports`].filter(Boolean);
  const time = finished.has(job.status) && job.actualMinutes !== null ? `${duration(job.actualMinutes)} actual` : job.minutes !== null ? `${duration(job.minutes)} est.` : '';
  const figures = [time, job.grams !== null && weight(job.grams), jobCost(job) !== null && `cost ${money(jobCost(job))}`].filter(Boolean);
  const buttons = {
    Queued: `<button class="mini primary-mini" data-action="job-start" data-id="${id}">Start</button><button class="mini" data-action="job-cancel" data-id="${id}">Cancel</button>`,
    Printing: `<button class="mini primary-mini" data-action="job-done" data-id="${id}">Succeeded</button><button class="mini danger-mini" data-action="job-fail" data-id="${id}">Failed</button>`,
    Failed: `<button class="mini" data-action="job-reprint" data-id="${id}">Reprint</button><button class="mini ai" data-action="ai-diagnose" data-id="${id}">✦ Diagnose</button>`,
    Succeeded: `<button class="mini" data-action="job-reprint" data-id="${id}">Print again</button>`,
    Cancelled: `<button class="mini" data-action="job-reprint" data-id="${id}">Re-queue</button>`,
  }[job.status];
  const when = job.status === 'Queued' ? `Queued ${stamp(job.createdAt)}` : job.status === 'Printing' ? '' : job.finishedAt ? stamp(job.finishedAt) : '';
  return `<article class="job-card">
    <div class="card-top"><span class="job-rev">${esc(job.revision || 'Print')}${job.printerTask ? ` <span class="job-link" title="Linked to printer task ${esc(job.printerTask)}">· linked to printer</span>` : ''}</span><span class="status-pill ${jobTone[job.status]}"><i aria-hidden="true"></i>${esc(job.status)}</span></div>
    ${showProject && project ? `<h3><a href="#/project/${encodeURIComponent(project.id)}">${esc(project.title)}</a></h3><span class="job-owner">${avatar(owner)}${esc(owner?.name)}</span>` : ''}
    <p class="job-meta">${swatch(spool, true)}<span>${esc(specs.join(' · ') || 'No settings recorded')}</span></p>
    ${figures.length ? `<p class="job-figures">${figures.map(f => `<span>${esc(f)}</span>`).join('')}</p>` : ''}
    ${job.status === 'Printing' ? `<div class="job-progress" data-job-progress="${id}"><span class="bar" aria-hidden="true"></span><small></small></div>` : ''}
    ${job.notes ? `<p class="job-notes">${esc(job.notes)}</p>` : ''}
    <div class="job-actions">${buttons}<span class="job-when">${esc(when)}</span><button class="mini icon" data-action="edit-job" data-id="${id}" aria-label="Edit print job" title="Edit">✎</button></div>
  </article>`;
}

// ---------- Views ----------
function renderProjects() {
  const owned = ownedProjects(), total = Math.max(owned.length, 1), who = byId(state.profiles, profile);
  hero({eyebrow:who ? `${who.name.toUpperCase()}'S WORKBENCH` : 'IDEAS → REAL THINGS', title:'What shall we make?', text:'A little practical. A little playful. Something for everyone.',
    actions:`<button class="primary" data-action="new-project">＋ New idea</button><button class="secondary ai" data-action="ai-ideas" data-id="${esc(profile)}">✦ Suggest ideas</button>${printerChip()}`,
    extra:tiles(statuses.map(s => { const n = owned.filter(i => i.status === s).length; return {label:s, sub:statusMeta[s], value:String(n), p:n / total, tone:s}; }), 'Projects by progress')});
  $('#status-tabs').innerHTML = ['All', ...statuses].map(s => `<button class="status-tab ${s === status ? 'selected' : ''}" aria-pressed="${s === status}" data-action="filter-status" data-value="${s}">${s === 'All' ? 'All projects' : s}<span>${owned.filter(i => s === 'All' || i.status === s).length}</span></button>`).join('');
  const items = listedProjects();
  $('#result-count').textContent = query || status !== 'All' ? `${items.length} ${items.length === 1 ? 'match' : 'matches'}` : '';
  $('#section-note').textContent = '';
  $('#content').className = 'project-grid';
  $('#content').innerHTML = items.map(i => {
    const p = profileOf(i), jobs = jobsFor(i.id), done = i.checklist.filter(c => c.done).length, active = jobs.some(j => j.status === 'Printing'), href = `#/project/${encodeURIComponent(i.id)}`;
    const stats = [jobs.length ? `${jobs.length} ${jobs.length === 1 ? 'print' : 'prints'}` : '', i.checklist.length ? `${done}/${i.checklist.length} steps` : ''].filter(Boolean).join(' · ');
    return `<article class="project-card idea-card${i.pinned ? ' pinned' : ''}" data-category="${esc(i.category)}" data-go="${href}" data-vt="${vtName(i.id)}" data-project="${esc(i.id)}">
      <div class="card-top"><span class="category"><span aria-hidden="true">${categoryGlyph[i.category] || '◇'}</span>${esc(i.category)}</span><span class="card-top-right"><button class="pin-button${i.pinned ? ' on' : ''}" data-action="toggle-pin" data-id="${esc(i.id)}" aria-pressed="${i.pinned}" aria-label="${i.pinned ? 'Unpin' : 'Pin'} ${esc(i.title)}" title="${i.pinned ? 'Unpin' : 'Pin to top'}">${pinIcon}</button>${statusPill(i.status, active)}</span></div>
      <h2><a href="${href}">${esc(i.title)}</a></h2>
      <p>${esc(i.description || 'An idea waiting to take shape.')}</p>
      <div class="card-meta"><span class="card-person">${avatar(p)}<span>${esc(p?.name)}</span></span>${stats ? `<span class="card-stats">${esc(stats)}</span>` : ''}</div>
      ${progressBar(i.status)}</article>`;
  }).join('') || '<div class="empty"><h2>Room for the next good idea</h2><p>Try another filter, or add something you would love to print.</p></div>';
}

function renderFamily() {
  hero({eyebrow:'EVERYONE HAS A LITTLE MAKER IN THEM', title:'Meet the makers', text:'Their favorites, their ideas, their next thing to make.', actions:`<button class="primary" data-action="new-profile">＋ Add person</button>`,
    extra:tiles([
      {label:'Makers', sub:'Family profiles', value:String(state.profiles.length), p:1, tone:'Idea'},
      {label:'Ideas', sub:'Across everyone', value:String(state.projects.length), p:1, tone:'Planned'},
      {label:'Prints', sub:'Jobs logged', value:String(state.jobs.length), p:1, tone:'Printing'},
      {label:'Made', sub:'Projects done', value:String(state.projects.filter(p => p.status === 'Done').length), p:state.projects.length ? state.projects.filter(p => p.status === 'Done').length / state.projects.length : 0, tone:'Done'},
    ], 'Family totals')});
  $('#result-count').textContent = `${state.profiles.length} family members`;
  $('#section-note').textContent = 'Profiles organize projects; they are not separate logins';
  $('#content').className = 'project-grid family-grid';
  $('#content').innerHTML = state.profiles.map(p => {
    const projects = state.projects.filter(i => i.profileId === p.id), made = projects.filter(i => i.status === 'Done').length, prints = state.jobs.filter(j => projects.some(i => i.id === j.projectId)).length;
    return `<article class="project-card family-card ${esc(p.color)}-glow"><div class="ring" data-p="${projects.length ? made / projects.length : 0}">${avatar(p)}</div><h2>${esc(p.name)}</h2><span class="profile-count">${p.age === null ? 'Adult' : `Age ${p.age}`} · ${projects.length} projects · ${prints} prints · ${made} made</span><p>${esc(p.interests || 'Add favorite colors, interests, or things they would love to make.')}</p><div class="card-buttons"><button class="secondary ai" data-action="ai-ideas" data-id="${esc(p.id)}">✦ Ideas</button><button class="secondary" data-action="filter-profile" data-id="${esc(p.id)}">Projects</button><button class="secondary" data-action="edit-profile" data-id="${esc(p.id)}">Edit profile</button></div></article>`;
  }).join('') || '<div class="empty"><h2>Who is making?</h2><p>Add your first family profile.</p></div>';
}

function renderJobs() {
  const jobs = ownedJobs(), rate = successRate(jobs), queued = jobs.filter(j => j.status === 'Queued'), printing = jobs.filter(j => j.status === 'Printing');
  const done = sortJobs(jobs.filter(j => finished.has(j.status)));
  hero({eyebrow:'THE PRINT QUEUE', title:'Print jobs', text:'Queue a plate, start it, log how it went. Filament is deducted from the spool when a print finishes.',
    actions:`<button class="primary" data-action="new-job">＋ Queue a print</button>${printerChip()}`,
    extra:tiles([
      {label:'Queued', sub:'Waiting', value:String(queued.length), p:jobs.length ? queued.length / jobs.length : 0, tone:'Idea'},
      {label:'Printing', sub:'On the plate', value:String(printing.length), p:printing.length ? 1 : 0, tone:'Printing'},
      {label:'Success', sub:`${jobs.filter(j => j.status === 'Succeeded').length} good · ${jobs.filter(j => j.status === 'Failed').length} failed`, value:rate === null ? '—' : `${Math.round(rate * 100)}%`, p:rate ?? 0, tone:'Done'},
      {label:'Machine time', sub:`${weight(usedGrams(jobs))} filament`, value:duration(printMinutes(jobs)), p:1, tone:'Planned'},
    ], 'Print job totals')});
  $('#result-count').textContent = '';
  $('#section-note').textContent = printer.connected ? 'Linked jobs show live progress from the printer' : 'Progress is estimated from start time — no printer is connected';
  $('#content').className = 'lanes';
  const lane = (title, list, empty, tone) => `<section class="lane t-${tone}"><header><h2>${title}</h2><span>${list.length}</span></header>${list.map(j => jobCard(j)).join('') || `<p class="lane-empty">${empty}</p>`}</section>`;
  $('#content').innerHTML = !state.projects.length ? '<div class="empty"><h2>No projects yet</h2><p>Add a project first, then queue its prints here.</p></div>'
    : lane('Queued', queued, 'Nothing waiting. Queue a plate from any project.', 'Idea') + lane('Printing', printing, 'The printer is free.', 'Printing') + lane('Finished', done, 'Finished prints and their results land here.', 'Done');
}

function renderFilament() {
  const spools = state.spools, onHand = spools.reduce((s, x) => s + x.remainingGrams, 0), total = spools.reduce((s, x) => s + x.totalGrams, 0);
  const low = spools.filter(s => s.remainingGrams / s.totalGrams < 0.15 || s.remainingGrams < 100);
  const used = usedGrams(state.jobs.filter(j => j.spoolId));
  hero({eyebrow:'MATERIALS', title:'Filament shelf', text:'Track what is on the shelf. Finished prints deduct from the spool you choose, so you know before a job runs out.',
    actions:`<button class="primary" data-action="new-spool">＋ Add spool</button>`,
    extra:tiles([
      {label:'Spools', sub:`${new Set(spools.map(s => s.material)).size} materials`, value:String(spools.length), p:1, tone:'Planned'},
      {label:'On hand', sub:`of ${weight(total)}`, value:weight(onHand), p:total ? onHand / total : 0, tone:'Done'},
      {label:'Low stock', sub:'Under 15% or 100 g', value:String(low.length), p:spools.length ? low.length / spools.length : 0, tone:'Printing'},
      {label:'Used', sub:'By logged prints', value:weight(used), p:total ? used / total : 0, tone:'Idea'},
    ], 'Filament totals')});
  $('#result-count').textContent = `${spools.length} ${spools.length === 1 ? 'spool' : 'spools'}`;
  $('#section-note').textContent = 'Weights are what you record — the app does not weigh spools';
  $('#content').className = 'project-grid spool-grid';
  $('#content').innerHTML = spools.map(s => {
    const p = s.remainingGrams / s.totalGrams, isLow = low.includes(s), jobs = state.jobs.filter(j => j.spoolId === s.id).length;
    return `<article class="project-card spool-card" data-swatch="${esc(s.colorHex)}"><div class="spool-visual"><div class="spool" data-swatch="${esc(s.colorHex)}" data-p="${p}" aria-hidden="true"><span class="hub"></span></div></div>
      <div class="card-body"><div class="spool-head"><h2>${esc(s.colorName || s.colorHex)}</h2>${isLow ? '<span class="status-pill Failed"><i aria-hidden="true"></i>Low stock</span>' : ''}</div><p class="spool-sub">${esc([s.brand, s.material].filter(Boolean).join(' · '))}</p>
      <div class="meter"><span class="bar" data-p="${p}"></span></div><div class="spool-figures"><span><strong>${esc(weight(s.remainingGrams))}</strong> left of ${esc(weight(s.totalGrams))}</span><span>${Math.round(p * 100)}%</span></div>
      <p class="spool-sub">${jobs} ${jobs === 1 ? 'print' : 'prints'}${s.cost !== null ? ` · ${esc(money(s.cost * 1000 / s.totalGrams))} per kg` : ''}</p>${s.notes ? `<p class="spool-notes">${esc(s.notes)}</p>` : ''}</div>
      <div class="card-footer"><span class="card-person">${swatch(s)}<span>${esc(s.colorHex.toUpperCase())}</span></span><button class="open-project" data-action="edit-spool" data-id="${esc(s.id)}">Edit</button></div></article>`;
  }).join('') || '<div class="empty"><h2>The shelf is empty</h2><p>Add the spools you own to track what is left and what each print costs.</p></div>';
}

function focusStage() {
  const project = byId(state.projects, route.id); if (!project) return;
  const active = jobsFor(project.id).find(j => j.status === 'Printing'), progress = active ? jobProgress(active) : project.status === 'Done' ? 1 : null;
  window.Lab3D?.focus(project.category, progress);
  $('#stage-note').textContent = active && liveFor(active) ? 'Live progress from the printer · representative shape'
    : active && progress !== null ? 'Estimated from start time and estimate — not live printer data'
    : `Representative ${project.category.toLowerCase()} shape — not this project's model`;
}

function renderSidebar() {
  const bar = $('#sidebar');
  if (!$('#side-search', bar)) {
    bar.innerHTML = `<div class="sidebar-head"><a class="crumb" href="#/projects"><span aria-hidden="true">←</span> All projects</a><button class="icon-button" data-action="new-project" title="New idea (N)" aria-label="New idea">＋</button></div>
      <label class="side-search"><span aria-hidden="true">⌕</span><input id="side-search" type="search" placeholder="Search projects" aria-label="Search projects" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd></label>
      <div class="side-filters" id="side-filters" role="group" aria-label="Filter by progress"></div>
      <div class="side-scroll" id="side-list"></div>`;
    const input = $('#side-search');
    input.addEventListener('input', () => { query = input.value; $('#search').value = query; renderSideList(); });
    input.addEventListener('keydown', e => {
      const first = $('#side-list .side-item');
      if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
      if (e.key === 'Enter' && first) { e.preventDefault(); first.click(); }
      if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; query = ''; $('#search').value = ''; renderSideList(); }
    });
    $('#side-list').addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = $$('#side-list .side-item'), at = items.indexOf(document.activeElement);
      if (at < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && at === 0) return $('#side-search').focus();
      items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
  }
  if (document.activeElement !== $('#side-search')) $('#side-search').value = query;
  const owned = ownedProjects();
  $('#side-filters').innerHTML = ['All', ...statuses].map(x => `<button class="side-filter ${x}${x === status ? ' selected' : ''}" aria-pressed="${x === status}" data-action="filter-status" data-value="${x}">${x === 'All' ? 'All' : `<i aria-hidden="true"></i>${x}`}<span>${owned.filter(i => x === 'All' || i.status === x).length}</span></button>`).join('');
  renderSideList();
  $('#side-list .current')?.scrollIntoView({block:'nearest'});
}

function renderSideList() {
  const items = listedProjects(), current = byId(state.projects, route.id);
  if (current && !items.includes(current) && !query) items.unshift(current);
  const row = (i) => {
    const owner = profileOf(i), here = i.id === route.id, live = jobsFor(i.id).some(j => j.status === 'Printing');
    return `<div class="side-row${here ? ' current' : ''}${i.pinned ? ' pinned' : ''}" data-vt="${vtName(i.id)}" data-project="${esc(i.id)}">
      <a class="side-item ${esc(i.status)}" href="#/project/${encodeURIComponent(i.id)}" data-category="${esc(i.category)}"${here ? ' aria-current="page"' : ''}>
        <span class="side-dot${live ? ' live' : ''}" aria-hidden="true"></span><span class="side-text"><span class="side-title">${highlight(i.title, query)}</span><span class="side-sub">${matchExcerpt(i, query) || `${esc(owner?.name)} · ${esc(i.category)}${live ? ' · printing' : ''}`}</span></span></a>
      <button class="pin-button${i.pinned ? ' on' : ''}" data-action="toggle-pin" data-id="${esc(i.id)}" aria-pressed="${i.pinned}" aria-label="${i.pinned ? 'Unpin' : 'Pin'} ${esc(i.title)}" title="${i.pinned ? 'Unpin' : 'Pin to top'}">${pinIcon}</button></div>`;
  };
  const pinned = items.filter(i => i.pinned), rest = items.filter(i => !i.pinned);
  const section = (label, list) => list.length ? `<section class="side-section">${label ? `<h3>${label}<span>${list.length}</span></h3>` : ''}${list.map(row).join('')}</section>` : '';
  $('#side-list').innerHTML = items.length
    ? section(pinned.length ? 'Pinned' : '', pinned) + section(pinned.length ? 'Projects' : '', rest)
    : `<div class="side-empty"><p>No projects match${query ? ` “${esc(query)}”` : ' this filter'}.</p><button class="mini" data-action="clear-filters">Clear filters</button></div>`;
  nameTransitions();
}

function renderProject() {
  const p = byId(state.projects, route.id);
  if (!p) {
    hero({eyebrow:'NOT FOUND', title:'This project is gone', text:'It may have been deleted in another tab.', actions:'<button class="primary" data-go="#/projects">← All projects</button>'});
    $('#content').className = ''; $('#content').innerHTML = ''; $('#result-count').textContent = ''; $('#section-note').textContent = '';
    return;
  }
  const owner = profileOf(p), jobs = sortJobs(jobsFor(p.id)), rate = successRate(jobs), idx = statuses.indexOf(p.status);
  const cost = jobs.filter(j => ['Succeeded', 'Failed'].includes(j.status)).reduce((s, j) => s + (jobCost(j) ?? 0), 0);
  const hasCost = jobs.some(j => ['Succeeded', 'Failed'].includes(j.status) && jobCost(j) !== null);
  const done = p.checklist.filter(c => c.done).length;
  hero({crumb:`<a class="crumb" href="#/projects">← All projects</a>`, eyebrow:`${categoryGlyph[p.category] || '◇'}  ${p.category.toUpperCase()}`, title:p.title, text:p.description || 'An idea waiting to take shape.',
    actions:`<button class="primary" data-action="new-job" data-id="${esc(p.id)}">＋ Queue a print</button><button class="secondary" data-action="edit-project" data-id="${esc(p.id)}">Edit details</button><button class="secondary pin-toggle${p.pinned ? ' on' : ''}" data-action="toggle-pin" data-id="${esc(p.id)}" aria-pressed="${p.pinned}">${pinIcon}${p.pinned ? 'Pinned' : 'Pin'}</button><button class="secondary" data-action="duplicate-project" data-id="${esc(p.id)}">Duplicate</button><button class="secondary ai" data-action="ai-ask" data-value="${esc(`Help me with the “${p.title}” project. What should I do next?`)}">✦ Ask</button>`,
    extra:`<div class="meta-row"><span class="meta-chip">${avatar(owner)}${esc(owner?.name)}</span>${p.material ? `<span class="meta-chip">◍ ${esc(p.material)}</span>` : ''}${p.createdAt ? `<span class="meta-chip">Added ${esc(stamp(p.createdAt))}</span>` : ''}</div>
      <div class="stepper" role="group" aria-label="Project progress">${statuses.map((s, n) => `<button class="${n <= idx ? 'on' : ''} ${s === p.status ? 'current' : ''} ${s}" aria-pressed="${s === p.status}" data-action="set-status" data-value="${s}"><i aria-hidden="true"></i><span>${s}</span><small>${statusMeta[s]}</small></button>`).join('')}</div>`});
  $('#result-count').textContent = '';
  $('#section-note').textContent = p.updatedAt ? `Last edited ${stamp(p.updatedAt)}` : '';
  const events = [
    p.createdAt && {at:p.createdAt, text:'Project added', tone:'Idea'},
    ...jobs.flatMap(j => [
      {at:j.createdAt, text:`Queued ${j.revision || 'a print'}`, tone:'Idea'},
      j.startedAt && {at:j.startedAt, text:`Started ${j.revision || 'print'}`, tone:'Printing'},
      j.finishedAt && {at:j.finishedAt, text:`${j.status} ${j.revision || ''}`.trim(), tone:j.status === 'Succeeded' ? 'Done' : j.status === 'Failed' ? 'Failed' : 'Idea'},
    ]),
  ].filter(e => e && e.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 14);
  const files = p.files.split(/\n|,(?=\s*\S+\.\w{2,5}\b)/).map(f => f.trim()).filter(Boolean);
  $('#content').className = 'detail';
  $('#content').innerHTML = `
    <div class="detail-main">
      <section class="panel"><header class="panel-head"><h2>Print jobs</h2><span class="head-actions"><button class="mini ai" data-action="ai-settings" data-id="${esc(p.id)}">✦ Suggest settings</button><button class="mini primary-mini" data-action="new-job" data-id="${esc(p.id)}">＋ Queue</button></span></header>
        ${jobs.length ? `<div class="job-list">${jobs.map(j => jobCard(j, {showProject:false})).join('')}</div>` : '<p class="panel-empty">No prints yet. Queue the first plate when the model is sliced.</p>'}</section>
      <section class="panel"><header class="panel-head"><h2>Measurements & print notes</h2><button class="mini" data-action="edit-project" data-id="${esc(p.id)}">Edit</button></header>
        ${p.notes ? `<p class="prose">${esc(p.notes)}</p>` : '<p class="panel-empty">Record fit, measurements and what to change next.</p>'}</section>
      <section class="panel"><header class="panel-head"><h2>Model & files</h2><button class="mini" data-action="edit-project" data-id="${esc(p.id)}">Edit</button></header>
        ${p.url ? `<a class="model-link" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">⬡</span><span><strong>Model reference</strong><small>${esc(p.url)}</small></span><span aria-hidden="true">↗</span></a>` : '<p class="panel-empty">No model chosen yet. Check dimensions and license before marking it Planned.</p>'}
        ${files.length ? `<ul class="files">${files.map(f => `<li><span aria-hidden="true">▢</span><code>${esc(f)}</code></li>`).join('')}</ul>` : ''}</section>
    </div>
    <aside class="detail-side">
      <section class="panel"><h2 class="panel-title">At a glance</h2><dl class="facts">
        <div><dt>Prints</dt><dd>${jobs.length}</dd></div><div><dt>Success</dt><dd>${rate === null ? '—' : `${Math.round(rate * 100)}%`}</dd></div>
        <div><dt>Machine time</dt><dd>${esc(duration(printMinutes(jobs)))}</dd></div><div><dt>Filament</dt><dd>${esc(weight(usedGrams(jobs)))}</dd></div>
        <div><dt>Material cost</dt><dd>${hasCost ? esc(money(cost)) : '—'}</dd></div><div><dt>Checklist</dt><dd>${p.checklist.length ? `${done}/${p.checklist.length}` : '—'}</dd></div></dl></section>
      <section class="panel"><header class="panel-head"><h2>Checklist</h2><span class="head-actions">${p.checklist.length ? `<span class="count">${Math.round(done / p.checklist.length * 100)}%</span>` : ''}<button class="mini ai" data-action="ai-checklist" data-id="${esc(p.id)}">✦ Tailor</button></span></header>
        ${p.checklist.length ? `<div class="meter"><span class="bar" data-p="${done / p.checklist.length}"></span></div><ul class="checklist">${p.checklist.map(c => `<li class="${c.done ? 'done' : ''}"><label><input type="checkbox" data-check="${esc(c.id)}" ${c.done ? 'checked' : ''}><span>${esc(c.text)}</span></label><button class="mini icon" data-action="remove-step" data-id="${esc(c.id)}" aria-label="Remove step: ${esc(c.text)}">×</button></li>`).join('')}</ul>`
          : `<p class="panel-empty">Break the build into small steps.</p><button class="mini primary-mini" data-action="starter-checklist" data-id="${esc(p.id)}">Use starter checklist</button>`}
        <form class="add-step" data-form="add-step"><input name="text" maxlength="200" required placeholder="Add a step…" aria-label="New checklist step"><button class="mini">Add</button></form></section>
      <section class="panel"><h2 class="panel-title">Timeline</h2>${events.length ? `<ol class="timeline">${events.map(e => `<li class="t-${e.tone}"><span>${esc(e.text)}</span><time datetime="${esc(e.at)}">${esc(stamp(e.at))}</time></li>`).join('')}</ol>` : '<p class="panel-empty">Activity appears here as you queue and finish prints.</p>'}</section>
    </aside>`;
  focusStage();
}

const hmsCode = (h) => [h.attr >>> 16, h.attr & 0xffff, h.code >>> 16, h.code & 0xffff].map(n => n.toString(16).toUpperCase().padStart(4, '0')).join('_');
const temp = (now, target) => now === null || now === undefined ? '—' : `${Math.round(now)}°${target ? ` / ${Math.round(target)}°` : ''}`;
function renderPrinter() {
  const name = printer.name || 'Bambu Lab X2D', s = printer.state;
  $('#result-count').textContent = printer.simulated ? 'Connected to the printer simulator — control it at http://127.0.0.1:8766' : ''; $('#section-note').textContent = printer.configured ? 'Read-only · the app never sends commands to the printer' : '';
  if (!printer.configured) {
    hero({eyebrow:'PRINTER LINK', title:'Connect the printer', text:'See live progress, temperatures and AMS filament here, and let print jobs close themselves when the printer finishes. The link is read-only and stays on your network.', actions:printerChip()});
    $('#content').className = 'detail';
    $('#content').innerHTML = `<div class="detail-main"><section class="panel"><h2 class="panel-title">Set up in four steps</h2><ol class="setup">
      <li><strong>On the printer:</strong> Settings → WLAN / Network → turn on <em>LAN Mode Only</em>, then <em>Developer Mode</em>. Note the IP address and the 8-character access code shown there.</li>
      <li><strong>Find the serial number</strong> in the printer's Settings → Device (also on the label at the back).</li>
      <li><strong>Copy</strong> <code>app/.env.example</code> to <code>app/.env</code> and fill in <code>BAMBU_HOST</code>, <code>BAMBU_SERIAL</code> and <code>BAMBU_ACCESS_CODE</code>. The file stays on this computer and is ignored by Git.</li>
      <li><strong>Restart</strong> the app (<code>node app/server.js</code>). This page turns live.</li></ol>
      <p class="panel-empty">LAN-only mode switches off Bambu's cloud features (remote printing from Bambu Handy). Bambu documents Developer Mode for the X1, P1 and A1 series; check your X2D's network settings for the option.</p></section></div>
      <aside class="detail-side"><section class="panel"><h2 class="panel-title">What you get</h2><ul class="bullets"><li>Live progress, layer and time left on jobs and the 3D stage</li><li>Jobs linked to a print close as Succeeded or Failed automatically</li><li>Nozzle, bed and chamber temperatures</li><li>AMS slots with color and remaining filament, one click to add to the shelf</li><li>Printer error codes</li></ul></section></aside>`;
    return;
  }
  const label = !printer.connected ? 'Offline' : s ? printerStates[s.gcodeState] || s.gcodeState : 'Connecting…';
  const linked = s?.task ? state.jobs.find(j => j.status === 'Printing' && j.printerTask === s.task) : null;
  const project = linked && projectOf(linked);
  window.Lab3D?.focus(project?.category || 'Home', printer.printing && s.percent !== null ? s.percent / 100 : s?.gcodeState === 'FINISH' ? 1 : null);
  $('#stage-note').textContent = printer.printing ? 'Live progress from the printer · representative shape' : 'Representative shape — not the model on the plate';
  hero({eyebrow:printer.simulated ? 'SIMULATED PRINTER · FOR DEVELOPMENT' : 'LIVE PRINTER · READ-ONLY', title:name, text:!printer.connected ? (printer.error || 'Waiting for the printer…') : s?.task ? `${label}: ${s.task}` : label,
    actions:`<button class="secondary" data-action="printer-refresh">↻ Refresh</button>`,
    extra:tiles([
      {label:'Progress', sub:label, value:s?.percent !== null && s?.percent !== undefined ? `${s.percent}%` : '—', p:(s?.percent ?? 0) / 100, tone:'Printing'},
      {label:'Layer', sub:s?.totalLayers ? `of ${s.totalLayers}` : 'No print', value:s?.layer !== null && s?.layer !== undefined ? String(s.layer) : '—', p:s?.totalLayers ? s.layer / s.totalLayers : 0, tone:'Planned'},
      {label:'Time left', sub:'Printer estimate', value:s?.remainingMinutes !== null && s?.remainingMinutes !== undefined && printer.printing ? duration(s.remainingMinutes) : '—', p:0, tone:'Idea'},
      {label:'Nozzle', sub:`bed ${temp(s?.bed, s?.bedTarget)}`, value:temp(s?.nozzle), p:s?.nozzle ? Math.min(s.nozzle / 300, 1) : 0, tone:'Done'},
    ], 'Printer status')});
  const candidates = state.jobs.filter(j => j.status === 'Queued' || (j.status === 'Printing' && !j.printerTask));
  const current = !printer.printing ? '<p class="panel-empty">Nothing printing right now. Start a print from Bambu Studio or the printer; it will appear here.</p>'
    : linked ? `<p class="panel-empty">Linked to this job. It closes as Succeeded or Failed when the printer finishes. <button class="mini" data-action="unlink-job" data-id="${esc(linked.id)}">Unlink</button></p><div class="job-list">${jobCard(linked)}</div>`
    : `<p class="panel-empty">The printer is running <strong>“${esc(s.task || 'an unnamed print')}”</strong>, which isn't linked to a job yet.</p>
       ${candidates.length ? `<div class="link-row"><select id="link-job" aria-label="Job to link">${candidates.map(j => `<option value="${esc(j.id)}">${esc(projectOf(j)?.title)} · ${esc(j.revision || j.status)}</option>`).join('')}</select><button class="mini primary-mini" data-action="link-job">Link job</button></div>` : ''}
       <button class="mini" data-action="new-linked-job">＋ Log it as a new job</button>`;
  const ams = s?.ams?.length ? s.ams.map(unit => `<div class="ams-unit"><header><span>AMS ${esc(Number(unit.unit) + 1 || unit.unit)}</span>${unit.humidity !== null ? `<small>humidity level ${esc(unit.humidity)}</small>` : ''}</header><div class="ams-slots">${unit.trays.map(t => `<div class="ams-slot ${t.active ? 'active' : ''} ${t.type ? '' : 'vacant'}">
      <span class="swatch big" ${t.color ? `data-swatch="${esc(t.color)}"` : ''} aria-hidden="true"></span><strong>${esc(t.type || 'Empty')}</strong><small>${t.remain !== null ? `${t.remain}% left` : t.type ? 'amount unknown' : `slot ${Number(t.slot) + 1}`}</small>
      ${t.type ? `<button class="mini" data-action="ams-spool" data-material="${esc(t.type)}" data-color="${esc(t.color || '')}" data-remain="${t.remain ?? ''}" data-unit="${esc(Number(unit.unit) + 1)}" data-slot="${esc(Number(t.slot) + 1)}">＋ Shelf</button>` : ''}</div>`).join('')}</div></div>`).join('')
    : '<p class="panel-empty">No AMS data reported.</p>';
  const errors = [...(s?.printError ? [`Print error ${s.printError.toString(16).toUpperCase().padStart(8, '0')}`] : []), ...(s?.hms || []).map(h => `HMS ${hmsCode(h)}`)];
  $('#content').className = 'detail';
  $('#content').innerHTML = `<div class="detail-main">
      <section class="panel"><header class="panel-head"><h2>Current print</h2>${printer.printing ? '<span class="count live-dot">LIVE</span>' : ''}</header>${current}</section>
      <section class="panel"><h2 class="panel-title">AMS filament</h2>${ams}</section></div>
    <aside class="detail-side">
      <section class="panel"><h2 class="panel-title">Temperatures</h2><dl class="facts">
        <div><dt>Nozzle</dt><dd>${esc(temp(s?.nozzle, s?.nozzleTarget))}</dd></div><div><dt>Bed</dt><dd>${esc(temp(s?.bed, s?.bedTarget))}</dd></div>
        <div><dt>Chamber</dt><dd>${esc(temp(s?.chamber))}</dd></div><div><dt>Speed</dt><dd>${esc({1:'Silent', 2:'Standard', 3:'Sport', 4:'Ludicrous'}[s?.speedLevel] || '—')}</dd></div></dl></section>
      <section class="panel"><h2 class="panel-title">Alerts</h2>${errors.length ? `<ul class="alerts">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul><p class="panel-empty">Look codes up in Bambu Handy or the Bambu Lab wiki.</p>` : '<p class="panel-empty">No errors reported.</p>'}${printer.warning ? `<p class="error">${esc(printer.warning)}</p>` : ''}</section>
      <section class="panel"><h2 class="panel-title">Connection</h2><dl class="facts one">
        <div><dt>Status</dt><dd>${printer.connected ? 'Connected' : 'Offline'}</dd></div><div><dt>Last report</dt><dd>${esc(stamp(printer.lastSeen) || '—')}</dd></div></dl>${printer.error && !printer.connected ? `<p class="panel-empty">${esc(printer.error)}</p>` : ''}</section>
    </aside>`;
}

// Printer polling: fast while the page is visible, slower in the background. Picks up jobs the server closed.
let lastPrinterState = null;
async function pollPrinter(manual = false) {
  clearTimeout(pollPrinter.timer);
  try { const r = await fetch('/api/printer'); if (r.ok) printer = await r.json(); } catch { printer = {...printer, connected:false}; }
  const current = printer.state?.gcodeState || '';
  if (lastPrinterState !== null && current !== lastPrinterState) await refreshState();
  lastPrinterState = current;
  $$('[data-printer-chip]').forEach(el => { el.innerHTML = printerChipInner(); });
  const nav = $('.nav[data-view="printer"]'); nav?.classList.toggle('p-live', !!printer.printing); nav?.classList.toggle('p-on', !!printer.connected && !printer.printing);
  if (route.view === 'printer' && state && (manual || !$('#content').contains(document.activeElement))) { renderPrinter(); setVars($('#hero-copy')); setVars($('#content')); }
  if (state) updateProgress();
  pollPrinter.timer = setTimeout(pollPrinter, !printer.configured ? 60000 : document.hidden ? 15000 : 3000);
}
async function refreshState() {
  if (busy || document.querySelector('dialog[open]')) return;
  try { const r = await fetch('/api/state'); if (r.ok) { state = await r.json(); render(); } } catch {}
}

function render() {
  if (!state) return;
  if (profile !== 'all' && !byId(state.profiles, profile)) profile = 'all';
  document.body.dataset.view = route.view;
  const navView = route.view === 'project' ? 'projects' : route.view;
  $$('.nav[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === navView); b.setAttribute('aria-current', b.dataset.view === navView ? 'page' : 'false'); });
  const live = state.jobs.filter(j => j.status === 'Printing' || j.status === 'Queued').length;
  $('#nav-jobs').hidden = !live; $('#nav-jobs').textContent = live;
  const people = [{id:'all', name:'Everyone', color:'green'}, ...state.profiles];
  $('#profile-switcher').innerHTML = people.map(p => `<option value="${esc(p.id)}" ${p.id === profile ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#profile-switcher').disabled = false;
  $('#active-profile-avatar').innerHTML = profile === 'all' ? '<span class="avatar green">✳</span>' : avatar(byId(state.profiles, profile));
  $('#toolbar').hidden = route.view !== 'projects';
  $('#sidebar').hidden = route.view !== 'project';
  if (route.view === 'project') renderSidebar();
  if (route.view !== 'project' && route.view !== 'printer') { window.Lab3D?.release(); $('#stage-note').textContent = printer.connected ? 'Preview animation — see Printer for the live print' : 'Preview animation — no printer is connected'; }
  ({projects:renderProjects, family:renderFamily, jobs:renderJobs, printer:renderPrinter, filament:renderFilament, project:renderProject})[route.view]();
  const title = route.view === 'project' ? byId(state.projects, route.id)?.title : {projects:'Projects', jobs:'Print jobs', printer:'Printer', filament:'Filament', family:'Family'}[route.view];
  document.title = `${title ? `${title} · ` : ''}Family Print Lab`;
  setVars();
  nameTransitions();
  updateProgress();
}
function nameTransitions() {
  const els = $$('.idea-card[data-vt], .side-row[data-vt]');
  if (els.length > 300) return;
  els.forEach(el => { if (el.offsetParent !== null) el.style.viewTransitionName = el.dataset.vt; });
}

// ---------- Editor ----------
function field(name, label, value = '', {type = 'text', hint = '', attrs = ''} = {}) {
  const limits = type === 'number' || type === 'datetime-local' || type === 'color' ? '' : name === 'name' || name === 'title' ? 'required maxlength="80"' : 'maxlength="1000"';
  return `<label class="field">${esc(label)}<input name="${name}" type="${type}" value="${esc(value ?? '')}" ${limits} ${attrs}>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
}
function area(name, label, value = '', hint = '', max = 4000) { return `<label class="field">${esc(label)}<textarea name="${name}" maxlength="${max}">${esc(value)}</textarea>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`; }
function select(name, label, value, options) {
  return `<label class="field">${esc(label)}<select name="${name}">${options.map(o => { const [id, text] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(text)}</option>`; }).join('')}</select></label>`;
}
const row = (...parts) => `<div class="fields-row">${parts.join('')}</div>`;
const withCurrent = (list, value) => value && !list.includes(value) ? [...list, value] : list;
const collections = {project:'projects', profile:'profiles', job:'jobs', spool:'spools'};

const forms = {
  profile(item) {
    const p = item || {name:'', age:null, interests:'', color:'violet'};
    return field('name', 'Name or nickname', p.name) + row(field('age', 'Age (optional)', p.age ?? '', {type:'number', hint:'Leave blank for an adult profile.', attrs:'min="0" max="120" step="1"'}), select('color', 'Profile color', p.color, ['violet', 'blue', 'orange', 'pink', 'green']))
      + area('interests', 'Interests & favorite colors', p.interests, 'Use this to choose future print ideas.', 500);
  },
  project(item) {
    const p = item || {title:'', profileId:profile === 'all' ? state.profiles[0].id : profile, status:'Idea', category:'Home', description:'', notes:'', url:'', files:'', material:''};
    return field('title', 'Project name', p.title) + row(select('profileId', 'For', p.profileId, state.profiles.map(x => [x.id, x.name])), select('status', 'Progress', p.status, statuses))
      + row(select('category', 'Category', p.category, categories), field('material', 'Material / color', p.material)) + area('description', 'The idea', p.description)
      + field('url', 'Model or reference link', p.url, {type:'url', hint:'Choose and check a model before marking it Planned.'}) + (p.url ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open model reference ↗</a></p>` : '')
      + area('files', 'Design & slicer file references', p.files, 'One per line, e.g. projects/cable-guide/cad/v01.step. References only; files stay in your project folder.')
      + area('notes', 'Measurements, print settings & results', p.notes, 'Record fit, nozzle, plate, layer height, supports, time, and what to change next.');
  },
  job(item, preset) {
    const project = byId(state.projects, preset.projectId) || (route.view === 'project' && byId(state.projects, route.id)) || ownedProjects()[0] || state.projects[0];
    const count = project ? jobsFor(project.id).length : 0;
    const j = item || {projectId:project.id, status:'Queued', revision:`v${String(count + 1).padStart(2, '0')}`, spoolId:'', material:project.material && materials.includes(project.material) ? project.material : 'PLA', grams:null, minutes:null, actualMinutes:null, layerHeight:'0.20', nozzle:'0.4', plate:'Textured PEI', supports:'None', infill:15, notes:'', startedAt:'', finishedAt:'', printerTask:'', ...preset.job};
    const spools = [['', 'No spool / not tracked'], ...state.spools.map(s => [s.id, `${s.colorName || s.colorHex} · ${s.material}${s.brand ? ` · ${s.brand}` : ''} (${weight(s.remainingGrams)} left)`])];
    return `<input type="hidden" name="printerTask" value="${esc(j.printerTask || '')}"><div class="ai-inline"><button type="button" class="mini ai" data-action="ai-settings-form">✦ Suggest settings</button><small id="ai-settings-note">Claude reads the project and recommends slicer settings.</small></div>`
      + row(select('projectId', 'Project', j.projectId, state.projects.map(x => [x.id, x.title])), select('status', 'Status', j.status, jobStatuses))
      + row(field('revision', 'Plate / revision', j.revision, {hint:'e.g. v02 · plate 1 of 2'}), select('spoolId', 'Spool', j.spoolId, spools))
      + row(select('material', 'Material', j.material, withCurrent(materials, j.material)), field('grams', 'Filament (g)', j.grams, {type:'number', hint:'From the slicer. Deducted from the spool when the print finishes.', attrs:'min="0" max="20000" step="0.1"'}))
      + row(field('minutes', 'Estimated time (min)', j.minutes, {type:'number', attrs:'min="0" max="100000" step="1"'}), field('actualMinutes', 'Actual time (min)', j.actualMinutes, {type:'number', hint:'Filled in automatically when you finish a started job.', attrs:'min="0" max="100000" step="1"'}))
      + row(select('layerHeight', 'Layer height (mm)', j.layerHeight, withCurrent(['', '0.08', '0.12', '0.16', '0.20', '0.24', '0.28'], j.layerHeight).map(v => [v, v || '—'])), select('nozzle', 'Nozzle (mm)', j.nozzle, withCurrent(['', '0.2', '0.4', '0.6', '0.8'], j.nozzle).map(v => [v, v || '—'])))
      + row(select('plate', 'Build plate', j.plate, withCurrent(['', ...plates], j.plate).map(v => [v, v || '—'])), select('supports', 'Supports', j.supports, withCurrent(['None', 'Normal', 'Tree'], j.supports)))
      + row(field('infill', 'Infill (%)', j.infill, {type:'number', attrs:'min="0" max="100" step="1"'}), '<span></span>')
      + row(field('startedAt', 'Started', toLocalInput(j.startedAt), {type:'datetime-local'}), field('finishedAt', 'Finished', toLocalInput(j.finishedAt), {type:'datetime-local'}))
      + area('notes', 'Result & notes', j.notes, 'What went well, what failed, what to change for the next plate.');
  },
  spool(item, preset) {
    const s = item || {brand:'', material:'PLA', colorName:'', colorHex:'#5ee7ff', totalGrams:1000, remainingGrams:1000, cost:null, notes:'', ...preset};
    return row(field('colorName', 'Color name', s.colorName, {attrs:'maxlength="80" required'}), field('colorHex', 'Swatch', s.colorHex, {type:'color'}))
      + row(select('material', 'Material', s.material, withCurrent(materials, s.material)), field('brand', 'Brand', s.brand, {attrs:'maxlength="80"'}))
      + row(field('totalGrams', 'Spool size (g)', s.totalGrams, {type:'number', attrs:'min="1" max="100000" step="1" required'}), field('remainingGrams', 'Remaining (g)', s.remainingGrams, {type:'number', hint:'Weigh it and subtract the empty spool for accuracy.', attrs:'min="0" max="100000" step="0.1" required'}))
      + row(field('cost', 'Price paid (optional)', s.cost, {type:'number', hint:'Used to estimate material cost per print.', attrs:'min="0" max="100000" step="0.01"'}), '<span></span>')
      + area('notes', 'Notes', s.notes, 'Drying, storage, print temperature that works…', 1000);
  },
};

const collect = {
  profile: (v) => ({name:v.name, age:v.age === '' ? null : Number(v.age), interests:v.interests, color:v.color}),
  project: (v, old) => ({title:v.title, profileId:v.profileId, status:v.status, category:v.category, material:v.material, description:v.description, url:v.url, files:v.files, notes:v.notes, checklist:old?.checklist ?? starter(), createdAt:old?.createdAt || now(), updatedAt:now()}),
  job(v, old) {
    const job = {projectId:v.projectId, status:v.status, revision:v.revision, spoolId:v.spoolId, material:v.material, grams:num(v.grams), minutes:num(v.minutes), actualMinutes:num(v.actualMinutes), layerHeight:v.layerHeight, nozzle:v.nozzle, plate:v.plate, supports:v.supports, infill:num(v.infill), notes:v.notes, createdAt:old?.createdAt || now(), startedAt:fromLocalInput(v.startedAt), finishedAt:fromLocalInput(v.finishedAt), charge:old?.charge ?? null, printerTask:v.printerTask || ''};
    if (job.status === 'Printing' && !job.startedAt) job.startedAt = now();
    if (job.status === 'Queued' || job.status === 'Printing') job.finishedAt = '';
    if (finished.has(job.status) && !job.finishedAt) job.finishedAt = now();
    return job;
  },
  spool: (v) => ({brand:v.brand, material:v.material, colorName:v.colorName, colorHex:v.colorHex, totalGrams:Number(v.totalGrams), remainingGrams:Math.min(Number(v.remainingGrams), Number(v.totalGrams)), cost:num(v.cost), notes:v.notes}),
};

const editorText = {
  project:{new:'A new idea', edit:'Edit project', add:'Add idea', eyebrow:'MAKE IT YOURS'},
  profile:{new:'Meet a new maker', edit:'Edit family profile', add:'Add person', eyebrow:'THE MAKERS'},
  job:{new:'Queue a print', edit:'Print job', add:'Add to queue', eyebrow:'PRINT JOB'},
  spool:{new:'Add a spool', edit:'Edit spool', add:'Add spool', eyebrow:'FILAMENT'},
};

function openEditor(kind, id = null, preset = {}) {
  if (busy) return;
  if (kind === 'project' && !state.profiles.length) { toast('Add a family profile first.'); go('#/family'); return; }
  if (kind === 'job' && !state.projects.length) { toast('Add a project first.'); go('#/projects'); return; }
  const item = id ? byId(state[collections[kind]], id) : null;
  editing = {kind, id, revision:state.revision};
  $('#form-error').hidden = true;
  $('#delete').hidden = !item;
  $('#dialog-eyebrow').textContent = editorText[kind].eyebrow;
  $('#dialog-title').textContent = item ? editorText[kind].edit : editorText[kind].new;
  $('#save').textContent = item ? 'Save changes' : editorText[kind].add;
  $('#form-fields').innerHTML = forms[kind](item, preset);
  if (kind === 'job') {
    $('#form-fields [name=spoolId]').addEventListener('change', e => { const s = spoolOf(e.target.value), m = $('#form-fields [name=material]'); if (s && [...m.options].some(o => o.value === s.material)) m.value = s.material; });
  }
  $('#editor').showModal();
}
function closeEditor() { if (!busy) $('#editor').close(); }
$('#close-dialog').onclick = closeEditor;
$('#cancel').onclick = closeEditor;
$('#editor').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
$('#editor-form').onsubmit = async e => {
  e.preventDefault(); if (busy) return;
  const values = Object.fromEntries(new FormData(e.target));
  Object.keys(values).forEach(k => { if (typeof values[k] === 'string') values[k] = values[k].trim(); });
  const {kind} = editing, key = collections[kind], next = structuredClone(state);
  next.revision = editing.revision;
  const index = next[key].findIndex(i => i.id === editing.id), old = next[key][index];
  const item = {id:editing.id || uuid(), ...collect[kind](values, old)};
  if (index < 0) next[key].push(item); else next[key][index] = item;
  if (kind === 'job') {
    Ledger.settle(next, item);
    const project = byId(next.projects, item.projectId);
    if (item.status === 'Printing' && ['Idea', 'Planned'].includes(project.status)) project.status = 'Printing';
  }
  if (kind === 'spool' && old) {
    // Editing stock by hand resets the baseline: past charges stay recorded but are no longer refundable.
    if (old.remainingGrams !== item.remainingGrams || old.totalGrams !== item.totalGrams) next.jobs.forEach(j => { if (j.charge?.spoolId === item.id) j.charge = {...j.charge, grams:0}; });
  }
  busy = true; $('#save').disabled = true; $('#delete').disabled = true;
  try {
    await save(next); $('#editor').close();
    toast(kind === 'job' && index < 0 ? 'Added to the print queue.' : 'Saved.');
    if (kind === 'project' && index < 0) go(`#/project/${encodeURIComponent(item.id)}`);
  } catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
  finally { busy = false; $('#save').disabled = false; $('#delete').disabled = false; }
};

function ask(title, text, ok = 'Delete') {
  $('#confirm-title').textContent = title; $('#confirm-text').textContent = text; $('#confirm-ok').textContent = ok;
  $('#confirm').returnValue = ''; $('#confirm').showModal();
  return new Promise(resolve => $('#confirm').addEventListener('close', () => resolve($('#confirm').returnValue === 'ok'), {once:true}));
}

$('#delete').onclick = async () => {
  if (busy) return;
  const {kind, id} = editing;
  if (kind === 'profile' && state.projects.some(i => i.profileId === id)) {
    $('#form-error').textContent = 'Reassign or delete this person’s projects before removing their profile.'; $('#form-error').hidden = false; return;
  }
  const jobCount = kind === 'project' ? jobsFor(id).length : 0;
  const text = {
    project:`This removes the project${jobCount ? ` and its ${jobCount} print ${jobCount === 1 ? 'job' : 'jobs'}` : ''}. Design and slicer files are not deleted.`,
    profile:'This removes the saved profile.',
    job:'This removes the print job. Any filament it used is returned to its spool.',
    spool:'This removes the spool. Print jobs keep their other details but no longer point to it.',
  }[kind];
  if (!await ask({project:'Delete this project?', profile:'Remove this family profile?', job:'Delete this print job?', spool:'Remove this spool?'}[kind], text)) return;
  busy = true; $('#save').disabled = true; $('#delete').disabled = true;
  try {
    const next = structuredClone(state), key = collections[kind];
    next.revision = editing.revision;
    if (kind === 'job') { const job = byId(next.jobs, id); job.status = 'Cancelled'; Ledger.settle(next, job); }
    if (kind === 'project') next.jobs.filter(j => j.projectId === id).forEach(j => { j.status = 'Cancelled'; Ledger.settle(next, j); });
    if (kind === 'project') next.jobs = next.jobs.filter(j => j.projectId !== id);
    if (kind === 'spool') next.jobs.forEach(j => { if (j.spoolId === id) j.spoolId = ''; if (j.charge?.spoolId === id) j.charge = null; });
    next[key] = next[key].filter(i => i.id !== id);
    await save(next);
    if (profile === id) profile = 'all';
    $('#editor').close(); toast('Removed from the workspace.');
    if (kind === 'project' && route.view === 'project') go('#/projects'); else render();
  } catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
  finally { busy = false; $('#save').disabled = false; $('#delete').disabled = false; }
};

// ---------- Actions ----------
function jobTransition(id, to) {
  const alsoPrinting = to === 'Printing' && state.jobs.some(j => j.status === 'Printing' && j.id !== id);
  const task = printer.printing ? printer.state?.task : '';
  const link = to === 'Printing' && task && !state.jobs.some(j => j.status === 'Printing' && j.printerTask === task) ? {printerTask:task} : {};
  let result = {};
  return commit(next => { result = Ledger.transition(next, id, to, now(), link); }).then(ok => {
    if (ok) toast({Printing:link.printerTask ? `Started and linked to the printer's “${link.printerTask}”.` : alsoPrinting ? 'Started. Note: another job is also marked Printing.' : 'Print started.', Succeeded:result.autoDone ? 'Print succeeded — project marked Done.' : 'Print logged as succeeded.', Failed:'Logged as failed. Try ✦ Diagnose for likely causes.', Cancelled:'Job cancelled.'}[to]);
  });
}

const actions = {
  'new-project': () => openEditor('project'),
  'new-profile': () => openEditor('profile'),
  'new-job': (d) => openEditor('job', null, {projectId:d.id}),
  'new-spool': () => openEditor('spool'),
  'edit-project': (d) => openEditor('project', d.id),
  'edit-profile': (d) => openEditor('profile', d.id),
  'edit-job': (d) => openEditor('job', d.id),
  'edit-spool': (d) => openEditor('spool', d.id),
  'filter-status': (d) => { status = d.value; render(); },
  'filter-profile': (d) => { profile = d.id; status = 'All'; query = ''; $('#search').value = ''; go('#/projects'); },
  'set-status': (d) => commit(n => { const p = byId(n.projects, route.id); p.status = d.value; p.updatedAt = now(); }, `Moved to ${d.value}.`),
  'job-start': (d) => jobTransition(d.id, 'Printing'),
  'job-done': (d) => jobTransition(d.id, 'Succeeded'),
  'job-fail': (d) => jobTransition(d.id, 'Failed'),
  'job-cancel': (d) => jobTransition(d.id, 'Cancelled'),
  'job-reprint': (d) => commit(n => {
    const source = byId(n.jobs, d.id);
    n.jobs.push({...structuredClone(source), id:uuid(), status:'Queued', createdAt:now(), startedAt:'', finishedAt:'', actualMinutes:null, notes:'', charge:null});
  }, 'Queued again.'),
  'toggle-pin': async (d) => {
    const project = byId(state.projects, d.id); if (!project) return;
    const ok = await commit(n => { const p = byId(n.projects, d.id); p.pinned = !p.pinned; }, project.pinned ? 'Unpinned.' : 'Pinned to the top.');
    if (ok) $(`#sidebar [data-action="toggle-pin"][data-id="${CSS.escape(d.id)}"], #content [data-action="toggle-pin"][data-id="${CSS.escape(d.id)}"]`)?.focus();
  },
  'clear-filters': () => { query = ''; status = 'All'; $('#search').value = ''; const input = $('#side-search'); if (input) input.value = ''; render(); },
  'set-project-status': (d) => commit(n => { const p = byId(n.projects, d.id); p.status = d.value; p.updatedAt = now(); }, `Moved to ${d.value}.`),
  'copy-link': async (d) => {
    const url = `${location.origin}/#/project/${encodeURIComponent(d.id)}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url); }
  },
  'delete-project': async (d) => {
    const project = byId(state.projects, d.id); if (!project) return;
    const count = jobsFor(project.id).length;
    if (!await ask(`Delete “${project.title}”?`, `This removes the project${count ? ` and its ${count} print ${count === 1 ? 'job' : 'jobs'}` : ''}. Design and slicer files are not deleted.`)) return;
    const ok = await commit(n => {
      n.jobs.filter(j => j.projectId === d.id).forEach(j => { j.status = 'Cancelled'; Ledger.settle(n, j); });
      n.jobs = n.jobs.filter(j => j.projectId !== d.id);
      n.projects = n.projects.filter(p => p.id !== d.id);
    }, 'Project deleted.');
    if (ok && route.id === d.id) go('#/projects');
  },
  'duplicate-project': async (d) => {
    const id = uuid();
    const ok = await commit(n => {
      const source = byId(n.projects, d.id);
      n.projects.push({...structuredClone(source), id, title:`${source.title} (copy)`.slice(0, 80), status:'Idea', checklist:source.checklist.map(c => ({...c, id:uuid(), done:false})), createdAt:now(), updatedAt:now()});
    }, 'Duplicated. Jobs were not copied.');
    if (ok) go(`#/project/${encodeURIComponent(id)}`);
  },
  'starter-checklist': (d) => commit(n => { byId(n.projects, d.id).checklist = starter(); }),
  'remove-step': (d) => commit(n => { const p = byId(n.projects, route.id); p.checklist = p.checklist.filter(c => c.id !== d.id); }),
  'link-job': () => {
    const id = $('#link-job')?.value, task = printer.state?.task;
    if (!id || !task) return;
    commit(next => { const job = byId(next.jobs, id); if (job.status === 'Printing') job.printerTask = task; else Ledger.transition(next, id, 'Printing', now(), {printerTask:task}); }, `Linked to “${task}”. It will close itself when the printer finishes.`);
  },
  'unlink-job': (d) => commit(next => { byId(next.jobs, d.id).printerTask = ''; }, 'Unlinked from the printer.'),
  'new-linked-job': () => {
    const s = printer.state || {};
    openEditor('job', null, {job:{status:'Printing', printerTask:s.task || '', revision:(s.task || '').slice(0, 80), minutes:s.remainingMinutes !== null && s.percent ? Math.round(s.remainingMinutes / Math.max(1 - s.percent / 100, 0.01)) : null, startedAt:now()}});
  },
  'ams-spool': (d) => openEditor('spool', null, {material:d.material || 'PLA', colorHex:d.color || '#5ee7ff', colorName:'', remainingGrams:d.remain ? Number(d.remain) * 10 : 1000, notes:`AMS ${d.unit ?? ''} slot ${d.slot ?? ''}`.trim()}),
  'printer-refresh': () => pollPrinter(true),
  'theme-menu': () => toggleThemeMenu(),
  'more-menu': () => togglePopover('#more-menu'),
  'set-theme': (d) => { setTheme(d.value); toggleThemeMenu(false); },
  'export': () => { togglePopover('#more-menu', false); exportBackup(); },
  'import': () => { togglePopover('#more-menu', false); $('#import-file').click(); },
  'palette': () => openPalette(),
};

document.addEventListener('click', e => {
  if (!state) return;
  const nav = e.target.closest('.nav[data-view]');
  if (nav) return go(`#/${nav.dataset.view}`);
  const action = e.target.closest('[data-action]');
  if (action) { e.preventDefault(); return actions[action.dataset.action]?.(action.dataset); }
  if (e.target.closest('a, input, label, select, textarea')) return;
  const target = e.target.closest('[data-go]');
  if (target) go(target.dataset.go);
});
document.addEventListener('change', e => {
  const box = e.target.closest('[data-check]'); if (!box) return;
  commit(n => { const step = byId(byId(n.projects, route.id).checklist, box.dataset.check); step.done = box.checked; }).then(ok => { if (!ok) box.checked = !box.checked; });
});
document.addEventListener('submit', e => {
  if (e.target.dataset.form !== 'add-step') return;
  e.preventDefault();
  const text = new FormData(e.target).get('text').trim(); if (!text) return;
  commit(n => { byId(n.projects, route.id).checklist.push({id:uuid(), text, done:false}); }).then(ok => { if (ok) $('.add-step input')?.focus(); });
});
$('#profile-switcher').onchange = e => {
  if (!state) return;
  profile = e.target.value; status = 'All'; query = ''; $('#search').value = '';
  if (route.view === 'project' || route.view === 'family') go('#/projects'); else render();
};
$('#search').oninput = e => { query = e.target.value; render(); };
addEventListener('hashchange', () => {
  const before = route, next = parseRoute();
  const pageChange = before.view !== next.view || before.id !== next.id;
  const update = () => { route = next; render(); if (pageChange) scrollTo({top:0, behavior:'instant'}); };
  // Grid <-> project: cards morph into the sidebar (and back). Other page changes fade in.
  const morph = pageChange && (before.view === 'project' || next.view === 'project') && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (morph) {
    document.documentElement.dataset.transition = next.view === 'project' ? (before.view === 'project' ? 'swap' : 'open') : 'close';
    document.startViewTransition(update).finished.finally(() => delete document.documentElement.dataset.transition);
    return;
  }
  update();
  if (pageChange) { const c = $('#content'); c.classList.remove('enter'); void c.offsetWidth; c.classList.add('enter'); }
});

async function exportBackup() {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('Could not load the latest backup.');
    const data = await response.json();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = `family-print-lab-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('Backup exported.');
  } catch (error) { showError(error.message); }
}
$('#import-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || busy) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { showError('That file is not a valid JSON backup.'); return; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.projects) || !Array.isArray(data.profiles)) { showError('That file does not look like a Family Print Lab backup.'); return; }
  if (!await ask('Restore this backup?', `This replaces all current profiles, projects, jobs and spools with “${file.name}”. Export a backup first if you might need what is here now.`, 'Restore')) return;
  busy = true;
  try { data.revision = state.revision; await save(data); toast('Backup restored.'); go('#/projects'); }
  catch (error) { showError(`Could not restore: ${error.message}`); }
  finally { busy = false; }
};

// ---------- Color themes ----------
function setTheme(choice) {
  const theme = choice === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'arctic' : 'holo') : choice;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeChoice = choice;
  try { localStorage.setItem('print-lab-theme', choice); } catch {}
  $('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  window.Lab3D?.refreshTheme?.();
}
function toggleThemeMenu(force) {
  const menu = $('#theme-menu'), button = $('.theme-button'), show = force ?? menu.hidden;
  if (show) {
    const choice = document.documentElement.dataset.themeChoice || 'auto';
    menu.innerHTML = themes.map(([id, name, hint]) => `<button role="menuitemradio" aria-checked="${id === choice}" data-action="set-theme" data-value="${id}"><span class="theme-swatch sw-${id}" aria-hidden="true"></span><span><strong>${name}</strong><small>${hint}</small></span></button>`).join('');
  }
  menu.hidden = !show; button.setAttribute('aria-expanded', String(show));
  if (show) $('[aria-checked="true"]', menu)?.focus();
}
function togglePopover(selector, force) {
  const menu = $(selector), button = $(`[aria-controls="${menu.id}"]`), show = force ?? menu.hidden;
  menu.hidden = !show; button.setAttribute('aria-expanded', String(show));
  if (show) $('button', menu)?.focus();
}
document.addEventListener('click', e => {
  if (!$('#theme-menu').hidden && !e.target.closest('.theme-picker')) toggleThemeMenu(false);
  if (!$('#more-menu').hidden && !e.target.closest('.more-picker')) togglePopover('#more-menu', false);
});
$('#more-menu').addEventListener('keydown', e => { if (e.key === 'Escape') { togglePopover('#more-menu', false); $('[aria-controls="more-menu"]').focus(); } });
$('#theme-menu').addEventListener('keydown', e => {
  const items = $$('[role=menuitemradio]', e.currentTarget), i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { toggleThemeMenu(false); $('.theme-button').focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
});
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if ((document.documentElement.dataset.themeChoice || 'auto') === 'auto') setTheme('auto'); });

// ---------- Context menu (right-click, Menu key or Shift+F10 on a project or job) ----------
function menuItems(target) {
  const projectId = target.closest('[data-project]')?.dataset.project, job = target.closest('.job-card')?.querySelector('[data-action="edit-job"]')?.dataset.id;
  if (job) {
    const j = byId(state.jobs, job); if (!j) return null;
    return {title:`${projectOf(j)?.title ?? 'Print job'} · ${j.revision || j.status}`, items:[
      ...(j.status === 'Queued' ? [['job-start', 'Start print', job]] : []),
      ...(j.status === 'Printing' ? [['job-done', 'Mark succeeded', job], ['job-fail', 'Mark failed', job]] : []),
      ...(finished.has(j.status) ? [['job-reprint', 'Print again', job]] : []),
      ...(j.status === 'Failed' ? [['ai-diagnose', '✦ Diagnose failure', job]] : []),
      ['edit-job', 'Edit job…', job],
      ...(projectOf(j) ? [['go', 'Open project', `#/project/${encodeURIComponent(j.projectId)}`]] : []),
    ]};
  }
  const p = projectId && byId(state.projects, projectId); if (!p) return null;
  return {title:p.title, items:[
    ['go', 'Open', `#/project/${encodeURIComponent(p.id)}`],
    ['toggle-pin', p.pinned ? 'Unpin' : 'Pin to top', p.id],
    '-',
    ['status-label', 'Progress'],
    ...statuses.map(x => ['set-project-status', x, p.id, x, x === p.status]),
    '-',
    ['new-job', 'Queue a print…', p.id],
    ['edit-project', 'Edit details…', p.id],
    ['duplicate-project', 'Duplicate', p.id],
    ['copy-link', 'Copy link', p.id],
    '-',
    ['delete-project', 'Delete…', p.id, '', false, true],
  ]};
}
function openContextMenu(target, x, y) {
  const spec = menuItems(target); if (!spec) return false;
  const menu = $('#context-menu');
  menu.innerHTML = `<div class="ctx-title">${esc(spec.title)}</div>` + spec.items.map(item => {
    if (item === '-') return '<hr>';
    const [action, label, id, value = '', checked = false, danger = false] = item;
    if (action === 'status-label') return `<div class="ctx-label">${esc(label)}</div>`;
    if (action === 'go') return `<button role="menuitem" data-go="${esc(id)}">${esc(label)}</button>`;
    if (action === 'set-project-status') return `<button role="menuitemradio" aria-checked="${checked}" class="ctx-status ${esc(value)}" data-action="${action}" data-id="${esc(id)}" data-value="${esc(value)}"><i aria-hidden="true"></i>${esc(label)}</button>`;
    return `<button role="menuitem" class="${danger ? 'danger-item' : ''}" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
  }).join('');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  closeContextMenu.returnTo = target.closest('a, button, [tabindex]') || target;
  $('button', menu)?.focus();
  return true;
}
function closeContextMenu(refocus = false) {
  const menu = $('#context-menu'); if (menu.hidden) return;
  menu.hidden = true;
  if (refocus) closeContextMenu.returnTo?.focus?.();
}
document.addEventListener('contextmenu', e => {
  if (!state || e.target.closest('input, textarea, select, dialog, #assistant')) return;
  if (e.target.closest('[data-project], .job-card') && openContextMenu(e.target, e.clientX, e.clientY)) e.preventDefault();
});
document.addEventListener('keydown', e => {
  const menu = $('#context-menu');
  if (!menu.hidden) {
    const items = $$('button', menu), at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(true); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    if (e.key === 'Tab') closeContextMenu();
    return;
  }
  if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && document.activeElement?.closest('[data-project], .job-card')) {
    const r = document.activeElement.getBoundingClientRect();
    if (openContextMenu(document.activeElement, r.left + 12, r.bottom + 4)) e.preventDefault();
  }
});
document.addEventListener('click', e => { if (!e.target.closest('#context-menu')) closeContextMenu(); else if (e.target.closest('button')) setTimeout(() => closeContextMenu(), 0); }, true);
addEventListener('scroll', () => closeContextMenu(), {passive:true});
addEventListener('resize', () => closeContextMenu());

// ---------- Command palette ----------
let paletteItems = [], paletteIndex = 0;
function paletteSource() {
  return [
    ...views.map(v => ({label:{projects:'Projects', jobs:'Print jobs', printer:'Printer (live)', filament:'Filament shelf', family:'Family'}[v], hint:'View', run:() => go(`#/${v}`)})),
    {label:'New idea', hint:'Action', run:() => openEditor('project')},
    {label:'Queue a print', hint:'Action', run:() => openEditor('job')},
    {label:'Add spool', hint:'Action', run:() => openEditor('spool')},
    {label:'Add person', hint:'Action', run:() => openEditor('profile')},
    {label:'Export backup', hint:'Action', run:exportBackup},
    {label:'Import backup', hint:'Action', run:() => $('#import-file').click()},
    ...(route.view === 'project' && byId(state.projects, route.id) ? [{label:byId(state.projects, route.id).pinned ? 'Unpin this project' : 'Pin this project', hint:'Action', run:() => actions['toggle-pin']({id:route.id})}] : []),
    {label:'Ask the lab assistant', hint:'AI', run:() => window.Assistant?.open()},
    ...themes.map(([id, name]) => ({label:`Theme: ${name}`, hint:'Appearance', run:() => setTheme(id)})),
    {label:'Suggest print ideas', hint:'AI', run:() => actions['ai-ideas']({id:profile})},
    ...state.projects.map(p => ({label:p.title, hint:`${p.category} · ${p.status}`, run:() => go(`#/project/${encodeURIComponent(p.id)}`)})),
    ...state.spools.map(s => ({label:`${s.colorName || s.colorHex} ${s.material}`, hint:`Spool · ${weight(s.remainingGrams)} left`, run:() => openEditor('spool', s.id)})),
  ];
}
function renderPalette() {
  const q = $('#palette-input').value.trim().toLowerCase();
  paletteItems = paletteSource().filter(i => `${i.label} ${i.hint}`.toLowerCase().includes(q)).slice(0, 12);
  paletteIndex = Math.min(paletteIndex, Math.max(paletteItems.length - 1, 0));
  $('#palette-list').innerHTML = paletteItems.map((i, n) => `<li role="option" id="pal-${n}" aria-selected="${n === paletteIndex}" data-index="${n}"><span>${esc(i.label)}</span><small>${esc(i.hint)}</small></li>`).join('') || '<li class="none">No matches</li>';
  $('#palette-input').setAttribute('aria-activedescendant', paletteItems.length ? `pal-${paletteIndex}` : '');
}
function openPalette() { if (!state || document.querySelector('dialog[open]')) return; $('#palette-input').value = ''; paletteIndex = 0; renderPalette(); $('#palette').showModal(); $('#palette-input').focus(); }
function runPalette(n) { const item = paletteItems[n]; if (!item) return; $('#palette').close(); item.run(); }
$('#palette-input').addEventListener('input', () => { paletteIndex = 0; renderPalette(); });
$('#palette-input').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); paletteIndex = (paletteIndex + (e.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % Math.max(paletteItems.length, 1); renderPalette(); $(`#pal-${paletteIndex}`)?.scrollIntoView({block:'nearest'}); }
  if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteIndex); }
});
$('#palette-list').addEventListener('click', e => { const li = e.target.closest('[data-index]'); if (li) runPalette(Number(li.dataset.index)); });
$('#palette').addEventListener('click', e => { if (e.target === $('#palette')) $('#palette').close(); });

// Hovering or focusing a card previews its category in the 3D stage.
const preview = e => { const card = e.target.closest('[data-category]'); if (card) window.Lab3D?.setShape(card.dataset.category); };
$('#content').addEventListener('pointerover', preview);
$('#content').addEventListener('focusin', preview);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/' && route.view === 'projects') { e.preventDefault(); $('#search').focus(); }
  if (e.key === '/' && route.view === 'project' && $('#side-search')?.offsetParent) { e.preventDefault(); $('#side-search').focus(); $('#side-search').select(); }
  if (e.key === 'n' && state) { e.preventDefault(); ({projects:() => openEditor('project'), project:() => openEditor('job', null, {projectId:route.id}), jobs:() => openEditor('job'), printer:() => openEditor('job'), filament:() => openEditor('spool'), family:() => openEditor('profile')})[route.view](); }
});
setInterval(() => { if (state && !document.hidden) updateProgress(); }, 15000);
// Sticky sidebar sits under the top bar, whatever height it wraps to.
new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--topbar-h', `${Math.round(entry.target.getBoundingClientRect().height)}px`)).observe($('.topbar'));

async function start() {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('Could not load your workspace. Refresh to try again.');
    state = await response.json(); render();
    fetch('/api/ai').then(r => r.ok ? r.json() : aiInfo).then(info => { aiInfo = info; document.body.classList.toggle('ai-ready', !!info.configured); }).catch(() => {});
    pollPrinter();
    if (document.modelContext?.registerTool) {
      const lifecycle = new AbortController();
      window.addEventListener('pagehide', () => lifecycle.abort(), {once:true});
      const tools = [
        {name:'list_family_prints', description:'Read family profiles, print projects, print jobs and filament spools.', inputSchema:{type:'object', properties:{}, additionalProperties:false}, annotations:{readOnlyHint:true, untrustedContentHint:true}, execute:() => structuredClone(state)},
        {name:'set_print_status', description:'Save a project’s progress and refresh the visible workspace.', inputSchema:{type:'object', properties:{projectId:{type:'string'}, status:{type:'string', enum:statuses}}, required:['projectId', 'status'], additionalProperties:false}, annotations:{readOnlyHint:false, untrustedContentHint:false}, execute:async input => {
          if (busy || $('#editor').open) throw new Error('Finish the open edit first.');
          if (!input || !statuses.includes(input.status) || !state.projects.some(p => p.id === input.projectId)) throw new Error('Invalid project or status.');
          busy = true;
          try { const next = structuredClone(state); next.projects.find(p => p.id === input.projectId).status = input.status; await save(next); return {id:input.projectId, status:input.status}; } finally { busy = false; }
        }},
      ];
      for (const tool of tools) { try { await document.modelContext.registerTool(tool, {signal:lifecycle.signal}); } catch (error) { console.warn('Optional agent tools unavailable', error); } }
    }
  } catch (error) { saveState('offline'); showError(error.message); }
}
start();
