<script lang="ts">
	import Modal from '../Modal.svelte';
	import {
		channelKind,
		DEFAULT_NTFY_SERVER,
		HMS_SEVERITIES,
		NOTIFY_EVENTS,
		type ChannelKind,
		type ChannelView,
		type DeliveryResult
	} from '$lib/shared/notifications';

	// Add or edit one notification channel: where it sends, which events, quiet hours, pictures.
	// Secrets are write-only: an empty field keeps the saved one.
	let {
		channel,
		kind,
		present,
		onsave,
		onclose
	}: {
		channel: ChannelView | null;
		kind: ChannelKind;
		/** Event names whose package is installed. */
		present: string[];
		onsave: (channel: Record<string, unknown>) => Promise<boolean>;
		onclose: () => void;
	} = $props();

	const info = $derived(channelKind(kind));
	const randomTopic = () =>
		`printlab-${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('')}`;
	const initial = () => {
		const c = channel as Record<string, unknown> | null;
		return {
			id:
				channel?.id ??
				(kind === 'desktop' ? 'desktop' : `${kind}-${crypto.randomUUID().slice(0, 8)}`),
			name: (c?.name as string) ?? '',
			enabled: (c?.enabled as boolean) ?? true,
			events:
				(c?.events as string[]) ?? NOTIFY_EVENTS.filter((e) => e.channelDefault).map((e) => e.name),
			quiet: {
				...((c?.quiet as { enabled: boolean; from: string; to: string }) ?? {
					enabled: false,
					from: '22:00',
					to: '07:00'
				})
			},
			snapshots: (c?.snapshots as boolean) ?? false,
			hmsSeverity: (c?.hmsSeverity as string) ?? 'serious',
			server: (c?.server as string) ?? DEFAULT_NTFY_SERVER,
			topic: (c?.topic as string) ?? (kind === 'ntfy' ? randomTopic() : ''),
			url: (c?.url as string) ?? '',
			chatId: (c?.chatId as string) ?? '',
			host: (c?.host as string) ?? '',
			port: (c?.port as number) ?? 587,
			security: (c?.security as string) ?? 'starttls',
			user: (c?.user as string) ?? '',
			from: (c?.from as string) ?? '',
			to: (c?.to as string) ?? '',
			secret: '',
			removeSecret: false
		};
	};
	let f = $state(initial());
	let busy = $state(false);
	let testing = $state(false);
	let result = $state<DeliveryResult | null>(null);

	const saved = (flag: string) => !!(channel as Record<string, unknown> | null)?.[flag];
	const SECRET: Partial<Record<ChannelKind, { field: string; flag: string; label: string }>> = {
		ntfy: { field: 'token', flag: 'hasToken', label: 'Access token (optional)' },
		webhook: { field: 'secret', flag: 'hasSecret', label: 'Signing secret (optional)' },
		discord: { field: 'url', flag: 'hasUrl', label: 'Webhook address' },
		telegram: { field: 'token', flag: 'hasToken', label: 'Bot token' },
		email: { field: 'password', flag: 'hasPassword', label: 'Password' }
	};
	const secret = $derived(SECRET[kind]);
	const optionalSecret = $derived(kind === 'ntfy' || kind === 'webhook' || kind === 'email');
	const SERVICE: Record<ChannelKind, string> = {
		desktop: '',
		ntfy: 'the ntfy server',
		webhook: 'the address you enter',
		discord: 'Discord',
		telegram: 'Telegram',
		email: 'your mail provider'
	};

	function body(): Record<string, unknown> {
		const out: Record<string, unknown> = {
			id: f.id,
			kind,
			name: f.name,
			enabled: f.enabled,
			events: f.events,
			quiet: f.quiet,
			snapshots: info.pictures && f.snapshots,
			hmsSeverity: f.hmsSeverity
		};
		if (kind === 'ntfy') Object.assign(out, { server: f.server, topic: f.topic });
		if (kind === 'webhook') out.url = f.url;
		if (kind === 'telegram') out.chatId = f.chatId;
		if (kind === 'email')
			Object.assign(out, {
				host: f.host,
				port: Number(f.port),
				security: f.security,
				user: f.user,
				from: f.from,
				to: f.to
			});
		if (secret) out[secret.field] = f.removeSecret ? null : f.secret;
		return out;
	}

	function toggle(name: string, on: boolean) {
		f.events = on ? [...new Set([...f.events, name])] : f.events.filter((e) => e !== name);
	}

	async function test() {
		testing = true;
		result = null;
		try {
			const r = await fetch('/api/notifications/test', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ channel: body() })
			});
			const data = await r.json();
			result = r.ok ? data.result : { at: '', ok: false, detail: data.error ?? 'The test failed.' };
		} catch {
			result = { at: '', ok: false, detail: 'Could not reach the app server.' };
		} finally {
			testing = false;
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		const ok = await onsave(body());
		busy = false;
		if (ok) onclose();
	}
