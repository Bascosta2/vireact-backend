import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { hashRefreshToken, refreshTokenMatches, isHashedRefreshToken } from '../src/utils/refresh-token-hash.js';
import {
    verifyEmailService,
    resetPasswordService,
    loginAdminService,
    loginUserService,
    upgradePasswordHash,
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
    PASSWORD_MIN_LENGTH,
    EMAIL_RESEND_COOLDOWN_MS,
    VERIFICATION_EMAIL,
} from '../src/service/auth.service.js';
import resend from '../src/lib/resend.js';
import jwt from 'jsonwebtoken';
import { AUTH_RATE_LIMITS, BCRYPT_COST } from '../src/constants.js';
import { verifyAccessToken, verifyRefreshToken, JWT_ALGORITHM } from '../src/utils/jwt.js';
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
    const matches = (filter) => Object.entries(filter).every(([key, value]) => (value === null ? doc[key] == null : String(doc[key]) === String(value)));
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
const passwordWorks = async (doc, password) => Boolean(doc.password) && bcrypt.compare(password, doc.password);

/** An unverified account created by a first signup with password "original-pw". */
const unverifiedAccount = async (overrides = {}) => ({
    _id: 'u1', name: 'First', email: 'pat@example.invalid', password: await bcrypt.hash('original-pw', 10),
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
        assert.deepEqual(updates[0].filter, { _id: 'u1', emailVerificationToken: HEX('a'), isEmailVerified: false, competingSignupAt: null });

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

/** Run one competing-signups scenario: the first signup exists; `second` signs up again; then a link is opened. */
const resetTokenWorks = (doc, resetToken) =>
    doc.passwordResetTokenHash === crypto.createHash('sha256').update(resetToken).digest('hex') && doc.passwordResetExpires > new Date();

const assertSetPasswordOutcome = async (doc, result, sent) => {
    assert.equal(result.status, EMAIL_VERIFICATION_STATUS.VERIFIED_SET_PASSWORD);
    assert.ok(isEmailLinkToken(result.resetToken));
    assert.ok(resetTokenWorks(doc, result.resetToken), 'reset token stored hashed, valid for an hour');
    assert.ok(doc.passwordResetExpires.getTime() <= Date.now() + 60 * 60 * 1000);
    assert.equal(doc.isEmailVerified, true);
    assert.equal(doc.password, undefined, 'no password from either signup survives');
    assert.ok(!(await passwordWorks(doc, 'original-pw')));
    assert.ok(!(await passwordWorks(doc, 'second-pw')));
    assert.deepEqual(doc.refreshSessions, [], 'every device signed out');
    assert.equal(doc.refreshToken, undefined);
    assert.equal(doc.name, 'pat', 'neutral name, not one a stranger typed');
    const resetEmail = sent.at(-1);
    assert.equal(resetEmail.subject, 'Set a password for Vireact');
    assert.ok(resetEmail.text.includes(`reset-password?token=${result.resetToken}`), 'reset link emailed as a fallback');
    assert.ok(!JSON.stringify(sent).includes('second-pw'), 'passwords never emailed');

    const again = await verifyEmailService(HEX('a'));
    assert.equal(again.status, EMAIL_VERIFICATION_STATUS.ALREADY_VERIFIED, 'second click is fine');
    assert.equal(again.resetToken, undefined, 'reset token is handed out once');
    assert.match(again.message, /Set a password/);
};

test('takeover blocked (a): stranger re-signs up, owner opens the newest email: verified, no password kept, owner gets a reset token', async () => {
    const doc = await unverifiedAccount(); // the owner's own first signup
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            const attempt = await customSignupUserService('Attacker', doc.email, 'second-pw', 'local');
            assert.equal(attempt.pendingSignup, true);
            assert.equal(attempt.verificationEmail, VERIFICATION_EMAIL.SENT);
            assert.ok(doc.competingSignupAt instanceof Date);
            assert.ok(await passwordWorks(doc, 'original-pw'), 'nothing on the account changes at re-signup');
            assert.equal(doc.name, 'First');
            assert.equal(tokenIn(sent[0]), HEX('a'), 'the newest email carries the same link');

            const result = await verifyEmailService(tokenIn(sent[0]));
            await assertSetPasswordOutcome(doc, result, sent);
        });
    });
});

