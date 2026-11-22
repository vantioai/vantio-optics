'use strict';

// The drift workflow checks out vantioai/vantio-open-core, which is private.
// It must read that repo with OPEN_CORE_READ_TOKEN and fail, not pass, when
// the secret is absent: a run that compared nothing is not green (VAN-189).

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
  else {
    if (!token.includes('secrets.OPEN_CORE_READ_TOKEN')) out.push('token step does not read the secret');
    const missing = token.slice(token.indexOf('else'));
    if (token.indexOf('else') === -1 || !/\n\s*exit 1\n/.test(missing)) {
      out.push('a missing token does not fail the run');
    }
    if (!missing.includes('::error::')) out.push('a missing token is not reported as an error');
  }
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

test('drift workflow reads private open-core with a token and fails without it', () => {
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

test('negative: a missing token that only logs a notice and passes is rejected', () => {
  const skip = [
    '      - name: Check for the open-core read token',
    '        id: token',
    '        env:',
    '          OPEN_CORE_READ_TOKEN: ${{ secrets.OPEN_CORE_READ_TOKEN }}',
    '        run: |',
    '          if [ -n "$OPEN_CORE_READ_TOKEN" ]; then',
    '            echo "present=true" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "present=false" >> "$GITHUB_OUTPUT"',
    '            echo "::notice::OPEN_CORE_READ_TOKEN is not set. The drift check is skipped."',
    '          fi',
    '',
  ].join('\n');
  const found = problems(skip);
  assert.ok(found.includes('a missing token does not fail the run'));
  assert.ok(found.includes('a missing token is not reported as an error'));
});
