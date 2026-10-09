import { describe, expect, it } from 'vitest';
import { nameRequestSchema, parseNameCandidates } from './generatedNames';

describe('GM name candidates', () => {
  it('bounds the request and returns distinct noncanonical candidates', () => {
    const request = nameRequestSchema.parse({ count: 2, intent: 'place', genre: 'fantasy', culturalBlends: ['Norse', 'Arabic'] });
    expect(parseNameCandidates('{"names":["Veyrholm","Qamar Vale"]}', request.count, request.exclude)).toEqual(['Veyrholm', 'Qamar Vale']);
    expect(() => nameRequestSchema.parse({ count: 13, intent: 'place' })).toThrow();
    expect(() => nameRequestSchema.parse({ count: 1, intent: 'character', projectId: 'other' })).toThrow();
  });

  it('rejects duplicates, exclusions, malformed counts, and controls', () => {
    expect(() => parseNameCandidates('{"names":["Vale","vale"]}', 2, [])).toThrow();
    expect(() => parseNameCandidates('{"names":["Vale"]}', 1, ['vale'])).toThrow();
    expect(() => parseNameCandidates('{"names":["Vale"]}', 2, [])).toThrow();
    expect(() => parseNameCandidates('{"names":["Va\\nle"]}', 1, [])).toThrow();
  });
});
