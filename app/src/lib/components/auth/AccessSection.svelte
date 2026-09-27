<script lang="ts">
	import { onMount } from 'svelte';
	import { useApp } from '$lib/client/app.svelte';
	import { stamp } from '$lib/client/format';
	import {
		deviceName,
		PASSWORD_MIN,
		PIN_PATTERN,
		type AuthSessionInfo,
		type AuthStatus
	} from '$lib/shared/lan-auth';
	import Avatar from '../Avatar.svelte';

	const { lab, ui } = useApp();
	let auth = $state<AuthStatus | null>(null);
	let working = $state<string | null>(null);

	// Password form (set, or change with the current one).
	let pwOpen = $state(false);
	let password = $state('');
	let confirm = $state('');
	let current = $state('');
	let pwError = $state('');
	// "Require login here too" and "Turn off" ask for the current password first.
	let confirming = $state<'require-on' | 'require-off' | 'off' | null>(null);
	let confirmPassword = $state('');
	// One profile's PIN being set.
	let pinFor = $state<string | null>(null);
	let pin = $state('');

	const on = $derived(!!auth && auth.mode !== 'off');
	const profiles = $derived(lab.ws.profiles);

	async function load() {
		auth = await lab.call<AuthStatus>('GET', '/api/auth');
	}
	onMount(load);

	async function run(key: string, method: string, path: string, body: unknown, done?: string) {
		working = key;
		const res = await lab.call<{ auth: AuthStatus }>(method, path, body, done);
		working = null;
		if (res?.auth) auth = res.auth;
		return !!res;
	}

	async function savePassword(e: SubmitEvent) {
		e.preventDefault();
		pwError = '';
		if (password.length < PASSWORD_MIN)
			return (pwError = `Use at least ${PASSWORD_MIN} characters.`);
		if (password !== confirm) return (pwError = 'The two passwords are different.');
		const first = !on;
		const ok = await run(
			'password',
			'PUT',
			'/api/auth/password',
			first ? { password } : { password, current },
			first
				? 'Household password set. Other devices can log in now.'
				: 'Password changed. Other devices need to log in again.'
		);
		if (ok) {
			password = confirm = current = '';
			pwOpen = false;
		}
	}

	async function confirmChange(e: SubmitEvent) {
		e.preventDefault();
		const body = { current: confirmPassword };
		const ok =
			confirming === 'off'
				? await run(
						'off',
						'DELETE',
						'/api/auth/password',
						body,
						'Only this computer can open Print Lab now.'
					)
				: await run(
						'require',
						'PATCH',
						'/api/auth/settings',
						{ ...body, requireLocal: confirming === 'require-on' },
						confirming === 'require-on'
							? 'This computer asks for a login too now.'
							: 'This computer opens without a login again.'
					);
		if (ok) {
			confirming = null;
			confirmPassword = '';
		}
	}

	async function savePin(e: SubmitEvent, profileId: string) {
		e.preventDefault();
		if (!PIN_PATTERN.test(pin)) return ui.toast('Use 4 to 8 digits.', 'error');
		if (await run('pin', 'PUT', `/api/auth/pins/${profileId}`, { pin }, 'PIN saved.')) {
			pinFor = null;
			pin = '';
		}
	}

	async function removePin(profileId: string) {
		const name = lab.profile(profileId)?.name ?? 'This profile';
		if (
			await ui.ask(
				`Remove ${name}’s PIN?`,
				`${name} will need the household password on other devices.`,
				'Remove'
			)
		)
			await run('pin', 'DELETE', `/api/auth/pins/${profileId}`, undefined, 'PIN removed.');
	}

	async function logoutDevice(s: AuthSessionInfo) {
		await run(
			s.id,
			'DELETE',
			`/api/auth/sessions/${s.id}`,
			undefined,
			s.current ? 'Logged out on this device.' : 'That device is logged out.'
		);
		if (s.current && !(auth?.local && !auth.requireLocal)) location.assign('/login');
	}

	async function logoutEverywhere() {
		if (
			!(await ui.ask(
				'Log out every device?',
				'Every phone, tablet and computer that logged in needs the password or a PIN again, this one included.',
				'Log out all'
			))
		)
			return;
		const ok = await lab.call(
			'POST',
			'/api/auth/logout',
			{ everywhere: true },
			'Every device is logged out.'
		);
		if (!ok) return;
		if (auth?.local && !auth.requireLocal) await load();
		else location.assign('/login');
	}

	function who(s: AuthSessionInfo) {
		return s.profileId ? (lab.profile(s.profileId)?.name ?? 'A profile') : 'Household password';
	}
</script>

