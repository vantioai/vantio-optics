'use strict';

// The drift workflow checks out vantioai/vantio-open-core, which is private.
// It must read that repo with OPEN_CORE_READ_TOKEN and skip, not fail, when
// the secret is absent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'open-core-drift.yml');
const GATE = "if: steps.token.outputs.present == 'true'";

function stepBlock(text, name) {
  const start = text.indexOf(`- name: ${name}`);
  if (start === -1) return null;
  const next = text.indexOf('\n      - name: ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

function problems(text) {
  const out = [];
  const token = stepBlock(text, 'Check for the open-core read token');
  if (!token) out.push('missing token check step');
  else if (!token.includes('secrets.OPEN_CORE_READ_TOKEN')) out.push('token step does not read the secret');
  const checkout = stepBlock(text, 'Checkout vantio-open-core main');
  if (!checkout) out.push('missing open-core checkout step');
  else {
    if (!checkout.includes(GATE)) out.push('open-core checkout is not gated on the token');
    if (!checkout.includes('token: ${{ secrets.OPEN_CORE_READ_TOKEN }}')) out.push('open-core checkout does not pass the token');
    if (!checkout.includes('persist-credentials: false')) out.push('open-core checkout persists credentials');
  }
  const compare = stepBlock(text, 'Compare');
  if (!compare) out.push('missing compare step');
  else if (!compare.includes(GATE)) out.push('compare is not gated on the token');
  return out;
}

test('drift workflow reads private open-core with a token and skips without it', () => {
  assert.deepEqual(problems(fs.readFileSync(WORKFLOW, 'utf8')), []);
});

test('negative: a checkout with no token and no gate is rejected', () => {
  const old = [
    '      - name: Checkout vantio-open-core main',
    '        uses: actions/checkout@v4',
    '        with:',
    '          repository: vantioai/vantio-open-core',
    '          persist-credentials: false',
    '',
    '      - name: Compare',
    '        run: python3 scripts/check_open_core_drift.py .open-core',
  ].join('\n');
  const found = problems(old);
  assert.ok(found.includes('missing token check step'));
  assert.ok(found.includes('open-core checkout is not gated on the token'));
  assert.ok(found.includes('open-core checkout does not pass the token'));
  assert.ok(found.includes('compare is not gated on the token'));
});
