import { forecastsSchema } from './intentions';

/** Forecast identity is unique in storage and in the inspection's keyed list. */
export function validateForecasts(raw: unknown, sourceIds: readonly string[]) {
 const forecasts = forecastsSchema.parse(raw);
 if (new Set(forecasts.map(row => row.id)).size !== forecasts.length) throw new Error('Duplicate forecast IDs.');
 const allowed = new Set(sourceIds);
 if (forecasts.some(row => row.evidence.some(id => !allowed.has(id)))) throw new Error('Unsupported forecast evidence.');
 return forecasts;
}
