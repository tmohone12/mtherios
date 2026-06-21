import type { RequestHandler } from '@sveltejs/kit';
import { turnRequestSchema } from '$lib/contracts/memory';
import { executeTurnSubmitCommand } from '$lib/server/engine/turnFacade';
import { processServerTurn } from '$lib/server/turn/orchestrator';

const encoder = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
	return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const POST: RequestHandler = async ({ request }) => {
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				const body = await request.json();
				const parsed = turnRequestSchema.parse(body);
				controller.enqueue(sse('start', { storyId: parsed.storyId, clientTurnId: parsed.clientTurnId }));
				controller.enqueue(sse('status', { stage: 'processing' }));
				const result = await executeTurnSubmitCommand(parsed, {
					submitTurn: (input) => processServerTurn(input, {
						onNarrationChunk: (text) => {
							controller.enqueue(sse('narration.chunk', {
								storyId: parsed.storyId,
								clientTurnId: parsed.clientTurnId,
								text,
							}));
						},
					}),
				});
				controller.enqueue(sse('narration', { text: result.narration }));
				controller.enqueue(sse('done', result));
			} catch (error) {
				controller.enqueue(sse('error', { error: error instanceof Error ? error.message : String(error) }));
			} finally {
				controller.close();
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
