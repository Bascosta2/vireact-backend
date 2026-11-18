import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TWILIO_ACCOUNT_SID = `AC${'a'.repeat(32)}`;
process.env.TWILIO_AUTH_TOKEN = 'token-0123456789abcdef';
process.env.TWILIO_VERIFY_SERVICE_SID = `VA${'b'.repeat(32)}`;
console.warn = () => {};

const { isVerifyConfigured, sendVerificationCode, checkVerificationCode } = await import('../src/lib/twilio-verify.js');

test('sends and checks codes through Twilio Verify with basic auth and form bodies', async () => {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const approved = url.endsWith('/VerificationCheck') && new URLSearchParams(init.body).get('Code') === '123456';
        const body = url.endsWith('/Verifications') ? { status: 'pending' } : approved ? { status: 'approved', valid: true } : { status: 'pending', valid: false };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        assert.equal(isVerifyConfigured(), true);
        assert.equal(await sendVerificationCode('+15550001234'), true);
        assert.equal(calls[0].url, `https://verify.twilio.com/v2/Services/VA${'b'.repeat(32)}/Verifications`);
        assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(`AC${'a'.repeat(32)}:token-0123456789abcdef`).toString('base64')}`);
        assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), { To: '+15550001234', Channel: 'sms' });
        assert.equal(await checkVerificationCode('+15550001234', '123456'), true);
        assert.equal(await checkVerificationCode('+15550001234', '999999'), false);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('rejects malformed settings', () => {
    const saved = process.env.TWILIO_VERIFY_SERVICE_SID;
    process.env.TWILIO_VERIFY_SERVICE_SID = 'not-a-sid';
    assert.equal(isVerifyConfigured(), false);
    process.env.TWILIO_VERIFY_SERVICE_SID = saved;
});
