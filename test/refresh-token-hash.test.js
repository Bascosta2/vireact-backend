import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashRefreshToken, refreshTokenMatches, isHashedRefreshToken } from '../src/utils/refresh-token-hash.js';
import {
    verifyEmailService,
    resetPasswordService,
    loginAdminService,
    isEmailLinkToken,
    verificationTokenFor,
    resendEmailVerificationService,
    customSignupUserService,
    buildVerificationEmail,
    buildPasswordResetEmail,
    escapeHtml,
    formatFromAddress,
    replyToAddress,
    EMAIL_VERIFICATION_STATUS,
    EMAIL_VERIFICATION_TTL_MS,
    EMAIL_RESEND_COOLDOWN_MS,
    VERIFICATION_EMAIL,
} from '../src/service/auth.service.js';
import resend from '../src/lib/resend.js';
import { AUTH_RATE_LIMITS } from '../src/constants.js';
import { User } from '../src/model/user.model.js';
import { Admin } from '../src/model/admin.model.js';

const TOKEN = 'header.payload.signature';
const PEPPER = 'a'.repeat(32);

test('peppered hash is h1, deterministic, and never contains the token', () => {
    const h = hashRefreshToken(TOKEN, PEPPER);
    assert.match(h, /^h1:[0-9a-f]{64}$/);
    assert.equal(h, hashRefreshToken(TOKEN, PEPPER));
    assert.ok(!h.includes(TOKEN));
    assert.ok(isHashedRefreshToken(h));
});

test('without a pepper the hash falls back to h0', () => {
    assert.match(hashRefreshToken(TOKEN, ''), /^h0:[0-9a-f]{64}$/);
});

