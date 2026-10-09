import type { RequestHandler } from '@sveltejs/kit';
import { listAgentRunEvents } from '$lib/server/engine/agentRuns';
import { apiError } from '$lib/server/memory/http';

export const GET: RequestHandler = async ({ request, url }) => {
  const storyId = url.searchParams.get('storyId') ?? '';
  const runId = url.searchParams.get('runId') ?? '';
  const rawCursor = request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? '0';
  const initialCursor = Number(rawCursor);
  if (!Number.isSafeInteger(initialCursor) || initialCursor < 0) return new Response('Invalid event cursor.', { status: 400 });
  try { await listAgentRunEvents({ storyId, runId, after: initialCursor, limit: 1 }); }
  catch (error) { return apiError(error); }
  const encoder = new TextEncoder();
  let cursor = initialCursor;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const tick = async () => {
        if (busy || request.signal.aborted) return;
        busy = true;
        try {
          const events = await listAgentRunEvents({ storyId, runId, after: cursor, limit: 100 });
          for (const event of events) {
            cursor = Number(event.seq);
            controller.enqueue(encoder.encode(`id: ${cursor}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.data)}\n\n`));
          }
        } catch {
          if (timer) clearInterval(timer);
          timer = null;
          try { controller.close(); } catch { /* disconnected */ }
        } finally { busy = false; }
      };
      void tick();
      timer = setInterval(() => void tick(), 2000);
      request.signal.addEventListener('abort', () => { if (timer) clearInterval(timer); timer = null; try { controller.close(); } catch { /* disconnected */ } }, { once: true });
    },
    cancel() { if (timer) clearInterval(timer); timer = null; },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
};
