<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { onNavigate } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { LabStore, UiState, setApp, syncThemeColor } from '$lib/client/app.svelte';
	import { jobMenu, modelMenu, openMenu, projectMenu } from '$lib/client/actions';
	import TopBar from '$lib/components/TopBar.svelte';
	import ProfileSelector from '$lib/components/ProfileSelector.svelte';
	import FloatingPanels from '$lib/components/FloatingPanels.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import Toasts from '$lib/components/Toasts.svelte';
	import Assistant from '$lib/components/Assistant.svelte';
	import ShortcutsDialog from '$lib/components/ShortcutsDialog.svelte';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import KidShell from '$lib/components/kid/KidShell.svelte';
	import { goto } from '$app/navigation';
	import { INTEGRATIONS_NAV, NAV } from '$lib/client/nav';

	let { data, children } = $props();
	const ui = new UiState();
	// The store is seeded once from the server render; afterwards it is kept current by live events.
	// svelte-ignore state_referenced_locally
	const lab = new LabStore(data, ui);
	const app = setApp({ lab, ui });

	onMount(() => {
		try {
			const saved = sessionStorage.getItem('print-lab-profile');
			if (data.kid) sessionStorage.removeItem('print-lab-profile');
			else if (saved === 'all' || lab.ws.profiles.some((p) => p.id === saved))
				ui.selectProfile(saved!);
		} catch {
			/* Start with the chooser when session storage is unavailable. */
		}
		ui.theme = document.documentElement.dataset.themeChoice ?? 'auto';
		syncThemeColor();
		lab.connect();
		if (!data.kid) void lab.loadIntegrations();
		document.documentElement.dataset.ready = '1'; // hydrated and interactive (used by end-to-end tests)
		const clock = setInterval(() => (ui.now = Date.now()), 15_000);
		const system = matchMedia('(prefers-color-scheme: light)');
		const follow = () => ui.theme === 'auto' && ui.setTheme('auto');
		system.addEventListener('change', follow);
		return () => {
			lab.disconnect();
			clearInterval(clock);
			system.removeEventListener('change', follow);
		};
	});

	let shortcutHandled = false;
	$effect(() => {
		if (ui.profileLocked) return;
		if (ui.profile !== 'all' && !lab.profile(ui.profile)) {
			ui.lockProfile();
			return;
		}
		try {
			sessionStorage.setItem('print-lab-profile', ui.profile);
		} catch {
			/* The selected profile still works without storage. */
		}
		// Defer home-screen shortcuts until a maker has been selected.
		if (!shortcutHandled && page.url.searchParams.get('new') === 'idea') {
			shortcutHandled = true;
			ui.openEditor('project');
			history.replaceState(history.state, '', page.url.pathname);
		}
	});

	// Grid <-> project page: cards morph into sidebar rows (shared view-transition names) and back.
	onNavigate((navigation) => {
		const from = navigation.from?.route.id,
			to = navigation.to?.route.id;
		const detail = '/projects/[id]';
		if (
			!document.startViewTransition ||
			matchMedia('(prefers-reduced-motion: reduce)').matches ||
			(from === to && from !== detail)
		)
			return;
		if (from !== detail && to !== detail) return;
		const mode = to === detail ? (from === detail ? 'swap' : 'open') : 'close';
		document.documentElement.dataset.transition = mode;
		return new Promise((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
			transition.finished.finally(() => delete document.documentElement.dataset.transition);
		});
	});

	function onContextMenu(e: MouseEvent) {
		// Android fires its own contextmenu on long press; let that one win over ours.
		if (e.isTrusted && press) {
			endPress();
			swallowClick = true;
			setTimeout(() => (swallowClick = false), 700);
		}
		const target = e.target as HTMLElement;
		if (target.closest('input, textarea, select, dialog, #assistant')) return;
		const modelEl = target.closest<HTMLElement>('[data-model]');
		const model = modelEl && lab.ws.models.find((m) => m.id === modelEl.dataset.model);
		if (model) {
			e.preventDefault();
			openMenu(
				app,
				model.name,
				modelMenu(app, model),
				e.clientX,
				e.clientY,
				target.closest<HTMLElement>('a, button')
			);
			return;
		}
		const projectEl = target.closest<HTMLElement>('[data-project]');
		const jobEl = target.closest<HTMLElement>('[data-job]');
		const job = jobEl && lab.ws.jobs.find((j) => j.id === jobEl.dataset.job);
		const project = !job && projectEl ? lab.project(projectEl.dataset.project) : undefined;
		if (!job && !project) return;
		e.preventDefault();
		const returnTo = target.closest<HTMLElement>('a, button') ?? null;
		if (job)
			openMenu(
				app,
				`${lab.project(job.projectId)?.title ?? 'Print job'} · ${job.revision || job.status}`,
				jobMenu(app, job),
				e.clientX,
				e.clientY,
				returnTo
			);
		else if (project)
			openMenu(app, project.title, projectMenu(app, project), e.clientX, e.clientY, returnTo);
	}

	// Touch has no right-click and iOS never fires contextmenu, so a long press opens the same menu.
	const PRESS_MS = 480;
	let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
	let swallowClick = false;
	function endPress() {
		if (press) clearTimeout(press.timer);
		press = null;
	}
	function onPointerDown(e: PointerEvent) {
		endPress();
		if (e.pointerType !== 'touch' || !e.isPrimary) return;
		const target = e.target as HTMLElement;
		if (!target.closest('[data-project], [data-job], [data-model]')) return;
		if (target.closest('input, textarea, select, canvas, dialog, #assistant')) return;
		const { clientX: x, clientY: y } = e;
		press = {
			x,
			y,
			timer: setTimeout(() => {
				press = null;
				swallowClick = true;
				setTimeout(() => (swallowClick = false), 700);
				navigator.vibrate?.(12);
				target.dispatchEvent(
					new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
				);
			}, PRESS_MS)
		};
	}
	function onPointerMove(e: PointerEvent) {
		if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) endPress();
	}
	function onClickCapture(e: MouseEvent) {
		// The finger lifting after a long press must not also follow the link underneath.
		if (!swallowClick) return;
		swallowClick = false;
		e.preventDefault();
		e.stopPropagation();
	}

	let goPending = false;
	let goTimer: ReturnType<typeof setTimeout> | undefined;

	function onKey(e: KeyboardEvent) {
		if (ui.profileLocked) return;
		const target = e.target as HTMLElement;
		const typing = !!target.closest('input, textarea, select, [contenteditable]');
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			ui.paletteOpen = true;
			return;
		}
		if (
			(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) &&
			target.closest('[data-project], [data-job], [data-model]')
		) {
			const r = target.getBoundingClientRect();
			e.preventDefault();
			target.dispatchEvent(
				new MouseEvent('contextmenu', {
					bubbles: true,
					cancelable: true,
					clientX: r.left + 12,
					clientY: r.bottom + 4
				})
			);
			return;
		}
		if (typing || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey)
			return;
		// "G then P/J/R/F/M/I" jumps to a section.
		if (goPending && e.key.length === 1) {
			goPending = false;
			const target = [...NAV, INTEGRATIONS_NAV].find((n) => n.key === e.key.toLowerCase());
			if (target) {
				e.preventDefault();
				// eslint-disable-next-line svelte/no-navigation-without-resolve -- NAV hrefs are built with resolve()
				void goto(target.href);
				return;
			}
		}
		if (e.key === 'g' || e.key === 'G') {
			goPending = true;
			clearTimeout(goTimer);
			goTimer = setTimeout(() => (goPending = false), 1200);
			return;
		}
		if (e.key === '?') {
			e.preventDefault();
			ui.shortcutsOpen = true;
			return;
		}
		if (e.key === '/') {
			const search = document.querySelector<HTMLInputElement>('.side-search input, .search input');
			if (search?.offsetParent) {
				e.preventDefault();
				search.focus();
				search.select();
			}
		}
		if (e.key === 'n') {
			e.preventDefault();
			const route = page.route.id ?? '/';
			if (route.startsWith('/projects/')) ui.openEditor('job', null, { projectId: page.params.id });
			else if (route === '/jobs' || route === '/printer') ui.openEditor('job');
			else if (route === '/filament') ui.openEditor('spool');
			else if (route === '/family') ui.openEditor('profile');
			else ui.openEditor('project');
		}
	}
