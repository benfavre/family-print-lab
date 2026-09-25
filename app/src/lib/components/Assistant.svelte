<script lang="ts">
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { CATEGORY_GLYPH, type Category } from '$lib/shared/domain';
	import { useApp } from '$lib/client/app.svelte';
	import { actions, projectHref } from '$lib/client/actions';
	import Avatar from './Avatar.svelte';

	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);

	interface Photo {
		mediaType: 'image/jpeg';
		data: string;
		url: string;
	}
	interface Settings {
		layerHeight: string;
		nozzle: string;
		plate: string;
		supports: string;
		infill: number;
	}
	interface Idea {
		title: string;
		category: Category;
		description: string;
		material: string;
		why: string;
		safety: string;
		checklist: string[];
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type Json = any;
	type Entry =
		| { kind: 'user'; text: string; photo?: string }
		| { kind: 'bot'; text: string; pending?: boolean }
		| { kind: 'error'; text: string }
		| { kind: 'intro' }
		| { kind: 'pick-person' }
		| { kind: 'diagnose-ask'; jobId: string; photo?: Photo }
		| { kind: 'pending'; label: string }
		| { kind: 'ideas'; profileId: string; ideas: Idea[]; added: Record<number, string> }
		| {
				kind: 'diagnosis';
				jobId: string;
				data: {
					summary: string;
					causes: { cause: string; likelihood: string; evidence: string }[];
					fixes: { change: string; why: string }[];
					settings: Settings;
					retry: string;
				};
		  }
		| { kind: 'checklist'; projectId: string; steps: string[] }
		| {
				kind: 'settings';
				projectId: string;
				data: { settings: Settings; rationale: string; tips: string[] };
		  };

	let log = $state<Entry[]>([]);
	let history: { role: 'user' | 'assistant'; content: string }[] = [];
	let input = $state('');
	let photo = $state<Photo | null>(null);
	let running = $state(false);
	let logEl = $state<HTMLElement>();
	let inputEl = $state<HTMLTextAreaElement>();

	const scroll = () => tick().then(() => logEl?.scrollTo({ top: logEl.scrollHeight }));
	const push = (entry: Entry) => {
		log.push(entry);
		scroll();
		return log.length - 1;
	};

	function open() {
		ui.assistantOpen = true;
		if (!log.length) push({ kind: 'intro' });
		tick().then(() => inputEl?.focus());
	}
	function close() {
		ui.assistantOpen = false;
	}
	ui.assistantAsk = (question: string) => {
		open();
		input = question;
	};
	ui.assistantTask = (task, body) => {
		open();
		if (task === 'ideas') {
			const person = lab.profile(body.profileId as string);
			if (!person) push({ kind: 'pick-person' });
			else
				runTask(
					`Dreaming up ideas for ${person.name}…`,
					'ideas',
					{ profileId: person.id },
					(data) => ({ kind: 'ideas', profileId: person.id, ideas: data.ideas, added: {} })
				);
		} else if (task === 'diagnose') push({ kind: 'diagnose-ask', jobId: body.jobId as string });
		else if (task === 'checklist')
			runTask('Tailoring the checklist…', 'checklist', body, (data) => ({
				kind: 'checklist',
				projectId: body.projectId as string,
				steps: data.steps
			}));
		else if (task === 'settings')
			runTask('Working out slicer settings…', 'settings', body, (data) => ({
				kind: 'settings',
				projectId: body.projectId as string,
				data
			}));
	};

	$effect(() => {
		document.body.classList.toggle('assistant-open', ui.assistantOpen);
	});

	const prompts = $derived.by(() => {
		const list: string[] = [];
		const project = page.params.id ? lab.project(page.params.id) : undefined;
		if (project) list.push(`What should I do next on “${project.title}”?`);
		if (lab.printerActive) list.push('How is the current print going?');
		if (lab.ws.jobs.some((j) => j.status === 'Failed'))
			list.push('Why do my prints fail, and what should I change?');
		list.push(
			'What should we print next as a family?',
			'Which spools should I restock soon?',
			'Best X2D settings for strong PETG brackets?'
		);
		return list.slice(0, 4);
	});

	async function readPhoto(file: File): Promise<Photo> {
		if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const url = canvas.toDataURL('image/jpeg', 0.85);
		return { mediaType: 'image/jpeg', data: url.split(',')[1], url };
	}
	async function pickPhoto(e: Event, apply: (p: Photo) => void) {
		const el = e.currentTarget as HTMLInputElement;
		const file = el.files?.[0];
		el.value = '';
		if (!file) return;
		try {
			apply(await readPhoto(file));
		} catch (error) {
			ui.toast((error as Error).message || 'Could not read that image.', 'error');
		}
	}

	async function post(task: string, body: unknown) {
		const r = await fetch(`/api/ai/${task}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const data = await r.json().catch(() => ({ error: 'The assistant sent an unreadable reply.' }));
		if (!r.ok) throw new Error(data.error || 'The assistant is unavailable.');
		return data;
	}

	async function runTask(label: string, task: string, body: unknown, make: (data: Json) => Entry) {
		if (running) return ui.toast('The assistant is still working on the last request.');
		if (!lab.ai.configured) return;
		running = true;
		const at = push({ kind: 'pending', label });
		try {
			log[at] = make(await post(task, body));
		} catch (error) {
			log[at] = { kind: 'error', text: (error as Error).message };
		} finally {
			running = false;
			scroll();
		}
	}

	async function send(text = input) {
		text = text.trim();
		if (!text || running) return;
		open();
		running = true;
		const project =
			history.length === 0 && page.params.id ? lab.project(page.params.id) : undefined;
		const content = project ? `(I'm looking at the project “${project.title}”.)\n${text}` : text;
		const message = {
			role: 'user' as const,
			content,
			...(photo ? { image: { mediaType: photo.mediaType, data: photo.data } } : {})
		};
		push({ kind: 'user', text, photo: photo?.url });
		photo = null;
		input = '';
		const at = push({ kind: 'bot', text: '', pending: true });
		try {
			const r = await fetch('/api/ai/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ messages: [...history, message] })
			});
			if (!r.ok)
				throw new Error(
					(await r.json().catch(() => ({}))).error || 'The assistant is unavailable.'
				);
			const reader = r.body!.getReader(),
				decoder = new TextDecoder();
			let answer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				answer += decoder.decode(value, { stream: true });
				log[at] = { kind: 'bot', text: answer };
				scroll();
			}
			if (!answer.trim()) throw new Error('No answer came back. Try again.');
			history.push({ role: 'user', content }, { role: 'assistant', content: answer });
			if (history.length > 30) history = history.slice(-30);
		} catch (error) {
			log[at] = { kind: 'error', text: (error as Error).message };
		} finally {
			running = false;
		}
	}

	/** Escape-first formatting: paragraphs and bullet lists; **bold** and `code` become marked segments. */
	function blocks(text: string) {
		const out: { list: boolean; lines: string[] }[] = [];
		for (const line of text.split('\n')) {
			const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
			if (item) {
				const last = out.at(-1);
				if (last?.list) last.lines.push(item[1]);
				else out.push({ list: true, lines: [item[1]] });
			} else if (line.trim()) out.push({ list: false, lines: [line] });
		}
		return out;
	}
	const inline = (s: string) =>
		s
			.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
			.map((part) =>
				part.startsWith('**')
					? { b: part.slice(2, -2) }
					: part.startsWith('`')
						? { c: part.slice(1, -1) }
						: { t: part }
			);

	async function addIdea(entry: Extract<Entry, { kind: 'ideas' }>, n: number) {
		const idea = entry.ideas[n];
		const res = await lab.call<{ id: string }>(
			'POST',
			'/api/projects',
			{
				profileId: entry.profileId,
				title: idea.title.slice(0, 80),
				category: idea.category,
				material: idea.material.slice(0, 1000),
				description: idea.description.slice(0, 4000),
				notes: [idea.why, idea.safety && `Safety: ${idea.safety}`]
					.filter(Boolean)
					.join('\n')
					.slice(0, 4000),
				checklist: idea.checklist
					.slice(0, 60)
					.map((text) => ({ text: text.slice(0, 200), done: false }))
			},
			`Added “${idea.title}”.`
		);
		if (res) entry.added[n] = res.id;
	}
	const jobSettings = (s: Settings) => ({
		layerHeight: s.layerHeight,
		nozzle: s.nozzle,
		plate: s.plate,
		supports: s.supports,
		infill: Math.min(100, Math.max(0, Math.round(s.infill)))
	});
</script>

<button
	class="ai-fab"
	type="button"
	aria-controls="assistant"
	aria-expanded={ui.assistantOpen}
	onclick={() => (ui.assistantOpen ? close() : open())}
>
	<span aria-hidden="true">✦</span><span>Ask the lab</span>
</button>

{#if ui.assistantOpen}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<aside
		id="assistant"
		class="assistant"
		aria-label="Lab assistant"
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				close();
			}
		}}
	>
		<header class="assistant-head">
			<div>
				<div class="eyebrow">LAB AI · CLAUDE</div>
				<h2>Lab assistant</h2>
			</div>
			<div class="assistant-tools">
				<button
					type="button"
					class="mini"
					disabled={running}
					onclick={() => ((history = []), (log = [{ kind: 'intro' }]))}>New chat</button
				>
				<button type="button" class="icon-button" aria-label="Close assistant" onclick={close}
					>×</button
				>
			</div>
		</header>
		<div class="assistant-body" bind:this={logEl} aria-live="polite">
			{#each log as entry, i (i)}
				{#if entry.kind === 'intro'}
					<div class="ai-msg bot">
						{#if !lab.ai.configured}
							<p><strong>Set up the assistant</strong></p>
							<p>
								The assistant uses {lab.ai.label || 'an AI provider'}, which is not ready on this
								computer. Open
								<a href={resolve('/integrations')}>Integrations</a> to see what is missing, or switch
								to Claude (Claude Code) or ChatGPT (Codex) with your subscription.
							</p>
							<p>
								Each question sends your workspace details (names, ages, projects, jobs, spools,
								printer status) to that provider.
							</p>
						{:else}
							<p>
								Hi! I can see your projects, print jobs, spools{lab.printer.connected
									? ' and the live printer'
									: ''}. Ask anything, attach a photo of a print, or try:
							</p>
							<div class="ai-chips">
								{#each prompts as p (p)}<button type="button" class="chip" onclick={() => send(p)}
										>{p}</button
									>{/each}
							</div>
						{/if}
					</div>
				{:else if entry.kind === 'user'}
					<div class="ai-msg user">
						<p>{entry.text}</p>
						{#if entry.photo}<img class="ai-thumb" src={entry.photo} alt="Attached" />{/if}
					</div>
				{:else if entry.kind === 'bot'}
					<div class="ai-msg bot" class:pending={entry.pending}>
						{#if entry.pending}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span
							><span>Thinking…</span>
						{:else}
							{#each blocks(entry.text) as block, b (b)}
								{#if block.list}<ul>
										{#each block.lines as line, l (l)}<li>
												{#each inline(line) as seg, s (s)}{#if 'b' in seg}<strong>{seg.b}</strong
														>{:else if 'c' in seg}<code>{seg.c}</code>{:else}{seg.t}{/if}{/each}
											</li>{/each}
									</ul>
								{:else}<p>
										{#each inline(block.lines[0]) as seg, s (s)}{#if 'b' in seg}<strong
													>{seg.b}</strong
												>{:else if 'c' in seg}<code>{seg.c}</code>{:else}{seg.t}{/if}{/each}
									</p>{/if}
							{/each}
						{/if}
					</div>
				{:else if entry.kind === 'error'}
					<div class="ai-msg error" role="alert">{entry.text}</div>
				{:else if entry.kind === 'pending'}
					<div class="ai-msg bot pending">
						<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span
							>{entry.label}</span
						>
					</div>
				{:else if entry.kind === 'pick-person'}
					<div class="ai-msg bot">
						<p>Who are the ideas for?</p>
						<div class="ai-chips">
							{#each lab.ws.profiles as p (p.id)}<button
									type="button"
									class="chip"
									onclick={() => ui.assistantTask?.('ideas', { profileId: p.id })}
									><Avatar profile={p} />{p.name}</button
								>{/each}
						</div>
					</div>
				{:else if entry.kind === 'diagnose-ask'}
					{@const job = lab.ws.jobs.find((j) => j.id === entry.jobId)}
					<div class="ai-msg bot">
						<p><strong>Diagnose {lab.project(job?.projectId)?.title} {job?.revision}</strong></p>
						<p>
							A photo of the failed print helps a lot: the first layer, the failure point, the
							underside.
						</p>
						<div class="ai-buttons">
							<label class="mini attach-inline"
								><input
									type="file"
									accept="image/*"
									onchange={(e) => pickPhoto(e, (p) => (entry.photo = p))}
								/>⌗ {entry.photo ? 'Change photo' : 'Add photo'}</label
							>
							<button
								type="button"
								class="mini primary-mini"
								disabled={running}
								onclick={() =>
									runTask(
										'Looking for likely causes…',
										'diagnose',
										{
											jobId: entry.jobId,
											...(entry.photo
												? { image: { mediaType: entry.photo.mediaType, data: entry.photo.data } }
												: {})
										},
										(data) => ({ kind: 'diagnosis', jobId: entry.jobId, data })
									)}>Diagnose now</button
							>
						</div>
						{#if entry.photo}<img class="ai-thumb" src={entry.photo.url} alt="Failed print" />{/if}
					</div>
				{:else if entry.kind === 'ideas'}
					<div class="ai-msg bot card">
						<p class="card-title">✦ Ideas for {lab.profile(entry.profileId)?.name}</p>
						{#each entry.ideas as idea, n (n)}
							<article class="ai-idea">
								<div class="ai-idea-top">
									<strong>{idea.title}</strong><span class="chip-static"
										>{CATEGORY_GLYPH[idea.category] ?? '◇'} {idea.category}</span
									>
								</div>
								<p>{idea.description}</p>
								<p class="muted">
									{idea.why}{#if idea.material}
										· <strong>{idea.material}</strong>{/if}
								</p>
								{#if idea.safety}<p class="ai-safety">⚠ {idea.safety}</p>{/if}
								{#if entry.added[n]}<button
										type="button"
										class="mini"
										onclick={() => goto(projectHref(entry.added[n]))}>Added ✓ Open ↗</button
									>
								{:else}<button
										type="button"
										class="mini primary-mini"
										onclick={() => addIdea(entry, n)}
										>＋ Add idea ({idea.checklist.length} steps)</button
									>{/if}
							</article>
						{/each}
					</div>
				{:else if entry.kind === 'diagnosis'}
					{@const job = lab.ws.jobs.find((j) => j.id === entry.jobId)}
					<div class="ai-msg bot card">
						<p class="card-title">
							✦ Diagnosis · {lab.project(job?.projectId)?.title}
							{job?.revision}
						</p>
						<p>{entry.data.summary}</p>
						<p class="label">Likely causes</p>
						<ul class="ai-causes">
							{#each entry.data.causes as c, n (n)}<li>
									<span class="likely {c.likelihood}">{c.likelihood}</span>
									<div><strong>{c.cause}</strong><small>{c.evidence}</small></div>
								</li>{/each}
						</ul>
						<p class="label">Fixes</p>
						<ul>
							{#each entry.data.fixes as f, n (n)}<li>
									<strong>{f.change}</strong> — {f.why}
								</li>{/each}
						</ul>
						<p class="label">Reprint settings</p>
						<div class="ai-settings">
							{#each [entry.data.settings.layerHeight && `${entry.data.settings.layerHeight} mm layers`, entry.data.settings.nozzle && `${entry.data.settings.nozzle} mm nozzle`, entry.data.settings.plate, `supports: ${entry.data.settings.supports}`, `${entry.data.settings.infill}% infill`].filter(Boolean) as s (s)}<span
									>{s}</span
								>{/each}
						</div>
						{#if entry.data.retry}<p class="muted">{entry.data.retry}</p>{/if}
						{#if job}<button
								type="button"
								class="mini primary-mini"
								onclick={() =>
									act.reprint(job, {
										...jobSettings(entry.data.settings),
										notes:
											`Reprint after diagnosis: ${entry.data.fixes.map((f) => f.change).join('; ')}`.slice(
												0,
												4000
											)
									})}>↻ Queue reprint with these settings</button
							>{/if}
					</div>
				{:else if entry.kind === 'checklist'}
					{@const project = lab.project(entry.projectId)}
					<div class="ai-msg bot card">
						<p class="card-title">✦ Checklist for {project?.title}</p>
						<ol class="ai-steps">
							{#each entry.steps as s, n (n)}<li>{s}</li>{/each}
						</ol>
						{#if project}
							<div class="ai-buttons">
								<button
									type="button"
									class="mini primary-mini"
									onclick={() => act.setChecklist(project, entry.steps, 'replace')}
									>Replace checklist</button
								>
								<button
									type="button"
									class="mini"
									onclick={() => act.setChecklist(project, entry.steps, 'append')}
									>Add new steps</button
								>
							</div>
						{/if}
					</div>
				{:else if entry.kind === 'settings'}
					<div class="ai-msg bot card">
						<p class="card-title">✦ Settings for {lab.project(entry.projectId)?.title}</p>
						<div class="ai-settings">
							{#each [entry.data.settings.layerHeight && `${entry.data.settings.layerHeight} mm layers`, entry.data.settings.nozzle && `${entry.data.settings.nozzle} mm nozzle`, entry.data.settings.plate, `supports: ${entry.data.settings.supports}`, `${entry.data.settings.infill}% infill`].filter(Boolean) as s (s)}<span
									>{s}</span
								>{/each}
						</div>
						<p>{entry.data.rationale}</p>
						{#if entry.data.tips.length}<ul>
								{#each entry.data.tips as t (t)}<li>{t}</li>{/each}
							</ul>{/if}
						<button
							type="button"
							class="mini primary-mini"
							onclick={() =>
								ui.openEditor('job', null, {
									projectId: entry.projectId,
									...jobSettings(entry.data.settings)
								})}>＋ Queue a print with these</button
						>
					</div>
				{/if}
			{/each}
		</div>
		<form
			class="assistant-form"
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			{#if photo}
				<div class="ai-attachment">
					<img src={photo.url} alt="Attached" /><button
						type="button"
						class="mini icon"
						aria-label="Remove photo"
						onclick={() => (photo = null)}>×</button
					>
				</div>
			{/if}
			<div class="assistant-input">
				<label class="attach" title="Attach a photo"
					><input
						type="file"
						accept="image/*"
						onchange={(e) => pickPhoto(e, (p) => (photo = p))}
					/><span aria-hidden="true">⌗</span><span class="sr-only">Attach a photo</span></label
				>
				<textarea
					bind:this={inputEl}
					bind:value={input}
					rows="1"
					maxlength="8000"
					placeholder="Ask about prints, settings, ideas…"
					aria-label="Message the lab assistant"
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
							e.preventDefault();
							send();
						}
					}}></textarea>
				<button class="primary" disabled={running || !lab.ai.configured}>Send</button>
			</div>
			<small class="assistant-note"
				>Uses {lab.ai.label || 'the configured AI'} (change in
				<a href={resolve('/integrations')}>Integrations</a>). Your workspace details are sent with
				each question.</small
			>
		</form>
	</aside>
{/if}
