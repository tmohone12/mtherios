/**
 * Logging for the browser AI assistants and the lorebook importer.
 */

/** Logs are only output in dev mode. */
const DEBUG_ENABLED = import.meta.env.DEV;

/**
 * Creates a logger function for an AI service.
 *
 * @example
 * const log = createLogger('Suggestions');
 * log('Processing entry', { id: entry.id }); // [Suggestions] Processing entry { id: ... }
 */
export function createLogger(serviceName: string) {
  const prefix = `[${serviceName}]`
  return (...args: unknown[]) => {
    if (DEBUG_ENABLED) {
      console.log(prefix, ...args)
    }
  }
}
