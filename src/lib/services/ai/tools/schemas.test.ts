import { describe, expect, it } from 'vitest';
import { GM_TOOLS } from './schemas';

function updateWorldStateParameters() {
	const tool = GM_TOOLS.find((candidate) => candidate.function.name === 'update_world_state');
	if (!tool) throw new Error('update_world_state tool missing');
	return tool.function.parameters as unknown as {
		properties: Record<string, {
			description?: string;
			items?: {
				properties?: Record<string, { description?: string }>;
			};
		}>;
	};
}

describe('GM tool schemas', () => {
	it('exposes roll_check as a narrator tool', () => {
		const tool = GM_TOOLS.find((candidate) => candidate.function.name === 'roll_check');

		expect(tool?.function.description ?? '').toContain('Call before narrating the outcome');
		expect((tool?.function.parameters as any).required).toContain('dc');
	});

	it('tells world-state extraction not to create character canon', () => {
		const parameters = updateWorldStateParameters();

		expect(parameters.properties.characters.description ?? '').toContain('Update only established canonical characters');
		expect(parameters.properties.lorebook_entries.description ?? '').toContain('Do not create character entries from narration extraction');
		expect(parameters.properties.lorebook_entries.items?.properties?.type.description ?? '').toContain('character is review-only unless the character already exists');
	});

	it('exposes rich character state fields to normal state extraction', () => {
		const characterProperties = updateWorldStateParameters().properties.characters.items?.properties ?? {};

		expect(characterProperties.appearance.description ?? '').toContain('visual portrayal');
		expect(characterProperties.background.description ?? '').toContain('backstory');
		expect(characterProperties.goals.description ?? '').toContain('Current concrete goals');
		expect(characterProperties.speechStyle.description ?? '').toContain('voice');
		expect(characterProperties.eventMemory.description ?? '').toContain('NPC memory');
	});
});
