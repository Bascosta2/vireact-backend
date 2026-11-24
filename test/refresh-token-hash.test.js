import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
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

// Verification links keep working (reused token, idempotent verify), re-signup cannot take over an
// unverified account, and auth emails are safe and clear.
// A one-document in-memory stand-in for the User model: no database needed.

/** Swap User.findOne/updateOne for an in-memory document; equality-only filters, $set/$unset updates. */
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
        for (const key of Object.keys(update.$unset || {})) delete doc[key];
        return { modifiedCount: 1 };
    };
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
const tokenIn = (message) => message.text.match(/token=([a-f0-9]{64})/)?.[1];
const passwordWorks = (doc, password) => bcrypt.compare(password, doc.password);

/** An unverified account created by a first signup with password "original-pw". */
const unverifiedAccount = async (overrides = {}) => ({
    _id: 'u1', name: 'First', email: 'pat@example.invalid', password: await User.hashPassword('original-pw'),
    isEmailVerified: false, emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: new Date(Date.now() + 7 * DAY),
    verificationEmailSentAt: new Date(Date.now() - EMAIL_RESEND_COOLDOWN_MS - 1), refreshToken: 'h0:x', refreshSessions: [{ hash: 'h0:x' }],
    ...overrides,
});

test('verificationTokenFor reuses a live link without extending it; a new 7-day link only when none, malformed, expired or under a day left', () => {
    const now = Date.now();
    const live = new Date(now + 3 * DAY);
    assert.deepEqual(verificationTokenFor({ emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: live }, now), { token: HEX('a'), expiresAt: live });

    const legacy = verificationTokenFor({ emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: null }, now);
    assert.equal(legacy.token, HEX('a'), 'link sent before expiries existed keeps working');
    assert.equal(legacy.expiresAt.getTime(), now + EMAIL_VERIFICATION_TTL_MS, 'and gets 7 days from its first resend');

    for (const user of [
        {},
        { emailVerificationToken: null },
        { emailVerificationToken: 'old' },
        { emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: new Date(now - 1) },
        { emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: new Date(now + DAY - 1) },
    ]) {
        const { token, expiresAt } = verificationTokenFor(user, now);
        assert.ok(isEmailLinkToken(token));
        assert.notEqual(token, HEX('a'));
        assert.equal(expiresAt.getTime(), now + 7 * DAY);
    }
    assert.equal(EMAIL_VERIFICATION_TTL_MS, 7 * DAY);
});

test('verify-email is idempotent: first use verifies, a second use says already_verified', async () => {
    const doc = await unverifiedAccount();
    await withFakeUser(doc, async (updates) => {
        assert.equal((await verifyEmailService(HEX('a'))).status, EMAIL_VERIFICATION_STATUS.VERIFIED);
        assert.equal(doc.isEmailVerified, true);
        assert.equal(doc.emailVerificationToken, HEX('a'), 'token kept so a second click is recognised');
        assert.deepEqual(updates[0].filter, { _id: 'u1', emailVerificationToken: HEX('a'), isEmailVerified: false });

        const again = await verifyEmailService(HEX('a'));
        assert.equal(again.status, EMAIL_VERIFICATION_STATUS.ALREADY_VERIFIED);
        assert.equal(updates.length, 1, 'second use changes nothing');

        await assert.rejects(verifyEmailService(HEX('c')), (e) => e.statusCode === 400, 'unknown token');
    });
});

test('verify-email: an expired link is a 400 and does not verify; a link without expiry (sent before this change) still works', async () => {
    const expired = await unverifiedAccount({ emailVerificationTokenExpiresAt: new Date(Date.now() - 1) });
    await withFakeUser(expired, async (updates) => {
        await assert.rejects(verifyEmailService(HEX('a')), (e) => e.statusCode === 400 && /expired/.test(e.message));
        assert.equal(expired.isEmailVerified, false);
        assert.equal(updates.length, 0);
    });
    const legacy = await unverifiedAccount({ emailVerificationTokenExpiresAt: null });
    await withFakeUser(legacy, async () => {
        assert.equal((await verifyEmailService(HEX('a'))).status, EMAIL_VERIFICATION_STATUS.VERIFIED);
        assert.equal(legacy.isEmailVerified, true);
    });
});

test('resend keeps the same link without extending it, and sends a text part from "Vireact <...>"', async () => {
    const expiresAt = new Date(Date.now() + 3 * DAY);
    const doc = await unverifiedAccount({ emailVerificationTokenExpiresAt: expiresAt, verificationEmailSentAt: null });
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            await resendEmailVerificationService(doc.email);
            doc.verificationEmailSentAt = new Date(Date.now() - EMAIL_RESEND_COOLDOWN_MS - 1);
            await resendEmailVerificationService(doc.email);
        });
        assert.equal(sent.length, 2);
        for (const message of sent) {
            assert.ok(message.html.includes(`token=${HEX('a')}`));
            assert.equal(tokenIn(message), HEX('a'), 'plain-text part carries the same link');
            assert.equal(message.from, formatFromAddress());
            assert.match(message.from, /<.+@.+>/, 'from has a display name');
            assert.equal(message.replyTo, replyToAddress());
        }
        assert.equal(doc.emailVerificationToken, HEX('a'));
        assert.equal(doc.emailVerificationTokenExpiresAt.getTime(), expiresAt.getTime(), 'resending does not extend the link');
    });
});

