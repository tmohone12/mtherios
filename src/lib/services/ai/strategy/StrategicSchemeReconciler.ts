import { createScheme, updateScheme } from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import type { Entry, Scheme, SchemeDirective, SchemeStage } from '$lib/types';

export interface StrategicSchemeReconcilerContext {
	storyId: string;
	branchId: string | null;
	currentChapterNumber: number | null;
	totalDays: number | null;
	schemes: Scheme[];
	ownerEntries: Entry[];
}

export interface StrategicSchemeReconcilerResult {
	applied: number;
	rejected: string[];
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function key(value: string | null | undefined): string {
	return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function resolveScheme(directive: SchemeDirective, schemes: Scheme[]): Scheme | null {
	if (directive.schemeId) {
		const id = directive.schemeId.toLowerCase();
		const exact = schemes.find(scheme => scheme.id.toLowerCase() === id || scheme.id.toLowerCase().startsWith(id));
		if (exact) return exact;
	}
	const titleKey = key(directive.title ?? directive.goal ?? '');
	if (titleKey) {
		return schemes.find(scheme => key(scheme.goal) === titleKey || key(scheme.goal).includes(titleKey)) ?? null;
	}
	return null;
}

function resolveOwner(directive: SchemeDirective, entries: Entry[]): Entry | null {
	const rawOwner = directive.ownerName?.trim().toLowerCase();
	const ownerName = key(directive.ownerName);
	if (!rawOwner && !ownerName) return null;
	return entries.find(entry => {
		const entryId = entry.id.toLowerCase();
		return (
			(rawOwner ? entryId === rawOwner || entryId.startsWith(rawOwner) : false)
			|| key(entry.name) === ownerName
			|| entry.aliases?.some(alias => key(alias) === ownerName)
		);
	}) ?? null;
}

function toSecrecy(visibility: SchemeDirective['visibility']): Scheme['secrecy'] | undefined {
	if (visibility === 'public') return 'known';
	if (visibility === 'rumored') return 'rumored';
	if (visibility === 'secret' || visibility === 'unknown') return 'secret';
	return undefined;
}

function pressureDelta(directive: SchemeDirective): number {
	if (typeof directive.pressureDelta === 'number') return directive.pressureDelta;
	if (typeof directive.progressDelta === 'number') return directive.progressDelta;
	return 0;
}

function buildStage(label: string, hook: string, index: number): SchemeStage {
	return {
		index,
		label: label || `Stage ${index + 1}`,
		hook,
		condition: index === 0 ? 'prerequisite' : 'time',
		conditionPayload: index === 0 ? {} : { days: 3 + index },
		completed: false,
		completedAt: null,
	};
}

function createStages(directive: SchemeDirective): SchemeStage[] {
	const moves = [
		...(directive.nextMoves ?? []),
		...(directive.visibleEffects ?? []),
	].map((line) => line.trim()).filter(Boolean);
	const seeds = moves.length >= 2
		? moves.slice(0, 5)
		: [
			directive.newStage ?? 'Position pieces',
			directive.visibleEffects[0] ?? directive.reason,
			'Force a decision or visible consequence',
		];
	return seeds.slice(0, 6).map((seed, index) => buildStage(seed.slice(0, 70), seed, index));
}

export class StrategicSchemeReconciler {
	async applyDirectives(
		directives: SchemeDirective[],
		ctx: StrategicSchemeReconcilerContext,
	): Promise<StrategicSchemeReconcilerResult> {
		const rejected: string[] = [];
		let applied = 0;
		const schemes = [...ctx.schemes];

		for (const directive of directives) {
			if (directive.confidence < 0.45) {
				rejected.push(`${directive.type}: confidence too low (${directive.confidence})`);
				continue;
			}

			try {
				if (directive.type === 'create_scheme' || directive.type === 'fork_scheme') {
					const owner = resolveOwner(directive, ctx.ownerEntries);
					if (!owner) {
						rejected.push(`${directive.type}: owner not found (${directive.ownerName ?? 'unknown'})`);
						continue;
					}
					const now = Date.now();
					const stages = createStages(directive);
					const firstStage = stages[0];
					const scheme: Scheme = {
						id: uuid(),
						storyId: ctx.storyId,
						ownerType: directive.ownerType === 'character' || directive.ownerType === 'faction'
							? directive.ownerType
							: owner.type === 'character' || owner.type === 'faction' ? owner.type : 'faction',
						ownerEntryId: owner.id,
						ownerName: owner.name,
						goal: directive.goal || directive.title || directive.reason,
						trigger: `Strategic brain: ${directive.reason}`,
						triggerChapter: ctx.currentChapterNumber,
						triggerEntryId: null,
						stages,
						currentStageIndex: 0,
						pressure: clamp(directive.progressDelta ?? directive.pressureDelta ?? 25, 0, 100),
						status: directive.status && ['incubating', 'active', 'climaxing'].includes(directive.status)
							? directive.status
							: 'active',
						secrecy: toSecrecy(directive.visibility) ?? 'secret',
						nextTickAtDay: firstStage?.condition === 'time' && ctx.totalDays != null ? ctx.totalDays + 3 : null,
						branchId: ctx.branchId,
						createdAt: now,
						updatedAt: now,
					};
					await createScheme(scheme);
					schemes.push(scheme);
					applied += 1;
					continue;
				}

				const target = resolveScheme(directive, schemes);
				if (!target) {
					rejected.push(`${directive.type}: scheme not found (${directive.schemeId ?? directive.title ?? directive.goal ?? 'unknown'})`);
					continue;
				}

				const now = Date.now();
				const patch: Partial<Scheme> = { updatedAt: now };
				const delta = pressureDelta(directive);

				if (directive.type === 'advance_scheme') {
					patch.pressure = clamp(target.pressure + (delta || 12), 0, 100);
					if (target.currentStageIndex < target.stages.length - 1) {
						const stages = target.stages.map((stage, index) =>
							index === target.currentStageIndex
								? { ...stage, completed: true, completedAt: now }
								: stage,
						);
						patch.stages = stages;
						patch.currentStageIndex = target.currentStageIndex + 1;
					}
					if (patch.pressure >= 70 && target.status === 'active') patch.status = 'climaxing';
				} else if (directive.type === 'stall_scheme') {
					patch.pressure = clamp(target.pressure + (delta || -10), 0, 100);
					patch.status = target.status === 'climaxing' ? 'active' : target.status;
				} else if (directive.type === 'expose_scheme') {
					patch.secrecy = toSecrecy(directive.visibility) ?? 'known';
					patch.pressure = clamp(target.pressure + Math.max(8, delta), 0, 100);
				} else if (directive.type === 'complete_scheme') {
					patch.status = directive.status === 'foiled' ? 'foiled' : 'resolved';
					patch.pressure = clamp(target.pressure + Math.max(0, delta), 0, 100);
				} else if (directive.type === 'retire_scheme') {
					patch.status = 'abandoned';
				} else if (directive.type === 'update_scheme' || directive.type === 'merge_scheme') {
					if (directive.goal) patch.goal = directive.goal;
					if (directive.visibility) patch.secrecy = toSecrecy(directive.visibility);
					if (delta) patch.pressure = clamp(target.pressure + delta, 0, 100);
				}

				if (directive.newStage && patch.stages == null) {
					const stages = target.stages.map((stage, index) =>
						index === target.currentStageIndex
							? { ...stage, hook: `${stage.hook}\nStrategic pressure: ${directive.newStage}` }
							: stage,
					);
					patch.stages = stages;
				}

				await updateScheme(target.id, patch);
				Object.assign(target, patch);
				applied += 1;
			} catch (error) {
				rejected.push(`${directive.type}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return { applied, rejected };
	}
}
