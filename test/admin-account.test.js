import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argValue, validateAdminInput, MIN_ADMIN_PASSWORD_LENGTH } from '../src/service/admin-account.js';

const good = 'x'.repeat(MIN_ADMIN_PASSWORD_LENGTH);

test('create-admin input validation', () => {
    assert.deepEqual(validateAdminInput({ email: 'ops@example.invalid', password: good, confirm: good }), []);
    assert.equal(validateAdminInput({ email: 'nope', password: good, confirm: good }).length, 1);
    assert.equal(validateAdminInput({ email: 'ops@example.invalid', password: 'short', confirm: 'short' }).length, 1);
    assert.equal(validateAdminInput({ email: 'ops@example.invalid', password: good, confirm: `${good}y` }).length, 1);
});

test('create-admin argument parsing', () => {
    assert.equal(argValue(['--email', 'a@b.co', '--apply'], '--email'), 'a@b.co');
    assert.equal(argValue(['--email=a@b.co'], '--email'), 'a@b.co');
    assert.equal(argValue(['--email', '--apply'], '--email'), undefined);
    assert.equal(argValue([], '--name'), undefined);
});
