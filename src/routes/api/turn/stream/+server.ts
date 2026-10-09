import type { RequestHandler } from '@sveltejs/kit';
import { turnRequestSchema } from '$lib/contracts/memory';
import { executeEngineCommand } from '$lib/server/engine/command';
import { publishEngineEvent } from '$lib/server/engine/events';
import { executeTurnSubmitCommand } from '$lib/server/engine/turnFacade';
import { normalizeGmToolArgs, processServerTurn } from '$lib/server/turn/orchestrator';

const encoder = new TextEncoder();

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Turn request was cancelled.');
	let onAbort: (() => void) | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Turn request was cancelled.'));
				signal.addEventListener('abort', onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

function sse(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const POST: RequestHandler = async ({ request }) => {
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const enqueue = (event: string, data: unknown) => {
				if (request.signal.aborted) return;
				try {
					controller.enqueue(sse(event, data));
				} catch {
					// The browser may close the stream while the provider is unwinding.
				}
			};
			try {
				const body = await request.json();
				const parsed = turnRequestSchema.parse(body);
				enqueue('start', { storyId: parsed.storyId, clientTurnId: parsed.clientTurnId });
				enqueue('status', { stage: 'processing' });
				const result = await executeTurnSubmitCommand(parsed, {
					submitTurn: (input) => processServerTurn(input, {
						runGmTool: async (call) => {
							const response = await awaitWithAbort(executeEngineCommand({
								storyId: parsed.storyId,
								command: call.command,
								clientCommandId: `${parsed.clientTurnId}:${call.id}`,
								args: normalizeGmToolArgs(call),
							}), request.signal);
							if (response.status !== 'succeeded') throw new Error(response.error || `${call.command} failed.`);
							return response.result;
						},
						onGmActivity: (activity) => {
							enqueue('gm.activity', activity);
							publishEngineEvent({ storyId: parsed.storyId, type: 'gm.activity', data: { ...activity } });
						},
						onNarrationChunk: (text) => {
							enqueue('narration.chunk', {
								storyId: parsed.storyId,
								clientTurnId: parsed.clientTurnId,
								text,
							});
						},
						signal: request.signal,
					}),
				});
				enqueue('narration', { text: result.narration });
				enqueue('done', result);
			} catch (error) {
				enqueue('error', { error: error instanceof Error ? error.message : String(error) });
			} finally {
				try {
					controller.close();
				} catch {
					// Already closed by the client.
				}
			}
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
