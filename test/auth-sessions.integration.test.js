import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectTestDb, disconnectTestDb } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import resend from '../src/lib/resend.js';
import {
    generateAccessToken,
    refreshTokenService,
    revokeRefreshSession,
    loginUserService,
    customSignupUserService,
    resendEmailVerificationService,
    forgotPasswordService,
    resetPasswordService,
    MAX_REFRESH_SESSIONS,
} from '../src/service/auth.service.js';

// Never send real email from tests: record instead.
const sent = [];
resend.emails.send = async (message) => {
    sent.push(message);
    return { data: { id: 'test' }, error: null };
};
console.log = () => {};
console.error = () => {};

before(async () => { await connectTestDb(); });
after(async () => { await disconnectTestDb(); });

const unique = (label) => `${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.invalid`;
const makeUser = (overrides = {}) =>
    User.create({ name: 'Test', email: unique('auth'), password: 'pw-123456', isEmailVerified: true, ...overrides });

test('two devices stay signed in: each refreshes on its own, replay of a rotated token is rejected', async () => {
    const user = await makeUser();
    const laptop = await generateAccessToken(user._id, User, 'User');
    const phone = await generateAccessToken(user._id, User, 'User');

    const laptop2 = await refreshTokenService(laptop.refreshToken);
    const phone2 = await refreshTokenService(phone.refreshToken);
    assert.ok(laptop2.refreshToken && phone2.refreshToken);

    await assert.rejects(refreshTokenService(laptop.refreshToken), (e) => e.statusCode === 401, 'replay rejected');
    assert.ok((await refreshTokenService(laptop2.refreshToken)).accessToken, 'laptop still works after the phone signed in');

    const stored = await User.findById(user._id).select('+refreshSessions').lean();
    assert.equal(stored.refreshSessions.length, 2);
});

test('logging out one device leaves the others signed in', async () => {
    const user = await makeUser();
    const a = await generateAccessToken(user._id, User, 'User');
    const b = await generateAccessToken(user._id, User, 'User');
    await revokeRefreshSession(user._id, a.refreshToken);
    await assert.rejects(refreshTokenService(a.refreshToken), (e) => e.statusCode === 401);
    assert.ok((await refreshTokenService(b.refreshToken)).accessToken);
});

test(`at most ${MAX_REFRESH_SESSIONS} devices: the oldest falls off`, async () => {
    const user = await makeUser();
    const tokens = [];
    for (let i = 0; i < MAX_REFRESH_SESSIONS + 1; i++) tokens.push(await generateAccessToken(user._id, User, 'User'));
    await assert.rejects(refreshTokenService(tokens[0].refreshToken), (e) => e.statusCode === 401);
    assert.ok((await refreshTokenService(tokens[MAX_REFRESH_SESSIONS].refreshToken)).accessToken);
});

test('a sign-in from before per-device sessions still refreshes and moves into the session list', async () => {
    const user = await makeUser();
    const raw = user.generateRefreshToken();
    const { hashRefreshToken } = await import('../src/utils/refresh-token-hash.js');
    await User.updateOne({ _id: user._id }, { $set: { refreshToken: hashRefreshToken(raw), refreshSessions: [] } });
    const out = await refreshTokenService(raw);
    assert.ok(out.refreshToken);
    assert.ok((await refreshTokenService(out.refreshToken)).accessToken);
    await assert.rejects(refreshTokenService(raw), (e) => e.statusCode === 401);
});

test('unverified user with the right password gets a clear 403 and a fresh link; wrong password stays generic', async () => {
    const user = await makeUser({ isEmailVerified: false, emailVerificationToken: 'old' });
    sent.length = 0;
    await assert.rejects(loginUserService(user.email, 'pw-123456'), (e) => e.statusCode === 403 && e.data?.code === 'EMAIL_NOT_VERIFIED');
    assert.equal(sent.length, 1, 'verification email resent');
    await assert.rejects(loginUserService(user.email, 'wrong-password'), (e) => e.statusCode === 401 && e.message === 'Invalid email or password');
    // Cooldown: an immediate second attempt does not send another email
    await assert.rejects(loginUserService(user.email.toUpperCase(), 'pw-123456'), (e) => e.statusCode === 403);
    assert.equal(sent.length, 1);
});

test('Google-only account trying a password gets told how to get in', async () => {
    const user = await User.create({ name: 'G', email: unique('google'), googleId: `g-${Date.now()}`, provider: 'google', isEmailVerified: true });
    await assert.rejects(loginUserService(user.email, 'anything'), (e) => e.statusCode === 409 && e.data?.code === 'USE_GOOGLE');
});