test('takeover blocked (b): stranger signs up first, owner re-signs up, owner opens the stranger\'s original email: no password kept, owner gets a reset token', async () => {
    const doc = await unverifiedAccount(); // the stranger's signup ("original-pw" is the stranger's)
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            await customSignupUserService('Owner', doc.email, 'second-pw', 'local');
            const result = await verifyEmailService(HEX('a')); // link from the first email
            await assertSetPasswordOutcome(doc, result, sent);
            await assert.rejects(customSignupUserService('Attacker', doc.email, 'x-pw-123', 'local'), (e) => e.statusCode === 409);
        });
    });
});

test('owner forgot their password before verifying: re-signup, open the link, set a new password with the reset token', async () => {
    const doc = await unverifiedAccount();
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            await customSignupUserService('Pat', doc.email, 'second-pw', 'local');
            const result = await verifyEmailService(tokenIn(sent[0]));
            assert.equal(result.status, EMAIL_VERIFICATION_STATUS.VERIFIED_SET_PASSWORD);

            // POST /auth/reset-password with the token (save() stands in for the database write).
            doc.save = async function () { if (this.password && !this.password.startsWith('$2')) this.password = await bcrypt.hash(this.password, 10); return this; };
            const original = User.findOne;
            User.findOne = (filter) => ({
                select: async () => (filter.passwordResetTokenHash === doc.passwordResetTokenHash && doc.passwordResetExpires > new Date() ? doc : null),
            });
            try {
                await resetPasswordService(result.resetToken, 'chosen-pw-1');
            } finally {
                User.findOne = original;
            }
            assert.ok(await passwordWorks(doc, 'chosen-pw-1'));
            assert.equal(doc.isEmailVerified, true);
        });
    });
});

test('a single signup is unchanged: verified with its own password, no reset token', async () => {
    const doc = await unverifiedAccount();
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async () => {
            const result = await verifyEmailService(HEX('a'));
            assert.deepEqual(Object.keys(result).sort(), ['message', 'status']);
            assert.equal(result.status, EMAIL_VERIFICATION_STATUS.VERIFIED);
            assert.ok(await passwordWorks(doc, 'original-pw'));
            assert.equal(doc.name, 'First');
            assert.equal(sent.length, 0);
        });
    });
});

test('a re-signup landing between the read and the write of a normal verify still takes the competing-signup path', async () => {
    const doc = await unverifiedAccount();
    await withSentEmails(async () => {
        await withFakeUser(doc, async () => {
            const realUpdate = User.updateOne;
            let raced = false;
            User.updateOne = async (filter, update) => {
                if (!raced && update.$set?.isEmailVerified) { raced = true; doc.competingSignupAt = new Date(); }
                return realUpdate(filter, update);
            };
            const result = await verifyEmailService(HEX('a'));
            assert.equal(result.status, EMAIL_VERIFICATION_STATUS.VERIFIED_SET_PASSWORD);
            assert.equal(doc.password, undefined, 'no password survives');
        });
    });
});

test('email down: an account marked as signed up more than once is never let in unverified', async () => {
    const original = resend.emails.send;
    const quiet = { error: console.error, warn: console.warn };
    resend.emails.send = async () => ({ data: null, error: { name: 'validation_error', message: 'The vireact.io domain is not verified.' } });
    console.error = () => {};
    console.warn = () => {};
    try {
        const marked = await unverifiedAccount({ competingSignupAt: new Date() });
        marked.comparePassword = (pw) => passwordWorks(marked, pw);
        await withFakeUser(marked, async () => {
            await assert.rejects(loginUserService(marked.email, 'original-pw'), (e) => e.statusCode === 403 && e.data?.code === 'EMAIL_NOT_VERIFIED');
        });
        const plain = await unverifiedAccount();
        plain.comparePassword = (pw) => passwordWorks(plain, pw);
        await withFakeUser(plain, async () => {
            assert.equal((await loginUserService(plain.email, 'original-pw'))._id, 'u1', 'single signup still let in while email is down');
        });
    } finally {
        resend.emails.send = original;
        Object.assign(console, quiet);
    }
});

