<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';
	import {
		CHANNEL_KINDS,
		channelKind,
		NOTIFY_EVENTS,
		TEMPLATE_VARS,
		type ChannelKind,
		type ChannelView,
		type DeliveryResult,
		type NotificationSettingsView,
		type Template
	} from '$lib/shared/notifications';
	import ChannelForm from './ChannelForm.svelte';

	// Integrations → Notifications: what the bell records, the channels that send news out (each
	// opt-in, with a test button), kids' pictures and the wording of each message.
	const { lab, ui } = useApp();
	let s = $state<NotificationSettingsView | null>(null);
	let problem = $state('');
	let editing = $state<{ channel: ChannelView | null; kind: ChannelKind } | null>(null);
	let adding = $state(false);
	let tests = $state<Record<string, { running: boolean; result?: DeliveryResult }>>({});
	let wording = $state<Record<string, Template>>({});

	const events = $derived(NOTIFY_EVENTS.filter((e) => s?.present.includes(e.name)));
	const kinds = $derived(
		CHANNEL_KINDS.filter(
			(k) =>
				k.kind !== 'desktop' ||
				(s?.desktopAvailable && !s.channels.some((c) => c.kind === 'desktop'))
		)
	);
	const pictures = $derived(!!s?.channels.some((c) => c.snapshots));

	async function load(keepWording = false) {
		try {
			const r = await fetch('/api/notifications/settings');
			const data = await r.json();
			if (!r.ok) throw new Error(data.error);
			if (keepWording) {
				s = data;
				problem = '';
			} else adopt(data);
		} catch (error) {
			problem = (error as Error).message || 'Could not load the notification settings.';
		}
	}
	function adopt(view: NotificationSettingsView) {
		s = view;
		problem = '';
		wording = Object.fromEntries(
			NOTIFY_EVENTS.filter((e) => e.name !== 'other').map((e) => [
				e.name,
				{ ...(view.templates[e.name] ?? e.template) }
			])
		);
	}
	onMount(() => void load());

	/** Saves everything; `channels` replaces the list (secrets the browser does not have are kept). */
	async function save(patch: Partial<Record<string, unknown>> = {}, success = 'Saved.') {
		if (!s) return false;
		const res = await lab.call<{ settings: NotificationSettingsView }>(
			'PUT',
			'/api/notifications/settings',
			{
				inApp: s.inApp,
				templates: wording,
				kidPictures: s.kidPictures,
				channels: s.channels,
				...patch
			},
			success
		);
		if (res) adopt(res.settings);
		// Refused (lab.call shows why): the switches go back to what is saved, drafts stay.
		else await load(true);
		return !!res;
	}

	const saveChannel = (channel: Record<string, unknown>) =>
		save(
			{
				channels: s!.channels.some((c) => c.id === channel.id)
					? s!.channels.map((c) => (c.id === channel.id ? channel : c))
					: [...s!.channels, channel]
			},
			'Channel saved.'
		);

	function toggleApp(name: string, on: boolean) {
		if (!s) return;
		void save({
			inApp: on ? [...new Set([...s.inApp, name])] : s.inApp.filter((e) => e !== name)
		});
	}
	const toggleChannel = (c: ChannelView) =>
		save(
			{ channels: s!.channels.map((x) => (x.id === c.id ? { ...x, enabled: !c.enabled } : x)) },
			c.enabled ? 'Switched off.' : 'Switched on.'
		);

	async function remove(c: ChannelView) {
		if (
			await ui.ask(
				`Remove ${c.name || channelKind(c.kind).label}?`,
				'It stops sending straight away, and its saved token or password is forgotten.',
				'Remove channel'
			)
		)
			await save({ channels: s!.channels.filter((x) => x.id !== c.id) }, 'Channel removed.');
	}

	async function test(c: ChannelView) {
		tests[c.id] = { running: true };
		try {
			const r = await fetch('/api/notifications/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ channel: c })
			});
			const data = await r.json();
			tests[c.id] = {
				running: false,
				result: r.ok ? data.result : { at: '', ok: false, detail: data.error ?? 'The test failed.' }
			};
		} catch {
			tests[c.id] = {
				running: false,
				result: { at: '', ok: false, detail: 'Could not reach the app server.' }
			};
		}
	}

	function resetWording(name: string) {
		const def = NOTIFY_EVENTS.find((e) => e.name === name)!.template;
		wording[name] = { ...def };
		void save({}, 'Back to the default wording.');
	}

	const summary = (c: ChannelView) => {
		switch (c.kind) {
			case 'desktop':
				return 'System notifications on this computer';
			case 'ntfy':
				return `${c.server.replace(/^https?:\/\//, '')} · topic ${c.topic}${c.hasToken ? ' · token saved' : ''}`;
			case 'webhook':
				return `${c.url}${c.hasSecret ? ' · signed' : ''}`;
			case 'discord':
				return c.hasUrl ? 'Webhook saved' : 'No webhook yet';
			case 'telegram':
				return `Chat ${c.chatId}`;
			case 'email':
				return `${c.to} via ${c.host}`;
		}
	};
	const eventCount = (c: ChannelView) =>
		`${c.events.filter((e) => s?.present.includes(e)).length} kinds of news${c.quiet.enabled ? ` · quiet ${c.quiet.from}–${c.quiet.to}` : ''}${c.snapshots ? ' · with pictures' : ''}`;