test('signup: duplicate verified email is 409 (not 500); unverified email restarts signup', async () => {
    const verified = await makeUser();
    await assert.rejects(customSignupUserService('X', verified.email, 'pw-123456', 'local'), (e) => e.statusCode === 409);

    const stuck = await makeUser({ isEmailVerified: false, emailVerificationToken: 'lost' });
    sent.length = 0;
    const again = await customSignupUserService('New Name', stuck.email, 'new-pass-1', 'local');
    assert.equal(again.name, 'New Name');
    assert.equal(sent.length, 1);
    const reloaded = await User.findById(stuck._id);
    assert.ok(await reloaded.comparePassword('new-pass-1'));
    assert.notEqual(reloaded.emailVerificationToken, 'lost');
});

test('resend verification answers the same for unknown, verified and unverified emails', async () => {
    const verified = await makeUser();
    const a = await resendEmailVerificationService(unique('nobody'));
    const b = await resendEmailVerificationService(verified.email);
    assert.deepEqual(a, b);
});

test('forgot + reset password: sets the password, verifies the email, signs out every device, single use', async () => {
    const user = await makeUser({ isEmailVerified: false });
    const device = await generateAccessToken(user._id, User, 'User');
    sent.length = 0;
    const generic = await forgotPasswordService(user.email);
    assert.equal(sent.length, 1);
    assert.deepEqual(await forgotPasswordService(unique('nobody')), generic, 'same answer for unknown email');

    const link = /reset-password\?token=([a-f0-9]{64})/.exec(sent[0].html);
    assert.ok(link, 'email contains a reset link');
    const out = await resetPasswordService(link[1], 'brand-new-pw');
    assert.equal(out.email, user.email);

    const reloaded = await User.findById(user._id).select('+refreshSessions');
    assert.ok(await reloaded.comparePassword('brand-new-pw'));
    assert.equal(reloaded.isEmailVerified, true);
    assert.equal(reloaded.refreshSessions.length, 0);
    await assert.rejects(refreshTokenService(device.refreshToken), (e) => e.statusCode === 401, 'old devices signed out');
    await assert.rejects(resetPasswordService(link[1], 'another-pw-1'), (e) => e.statusCode === 400, 'link is single use');
    assert.ok(await loginUserService(user.email, 'brand-new-pw'));
});

test('expired reset links and short passwords are rejected', async () => {
    const user = await makeUser();
    const token = crypto.randomBytes(32).toString('hex');
    await User.updateOne({ _id: user._id }, { $set: {
        passwordResetTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        passwordResetExpires: new Date(Date.now() - 1000),
    } });
    await assert.rejects(resetPasswordService(token, 'long-enough'), (e) => e.statusCode === 400);
    await assert.rejects(resetPasswordService(token, '123'), (e) => e.statusCode === 400);
    await assert.rejects(resetPasswordService('not-a-token', 'long-enough'), (e) => e.statusCode === 400);
});

test('a Google account can add a password through the reset flow', async () => {
    const user = await User.create({ name: 'G', email: unique('gpw'), googleId: `g2-${Date.now()}`, provider: 'google', isEmailVerified: true });
    sent.length = 0;
    await forgotPasswordService(user.email);
    assert.match(sent[0].subject, /Set a password/);
    const token = /token=([a-f0-9]{64})/.exec(sent[0].html)[1];
    await resetPasswordService(token, 'added-pw-1');
    assert.ok(await loginUserService(user.email, 'added-pw-1'));
});

test('Continue with Google links to an existing email account', async () => {
    const verified = await makeUser();
    const linked = await User.findOrCreateByGoogleProfile({ id: `g3-${Date.now()}`, emails: [{ value: verified.email.toUpperCase(), verified: true }], displayName: 'V' });
    assert.equal(String(linked._id), String(verified._id));
    const reloaded = await User.findById(verified._id);
    assert.ok(reloaded.googleId);
    assert.ok(await reloaded.comparePassword('pw-123456'), 'password login still works');

    // Never-verified account: the unproven password is dropped (pre-hijacking protection)
    const unverified = await makeUser({ isEmailVerified: false });
    await User.findOrCreateByGoogleProfile({ id: `g4-${Date.now()}`, emails: [{ value: unverified.email, verified: true }], displayName: 'U' });
    const after = await User.findById(unverified._id);
    assert.equal(after.isEmailVerified, true);
    assert.equal(after.password, undefined);
});
