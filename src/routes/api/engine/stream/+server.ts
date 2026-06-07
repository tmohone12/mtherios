import type { RequestHandler } from '@sveltejs/kit';
import { getCampaignProjection } from '$lib/server/engine/projections';
import { getEngineCacheStatus } from '$lib/server/engine/cache';
import { getRecentEngineEvents, publishEngineEvent, subscribeEngineEvents } from '$lib/server/engine/events';

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function projectionStatus(projection: Awaited<ReturnType<typeof getCampaignProjection>>) {
	return {
		mode: projection.mode,
		counts: projection.counts,
		vault: projection.vault,
		cache: projection.cache,
	};
}

export const GET: RequestHandler = async ({ request, url }) => {
	const storyId = url.searchParams.get('storyId');
	const replayLimit = Math.max(0, Math.min(100, Number(url.searchParams.get('replay') ?? 25)));
	const encoder = new TextEncoder();
	let heartbeat: ReturnType<typeof setInterval> | null = null;
	let unsubscribe: (() => void) | null = null;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(sse(event, data)));
				} catch {
					// Client disconnected between ticks.
				}
			};
			const close = () => {
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = null;
				if (unsubscribe) unsubscribe();
				unsubscribe = null;
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};

			const connected = publishEngineEvent({
				storyId,
				type: 'engine.connected',
				data: {
					serverTime: new Date().toISOString(),
					storyId,
					streams: ['command_progress', 'narration_chunks', 'state_cache_job_events'],
				},
			});
			send('engine.connected', connected);
			unsubscribe = subscribeEngineEvents(storyId, (event) => {
				send(event.type, event);
			});
			if (replayLimit > 0) {
				for (const event of getRecentEngineEvents(storyId, replayLimit)) {
					if (event.id === connected.id) continue;
					send(event.type, event);
				}
			}
			if (storyId) {
				try {
				const [projection, cache] = await Promise.all([
					getCampaignProjection(storyId),
					getEngineCacheStatus(storyId),
				]);
				publishEngineEvent({
					storyId,
					type: 'campaign.status',
					data: projectionStatus(projection),
				});
				publishEngineEvent({
					storyId,
					type: 'cache.status',
					data: { cache },
				});
			} catch (error) {
				publishEngineEvent({
					storyId,
					type: 'engine.error',
					data: {
						error: error instanceof Error ? error.message : String(error),
					},
				});
			}
		}
		publishEngineEvent({
			storyId,
			type: 'engine.ready',
			data: {
				serverTime: new Date().toISOString(),
				storyId,
			},
		});
		heartbeat = setInterval(() => {
			publishEngineEvent({
				storyId,
				type: 'engine.heartbeat',
				data: { serverTime: new Date().toISOString(), storyId },
			});
		}, 15_000);
			request.signal.addEventListener('abort', close, { once: true });
		},
		cancel() {
			if (heartbeat) clearInterval(heartbeat);
			heartbeat = null;
			if (unsubscribe) unsubscribe();
			unsubscribe = null;
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
		},
	});
};