test('takeover blocked: a stranger re-signs up on an unverified address, the owner clicks their original link: the stranger\'s password does not work', async () => {
    const doc = await unverifiedAccount();
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            const attempt = await customSignupUserService('Attacker', doc.email, 'attacker-pw', 'local');
            assert.equal(attempt.pendingSignup, true);
            assert.equal(attempt.verificationEmail, VERIFICATION_EMAIL.SENT);
            assert.ok(await passwordWorks(doc, 'original-pw'), 'stored password untouched by re-signup');
            assert.equal(doc.name, 'First');
            assert.equal(doc.emailVerificationToken, HEX('a'), 'original link untouched');
            assert.ok(doc.pendingPasswordHash && !doc.pendingPasswordHash.includes('attacker-pw'), 'pending password is hashed');
            assert.ok(!JSON.stringify(sent).includes('attacker-pw'), 'password never emailed');
            const pendingToken = tokenIn(sent[0]);
            assert.notEqual(pendingToken, HEX('a'));
            assert.equal(doc.pendingVerificationTokenHash, crypto.createHash('sha256').update(pendingToken).digest('hex'), 'pending link stored hashed');

            // The inbox owner opens the link from their own first email.
            assert.equal((await verifyEmailService(HEX('a'))).status, EMAIL_VERIFICATION_STATUS.VERIFIED);
            assert.equal(doc.isEmailVerified, true);
            assert.ok(await passwordWorks(doc, 'original-pw'));
            assert.ok(!(await passwordWorks(doc, 'attacker-pw')), 'attacker password does not work');
            assert.equal(doc.name, 'First');
            assert.equal(doc.pendingPasswordHash, null, 'pending re-signup dropped');

            // The re-signup link (also only in the owner's inbox) now does nothing.
            await assert.rejects(verifyEmailService(pendingToken), (e) => e.statusCode === 400);
            assert.ok(!(await passwordWorks(doc, 'attacker-pw')));
            // Re-signup on the now verified address is refused.
            await assert.rejects(customSignupUserService('Attacker', doc.email, 'attacker-pw', 'local'), (e) => e.statusCode === 409);
        });
    });
});

test('owner forgot their password before verifying: re-signup, open the new link: the new password works and the old link retires', async () => {
    const doc = await unverifiedAccount();
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            await customSignupUserService('Pat', doc.email, 'new-owner-pw', 'local');
            const pendingToken = tokenIn(sent[0]);

            assert.equal((await verifyEmailService(pendingToken)).status, EMAIL_VERIFICATION_STATUS.VERIFIED);
            assert.equal(doc.isEmailVerified, true);
            assert.ok(await passwordWorks(doc, 'new-owner-pw'), 'new password works');
            assert.ok(!(await passwordWorks(doc, 'original-pw')));
            assert.equal(doc.name, 'Pat');
            assert.deepEqual(doc.refreshSessions, [], 'every device signed out');
            assert.equal(doc.refreshToken, undefined);
            assert.equal(doc.emailVerificationToken, null);
            assert.equal(doc.pendingPasswordHash, null);

            assert.equal((await verifyEmailService(pendingToken)).status, EMAIL_VERIFICATION_STATUS.ALREADY_VERIFIED, 'second click is fine');
            await assert.rejects(verifyEmailService(HEX('a')), (e) => e.statusCode === 400, 'original link retired');
        });
    });
});

test('owner re-signs up but opens the old link instead: verified with the original password', async () => {
    const doc = await unverifiedAccount();
    await withSentEmails(async () => {
        await withFakeUser(doc, async () => {
            await customSignupUserService('Pat', doc.email, 'new-owner-pw', 'local');
            assert.equal((await verifyEmailService(HEX('a'))).status, EMAIL_VERIFICATION_STATUS.VERIFIED);
            assert.ok(await passwordWorks(doc, 'original-pw'));
            assert.ok(!(await passwordWorks(doc, 'new-owner-pw')));
        });
    });
});

test('re-signup inside the 60 s cooldown is a 429 and changes nothing; an expired pending link does not verify', async () => {
    const doc = await unverifiedAccount({ verificationEmailSentAt: new Date() });
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async (updates) => {
            await assert.rejects(customSignupUserService('X', doc.email, 'other-pw-1', 'local'), (e) => e.statusCode === 429);
            assert.equal(updates.length, 0);
            assert.equal(sent.length, 0);
            assert.equal(doc.pendingPasswordHash, undefined);

            doc.verificationEmailSentAt = new Date(Date.now() - EMAIL_RESEND_COOLDOWN_MS - 1);
            await customSignupUserService('X', doc.email, 'other-pw-1', 'local');
            doc.pendingVerificationTokenExpiresAt = new Date(Date.now() - 1);
            await assert.rejects(verifyEmailService(tokenIn(sent[0])), (e) => e.statusCode === 400 && /expired/.test(e.message));
            assert.equal(doc.isEmailVerified, false);
            assert.ok(await passwordWorks(doc, 'original-pw'));
        });
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
