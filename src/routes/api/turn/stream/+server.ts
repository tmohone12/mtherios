import type { RequestHandler } from '@sveltejs/kit';
import { turnRequestSchema } from '$lib/contracts/memory';
import { executeTurnSubmitCommand } from '$lib/server/engine/turnFacade';

const encoder = new TextEncoder();

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
					agentTurnOptions: {
						onGmActivity: (activity) => {
							enqueue('gm.activity', activity);
						},
						onNarrationChunk: (text) => {
							enqueue('narration.chunk', {
								storyId: parsed.storyId,
								clientTurnId: parsed.clientTurnId,
								text,
							});
						},
						signal: request.signal,
					},
				});
				if ('status' in result) enqueue('pending', result);
				else enqueue('narration', { text: result.narration });
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
