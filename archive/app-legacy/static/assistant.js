'use strict';
// Lab assistant drawer: chat with Claude about the workspace, plus one-click suggestions
// (ideas, failure diagnosis, slicer settings, checklists). Suggestions change nothing until applied.
// Shares app.js globals ($, esc, state, commit, actions, openEditor…) as a classic script.
(() => {
  const drawer = $('#assistant'), log = $('#ai-log'), input = $('#ai-input'), fab = $('#ai-fab');
  const cards = new Map();
  let history = [], photo = null, running = false;

  // ---------- Drawer ----------
  function open() {
    drawer.hidden = false; fab.setAttribute('aria-expanded', 'true'); document.body.classList.add('assistant-open');
    if (!log.children.length) intro();
    setTimeout(() => input.focus(), 60);
  }
  function close() { drawer.hidden = true; fab.setAttribute('aria-expanded', 'false'); document.body.classList.remove('assistant-open'); fab.focus(); }
  fab.addEventListener('click', () => drawer.hidden ? open() : close());
  $('#ai-close').addEventListener('click', close);
  drawer.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.stopPropagation(); close(); } });
  $('#ai-new').addEventListener('click', () => { if (running) return; history = []; cards.clear(); log.innerHTML = ''; clearPhoto(); intro(); input.focus(); });

  function prompts() {
    const list = [];
    const project = route.view === 'project' && byId(state.projects, route.id);
    if (project) list.push(`What should I do next on “${project.title}”?`);
    if (printer.printing) list.push('How is the current print going?');
    if (state.jobs.some(j => j.status === 'Failed')) list.push('Why do my prints fail, and what should I change?');
    list.push('What should we print next as a family?', 'Which spools should I restock soon?', 'Best X2D settings for strong PETG brackets?');
    return list.slice(0, 4);
  }
  function intro() {
    if (!aiInfo.configured) {
      bubble('bot', `<p><strong>Set up the assistant</strong></p><p>The lab assistant uses Claude through your Anthropic account. It is off until you add a key:</p>
        <ul><li>Copy <code>app/.env.example</code> to <code>app/.env</code></li><li>Set <code>ANTHROPIC_API_KEY=</code> to a key from console.anthropic.com (or run <code>ant auth login</code> instead)</li><li>Restart <code>node app/server.js</code></li></ul>
        <p>Each question sends your workspace details (names, ages, projects, jobs, spools, printer status) to Anthropic. Usage is billed to your account.</p>`);
      return;
    }
    bubble('bot', `<p>Hi! I can see your projects, print jobs, spools${printer.connected ? ' and the live printer' : ''}. Ask anything, attach a photo of a print, or try:</p>
      <div class="ai-chips">${prompts().map(p => `<button type="button" class="chip" data-action="ai-prompt" data-value="${esc(p)}">${esc(p)}</button>`).join('')}</div>`);
  }

  function bubble(kind, html) {
    const el = document.createElement('div');
    el.className = `ai-msg ${kind}`; el.innerHTML = html;
    log.append(el); log.scrollTop = log.scrollHeight;
    return el;
  }
  const pending = (label) => bubble('bot pending', `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(label)}</span>`);
  function fail(el, message) { el.className = 'ai-msg error'; el.textContent = message; }

  // Minimal, escape-first formatting for Claude's replies: paragraphs, bullets, **bold**, `code`.
  function format(text) {
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = []; let list = null;
    for (const line of text.split('\n')) {
      const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (item) { (list ??= []).push(`<li>${inline(item[1])}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  }

  // ---------- Photos ----------
  async function readPhoto(file) {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    return {mediaType:'image/jpeg', data:url.split(',')[1], url};
  }
  function clearPhoto() { photo = null; $('#ai-attachment').hidden = true; $('#ai-preview').removeAttribute('src'); }
  $('#ai-photo').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try { photo = await readPhoto(file); $('#ai-preview').src = photo.url; $('#ai-attachment').hidden = false; }
    catch (error) { toast(error.message || 'Could not read that image.'); }
  });
  $('#ai-remove-photo').addEventListener('click', clearPhoto);

  // ---------- Chat ----------
  async function post(task, body) {
    const response = await fetch(`/api/ai/${task}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const data = await response.json().catch(() => ({error:'The assistant sent an unreadable reply.'}));
    if (!response.ok) throw new Error(data.error || 'The assistant is unavailable.');
    return data;
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || running) return;
    open(); running = true; $('#ai-send').disabled = true;
    const project = history.length === 0 && route.view === 'project' ? byId(state.projects, route.id) : null;
    const content = project ? `(I'm looking at the project “${project.title}”.)\n${text}` : text;
    const message = {role:'user', content, ...(photo ? {image:{mediaType:photo.mediaType, data:photo.data}} : {})};
    bubble('user', format(text) + (photo ? `<img class="ai-thumb" src="${esc(photo.url)}" alt="Attached photo">` : ''));
    clearPhoto(); input.value = ''; resize();
    const reply = pending('Thinking…');
    let answer = '';
    try {
      const response = await fetch('/api/ai/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages:[...history, message]})});
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'The assistant is unavailable.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        answer += decoder.decode(value, {stream:true});
        reply.className = 'ai-msg bot'; reply.innerHTML = format(answer);
        log.scrollTop = log.scrollHeight;
      }
      if (!answer.trim()) throw new Error('No answer came back. Try again.');
      history.push({role:'user', content}, {role:'assistant', content:answer});
      if (history.length > 30) history = history.slice(-30);
    } catch (error) { fail(reply, error.message); }
    finally { running = false; $('#ai-send').disabled = false; }
  }

  const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
  input.addEventListener('input', resize);
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  $('#ai-form').addEventListener('submit', e => { e.preventDefault(); send(input.value); });

  // ---------- One-click tasks ----------
  async function task(label, name, body, draw) {
    open();
    if (running) { toast('The assistant is still working on the last request.'); return; }
    if (!aiInfo.configured) { if (log.lastElementChild?.textContent.includes('Set up the assistant')) return; intro(); return; }
    running = true;
    const el = pending(label);
    try { const data = await post(name, body); el.className = 'ai-msg bot card'; el.innerHTML = draw(data); setVars(el); }
    catch (error) { fail(el, error.message); }
    finally { running = false; log.scrollTop = log.scrollHeight; }
  }
  const remember = (data) => { const id = uuid(); cards.set(id, data); return id; };
  const settingChips = (s) => `<div class="ai-settings">${[s.layerHeight && `${s.layerHeight} mm layers`, s.nozzle && `${s.nozzle} mm nozzle`, s.plate, s.supports && `supports: ${s.supports}`, s.infill !== null && s.infill !== undefined && `${s.infill}% infill`].filter(Boolean).map(t => `<span>${esc(t)}</span>`).join('')}</div>`;
  const clip = (t, n) => String(t || '').slice(0, n);

  function ideasCard(data, person) {
    const id = remember({ideas:data.ideas, profileId:person.id});
    return `<p class="card-title">✦ Ideas for ${esc(person.name)}</p>${data.ideas.map((idea, n) => `<article class="ai-idea">
      <div class="ai-idea-top"><strong>${esc(idea.title)}</strong><span class="chip-static">${esc(categoryGlyph[idea.category] || '◇')} ${esc(idea.category)}</span></div>
      <p>${esc(idea.description)}</p><p class="muted">${esc(idea.why)}${idea.material ? ` · <strong>${esc(idea.material)}</strong>` : ''}</p>
      ${idea.safety ? `<p class="ai-safety">⚠ ${esc(idea.safety)}</p>` : ''}
      <button type="button" class="mini primary-mini" data-action="ai-add-idea" data-card="${id}" data-index="${n}">＋ Add idea (${idea.checklist.length} steps)</button></article>`).join('')}`;
  }
  function diagnoseCard(data, job) {
    const id = remember({diagnosis:data, jobId:job.id});
    return `<p class="card-title">✦ Diagnosis · ${esc(projectOf(job)?.title)} ${esc(job.revision)}</p><p>${esc(data.summary)}</p>
      <p class="label">Likely causes</p><ul class="ai-causes">${data.causes.map(c => `<li><span class="likely ${esc(c.likelihood)}">${esc(c.likelihood)}</span><div><strong>${esc(c.cause)}</strong><small>${esc(c.evidence)}</small></div></li>`).join('')}</ul>
      <p class="label">Fixes</p><ul>${data.fixes.map(f => `<li><strong>${esc(f.change)}</strong> — ${esc(f.why)}</li>`).join('')}</ul>
      <p class="label">Reprint settings</p>${settingChips(data.settings)}${data.retry ? `<p class="muted">${esc(data.retry)}</p>` : ''}
      <button type="button" class="mini primary-mini" data-action="ai-reprint" data-card="${id}">↻ Queue reprint with these settings</button>`;
  }
  function checklistCard(data, project) {
    const id = remember({steps:data.steps, projectId:project.id});
    return `<p class="card-title">✦ Checklist for ${esc(project.title)}</p><ol class="ai-steps">${data.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
      <div class="ai-buttons"><button type="button" class="mini primary-mini" data-action="ai-apply-checklist" data-card="${id}" data-value="replace">Replace checklist</button><button type="button" class="mini" data-action="ai-apply-checklist" data-card="${id}" data-value="append">Add new steps</button></div>`;
  }
  function settingsCard(data, project) {
    const id = remember({settings:data.settings, projectId:project.id});
    return `<p class="card-title">✦ Settings for ${esc(project.title)}</p>${settingChips(data.settings)}<p>${esc(data.rationale)}</p>
      ${data.tips.length ? `<ul>${data.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <button type="button" class="mini primary-mini" data-action="ai-queue-settings" data-card="${id}">＋ Queue a print with these</button>`;
  }

  const jobSettings = (s) => ({layerHeight:s.layerHeight, nozzle:s.nozzle, plate:s.plate, supports:s.supports, infill:Math.min(100, Math.max(0, Math.round(s.infill)))});

  Object.assign(actions, {
    'ai-open': () => open(),
    'ai-prompt': (d) => send(d.value),
    'ai-ask': (d) => { open(); input.value = d.value; resize(); input.focus(); },
    'ai-ideas': (d) => {
      const person = byId(state.profiles, d.id);
      if (!person) {
        open();
        bubble('bot', `<p>Who are the ideas for?</p><div class="ai-chips">${state.profiles.map(p => `<button type="button" class="chip" data-action="ai-ideas" data-id="${esc(p.id)}">${avatar(p)}${esc(p.name)}</button>`).join('')}</div>`);
        return;
      }
      task(`Dreaming up ideas for ${person.name}…`, 'ideas', {profileId:person.id}, data => ideasCard(data, person));
    },
    'ai-diagnose': (d) => {
      const job = byId(state.jobs, d.id); if (!job) return;
      open();
      bubble('bot', `<p><strong>Diagnose ${esc(projectOf(job)?.title)} ${esc(job.revision)}</strong></p><p>A photo of the failed print helps a lot (the first layer, the failure point, the underside).</p>
        <div class="ai-buttons"><label class="mini attach-inline"><input type="file" accept="image/*" data-diagnose-photo="${esc(job.id)}">⌗ Add photo</label><button type="button" class="mini primary-mini" data-action="ai-diagnose-run" data-id="${esc(job.id)}">Diagnose now</button></div><img class="ai-thumb" data-diagnose-preview="${esc(job.id)}" alt="" hidden>`);
    },
    'ai-diagnose-run': (d) => {
      const job = byId(state.jobs, d.id); if (!job) return;
      const shot = cards.get(`photo:${job.id}`);
      task('Looking for likely causes…', 'diagnose', {jobId:job.id, ...(shot ? {image:{mediaType:shot.mediaType, data:shot.data}} : {})}, data => diagnoseCard(data, job));
    },
    'ai-checklist': (d) => { const p = byId(state.projects, d.id); if (p) task('Tailoring the checklist…', 'checklist', {projectId:p.id}, data => checklistCard(data, p)); },
    'ai-settings': (d) => { const p = byId(state.projects, d.id); if (p) task('Working out slicer settings…', 'settings', {projectId:p.id}, data => settingsCard(data, p)); },
    'ai-settings-form': async () => {
      const form = $('#editor-form'), note = $('#ai-settings-note'), button = $('[data-action="ai-settings-form"]');
      if (!aiInfo.configured) { note.textContent = 'Set up the assistant first (see ✦ Ask the lab).'; return; }
      button.disabled = true; note.textContent = 'Asking Claude…';
      try {
        const data = await post('settings', {projectId:form.elements.projectId.value, material:form.elements.material.value});
        for (const [name, value] of Object.entries(jobSettings(data.settings))) {
          const el = form.elements[name]; if (!el) continue;
          if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(value))) el.add(new Option(String(value), String(value)));
          el.value = String(value);
        }
        note.textContent = `✦ ${data.rationale}`;
      } catch (error) { note.textContent = error.message; }
      finally { button.disabled = false; }
    },
    'ai-add-idea': async (d, el) => {
      const {ideas, profileId} = cards.get(d.card) || {}, idea = ideas?.[Number(d.index)];
      if (!idea || !byId(state.profiles, profileId)) return;
      const id = uuid(), at = now();
      const ok = await commit(next => next.projects.push({id, title:clip(idea.title, 80), profileId, status:'Idea', category:idea.category, material:clip(idea.material, 1000), description:clip(idea.description, 4000), url:'', files:'',
        notes:clip([idea.why, idea.safety && `Safety: ${idea.safety}`].filter(Boolean).join('\n'), 4000), checklist:idea.checklist.slice(0, 60).map(text => ({id:uuid(), text:clip(text, 200), done:false})), createdAt:at, updatedAt:at}), `Added “${clip(idea.title, 80)}”.`);
      if (ok) { const b = log.querySelector(`[data-card="${d.card}"][data-index="${d.index}"]`); if (b) { b.outerHTML = `<button type="button" class="mini" data-go="#/project/${encodeURIComponent(id)}">Added ✓ Open ↗</button>`; } }
    },
    'ai-apply-checklist': (d) => {
      const {steps, projectId} = cards.get(d.card) || {}; if (!steps) return;
      commit(next => {
        const p = byId(next.projects, projectId); if (!p) return;
        const existing = new Map(p.checklist.map(c => [c.text.toLowerCase(), c]));
        const fresh = steps.map(text => clip(text, 200)).filter(Boolean);
        p.checklist = d.value === 'replace'
          ? fresh.map(text => existing.get(text.toLowerCase()) || {id:uuid(), text, done:false}).slice(0, 60)
          : [...p.checklist, ...fresh.filter(t => !existing.has(t.toLowerCase())).map(text => ({id:uuid(), text, done:false}))].slice(0, 60);
        p.updatedAt = now();
      }, d.value === 'replace' ? 'Checklist replaced.' : 'Steps added.');
    },
    'ai-reprint': (d) => {
      const {diagnosis, jobId} = cards.get(d.card) || {}; const source = diagnosis && byId(state.jobs, jobId); if (!source) return;
      commit(next => next.jobs.push({...structuredClone(byId(next.jobs, jobId)), ...jobSettings(diagnosis.settings), id:uuid(), status:'Queued', createdAt:now(), startedAt:'', finishedAt:'', actualMinutes:null, charge:null, printerTask:'',
        notes:clip(`Reprint after diagnosis: ${diagnosis.fixes.map(f => f.change).join('; ')}`, 4000)}), 'Reprint queued with the suggested settings.');
    },
    'ai-queue-settings': (d) => {
      const {settings, projectId} = cards.get(d.card) || {}; if (!settings) return;
      openEditor('job', null, {projectId, job:{projectId, ...jobSettings(settings)}});
    },
  });

  document.addEventListener('change', async e => {
    const inputEl = e.target.closest('[data-diagnose-photo]'); if (!inputEl?.files[0]) return;
    try {
      const shot = await readPhoto(inputEl.files[0]), id = inputEl.dataset.diagnosePhoto;
      cards.set(`photo:${id}`, shot);
      const preview = log.querySelector(`[data-diagnose-preview="${CSS.escape(id)}"]`); if (preview) { preview.src = shot.url; preview.hidden = false; }
    } catch (error) { toast(error.message || 'Could not read that image.'); }
  });

  window.Assistant = {open, send};
})();
