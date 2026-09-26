<script lang="ts">
	import { useApp } from '$lib/client/app.svelte';
	import { thumbZoom } from '$lib/client/kid';
	import { projectHref } from '$lib/client/actions';
	import { fileUrl, modelHref } from '$lib/client/models';
	import { plaGrams, smallPartsHazard } from '$lib/shared/kid';
	import type { PrintRequest } from '$lib/shared/domain';
	import Avatar from './Avatar.svelte';

	const { lab, ui } = useApp();
	const cloud = $derived(lab.cloud);
	const kids = $derived(lab.ws.profiles.filter((p) => p.kid));
	const waiting = $derived(lab.ws.printRequests.filter((r) => r.status === 'Waiting'));
	const answered = $derived(lab.ws.printRequests.filter((r) => r.status !== 'Waiting').slice(0, 5));

	let pinFormOpen = $state(false);
	let pin = $state('');
	let confirm = $state('');
	let current = $state('');
	let pinError = $state('');
	let replies = $state<Record<string, string>>({});

	async function savePin(e: SubmitEvent) {
		e.preventDefault();
		pinError = '';
		if (!/^\d{4,8}$/.test(pin)) return (pinError = 'Use 4 to 8 digits.');
		if (pin !== confirm) return (pinError = 'The two PINs are different.');
		const ok = await lab.call(
			'POST',
			'/api/parent/pin',
			lab.ws.parentPin ? { pin, current } : { pin },
			lab.ws.parentPin ? 'Parent PIN changed.' : 'Parent PIN set. You can turn on kid mode now.'
		);
		if (ok) {
			pin = confirm = current = '';
			pinFormOpen = false;
		}
	}

	function details(r: PrintRequest) {
		const project = lab.project(r.projectId);
		const model = lab.ws.models.find((m) => m.versions.some((v) => v.id === r.modelVersionId));
		const version = model?.versions.find((v) => v.id === r.modelVersionId);
		return {
			project,
			kid: lab.profile(r.profileId),
			model,
			version,
			spool: r.spoolId ? lab.spools.get(r.spoolId) : undefined,
			small: version ? smallPartsHazard([version.sizeX, version.sizeY, version.sizeZ]) : false
		};
	}

	async function unlinkCloud() {
		if (
			await ui.ask(
				'Unlink from Print Lab Cloud?',
				'Requests will no longer reach your phone. You can link again at any time.',
				'Unlink'
			)
		)
			await lab.call('POST', '/api/cloud/unlink', {}, 'Unlinked from Print Lab Cloud.');
	}

	async function decide(r: PrintRequest, decision: 'approve' | 'decline') {
		const name = lab.profile(r.profileId)?.name ?? 'They';
		await lab.call(
			'POST',
			`/api/requests/${r.id}`,
			{ decision, reply: replies[r.id] ?? '', version: r.version },
			decision === 'approve'
				? `Queued. ${name} will see “Yes! It’s coming soon”.`
				: `${name} will see your answer.`
		);
	}
</script>