</script>

<svelte:window onkeydown={onKey} />
<svelte:document
	onkeydown={(e) => {
		// Keep hidden workbench shortcuts inactive while the chooser is on screen.
		if (ui.profileLocked) e.stopPropagation();
	}}
	oncontextmenu={onContextMenu}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={endPress}
	onpointercancel={endPress}
	onclickcapture={onClickCapture}
/>

{#if data.kid}
	<KidShell kid={data.kid}>{@render children()}</KidShell>
	<Toasts />
{:else if ui.profileLocked}<ProfileSelector />{/if}
{#if ui.hasEntered && !data.kid}
	<div hidden={ui.profileLocked} inert={ui.profileLocked}>
		<a class="skip-link" href="#main">Skip to content</a>
		{#if navigating.to}<div class="route-progress" aria-hidden="true"></div>{/if}
		<TopBar />
		{#if !lab.online}<div class="offline-banner" role="status">
				Reconnecting to the app server…
			</div>{/if}
		<main id="main" tabindex="-1">
			{@render children()}
			<footer>
				<span>Made for your family, saved on this computer.</span><span
					>Ideas are starting points; choose a model before printing.</span
				>
			</footer>
		</main>
		<FloatingPanels />
		<ConfirmDialog />
		<CommandPalette />
		{#if ui.shortcutsOpen}<ShortcutsDialog onclose={() => (ui.shortcutsOpen = false)} />{/if}
		<ContextMenu />
		<Toasts />
		<Assistant />
		<BottomNav />
	</div>
{/if}