<section class="int-section" id="access" aria-labelledby="access-title">
	<div class="section-head">
		<h2 id="access-title">Access from other devices</h2>
		{#if auth}
			<span class="state" class:on
				>{auth.mode === 'off'
					? 'Only this computer'
					: auth.mode === 'profiles'
						? 'On · password or PIN'
						: 'On · password'}</span
			>
		{/if}
	</div>
	<p class="section-lead">
		Open Print Lab from phones, tablets and other computers at home. Other devices always log in;
		this computer does not, unless you ask it to. The app also has to listen on your home network:
		set
		<code>HOST</code> and <code>ALLOWED_HOSTS</code> in the settings file (see
		<code>.env.example</code>).
	</p>

	{#if !auth}
		<p class="panel-empty">Loading…</p>
	{:else}
		{#if auth.exposedBy && !on}
			<p class="warn" role="alert">
				Print Lab is set up for other devices (<code>{auth.exposedBy}</code>). They see “Set a
				password on the computer first” until you choose one below.
			</p>
		{/if}

		{#if !auth.canManage}
			<p class="hint">Log in with the household password to change these settings.</p>
		{:else}
			{#if !on || pwOpen}
				<form class="ac-form" onsubmit={savePassword}>
					<p class="ac-why">
						{on
							? 'Enter the current password, then the new one. Other devices will need to log in again.'
							: `Choose a household password (at least ${PASSWORD_MIN} characters) that grown-ups type on other devices.`}
					</p>
					{#if on}
						<label class="field"
							>Current password<input
								type="password"
								autocomplete="current-password"
								bind:value={current}
							/></label
						>
					{/if}
					<label class="field"
						>{on ? 'New password' : 'Household password'}<input
							type="password"
							autocomplete="new-password"
							maxlength="200"
							bind:value={password}
						/></label
					>
					<label class="field"
						>Type it again<input
							type="password"
							autocomplete="new-password"
							maxlength="200"
							bind:value={confirm}
						/></label
					>
					<div class="ac-actions">
						<button class="primary" disabled={working === 'password'}
							>{on ? 'Change password' : 'Set password'}</button
						>
						{#if pwOpen}<button
								type="button"
								class="ghost-button"
								onclick={() => {
									pwOpen = false;
									pwError = '';
								}}>Cancel</button
							>{/if}
						<span class="bad" role="alert">{pwError}</span>
					</div>
				</form>
			{/if}

			{#if on}
				<div class="ac-options">
					<fieldset>
						<legend>Other devices log in with</legend>
						<label
							><input
								type="radio"
								name="ac-mode"
								checked={auth.mode === 'password'}
								disabled={!!working}
								onchange={() => run('mode', 'PATCH', '/api/auth/settings', { profilePins: false })}
							/> The household password</label
						>
						<label
							><input
								type="radio"
								name="ac-mode"
								checked={auth.mode === 'profiles'}
								disabled={!!working}
								onchange={() => run('mode', 'PATCH', '/api/auth/settings', { profilePins: true })}
							/> The password, or each person’s own PIN (a kid’s PIN opens kid mode)</label
						>
					</fieldset>
					<label class="ac-check"
						><input
							type="checkbox"
							checked={auth.requireLocal}
							disabled={!!working}
							onclick={(e) => {
								e.preventDefault();
								confirming = auth?.requireLocal ? 'require-off' : 'require-on';
							}}
						/> Require login here too (on this computer)</label
					>
					<div class="ac-actions">
						{#if !pwOpen}<button class="mini" onclick={() => (pwOpen = true)}
								>Change password</button
							>{/if}
						{#if auth.local}<button class="mini danger-mini" onclick={() => (confirming = 'off')}
								>Turn off</button
							>{/if}
					</div>
				</div>

				{#if confirming}
					<form class="ac-confirm" onsubmit={confirmChange}>
						<label class="field"
							>{confirming === 'off'
								? 'Current password, to turn off access from other devices'
								: confirming === 'require-on'
									? 'Current password, so you can still get in on this computer'
									: 'Current password, to open this computer without a login'}<input
								type="password"
								autocomplete="current-password"
								bind:value={confirmPassword}
							/></label
						>
						<div class="ac-actions">
							<button class={confirming === 'off' ? 'danger-solid' : 'primary'} disabled={!!working}
								>{confirming === 'off' ? 'Turn off' : 'Confirm'}</button
							>
							<button
								type="button"
								class="ghost-button"
								onclick={() => {
									confirming = null;
									confirmPassword = '';
								}}>Cancel</button
							>
						</div>
					</form>
				{/if}

				{#if auth.mode === 'profiles'}
					<h3>PINs</h3>
					<p class="hint">
						4 to 8 digits, different for everyone. A kid’s PIN opens kid mode; leaving it still
						needs the parent PIN.
					</p>
					<ul class="ac-list" aria-label="Profile PINs">
						{#each profiles as p (p.id)}
							{@const has = auth.pins.includes(p.id)}
							<li>
								<Avatar profile={p} />
								<span class="ac-who"
									><b>{p.name}</b><small
										>{p.kid ? 'Kid mode · ' : ''}{has ? 'PIN set' : 'No PIN'}</small
									></span
								>
								{#if pinFor === p.id}
									<form class="ac-pin" onsubmit={(e) => savePin(e, p.id)}>
										<input
											type="password"
											inputmode="numeric"
											autocomplete="off"
											maxlength="8"
											aria-label="New PIN for {p.name}"
											bind:value={pin}
										/>
										<button class="mini primary-mini" disabled={working === 'pin'}>Save</button>
										<button type="button" class="mini" onclick={() => (pinFor = null)}
											>Cancel</button
										>
									</form>
								{:else}
									<span class="ac-acts">
										<button
											class="mini"
											onclick={() => {
												pinFor = p.id;
												pin = '';
											}}>{has ? 'Change PIN' : 'Set PIN'}</button
										>
										{#if has}<button class="mini danger-mini" onclick={() => removePin(p.id)}
												>Remove</button
											>{/if}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}

				<h3>Signed-in devices</h3>
				{#if auth.sessions.length}
					<ul class="ac-list" aria-label="Signed-in devices">
						{#each auth.sessions as s (s.id)}
							<li>
								<span class="ac-who"
									><b
										>{deviceName(s.userAgent)}{#if s.current}<small class="this">this device</small
											>{/if}</b
									><small
										>{who(s)} · {s.ip || 'unknown address'} · last seen {stamp(s.lastSeenAt)}</small
									></span
								>
								<button
									class="mini"
									disabled={working === s.id}
									onclick={() => logoutDevice(s)}
									aria-label="Log out {deviceName(s.userAgent)}">Log out</button
								>
							</li>
						{/each}
					</ul>
					<div class="ac-actions">
						<button class="mini danger-mini" onclick={logoutEverywhere}>Log out all devices</button>
					</div>
				{:else}
					<p class="hint">No device has logged in yet.</p>
				{/if}
			{/if}
		{/if}
	{/if}
</section>

<style>
	.int-section {
		margin-bottom: 26px;
		scroll-margin-top: 80px;
	}
	.section-head {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	h2 {
		font-size: 15px;
		margin: 0 0 4px;
	}
	h3 {
		font-size: 14px;
		margin: 18px 0 6px;
	}
	.section-lead {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
		max-width: 90ch;
	}
	code {
		font-size: 12px;
	}
	.state {
		font-size: 11.5px;
		padding: 2px 9px;
		border-radius: 999px;
		color: var(--muted);
		box-shadow: 0 0 0 1px var(--line-strong) inset;
	}
	.state.on {
		color: var(--lime);
		box-shadow: 0 0 0 1px rgb(var(--c3) / 0.4) inset;
	}
	.warn {
		margin: 0 0 12px;
		color: var(--amber);
		font-size: 13px;
		max-width: 90ch;
	}
	.hint {
		font-size: 12.5px;
		color: var(--dim);
		margin: 0 0 8px;
		max-width: 90ch;
	}
	.bad {
		color: var(--err-text);
		font-size: 13px;
	}
	.ac-form,
	.ac-confirm {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 0 12px;
		align-items: end;
		max-width: 760px;
	}
	.ac-why,
	.ac-form .ac-actions,
	.ac-confirm .ac-actions {
		grid-column: 1 / -1;
	}
	.ac-why {
		margin: 0 0 10px;
		font-size: 13px;
		color: var(--muted);
	}
	.ac-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin: 4px 0 8px;
	}
	.ac-options {
		display: grid;
		gap: 10px;
		max-width: 760px;
	}
	fieldset {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 6px;
		font-size: 12.5px;
		font-weight: 500;
		color: var(--muted);
	}
	fieldset label,
	.ac-check {
		display: flex;
		gap: 8px;
		align-items: center;
		color: var(--text-2);
		font-size: 13px;
	}
	.ac-list {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
		display: grid;
		gap: 8px;
		max-width: 760px;
	}
	.ac-list li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border-radius: var(--r-md);
		border: 1px solid var(--line);
		background: var(--panel);
		flex-wrap: wrap;
	}
	.ac-who {
		flex: 1;
		min-width: 160px;
		display: grid;
		gap: 2px;
	}
	.ac-who small {
		color: var(--muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.ac-who .this {
		display: inline;
		margin-left: 8px;
		color: var(--cyan);
	}
	.ac-acts,
	.ac-pin {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.ac-pin input {
		width: 110px;
		padding: 5px 9px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-md);
		background: rgb(var(--hi) / 0.03);
		color: var(--text);
		font: inherit;
	}
</style>
