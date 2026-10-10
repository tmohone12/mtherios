import { describe, expect, it } from 'vitest';
import { validateForecasts } from './forecastValidation';

const forecast = {
 id: 'possible_relief', if: 'The request is accepted', unless: 'The request is withdrawn',
 development: 'Relief may arrive.', earliest: null, evidence: ['request'],
 uncertainty: 'Recipient consent is unresolved.', invalidateWhen: 'The request is abandoned.',
};

describe('conditional forecast validation', () => {
 it('accepts grounded conditional aid and quiet without establishing outcomes', () => {
  expect(validateForecasts([forecast], ['request'])).toEqual([forecast]);
  expect(validateForecasts([], ['request'])).toEqual([]);
 });
 it('rejects duplicate forecast identities before they reach the keyed inspection list', () => {
  expect(() => validateForecasts([forecast, { ...forecast, development: 'The request may fail.' }], ['request'])).toThrow('Duplicate forecast IDs.');
 });
 it('requires exact supported source identities, not paraphrases or obsolete source IDs', () => {
  expect(() => validateForecasts([{ ...forecast, evidence: ['The request is accepted'] }], ['request'])).toThrow('Unsupported forecast evidence.');
  expect(() => validateForecasts([forecast], ['changed_request'])).toThrow('Unsupported forecast evidence.');
 });
});
