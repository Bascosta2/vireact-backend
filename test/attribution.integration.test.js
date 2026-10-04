import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, disconnectTestDb, fakeRes } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { storeFirstTouchAttribution } from '../src/service/attribution.service.js';
import { saveAttribution } from '../src/controller/auth.controller.js';

before(async () => { await connectTestDb(); });
after(async () => { await disconnectTestDb(); });

const newUser = (suffix) =>
    User.create({ name: 'Test', email: `attr-${suffix}-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true });

test('new users have no attribution field by default', async () => {
    const user = await newUser('default');
    const raw = await User.collection.findOne({ _id: user._id });
    assert.equal('attribution' in raw, false);
});

test('first-touch attribution is written once and never overwritten', async () => {
    const user = await newUser('once');
    assert.equal(await storeFirstTouchAttribution(user._id, { utm_source: 'tiktok', landing_path: '/' }), true);
    assert.equal(await storeFirstTouchAttribution(user._id, { utm_source: 'google' }), false);
    const stored = (await User.findById(user._id).lean()).attribution;
    assert.equal(stored.utm_source, 'tiktok');
    assert.equal(stored.landing_path, '/');
});

test('unsanitizable payloads are not written', async () => {
    const user = await newUser('junk');
    assert.equal(await storeFirstTouchAttribution(user._id, { $set: { role: 'admin' } }), false);
    const stored = await User.findById(user._id).lean();
    assert.equal(stored.attribution, undefined);
    assert.equal(stored.role, 'user');
});

test('POST /auth/attribution handler reports whether it stored', async () => {
    const user = await newUser('handler');
    const res = fakeRes();
    let err;
    await saveAttribution({ user: { _id: user._id }, body: { attribution: { utm_source: 'yt' } } }, res, (e) => { err = e; });
    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.stored, true);

    const unauth = fakeRes();
    await saveAttribution({ user: null, body: {} }, unauth, (e) => { err = e; });
    assert.equal(err.statusCode, 401);
});