<section class="kid-mode" id="kid-mode" aria-labelledby="kid-mode-title">
	<div class="kid-mode-head">
		<div>
			<h2 id="kid-mode-title">Kid mode</h2>
			<p>
				A simpler space with big buttons and safe templates. Kids design, then ask; nothing prints
				without a grown-up’s yes. Start it on a tablet by tapping the child’s profile in the profile
				picker.
			</p>
		</div>
		{#if lab.ws.parentPin && !pinFormOpen}
			<button class="ghost-button" onclick={() => (pinFormOpen = true)}>Change parent PIN</button>
		{/if}
	</div>

	{#if !lab.ws.parentPin || pinFormOpen}
		<form class="pin-form" onsubmit={savePin}>
			<p class="pin-why">
				{lab.ws.parentPin
					? 'Enter the current PIN, then the new one.'
					: 'First, choose a parent PIN (4 to 8 digits). It is needed to leave kid mode.'}
			</p>
			{#if lab.ws.parentPin}
				<label class="field"
					>Current PIN<input
						type="password"
						inputmode="numeric"
						autocomplete="off"
						maxlength="8"
						bind:value={current}
					/></label
				>
			{/if}
			<label class="field"
				>{lab.ws.parentPin ? 'New PIN' : 'Parent PIN'}<input
					type="password"
					inputmode="numeric"
					autocomplete="new-password"
					maxlength="8"
					bind:value={pin}
				/></label
			>
			<label class="field"
				>Type it again<input
					type="password"
					inputmode="numeric"
					autocomplete="new-password"
					maxlength="8"
					bind:value={confirm}
				/></label
			>
			<div class="pin-actions">
				<button class="primary">{lab.ws.parentPin ? 'Change PIN' : 'Set PIN'}</button>
				{#if pinFormOpen}<button
						type="button"
						class="ghost-button"
						onclick={() => {
							pinFormOpen = false;
							pinError = '';
						}}>Cancel</button
					>{/if}
				<span class="pin-error" role="alert">{pinError}</span>
			</div>
		</form>
	{:else if !kids.length}
		<p class="hint">
			Parent PIN is set. Edit a child’s profile (✎ on their card) and choose a kid mode level.
		</p>
	{/if}

	{#if cloud.configured && lab.ws.parentPin}
		<div class="phone" aria-live="polite">
			<h3>Answer from your phone</h3>
			{#if cloud.state === 'unlinked'}
				<p class="hint">
					Link this computer to Print Lab Cloud to get kids’ requests on your phone and answer from
					anywhere (Family plan). Only the requests are shared; see what exactly before you confirm.
				</p>
				<button class="ghost-button" onclick={() => lab.call('POST', '/api/cloud/link', {})}
					>Link to Print Lab Cloud</button
				>
			{:else if cloud.state === 'pairing' && cloud.pairing}
				<p class="hint">
					On your phone, open
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the cloud's own site, not an app route -->
					<a href={cloud.pairing.verifyUrl} target="_blank" rel="noopener"
						>{cloud.pairing.verifyUrl.replace(/^https?:\/\//, '')}</a
					>, sign in, and enter this code:
				</p>
				<p class="code" data-testid="cloud-code">{cloud.pairing.userCode}</p>
				<p class="hint">
					Waiting for it… The code works until {new Date(
						cloud.pairing.expiresAt
					).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
					<button class="link-button" onclick={() => lab.call('POST', '/api/cloud/cancel', {})}
						>Cancel</button
					>
				</p>
			{:else}
				<p class="linked">
					<span class="dot {cloud.state}" aria-hidden="true"></span>
					{cloud.state === 'online'
						? 'Online'
						: cloud.state === 'connecting'
							? 'Connecting…'
							: 'Offline, retrying'} · linked to <strong>{cloud.account}</strong>
				</p>
				{#if cloud.state === 'online' && !cloud.plan}
					<p class="warn">
						Answering from the phone needs the Family plan. Requests still show up there.
					</p>
				{/if}
				<label class="share"
					><input
						type="checkbox"
						checked={cloud.shareNames}
						onchange={(e) =>
							lab.call('PATCH', '/api/cloud', { shareNames: e.currentTarget.checked })}
					/> Send kids’ first names with their requests (otherwise “Your child”)</label
				>
				<label class="share"
					><input
						type="checkbox"
						checked={cloud.shareProgress}
						onchange={(e) =>
							lab.call('PATCH', '/api/cloud', { shareProgress: e.currentTarget.checked })}
					/> Share print progress (what is printing, how far along, time left) so the phone can follow
					it and say when it is done</label
				>
				<button class="link-button" onclick={unlinkCloud}>Unlink</button>
			{/if}
			{#if cloud.error}<p class="pin-error" role="alert">{cloud.error}</p>{/if}
		</div>
	{/if}

	<div id="requests">
		<h3>
			Print requests {#if waiting.length}<span class="request-count">{waiting.length}</span>{/if}
		</h3>
		{#if waiting.length}
			<ul class="requests">
				{#each waiting as r (r.id)}
					{@const d = details(r)}
					<li class="request">
						<a
							class="request-picture"
							href={d.model && d.project ? modelHref(d.project.id, d.model.id) : undefined}
							title="Open in the workbench"
						>
							{#if d.model && d.version?.hasThumbnail}
								<img
									src={fileUrl(d.model.id, d.version.id, 'thumbnail.webp')}
									alt=""
									style:transform="scale({thumbZoom(d.version)})"
								/>
							{:else}<span aria-hidden="true">✨</span>{/if}
						</a>
						<div class="request-body">
							<p class="who">
								<Avatar profile={d.kid} />
								<span
									><strong>{d.kid?.name ?? 'A kid'}</strong> wants to print
									<a href={d.project ? projectHref(d.project.id) : undefined}
										>{d.project?.title ?? 'something'}</a
									></span
								>
							</p>
							{#if r.message}<p class="message">“{r.message}”</p>{/if}
							<p class="request-facts">
								{#if d.version}{Math.round(d.version.sizeX)} × {Math.round(d.version.sizeY)} × {Math.round(
										d.version.sizeZ
									)} mm · about {plaGrams(d.version.volume)} g solid{/if}
								{#if d.spool}· <span class="request-swatch" style:background={d.spool.colorHex}
									></span>
									{d.spool.colorName || d.spool.material}{/if}
							</p>
							{#if d.small}<p class="warn">Small part: keep it away from children under 3.</p>{/if}
							<input
								class="reply"
								placeholder="Answer (optional), e.g. “Tonight after dinner!”"
								maxlength="300"
								aria-label="Answer to {d.kid?.name ?? 'the kid'}"
								bind:value={replies[r.id]}
							/>
							<div class="request-actions">
								<button class="primary" onclick={() => decide(r, 'approve')}>Yes, queue it</button>
								<button class="ghost-button" onclick={() => decide(r, 'decline')}
									>Not this time</button
								>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="hint">No requests waiting.</p>
		{/if}
		{#if answered.length}
			<details class="answered">
				<summary>Recently answered</summary>
				<ul>
					{#each answered as r (r.id)}
						{@const d = details(r)}
						<li>
							{r.status === 'Approved' ? '👍' : '💬'}
							{d.kid?.name ?? 'A kid'} · {d.project?.title ?? 'something'} · {r.status ===
							'Approved'
								? 'queued'
								: 'not this time'}{#if r.reply}: “{r.reply}”{/if}
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</div>
</section>

<style>
	.kid-mode {
		display: grid;
		gap: 16px;
		margin: 0 0 22px;
		padding: 20px 22px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--panel);
	}
	.kid-mode-head {
		display: flex;
		gap: 16px;
		align-items: flex-start;
		justify-content: space-between;
	}
	h2 {
		margin: 0 0 4px;
		font-size: 18px;
	}
	h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 10px;
		font-size: 15px;
	}
	.kid-mode-head p,
	.hint,
	.pin-why {
		margin: 0;
		max-width: 70ch;
		color: var(--muted);
	}
	.request-count {
		padding: 1px 8px;
		border-radius: 999px;
		color: var(--on-accent);
		background: var(--amber);
		font-size: 12px;
	}
	.pin-form {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 12px;
		align-items: end;
	}
	.pin-why,
	.pin-actions {
		grid-column: 1 / -1;
	}
	.pin-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.pin-error {
		color: var(--err-text);
	}
	.requests {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.request {
		display: grid;
		grid-template-columns: 132px minmax(0, 1fr);
		gap: 16px;
		padding: 12px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--panel-strong);
	}
	.request-picture {
		display: grid;
		place-items: center;
		aspect-ratio: 4 / 3;
		border-radius: 10px;
		background: rgb(var(--hi) / 0.04);
		font-size: 36px;
		overflow: hidden;
	}
	.request-picture img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		transform-origin: 50% 52%;
	}
	.request-body {
		display: grid;
		gap: 6px;
		align-content: start;
	}
	.request-body p {
		margin: 0;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.who a {
		color: var(--text);
	}
	.message {
		font-size: 15px;
	}
	.request-facts {
		color: var(--muted);
		font-size: 13px;
	}
	.request-swatch {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		vertical-align: -1px;
	}
	.warn {
		color: var(--amber);
		font-size: 13px;
	}
	.reply {
		width: 100%;
		max-width: 480px;
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid var(--line-strong);
		border-radius: 10px;
		color: var(--text);
		background: rgb(var(--base));
		font: inherit;
	}
	.request-actions {
		display: flex;
		gap: 8px;
		margin-top: 4px;
	}
	.answered {
		margin-top: 10px;
		color: var(--muted);
	}
	.answered ul {
		margin: 8px 0 0;
		padding-left: 18px;
	}
	@media (max-width: 560px) {
		.kid-mode-head {
			flex-direction: column;
		}
		.request {
			grid-template-columns: 1fr;
		}
	}
	.phone {
		display: grid;
		gap: 8px;
		justify-items: start;
		padding: 14px 16px;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--panel-strong);
	}
	.phone h3,
	.phone p {
		margin: 0;
	}
	.code {
		font: 700 28px var(--mono);
		letter-spacing: 0.12em;
	}
	.linked {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.phone .dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--muted);
	}
	.phone .dot.online {
		background: var(--lime);
	}
	.phone .dot.offline {
		background: var(--red);
	}
	.share {
		display: flex;
		gap: 8px;
		align-items: center;
		color: var(--text-2);
	}
	.link-button {
		padding: 0;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