</script>

<Modal id="channel-form" {onclose} {busy}>
	<form onsubmit={save}>
		<div class="dialog-top">
			<div>
				<div class="eyebrow">NOTIFICATIONS</div>
				<h2 id="channel-form-title">
					{channel ? `Edit ${channel.name || info.label}` : `Add ${info.label}`}
				</h2>
			</div>
		</div>

		{#if info.external}
			<p class="privacy">
				Messages go through {SERVICE[kind]}, outside your home: they name your printers and prints.
				{#if kind === 'ntfy'}The public server ntfy.sh lets anyone who knows the topic read it, so
					keep the random topic below secret.{/if}
			</p>
		{:else}
			<p class="privacy">
				Notifications from your computer's system tray. Nothing leaves this computer.
			</p>
		{/if}

		<label class="field"
			>Name<input bind:value={f.name} maxlength="60" placeholder={info.label} /></label
		>

		{#if kind === 'ntfy'}
			<div class="fields-row">
				<label class="field"
					>Server<input bind:value={f.server} required maxlength="500" /><small
						>Your own ntfy server, or the public ntfy.sh.</small
					></label
				>
				<label class="field"
					>Topic<input
						bind:value={f.topic}
						required
						maxlength="64"
						pattern={'[\\-_A-Za-z0-9]{1,64}'}
						autocomplete="off"
					/><small
						>Subscribe to it in the ntfy app. <button
							type="button"
							class="link"
							onclick={() => (f.topic = randomTopic())}>New random topic</button
						></small
					></label
				>
			</div>
		{:else if kind === 'webhook'}
			<label class="field"
				>Address<input
					bind:value={f.url}
					required
					maxlength="500"
					placeholder="https://example.com/hooks/print-lab"
				/><small
					>Gets a POST with JSON <code>{'{ event, at, data }'}</code>, signed in
					<code>X-PrintLab-Signature</code> when a secret is set.</small
				></label
			>
		{:else if kind === 'discord'}
			<p class="hint">
				In Discord: Server settings → Integrations → Webhooks → New webhook → Copy webhook URL.
			</p>
		{:else if kind === 'telegram'}
			<p class="hint">
				Ask @BotFather for a bot and its token, send your bot a message, then use your chat id (for
				example from @userinfobot).
			</p>
			<label class="field"
				>Chat id<input bind:value={f.chatId} required maxlength="70" autocomplete="off" /></label
			>
		{:else if kind === 'email'}
			<div class="fields-row">
				<label class="field"
					>Mail server<input
						bind:value={f.host}
						required
						maxlength="253"
						placeholder="smtp.example.com"
					/></label
				>
				<label class="field"
					>Port<input type="number" min="1" max="65535" bind:value={f.port} required /></label
				>
			</div>
			<label class="field"
				>Encryption<select bind:value={f.security}>
					<option value="starttls">STARTTLS (usually port 587)</option>
					<option value="tls">TLS (usually port 465)</option>
				</select></label
			>
			<div class="fields-row">
				<label class="field"
					>From<input type="email" bind:value={f.from} required maxlength="200" /></label
				>
				<label class="field"
					>To<input type="email" bind:value={f.to} required maxlength="200" /></label
				>
			</div>
			<label class="field"
				>User name<input bind:value={f.user} maxlength="200" autocomplete="off" /></label
			>
		{/if}

		{#if secret}
			<label class="field"
				>{secret.label}<input
					type="password"
					bind:value={f.secret}
					required={!optionalSecret && !saved(secret.flag)}
					maxlength="500"
					autocomplete="off"
					placeholder={saved(secret.flag) ? 'Leave empty to keep' : ''}
				/><small>It stays on this computer and is never shown again.</small></label
			>
			{#if optionalSecret && saved(secret.flag)}
				<label class="toggle"
					><input type="checkbox" bind:checked={f.removeSecret} /> Remove the saved {secret.label
						.replace(' (optional)', '')
						.toLowerCase()}</label
				>
			{/if}
		{/if}

		<fieldset>
			<legend>Tell me about</legend>
			<div class="events">
				{#each NOTIFY_EVENTS as e (e.name)}
					{#if present.includes(e.name)}
						<label class="toggle"
							><input
								type="checkbox"
								checked={f.events.includes(e.name)}
								onchange={(ev) => toggle(e.name, ev.currentTarget.checked)}
							/>
							{e.label}</label
						>
					{/if}
				{/each}
			</div>
			{#if f.events.includes('hms.raised')}
				<label class="field inline"
					>Printer alerts from<select bind:value={f.hmsSeverity}>
						{#each HMS_SEVERITIES as s (s)}<option value={s}
								>{s === 'fatal'
									? 'Fatal only'
									: s === 'serious'
										? 'Serious and worse'
										: s === 'common'
											? 'Common and worse'
											: 'Everything, even tips'}</option
							>{/each}
					</select></label
				>
			{/if}
		</fieldset>

		<fieldset>
			<legend>Quiet hours</legend>
			<label class="toggle"
				><input type="checkbox" bind:checked={f.quiet.enabled} /> Stay quiet at night</label
			>
			{#if f.quiet.enabled}
				<div class="quiet">
					<label class="field inline">From<input type="time" bind:value={f.quiet.from} /></label>
					<label class="field inline">to<input type="time" bind:value={f.quiet.to} /></label>
				</div>
				<small class="hint">Messages in quiet hours stay in the bell only.</small>
			{/if}
		</fieldset>

		{#if info.pictures}
			<label class="toggle"
				><input type="checkbox" bind:checked={f.snapshots} /> Add a picture from the printer's camera</label
			>
			{#if f.snapshots}
				<p class="privacy">
					Pictures show the inside of your home to {SERVICE[kind]}. Kids' prints get none unless
					"Include pictures of kids' prints" is on.
				</p>
			{/if}
		{/if}

		<label class="toggle"><input type="checkbox" bind:checked={f.enabled} /> Switched on</label>

		{#if result}
			<p class="result" class:bad={!result.ok} role="status">
				{result.ok ? '✓' : '✕'}
				{result.detail}
			</p>
		{/if}
		<div class="dialog-actions">
			<button type="button" class="secondary" disabled={testing} onclick={test}
				>{testing ? 'Sending…' : 'Send a test'}</button
			>
			<div>
				<button type="button" class="secondary" onclick={onclose}>Cancel</button>
				<button class="primary" disabled={busy}>{channel ? 'Save changes' : 'Add channel'}</button>
			</div>
		</div>
	</form>
</Modal>

<style>
	form {
		display: grid;
		gap: 10px;
	}
	.privacy,
	.hint {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}
	.privacy {
		padding: 8px 10px;
		border-radius: var(--r-md);
		background: rgb(var(--c4) / 0.1);
		box-shadow: inset 0 0 0 1px rgb(var(--c4) / 0.25);
	}
	fieldset {
		margin: 0;
		padding: 8px 10px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		display: grid;
		gap: 8px;
	}
	legend {
		font-size: 12px;
		color: var(--dim);
		padding: 0 4px;
	}
	.events {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
		gap: 6px 12px;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		color: var(--text-2);
	}
	.quiet {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}
	.field {
		margin-bottom: 0;
	}
	.field.inline {
		flex-direction: row;
		align-items: center;
		gap: 8px;
	}
	.field.inline select,
	.field.inline input {
		width: auto;
	}
	.link {
		border: 0;
		padding: 0;
		background: none;
		color: var(--cyan);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
	}
	.result {
		margin: 0;
		font-size: 13px;
		color: var(--lime);
	}
	.result.bad {
		color: var(--err-text);
	}
</style>