</script>

<section class="int-section notifications" id="notifications" aria-label="Notifications">
	<div class="section-head">
		<h2>Notifications</h2>
		{#if s}
			<div class="add">
				<button
					class="primary"
					aria-expanded={adding}
					aria-haspopup="true"
					onclick={() => (adding = !adding)}>＋ Add a channel</button
				>
				{#if adding}
					<div class="popover add-menu" role="menu" aria-label="Channel type">
						{#each kinds as k (k.kind)}
							<button
								role="menuitem"
								onclick={() => {
									adding = false;
									editing = { channel: null, kind: k.kind };
								}}>{k.label}</button
							>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
	<p class="section-lead">
		The bell in the top bar keeps the latest news from the lab. Channels send the same news to your
		phone, a chat or another app; each one is off until you add it, and outside ones send text (and
		pictures, only if you ask) to a service outside your home.
	</p>

	{#if problem}
		<p class="error">{problem}</p>
	{:else if !s}
		<p class="panel-empty">Loading…</p>
	{:else}
		<h3>The bell</h3>
		<div class="events">
			{#each events as e (e.name)}
				<label class="toggle"
					><input
						type="checkbox"
						checked={s.inApp.includes(e.name)}
						onchange={(ev) => toggleApp(e.name, ev.currentTarget.checked)}
					/>
					{e.label}</label
				>
			{/each}
		</div>

		<h3>Channels</h3>
		{#if s.channels.length}
			<ul class="channels" aria-label="Notification channels">
				{#each s.channels as c (c.id)}
					{@const t = tests[c.id]}
					{@const last = t?.result ?? c.last}
					<li class:off={!c.enabled} data-channel={c.id}>
						<div class="who">
							<b>{c.name || channelKind(c.kind).label}</b>
							<small>{channelKind(c.kind).label} · {summary(c)}</small>
							<small class="dim">{eventCount(c)}</small>
							{#if last}<small class="result" class:bad={!last.ok}
									>{last.ok ? '✓' : '✕'}
									{last.detail}{last.at ? ` · ${stamp(last.at)}` : ''}</small
								>{/if}
						</div>
						<div class="acts">
							<label class="switch" title={c.enabled ? 'Switch off' : 'Switch on'}
								><input
									type="checkbox"
									checked={c.enabled}
									onchange={() => toggleChannel(c)}
									aria-label="{c.name || channelKind(c.kind).label} switched on"
								/></label
							>
							<button class="mini" disabled={t?.running} onclick={() => test(c)}
								>{t?.running ? 'Sending…' : 'Test'}</button
							>
							<button class="mini" onclick={() => (editing = { channel: c, kind: c.kind })}
								>Edit</button
							>
							<button class="mini danger-mini" onclick={() => remove(c)}>Remove</button>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="panel-empty">
				No channels yet.{#if s.desktopAvailable}
					Add “This computer” for system notifications on this computer.{/if} For your phone, try ntfy:
				install the free ntfy app, add a channel here and subscribe to its topic.
			</p>
		{/if}

		{#if pictures}
			<label class="toggle kid"
				><input
					type="checkbox"
					checked={s.kidPictures}
					onchange={(ev) =>
						save(
							{ kidPictures: ev.currentTarget.checked },
							ev.currentTarget.checked
								? 'Kids’ prints get pictures too.'
								: 'No pictures of kids’ prints.'
						)}
				/> Include pictures of kids' prints</label
			>
		{/if}

		<details class="wording">
			<summary>Message wording</summary>
			<p class="hint">
				Placeholders: {#each TEMPLATE_VARS as v, i (v)}<code>{`{{${v}}}`}</code>{i <
					TEMPLATE_VARS.length - 1
						? ' '
						: ''}{/each}. <code>{'{{kid}}'}</code> is the profile's name as shown in the app.
			</p>
			{#each events.filter((e) => e.name !== 'other') as e (e.name)}
				{#if wording[e.name]}
					<fieldset>
						<legend>{e.label}</legend>
						<label class="field"
							>Title<input
								aria-label="{e.label} title"
								bind:value={wording[e.name].title}
								maxlength="120"
							/></label
						>
						<label class="field"
							>Message<input
								aria-label="{e.label} message"
								bind:value={wording[e.name].body}
								maxlength="500"
							/></label
						>
						{#if s.templates[e.name]}<button
								type="button"
								class="mini"
								onclick={() => resetWording(e.name)}>Use the default</button
							>{/if}
					</fieldset>
				{/if}
			{/each}
			<button class="secondary" onclick={() => save({}, 'Wording saved.')}>Save wording</button>
		</details>
	{/if}
</section>

{#if editing && s}
	<ChannelForm
		channel={editing.channel}
		kind={editing.kind}
		present={s.present}
		onsave={saveChannel}
		onclose={() => (editing = null)}
	/>
{/if}

<style>
	.notifications {
		margin-bottom: 26px;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}
	h3 {
		font-size: 13px;
		margin: 14px 0 6px;
		color: var(--text-2);
	}
	.section-lead {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	.add {
		position: relative;
	}
	.add-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 40;
		display: grid;
		min-width: 180px;
		padding: 6px;
		border-radius: var(--r-md);
		border: 1px solid var(--line-strong);
		background: var(--menu);
		box-shadow: 0 18px 40px rgb(var(--lo) / 0.4);
	}
	.add-menu button {
		border: 0;
		background: transparent;
		color: var(--text);
		text-align: left;
		padding: 7px 10px;
		border-radius: var(--r-md);
		font: inherit;
		font-size: 13px;
	}
	.add-menu button:hover,
	.add-menu button:focus-visible {
		background: rgb(var(--hi) / 0.07);
	}
	.events {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 6px 14px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-2);
	}
	.toggle.kid {
		margin-top: 10px;
	}
	.channels {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.channels li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
	}
	.channels li.off {
		opacity: 0.7;
	}
	.who {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.who small {
		color: var(--muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.who .dim {
		color: var(--dim);
	}
	.result {
		color: var(--lime) !important;
	}
	.result.bad {
		color: var(--err-text) !important;
	}
	.acts {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.switch input {
		width: 16px;
		height: 16px;
	}
	.wording {
		margin-top: 14px;
	}
	.wording summary {
		cursor: pointer;
		font-size: 13px;
		color: var(--text-2);
	}
	.wording fieldset {
		margin: 8px 0;
		padding: 8px 10px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
		align-items: end;
		gap: 6px 12px;
	}
	.wording .field {
		margin-bottom: 0;
	}
	.wording legend {
		font-size: 12px;
		color: var(--dim);
		padding: 0 4px;
	}
	.wording fieldset .mini {
		justify-self: start;
		grid-column: 1 / -1;
	}
	.hint {
		font-size: 12px;
		color: var(--dim);
	}
	@media (max-width: 700px) {
		.wording fieldset {
			grid-template-columns: minmax(0, 1fr);
		}
		.channels li {
			grid-template-columns: minmax(0, 1fr);
		}
		.acts {
			justify-content: flex-start;
		}
	}
</style>
