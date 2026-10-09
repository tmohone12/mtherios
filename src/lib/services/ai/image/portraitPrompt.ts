import { characterStateView } from '$lib/utils/characterState';
import type { Character } from '$lib/types';

type PortraitCharacter = Pick<Character, 'name' | 'description' | 'traits' | 'visualDescriptors' | 'metadata'>;
type PortraitLore = { type: string; description?: string | null; state: unknown };

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).map(([key, part]) => typeof part === 'string' && part.trim() ? `${key}: ${part.trim()}` : '').filter(Boolean).join(', ');
}

/** Prefer saved visual canon; a biography is a fallback, not extra image content. */
export function buildCharacterPortraitPrompt(character: PortraitCharacter, lore?: PortraitLore | null): string {
  const metadata = character.metadata && typeof character.metadata === 'object' ? character.metadata : {};
  const state = characterStateView(lore?.type === 'character' ? lore.state : {}, metadata);
  const appearance = [text(state.appearance), text(state.visualDescriptors),
    ...Object.entries(character.visualDescriptors ?? {}).map(([key, value]) => text(value) ? `${key}: ${text(value)}` : '')].filter(Boolean);
  const biography = appearance.length ? [] : [text(state.bio) || text(character.description) || text(lore?.description)];
  const attire = [text(state.presentation), text(state.clothing)].filter(Boolean);
  const details = [
    `Create a character illustration of ${character.name}`,
    ...appearance, ...biography,
    text(state.species), text(state.race), text(state.currentForm),
    ...attire,
    attire.length ? '' : 'Human or humanoid subjects wear a fully covering tunic, trousers and boots. Non-humanoid creatures retain their natural appearance',
    'One figure, natural proportions, simple neutral background. Preserve the saved species, anatomy and current form. No text',
    /\bdragon\b/i.test([...appearance, ...biography, text(state.species), text(state.currentForm)].join(' '))
      ? 'A dragon in dragon form has a complete dragon body, wings and tail; never attach a dragon head to a human torso. Use human anatomy only when the saved current form explicitly calls for it' : '',
  ].filter(Boolean);
  return [...new Set(details)].join('. ');
}