test('re-signup inside the 60 s cooldown is a 429 and changes nothing', async () => {
    const doc = await unverifiedAccount({ verificationEmailSentAt: new Date() });
    await withSentEmails(async (sent) => {
        await withFakeUser(doc, async (updates) => {
            await assert.rejects(customSignupUserService('X', doc.email, 'second-pw', 'local'), (e) => e.statusCode === 429);
            assert.equal(updates.length, 0);
            assert.equal(sent.length, 0);
            assert.equal(doc.competingSignupAt, undefined);
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

// JWT hardening: one algorithm (HS256), typed tokens (`typ`), and tokens issued before `typ` existed keep
// working as their own type only. No database needed.

const ACCESS_SECRET = 'a'.repeat(40);
const REFRESH_SECRET = 'r'.repeat(40);

/** Run fn with these JWT secrets (refresh undefined = unset, so it falls back to the access secret). */
const withJwtSecrets = (access, refresh, fn) => {
    const prev = { access: process.env.ACCESS_TOKEN_SECRET, refresh: process.env.REFRESH_TOKEN_SECRET };
    process.env.ACCESS_TOKEN_SECRET = access;
    if (refresh === undefined) delete process.env.REFRESH_TOKEN_SECRET;
    else process.env.REFRESH_TOKEN_SECRET = refresh;
    try {
        return fn();
    } finally {
        for (const [key, value] of [['ACCESS_TOKEN_SECRET', prev.access], ['REFRESH_TOKEN_SECRET', prev.refresh]]) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const isInvalidToken = (e) => e?.name === 'JsonWebTokenError';

test('user and admin tokens are HS256 with typ, and each type is rejected where the other is expected', () => {
    for (const refreshSecret of [REFRESH_SECRET, undefined]) {
        withJwtSecrets(ACCESS_SECRET, refreshSecret, () => {
            for (const account of [new User({ name: 'T', email: 't@example.invalid' }), new Admin({ name: 'A', email: 'a@example.invalid', password: 'x' })]) {
                const access = account.generateAccessToken();
                const refresh = account.generateRefreshToken();
                assert.equal(jwt.decode(access, { complete: true }).header.alg, JWT_ALGORITHM);
                assert.equal(jwt.decode(access).typ, 'access');
                assert.equal(jwt.decode(refresh).typ, 'refresh');
                assert.equal(verifyAccessToken(access)._id, String(account._id));
                assert.equal(verifyRefreshToken(refresh)._id, String(account._id));
                assert.throws(() => verifyAccessToken(refresh), isInvalidToken);
                assert.throws(() => verifyRefreshToken(access), isInvalidToken);
            }
        });
    }
});

test('only HS256 is accepted: alg none and other HMAC algorithms are rejected', () => {
    withJwtSecrets(ACCESS_SECRET, REFRESH_SECRET, () => {
        const payload = { _id: 'u1', typ: 'access' };
        const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const exp = Math.floor(Date.now() / 1000) + 600;
        const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, exp })}.`;
        assert.throws(() => verifyAccessToken(unsigned), isInvalidToken);
        for (const algorithm of ['HS384', 'HS512']) {
            const token = jwt.sign(payload, ACCESS_SECRET, { algorithm, expiresIn: '30m' });
            assert.throws(() => verifyAccessToken(token), isInvalidToken, algorithm);
        }
        // A caller can never widen the allowed algorithms.
        const hs512 = jwt.sign(payload, ACCESS_SECRET, { algorithm: 'HS512', expiresIn: '30m' });
        assert.throws(() => verifyAccessToken(hs512, { algorithms: ['HS512'] }), isInvalidToken);
    });
});

test('tokens issued before typ existed still work as their own type during the transition, never the other', () => {
    for (const refreshSecret of [REFRESH_SECRET, undefined]) {
        withJwtSecrets(ACCESS_SECRET, refreshSecret, () => {
            const refreshKey = refreshSecret || ACCESS_SECRET;
            const legacyAccess = jwt.sign({ _id: 'u1', email: 'u@example.invalid' }, ACCESS_SECRET, { expiresIn: '30m' });
            const legacyRefresh = jwt.sign({ _id: 'u1', email: 'u@example.invalid', jti: 'j1' }, refreshKey, { expiresIn: '30d' });
            assert.equal(verifyAccessToken(legacyAccess)._id, 'u1');
            assert.equal(verifyRefreshToken(legacyRefresh)._id, 'u1');
            assert.throws(() => verifyAccessToken(legacyRefresh), isInvalidToken);
            assert.throws(() => verifyRefreshToken(legacyAccess), isInvalidToken);
        });
    }
});

test('an expired refresh token still identifies the session at logout (ignoreExpiration), but not for refreshing', () => {
    withJwtSecrets(ACCESS_SECRET, REFRESH_SECRET, () => {
        const now = Math.floor(Date.now() / 1000);
        for (const extra of [{ typ: 'refresh' }, {}]) {
            const expired = jwt.sign({ _id: 'u1', iat: now - 40 * 86400, exp: now - 10 * 86400, ...extra }, REFRESH_SECRET);
            assert.equal(verifyRefreshToken(expired, { ignoreExpiration: true })._id, 'u1');
            assert.throws(() => verifyRefreshToken(expired), (e) => e?.name === 'TokenExpiredError');
        }
    });
});

test('admin login: unknown email and wrong password get the same 401 "Invalid email or password"', async () => {
    const original = Admin.findOne;
    const admin = { _id: 'a1', comparePassword: async (pw) => pw === 'right-password' };
    try {
        const messages = [];
        for (const found of [null, admin]) {
            Admin.findOne = async () => found;
            await assert.rejects(loginAdminService('admin@example.invalid', 'wrong-password'), (e) => {
                messages.push(e.message);
                return e.statusCode === 401;
            });
        }
        assert.deepEqual(messages, ['Invalid email or password', 'Invalid email or password']);
        Admin.findOne = async () => admin;
        assert.equal(await loginAdminService('admin@example.invalid', 'right-password'), admin);
    } finally {
        Admin.findOne = original;
    }
});

test('new password hashes use bcrypt cost 12; existing cost-10 hashes still log in', async () => {
    assert.equal(BCRYPT_COST, 12);
    const user = new User({ name: 'T', email: 'cost@example.invalid', password: 'new-password-1' });
    // Run the model's pre-save hooks (where the password is hashed) without a database.
    await new Promise((resolve, reject) => User.schema.s.hooks.execPre('save', user, [], (err) => (err ? reject(err) : resolve())));
    assert.equal(bcrypt.getRounds(user.password), 12);
    assert.ok(await user.comparePassword('new-password-1'));

    const old = new User({ name: 'O', email: 'old@example.invalid' });
    old.password = bcrypt.hashSync('old-password', 10);
    assert.ok(await old.comparePassword('old-password'));
    assert.ok(!(await old.comparePassword('wrong-password')));
});

test('signup and password reset need at least 8 characters (checked before any query)', async () => {
    assert.equal(PASSWORD_MIN_LENGTH, 8);
    const spy = spyFindOne(User);
    try {
        await assert.rejects(customSignupUserService('X', 'short@example.invalid', '7-chars', 'local'), (e) => e.statusCode === 400 && /at least 8/.test(e.message));
        await assert.rejects(resetPasswordService('a'.repeat(64), '7-chars'), (e) => e.statusCode === 400 && /at least 8/.test(e.message));
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

test('a successful login re-hashes a cost-10 password at cost 12, once, and never fails the login', async () => {
    const fakeModel = (doc, { fail = false } = {}) => ({
        calls: [],
        async updateOne(filter, update) {
            this.calls.push(filter);
            if (fail) throw new Error('db down');
            if (String(filter._id) !== String(doc._id) || filter.password !== doc.password) return { modifiedCount: 0 };
            doc.password = update.$set.password;
            return { modifiedCount: 1 };
        },
    });
    const doc = { _id: 'a1', password: bcrypt.hashSync('right-password', 10) };
    const model = fakeModel(doc);
    assert.equal(await upgradePasswordHash(model, { ...doc }, 'right-password'), true);
    assert.equal(bcrypt.getRounds(doc.password), BCRYPT_COST);
    assert.ok(bcrypt.compareSync('right-password', doc.password));
    // Already at cost 12, not a bcrypt hash, or no password: nothing to do.
    for (const account of [{ ...doc }, { _id: 'a1', password: 'hash' }, { _id: 'a1' }]) {
        assert.equal(await upgradePasswordHash(model, account, 'right-password'), false);
    }
    assert.equal(model.calls.length, 1);
    // A database error is swallowed.
    const quiet = console.warn;
    console.warn = () => {};
    try {
        const old = { _id: 'a2', password: bcrypt.hashSync('pw-123456', 10) };
        assert.equal(await upgradePasswordHash(fakeModel(old, { fail: true }), old, 'pw-123456'), false);
    } finally {
        console.warn = quiet;
    }
});

test('admin login upgrades a cost-10 admin hash on success', async () => {
    const original = { findOne: Admin.findOne, updateOne: Admin.updateOne };
    const admin = new Admin({ name: 'A', email: 'up@example.invalid', password: bcrypt.hashSync('right-password', 10) });
    const updates = [];
    Admin.findOne = async () => admin;
    Admin.updateOne = async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; };
    try {
        assert.equal(await loginAdminService('up@example.invalid', 'right-password'), admin);
        assert.equal(updates.length, 1);
        assert.equal(bcrypt.getRounds(updates[0].update.$set.password), BCRYPT_COST);
        await assert.rejects(loginAdminService('up@example.invalid', 'wrong-password'), (e) => e.statusCode === 401);
        assert.equal(updates.length, 1, 'no upgrade on a wrong password');
    } finally {
        Object.assign(Admin, original);
    }
});
