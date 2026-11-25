import assert from 'node:assert/strict';
import test from 'node:test';
import { formProblems, normalizeSubmission, type InboundForm } from '../../../kernel/inboundForms.ts';
const form: InboundForm = { name: 'Contact us', fields: [{ key: 'email', label: 'Email', kind: 'email', required: true, mapsTo: 'email' }, { key: 'note', label: 'Message', kind: 'textarea' }, { key: 'consent', label: 'Consent', kind: 'checkbox', required: true }], hiddenParams: [] };
test('hosted forms enforce mapping, bounds and safe redirects', () => {
  assert.deepEqual(formProblems(form), []);
  for (const redirect of ['javascript:alert(1)', 'http://example.test', 'https://user@example.test', 'https://example.test/\n']) assert.ok(formProblems({ ...form, redirect }).length);
  assert.ok(formProblems({ ...form, fields: Array(26).fill(form.fields[0]) }).length);
  assert.ok(formProblems({ ...form, fields: [{ ...form.fields[0], required: false }] }).length);
});
test('answers retain inert text, drop unknown keys, bound values and enforce consent', () => {
  const result = normalizeSubmission(form, { email: 'a@example.test', note: '<img onerror=x>\u0000' + 'a'.repeat(2100), consent: true, ownerId: 'attacker' }, { utm_source: 'campaign', other: 'ignored' });
  assert.equal(result.answers.note.length, 2000);
  assert.ok(result.answers.note.startsWith('<img onerror=x>'));
  assert.equal(result.answers.ownerId, undefined);
  assert.equal(result.values.ownerId, undefined);
  assert.deepEqual(result.utm, { utm_source: 'campaign' });
  assert.throws(() => normalizeSubmission(form, { email: 'a@example.test' }, {}));
});