test('matching: h1 needs the same pepper, h0 works with or without one', () => {
    const h1 = hashRefreshToken(TOKEN, PEPPER);
    assert.ok(refreshTokenMatches(h1, TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(h1, TOKEN, 'b'.repeat(32)));
    assert.ok(!refreshTokenMatches(h1, TOKEN, ''));
    assert.ok(!refreshTokenMatches(h1, 'other.token', PEPPER));

    const h0 = hashRefreshToken(TOKEN, '');
    assert.ok(refreshTokenMatches(h0, TOKEN, ''));
    assert.ok(refreshTokenMatches(h0, TOKEN, PEPPER));
});

test('legacy plaintext tokens still match exactly once stored', () => {
    assert.ok(!isHashedRefreshToken(TOKEN));
    assert.ok(refreshTokenMatches(TOKEN, TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(TOKEN, TOKEN + 'x', PEPPER));
});

test('empty values never match', () => {
    assert.ok(!refreshTokenMatches('', TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(null, TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(hashRefreshToken(TOKEN, PEPPER), '', PEPPER));
    assert.throws(() => hashRefreshToken('', PEPPER));
});


// Emailed-link tokens and login fields: request values must never reach a Mongo filter as operators.

/** Replace Model.findOne for one test and record every filter it receives (no database needed). */
const spyFindOne = (model) => {
    const calls = [];
    const original = model.findOne;
    model.findOne = (filter) => { calls.push(filter); throw new Error('findOne must not be reached'); };
    return { calls, restore: () => { model.findOne = original; } };
};

const NON_TOKEN_VALUES = [
    { $ne: null },
    { $gt: '' },
    { $regex: '.*' },
    ['a'.repeat(64)],
    123,
    true,
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    ` ${'a'.repeat(64)}`,
];

test('isEmailLinkToken accepts only a 64-char lowercase hex string', () => {
    assert.ok(isEmailLinkToken('0123456789abcdef'.repeat(4)));
    for (const value of [...NON_TOKEN_VALUES, '', null, undefined]) {
        assert.equal(isEmailLinkToken(value), false, `accepted ${JSON.stringify(value)}`);
    }
});

test('verifyEmailService rejects operator objects and malformed tokens with 400 before any query', async () => {
    const spy = spyFindOne(User);
    try {
        for (const token of NON_TOKEN_VALUES) {
            await assert.rejects(verifyEmailService(token), (e) => e.statusCode === 400, `token ${JSON.stringify(token)}`);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

test('reset-password keeps rejecting non-hex tokens before any query', async () => {
    const spy = spyFindOne(User);
    try {
        for (const token of NON_TOKEN_VALUES) {
            await assert.rejects(resetPasswordService(token, 'new-password-1'), (e) => e.statusCode === 400);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

test('admin login rejects a non-string email or password with 400 before any query', async () => {
    const spy = spyFindOne(Admin);
    try {
        for (const [email, password] of [[{ $ne: null }, 'pw-123456'], ['a@example.invalid', { $ne: null }], [['a@example.invalid'], 'pw-123456']]) {
            await assert.rejects(loginAdminService(email, password), (e) => e.statusCode === 400);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

// Verification links keep working (reused token, idempotent verify) and auth emails are safe and clear.
// A one-document in-memory stand-in for the User model: no database needed.

/** Swap User.findOne/updateOne for an in-memory document; equality-only filters, $set-only updates. */
const withFakeUser = async (doc, fn) => {
    const original = { findOne: User.findOne, updateOne: User.updateOne };
    const matches = (filter) => Object.entries(filter).every(([key, value]) => String(doc[key]) === String(value));
    const updates = [];
    User.findOne = (filter) => {
        const found = matches(filter) ? doc : null;
        const query = Promise.resolve(found);
        query.select = () => Promise.resolve(found);
        return query;
    };
    User.updateOne = async (filter, update) => {
        updates.push({ filter, update });
        if (!matches(filter)) return { modifiedCount: 0 };
        Object.assign(doc, update.$set);
        return { modifiedCount: 1 };
    };
    doc.save ??= async () => doc;
    try {
        return await fn(updates);
    } finally {
        Object.assign(User, original);
    }
};

/** Record outgoing email instead of sending it. */
const withSentEmails = async (fn) => {
    const original = resend.emails.send;
    const sent = [];
    resend.emails.send = async (message) => { sent.push(message); return { data: { id: 'test' }, error: null }; };
    const quiet = console.error;
    console.error = () => {};
    try {
        return await fn(sent);
    } finally {
        resend.emails.send = original;
        console.error = quiet;
    }
};

const HEX = (c) => c.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

test('verificationTokenFor reuses a live token and mints one only when there is none, it is malformed or expired', () => {
    const now = Date.now();
    assert.equal(verificationTokenFor({ emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: new Date(now + DAY) }, now), HEX('a'));
    assert.equal(verificationTokenFor({ emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: null }, now), HEX('a'), 'older token without expiry');
    for (const user of [
        {},
        { emailVerificationToken: null },
        { emailVerificationToken: 'old' },
        { emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: new Date(now - 1) },
    ]) {
        const token = verificationTokenFor(user, now);
        assert.ok(isEmailLinkToken(token));
        assert.notEqual(token, HEX('a'));
    }
    assert.equal(EMAIL_VERIFICATION_TTL_MS, 7 * DAY);
});

test('verify-email is idempotent: first use verifies, a second use says already_verified', async () => {
    const doc = { _id: 'u1', email: 'a@example.invalid', isEmailVerified: false, emailVerificationToken: HEX('b'), emailVerificationTokenExpiresAt: new Date(Date.now() + DAY) };
    await withFakeUser(doc, async (updates) => {
        assert.equal((await verifyEmailService(HEX('b'))).status, EMAIL_VERIFICATION_STATUS.VERIFIED);
        assert.equal(doc.isEmailVerified, true);
        assert.equal(doc.emailVerificationToken, HEX('b'), 'token kept so a second click is recognised');
        assert.deepEqual(updates[0].filter, { _id: 'u1', emailVerificationToken: HEX('b') }, 'update is tied to the presented token');

        const again = await verifyEmailService(HEX('b'));
        assert.equal(again.status, EMAIL_VERIFICATION_STATUS.ALREADY_VERIFIED);
        assert.equal(updates.length, 1, 'second use changes nothing');

        await assert.rejects(verifyEmailService(HEX('c')), (e) => e.statusCode === 400, 'unknown token');
    });
});

test('verify-email: an expired link is a 400 and does not verify; a link without expiry (sent before this change) still works', async () => {
    const expired = { _id: 'u2', isEmailVerified: false, emailVerificationToken: HEX('d'), emailVerificationTokenExpiresAt: new Date(Date.now() - 1) };
    await withFakeUser(expired, async (updates) => {
        await assert.rejects(verifyEmailService(HEX('d')), (e) => e.statusCode === 400 && /expired/.test(e.message));
        assert.equal(expired.isEmailVerified, false);
        assert.equal(updates.length, 0);
    });
    const legacy = { _id: 'u3', isEmailVerified: false, emailVerificationToken: HEX('e'), emailVerificationTokenExpiresAt: null };
    await withFakeUser(legacy, async () => {
        assert.equal((await verifyEmailService(HEX('e'))).status, EMAIL_VERIFICATION_STATUS.VERIFIED);
        assert.equal(legacy.isEmailVerified, true);
    });
});

test('resend keeps the same link (earlier emails keep working), extends it 7 days, and sends a text part from "Vireact <...>"', async () => {
    const doc = {
        _id: 'u4', name: 'Pat', email: 'pat@example.invalid', isEmailVerified: false,
        emailVerificationToken: HEX('f'), emailVerificationTokenExpiresAt: new Date(Date.now() + DAY), verificationEmailSentAt: null,
    };
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            await resendEmailVerificationService(doc.email);
            doc.verificationEmailSentAt = new Date(Date.now() - EMAIL_RESEND_COOLDOWN_MS - 1);
            await resendEmailVerificationService(doc.email);
        });
        assert.equal(sent.length, 2);
        for (const message of sent) {
            assert.ok(message.html.includes(`token=${HEX('f')}`));
            assert.ok(message.text.includes(`token=${HEX('f')}`), 'plain-text part carries the link');
            assert.equal(message.from, formatFromAddress());
            assert.match(message.from, /<.+@.+>/, 'from has a display name');
            assert.equal(message.replyTo, replyToAddress());
        }
        assert.equal(doc.emailVerificationToken, HEX('f'));
        assert.ok(doc.emailVerificationTokenExpiresAt.getTime() > Date.now() + 6 * DAY, 'link extended to 7 days from the latest email');
    });
});

test('re-signup of an unverified account keeps the link and respects the 60 s cooldown', async () => {
    const doc = {
        _id: 'u5', name: 'Old', email: 'sam@example.invalid', password: 'hash', isEmailVerified: false,
        emailVerificationToken: HEX('1'), emailVerificationTokenExpiresAt: new Date(Date.now() + DAY), verificationEmailSentAt: new Date(),
    };
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            const first = await customSignupUserService('New', doc.email, 'new-pass-1', 'local');
            assert.equal(first.verificationEmail, VERIFICATION_EMAIL.RECENT, 'within a minute of the last email: no new send');
            assert.equal(sent.length, 0);

            doc.verificationEmailSentAt = new Date(Date.now() - EMAIL_RESEND_COOLDOWN_MS - 1);
            const second = await customSignupUserService('New', doc.email, 'new-pass-1', 'local');
            assert.equal(second.verificationEmail, VERIFICATION_EMAIL.SENT);
        });
        assert.equal(sent.length, 1);
        assert.ok(sent[0].text.includes(`token=${HEX('1')}`), 'same link as the first email');
        assert.equal(doc.emailVerificationToken, HEX('1'));
    });
});

test('auth emails never carry HTML a stranger typed; reset greeting is escaped, verification drops the name', () => {
    const verification = buildVerificationEmail(`https://vireact.io/verify-email?token=${HEX('2')}`);
    assert.ok(verification.text.includes(`token=${HEX('2')}`));
    assert.doesNotMatch(verification.text, /</);

    const evil = '<a href="https://evil.example">Claim prize</a>';
    const reset = buildPasswordResetEmail({ name: evil, resetUrl: 'https://vireact.io/reset-password?token=x', hasPassword: true });
    assert.ok(!reset.html.includes('evil.example">'), 'no injected link');
    assert.ok(reset.html.includes('&lt;a href=&quot;https://evil.example&quot;&gt;'));
    assert.equal(reset.subject, 'Reset your Vireact password');
    assert.ok(reset.text.includes('https://vireact.io/reset-password?token=x'));
    assert.equal(buildPasswordResetEmail({ name: '', resetUrl: 'u', hasPassword: false }).subject, 'Set a password for Vireact');
    assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

test('from gets a "Vireact" display name unless it has one; reply-to defaults to the bare address', () => {
    assert.equal(formatFromAddress('support@vireact.io'), 'Vireact <support@vireact.io>');
    assert.equal(formatFromAddress('Team <hi@vireact.io>'), 'Team <hi@vireact.io>');
    assert.equal(replyToAddress('support@vireact.io', undefined), 'support@vireact.io');
    assert.equal(replyToAddress('Team <hi@vireact.io>', ''), 'hi@vireact.io');
    assert.equal(replyToAddress('support@vireact.io', 'help@vireact.io'), 'help@vireact.io');
});

test('login, signup, verify and resend each have their own per-IP limit', () => {
    const paths = ['login', 'signup', 'verify-email', 'resend-verification', 'forgot-password', 'reset-password'];
    for (const path of paths) {
        const limit = AUTH_RATE_LIMITS[`/api/v1/auth/${path}`];
        assert.ok(limit, path);
        assert.equal(limit.windowMs, 15 * 60 * 1000);
    }
    assert.equal(AUTH_RATE_LIMITS['/api/v1/auth/login'].max, 20);
    assert.equal(AUTH_RATE_LIMITS['/api/v1/auth/verify-email'].max, 60);
    assert.ok(AUTH_RATE_LIMITS['/api/v1/auth/signup'].max <= 20);
    assert.ok(AUTH_RATE_LIMITS['/api/v1/auth/resend-verification'].max <= 20);
});
