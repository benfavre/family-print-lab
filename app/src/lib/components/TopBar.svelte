<script lang="ts">
	import IntegrationsPill from './IntegrationsPill.svelte';
	import ActivityTray from './ActivityTray.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { THEMES, useApp } from '$lib/client/app.svelte';
	import { actions } from '$lib/client/actions';
	import { NAV } from '$lib/client/nav';
	import Avatar from './Avatar.svelte';

	const app = useApp();
	const { lab, ui } = app;
	const act = actions(app);
	let moreOpen = $state(false);
	let importInput: HTMLInputElement;
	let scrolled = $state(false);

	const openJobs = $derived(
		lab.ws.jobs.filter((j) => j.status === 'Queued' || j.status === 'Printing').length
	);
	const printerDot = $derived(lab.printerActive ? 'p-live' : lab.printer.connected ? 'p-on' : '');
	const saveLabel = $derived(lab.saving ? 'Saving…' : '');

	function closeMenus(e: MouseEvent) {
		if (!(e.target as HTMLElement).closest('.more-picker')) moreOpen = false;
	}
	function menuKeys(e: KeyboardEvent) {
		const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button, a')];
		const at = items.indexOf(document.activeElement as HTMLElement);
		if (e.key === 'Escape') moreOpen = false;
		if (
			e.key === 'ArrowDown' ||
			e.key === 'ArrowUp' ||
			e.key === 'ArrowRight' ||
			e.key === 'ArrowLeft'
		) {
			e.preventDefault();
			const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
			items[(at + step + items.length) % items.length]?.focus();
		}
	}
	const focusFirst = (node: HTMLElement) => {
		node.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
	};
	const run = (fn: () => unknown) => () => {
		moreOpen = false;
		void fn();
	};
</script>

<svelte:window onclick={closeMenus} onscroll={() => (scrolled = scrollY > 4)} />

<header class="topbar" class:scrolled>
	<a class="brand" href={resolve('/')} aria-label="Family Print Lab home">
		<span class="brand-mark" aria-hidden="true"
			><span class="cube"><i></i><i></i><i></i></span></span
		>
		<span class="brand-text"><strong>Family Print Lab</strong></span>
	</a>
	<nav class="views" aria-label="Main navigation">
		<!-- eslint-disable svelte/no-navigation-without-resolve -- NAV hrefs are built with resolve() in nav.ts -->
		{#each NAV as item (item.href)}
			{@const active = item.match(page.url.pathname)}
			<a
				class="nav {item.href === resolve('/printer') ? printerDot : ''}"
				class:active
				href={item.href}
				aria-current={active ? 'page' : undefined}
				title="{item.label} (G then {item.key.toUpperCase()})"
			>
				<svg class="nav-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"
					><path
						d={item.icon}
						fill="none"
						stroke="currentColor"
						stroke-width="1.4"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				><span class="nav-label">{item.label}</span><span class="nav-dot" aria-hidden="true"
				></span>{#if item.href === resolve('/jobs') && openJobs}<span class="nav-count"
						>{openJobs}</span
					>{/if}
			</a>
		{/each}
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	</nav>
	<div class="topbar-actions">
		<span class="save-indicator" aria-live="polite">{lab.online ? saveLabel : 'Reconnecting…'}</span
		>
		<button
			class="search-button"
			title="Search and commands (Ctrl+K)"
			aria-label="Search and commands (Ctrl+K)"
			onclick={() => (ui.paletteOpen = true)}
		>
			<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
				><path
					d="M7 2.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9zM10.4 10.4l3.1 3.1"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
				/></svg
			><span class="search-label">Search or jump…</span><kbd>Ctrl K</kbd>
		</button>
		<!-- Everything the lab is doing and connected to, in one place. -->
		<div class="status-capsule" role="group" aria-label="Lab status">
			<ActivityTray />
			<span class="capsule-sep" aria-hidden="true"></span>
			<IntegrationsPill />
		</div>
		<label class="profile-switcher" title="Show one person's projects">
			<span id="active-profile-avatar" aria-hidden="true">
				{#if ui.profile === 'all'}<span class="avatar green">✳</span>{:else}<Avatar
						profile={lab.profile(ui.profile)}
					/>{/if}
			</span>
			<select
				aria-label="Show projects for"
				bind:value={ui.profile}
				onchange={() => {
					ui.status = 'All';
					ui.query = '';
					if (!page.url.pathname.startsWith('/jobs')) goto(resolve('/'));
				}}
			>
				<option value="all">Everyone</option>
				{#each lab.ws.profiles as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
			</select>
		</label>
		<div class="more-picker">
			<button
				class="icon-button"
				aria-haspopup="true"
				aria-expanded={moreOpen}
				aria-label="Menu: theme, integrations, backups"
				title="Theme, integrations, backups"
				onclick={() => (moreOpen = !moreOpen)}
				><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
					><path
						d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
					/></svg
				></button
			>
			{#if moreOpen}
				<div
					class="popover more-menu"
					role="menu"
					aria-label="Menu"
					tabindex="-1"
					onkeydown={menuKeys}
					use:focusFirst
				>
					<div class="menu-section">Theme</div>
					<div class="theme-row" role="group" aria-label="Color theme">
						{#each THEMES as [id, name, hint] (id)}
							<button
								role="menuitemradio"
								class="theme-chip"
								aria-checked={ui.theme === id}
								title="{name} — {hint}"
								aria-label="{name} theme"
								onclick={() => ui.setTheme(id)}
								><span class="theme-swatch sw-{id}" aria-hidden="true"></span><small>{name}</small
								></button
							>
						{/each}
					</div>
					<div class="menu-sep" role="separator"></div>
					<button role="menuitem" onclick={run(() => goto(resolve('/integrations')))}
						><span aria-hidden="true">⚙</span>Integrations<kbd>G I</kbd></button
					>
					<button role="menuitem" onclick={run(() => (ui.shortcutsOpen = true))}
						><span aria-hidden="true">⌨</span>Keyboard shortcuts<kbd>?</kbd></button
					>
					<div class="menu-sep" role="separator"></div>
					<div class="menu-section">Data</div>
					<button role="menuitem" onclick={run(() => act.exportBackup())}
						><span aria-hidden="true">⤓</span>Export backup (JSON)</button
					>
					<button role="menuitem" onclick={run(() => importInput.click())}
						><span aria-hidden="true">⤒</span>Import backup…</button
					>
					<button role="menuitem" onclick={run(() => act.snapshotNow())}
						><span aria-hidden="true">⛁</span>Save database snapshot</button
					>
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() plus a hash -->
					<button role="menuitem" onclick={run(() => goto(`${resolve('/integrations')}#backups`))}
						><span aria-hidden="true">↺</span>Backups and restore…</button
					>
				</div>
			{/if}
			<input
				bind:this={importInput}
				type="file"
				accept="application/json,.json"
				hidden
				onchange={(e) => {
					const input = e.currentTarget;
					const file = input.files?.[0];
					input.value = '';
					if (file) act.importBackup(file);
				}}
			/>
		</div>
	</div>
</header>
