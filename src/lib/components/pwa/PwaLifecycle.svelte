<script lang="ts">
	import { Download, RefreshCw, Share, WifiOff, X } from 'lucide-svelte';
	import { onMount } from 'svelte';
	import { isIosSafari, isStandalone } from '$lib/utils/pwa';

	let online = $state(true);
	let reconnecting = $state(false);
	let showInstallCoach = $state(false);
	let updateReady = $state(false);
	let waitingWorker = $state<ServiceWorker | null>(null);
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	function dismissInstallCoach() {
		showInstallCoach = false;
		localStorage.setItem('nightChronicleInstallCoachDismissed', 'true');
	}

	function reloadUpdate() {
		if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' });
		else location.reload();
	}

	onMount(() => {
		online = navigator.onLine;
		const displayStandalone = matchMedia('(display-mode: standalone)').matches;
		const navigatorStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
		showInstallCoach = isIosSafari(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)
			&& !isStandalone(displayStandalone, navigatorStandalone)
			&& localStorage.getItem('nightChronicleInstallCoachDismissed') !== 'true';

		const handleOffline = () => { online = false; reconnecting = false; };
		const handleOnline = () => {
			online = true;
			reconnecting = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = setTimeout(() => reconnecting = false, 2500);
		};
		addEventListener('offline', handleOffline);
		addEventListener('online', handleOnline);

		const inspectRegistration = (registration: ServiceWorkerRegistration) => {
			if (registration.waiting) {
				waitingWorker = registration.waiting;
				updateReady = true;
			}
			registration.addEventListener('updatefound', () => {
				const installing = registration.installing;
				installing?.addEventListener('statechange', () => {
					if (installing.state === 'installed' && navigator.serviceWorker.controller) {
						waitingWorker = registration.waiting ?? installing;
						updateReady = true;
					}
				});
			});
		};

		let handleControllerChange: (() => void) | null = null;
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.ready.then(inspectRegistration);
			let refreshing = false;
			handleControllerChange = () => {
				if (!refreshing) { refreshing = true; location.reload(); }
			};
			navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
		}

		return () => {
			removeEventListener('offline', handleOffline);
			removeEventListener('online', handleOnline);
			if (handleControllerChange) navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
			if (reconnectTimer) clearTimeout(reconnectTimer);
		};
	});
</script>

{#if !online || reconnecting}
	<div class="fixed inset-x-3 top-[max(env(safe-area-inset-top),12px)] z-[80] mx-auto flex min-h-11 max-w-md items-center gap-2 rounded-xl border border-white/10 bg-[#1c1c21]/95 px-3 py-2 text-xs shadow-xl backdrop-blur-xl" role="status">
		{#if online}<RefreshCw class="h-4 w-4 animate-spin text-[var(--text-accent)]" />{:else}<WifiOff class="h-4 w-4 text-[var(--color-crimson-400)]" />{/if}
		<span class="text-[var(--text-secondary)]">{online ? 'Reconnecting to the chronicle…' : 'Offline — reading and drafts remain available; turns are disabled.'}</span>
	</div>
{/if}

{#if showInstallCoach}
	<aside class="fixed inset-x-3 bottom-[max(env(safe-area-inset-bottom),12px)] z-[70] mx-auto max-w-md rounded-2xl border border-white/10 bg-[#1c1c21]/95 p-4 shadow-2xl backdrop-blur-xl" aria-label="Install MythEngine">
		<div class="flex items-start gap-3">
			<div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--text-accent)]/12 text-[var(--text-accent)]"><Download class="h-5 w-5" /></div>
			<div class="min-w-0 flex-1">
				<p class="font-semibold text-[var(--text-primary)]">Keep the chronicle on your Home Screen</p>
				<p class="mt-1 text-sm leading-relaxed text-[var(--text-secondary)]">Tap <Share class="mx-0.5 inline h-4 w-4" /> Share, then <strong>Add to Home Screen</strong>.</p>
			</div>
			<button onclick={dismissInstallCoach} class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)]" aria-label="Dismiss install instructions"><X class="h-5 w-5" /></button>
		</div>
	</aside>
{/if}

{#if updateReady}
	<div class="fixed inset-x-3 bottom-[max(env(safe-area-inset-bottom),12px)] z-[90] mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-white/10 bg-[#1c1c21]/95 p-3 shadow-2xl backdrop-blur-xl" role="status">
		<div class="min-w-0 flex-1"><p class="text-sm font-semibold text-[var(--text-primary)]">A new chronicle is ready</p><p class="text-xs text-[var(--text-muted)]">Reload to update the app shell.</p></div>
		<button onclick={reloadUpdate} class="min-h-11 rounded-xl bg-[var(--text-accent)] px-4 text-sm font-semibold text-[#09090b]">Reload</button>
	</div>
{/if}
