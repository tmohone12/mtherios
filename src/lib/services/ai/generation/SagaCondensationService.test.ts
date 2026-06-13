import { describe, expect, it } from 'vitest';
import { sagaSummarySchema, type SagaSummary } from '../sdk/schemas/saga';
import { SagaCondensationService } from './SagaCondensationService';
import type { Arc } from '$lib/types';
import type { z } from 'zod';

function arc(number: number, overrides: Partial<Arc> = {}): Arc {
	return {
		id: `arc-${number}`,
		storyId: 'story-1',
		arcNumber: number,
		title: `Arc ${number}`,
		summary: `Faction pressure and character debt from arc ${number}.`,
		keyPlotPoints: [`Plot point ${number}`],
		characterArcs: [{ name: 'Asha', development: `Changed in arc ${number}` }],
		unresolvedThreads: [`Thread ${number}`],
		threadIds: [],
		resolvedThreadIds: [],
		emotionalProgression: 'pressure rises',
		chapterIds: [`chapter-${number}`],
		chapterRange: `${number * 5 - 4}-${number * 5}`,
		branchId: null,
		createdAt: number,
		...overrides,
	};
}

describe('sagaSummarySchema', () => {
	it('accepts a valid saga summary payload', () => {
		const data: SagaSummary = {
			title: 'The Ashen Succession',
			summary: 'Ten arcs of faction pressure reshape the realm.',
			arcRange: 'Arcs 1-10',
			keyFactionShifts: ['House Blackwood loses leverage.'],
			majorPowerChanges: ['The river crossings become contested.'],
			lingeringThreads: ['The missing oathkeeper remains unaccounted for.'],
			overallTone: 'suspicion hardens into open pressure',
		};

		expect(sagaSummarySchema.parse(data)).toEqual(data);
	});
});

describe('SagaCondensationService', () => {
	it('returns the next ten uncovered arcs for a new saga', () => {
		const service = new SagaCondensationService();
		const arcs = Array.from({ length: 21 }, (_, i) => arc(i + 1));

		expect(service.getCondensableArcs(arcs, 1).map((item) => item.arcNumber))
			.toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
	});

	it('uses structured generation instead of the placeholder summary', async () => {
		const expected: SagaSummary = {
			title: 'The River War',
			summary: 'The saga tracks how local debts became open regional pressure.',
			arcRange: 'Arcs 1-10',
			keyFactionShifts: ['House Mooton becomes isolated.'],
			majorPowerChanges: ['Riverland roads become militarized.'],
			lingeringThreads: ['A secret pact remains unpaid.'],
			overallTone: 'slow-burn dread',
		};
		class TestService extends SagaCondensationService {
			call: { system: string; prompt: string } | null = null;
			protected async generateStructured<T>(
				_schema: z.ZodType<T>,
				system: string,
				prompt: string,
			): Promise<T> {
				this.call = { system, prompt };
				return expected as T;
			}
		}

		const service = new TestService();
		const result = await service.condense(Array.from({ length: 10 }, (_, i) => arc(i + 1)), 1);

		expect(result).toEqual(expected);
		expect(service.call?.system).toContain('SAGA SUMMARY');
		expect(service.call?.system).toContain('MTHERIOS SAGA SUMMARY FORMAT');
		expect(service.call?.system).toContain('[CURRENTLY — day, date | time | location | weather, temp°C]');
		expect(service.call?.prompt).toContain('Arc 1');
		expect(service.call?.prompt).toContain('Arc 10');
	});
});
