import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    assertSafeDatabase,
    assertSafeStripeKey,
    databaseNameFromUri,
    redactHost,
} from '../src/config/env-guards.js';

const SRV = 'mongodb+srv://fixture-user:fixture-pass@cluster0.example.invalid';

test('databaseNameFromUri reads the path database', () => {
    assert.equal(databaseNameFromUri(`${SRV}/prod?retryWrites=true`), 'prod');
    assert.equal(databaseNameFromUri(`${SRV}/vireact_dev`), 'vireact_dev');
    assert.equal(databaseNameFromUri(`${SRV}/?retryWrites=true`), null);
    assert.equal(databaseNameFromUri(SRV), null);
    assert.equal(databaseNameFromUri(undefined), null);
});

test('redactHost logs only a short fragment of the first host label', () => {
    assert.equal(redactHost('cluster0-shard-00-01.abcde.mongodb.net'), 'clus***');
    assert.equal(redactHost(undefined), 'unknown');
});

test('DB guard blocks the production database name outside production', () => {
    assert.throws(() => assertSafeDatabase({ NODE_ENV: 'development', DB_NAME: 'prod' }), /DB_NAME="prod"/);
    assert.throws(() => assertSafeDatabase({ DB_NAME: 'prod' }), /NODE_ENV=\(unset\)/);
});

test('DB guard checks the URI path database too', () => {
    assert.throws(
        () => assertSafeDatabase({ NODE_ENV: 'development', DB_NAME: 'vireact_dev', DB_URL: `${SRV}/prod?x=1` }),
        /DB_URL database="prod"/
    );
    assert.throws(
        () => assertSafeDatabase({ NODE_ENV: 'development', MONGODB_URI: `${SRV}/prod` }),
        /MONGODB_URI database="prod"/
    );
});

test('DB guard compares names, not hosts: same host with dev database passes', () => {
    assert.doesNotThrow(() =>
        assertSafeDatabase({ NODE_ENV: 'development', DB_NAME: 'vireact_dev', DB_URL: `${SRV}/vireact_dev?x=1` })
    );
    assert.doesNotThrow(() => assertSafeDatabase({ NODE_ENV: 'development', DB_NAME: 'production_copy' }));
});

test('DB guard honours production, the explicit override, and a custom pattern', () => {
    assert.doesNotThrow(() => assertSafeDatabase({ NODE_ENV: 'production', DB_NAME: 'prod' }));
    assert.doesNotThrow(() => assertSafeDatabase({ NODE_ENV: 'development', DB_NAME: 'prod', ALLOW_PROD_DB_IN_DEV: 'true' }));
    assert.throws(() => assertSafeDatabase({ NODE_ENV: 'development', DB_NAME: 'prod', ALLOW_PROD_DB_IN_DEV: 'yes' }));
    assert.throws(() => assertSafeDatabase({ NODE_ENV: 'test', DB_NAME: 'live', PROD_DB_NAME_PATTERN: '^(prod|live)$' }));
    assert.throws(() => assertSafeDatabase({ NODE_ENV: 'test', DB_NAME: 'x', PROD_DB_NAME_PATTERN: '(' }), /not a valid regular expression/);
});

test('Stripe guard requires a test-mode key outside production', () => {
    assert.throws(() => assertSafeStripeKey({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_live_abc' }), /prefix "sk_live"/);
    assert.throws(() => assertSafeStripeKey({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'rk_live_abc' }));
    assert.doesNotThrow(() => assertSafeStripeKey({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'sk_test_abc' }));
    assert.doesNotThrow(() => assertSafeStripeKey({ NODE_ENV: 'development', STRIPE_SECRET_KEY: 'rk_test_abc' }));
    assert.doesNotThrow(() => assertSafeStripeKey({ NODE_ENV: 'development' }));
    assert.doesNotThrow(() => assertSafeStripeKey({ NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_live_abc' }));
});

test('Stripe guard error never contains more than the key prefix', () => {
    const secret = 'sk_live_' + 'x'.repeat(40);
    try {
        assertSafeStripeKey({ NODE_ENV: 'development', STRIPE_SECRET_KEY: secret });
        assert.fail('expected throw');
    } catch (err) {
        assert.ok(!err.message.includes(secret));
    }
});

const runServer = (env) =>
    spawnSync(process.execPath, ['src/server.js'], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: 20000,
    });

test('server refuses to start against the production database name', () => {
    const r = runServer({ NODE_ENV: 'development', DB_NAME: 'prod', ALLOW_PROD_DB_IN_DEV: '', DB_URL: `${SRV}/prod` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing to start/);
    assert.doesNotMatch(r.stdout + r.stderr, /Connecting to MongoDB|Connected/);
});

test('server refuses to start with a non-test Stripe key', () => {
    const r = runServer({ NODE_ENV: 'development', DB_NAME: 'vireact_dev', DB_URL: `${SRV}/vireact_dev`, STRIPE_SECRET_KEY: 'sk_live_dummy' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /STRIPE_SECRET_KEY is not a test-mode key/);
});
