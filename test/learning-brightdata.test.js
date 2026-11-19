import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
console.warn = () => {};

const { createBrightDataAdapter, DATASETS, isMediaUrl, mediaHeaders } = await import('../src/service/learning/social/brightdata.js');
const { getProvider, cleanVideo, cleanCreator } = await import('../src/service/learning/social/providers.js');

/** A record shaped like the live API's (2026-11-19 probe). */
const post = (id, extra = {}) => ({
    url: `https://www.tiktok.com/@healthbyarta/video/${id}`, post_id: id, description: 'never regretted showing up #fitness',
    create_time: '2026-10-29T15:33:46.000Z', digg_count: 3300, share_count: '45', num_share_count: 45, collect_count: 120,
    comment_count: 40, play_count: 77300, video_duration: 27, hashtags: ['fitness', 'gym'], original_sound: 'original sound',
    profile_id: '6800000000000000001', profile_username: 'Arta', account_id: 'healthbyarta', profile_followers: 15500,
    post_type: 'video', region: 'US', music: { id: '7702113400000000000', title: 'original sound - arta' }, ...extra,
});

const json = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** Fake API: trigger -> snapshot; progress runs `progress` statuses in order; snapshot returns `records`. */
const fakeApi = ({ records, progress = ['running', 'ready'], snapshot = null, triggerResponses = [] } = {}) => {
    const calls = [];
    let p = 0;
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.Authorization });
        if (url.includes('/trigger')) return triggerResponses.shift() ?? json(200, { snapshot_id: 'sd_test' });
        if (url.includes('/progress/')) return json(200, { status: progress[Math.min(p++, progress.length - 1)], error_message: 'Account is suspended' });
        if (url.includes('/snapshot/')) return snapshot ?? json(200, records);
        throw new Error(`unexpected ${url}`);
    };
    return { calls, fetchImpl, adapter: createBrightDataAdapter({ apiKey: 'k', fetchImpl, sleep: async () => {}, pollMs: 0 }) };
};

test('search: maps records to the provider contract, skips errors and non-videos, counts billable records', async () => {
    const { calls, adapter } = fakeApi({ records: [post('7702113368282254605'), post('7702113368282254606', { post_type: 'image' }), { error: 'x', error_code: 'dead_page' }] });
    const out = await adapter.searchVideos({ query: 'morning routine', limit: 30 });
    const trigger = calls[0];
    assert.match(trigger.url, new RegExp(`dataset_id=${DATASETS.search}`));
    assert.equal(trigger.auth, 'Bearer k');
    assert.deepEqual(trigger.body, { input: [{ url: 'https://www.tiktok.com/search?q=morning%20routine' }], limit_per_input: 30 });
    assert.equal(out.used, 2, 'error records are not billed');
    assert.equal(out.videos.length, 1);
    const v = cleanVideo(out.videos[0]);
    assert.equal(v.externalId, '7702113368282254605');
    assert.equal(v.creatorExternalId, '6800000000000000001');
    assert.equal(v.views, 77300);
    assert.equal(v.likes, 3300);
    assert.equal(v.shares, 45);
    assert.equal(v.saves, 120);
    assert.equal(v.durationSec, 27);
    assert.equal(v.soundId, '7702113400000000000');
    assert.deepEqual(v.hashtags, ['fitness', 'gym']);
    assert.equal(v.postedAt.toISOString(), '2026-10-29T15:33:46.000Z');
    assert.deepEqual(cleanCreator(out.creators[0]), { externalId: '6800000000000000001', handle: 'healthbyarta', followers: 15500 });
});

test('creator videos: uses the handle (account_id) profile URL; no handle is an error', async () => {
    const { calls, adapter } = fakeApi({ records: [post('1'), post('2')] });
    const out = await adapter.creatorVideos({ externalId: '6800000000000000001', handle: 'healthbyarta', limit: 30 });
    assert.match(calls[0].url, new RegExp(`dataset_id=${DATASETS.creator}`));
    assert.deepEqual(calls[0].body.input, [{ url: 'https://www.tiktok.com/@healthbyarta' }]);
    assert.equal(out.videos.length, 2);
    assert.equal(out.creator.handle, 'healthbyarta');
    await assert.rejects(adapter.creatorVideos({ externalId: 'x', handle: null }), /handle/);
});

test('video stats: one job for the whole batch, by stored URL', async () => {
    const { calls, adapter } = fakeApi({ records: [post('1', { play_count: 90000 }), post('2', { play_count: 5 })] });
    const videos = [{ externalId: '1', url: 'https://www.tiktok.com/@a/video/1' }, { externalId: '2', url: 'https://www.tiktok.com/@b/video/2' }, { externalId: '3', url: null }];
    const out = await adapter.videoStats({ ids: ['1', '2', '3'], videos });
    const triggers = calls.filter((c) => c.url.includes('/trigger'));
    assert.equal(triggers.length, 1);
    assert.match(triggers[0].url, new RegExp(`dataset_id=${DATASETS.stats}`));
    assert.equal(triggers[0].body.input.length, 2, 'a video without a URL is skipped');
    assert.deepEqual(out.stats.map((s) => [s.externalId, s.views]), [['1', 90000], ['2', 5]]);
    assert.deepEqual(await adapter.videoStats({ ids: ['9'], videos: [] }), { stats: [], used: 0 });
});

test('video stats extras: file link, captions (fetched with the session cookie), cover, top comments; other hosts ignored', async () => {
    const sub = 'https://v16-webapp.tiktokcdn-us.com/abc/video/tos/sub.vtt';
    const rec = post('1', {
        video_url: 'https://v16-webapp-prime.us.tiktok.com/video/tos/x.mp4', cdn_url: 'https://www.tiktok.com/64e60a48', tt_chain_token: 'tok123',
        subtitle_url: sub, subtitle_info: [{ url: sub, language_code_name: 'eng-US', url_expire: '1795298421' }],
        preview_image: 'https://p16-sign.tiktokcdn-us.com/cover.jpeg',
        comments: [{ comment: 'part 2 please', user_handle: 'someone', likes: 5, num_of_replies: 1, date: '2026-11-18T19:58:20.000Z' }, { comment: 'wow', likes: 50 }, { comment: '  ' }],
    });
    const evil = post('2', { video_url: 'https://evil.example.com/x.mp4', cdn_link: 'http://v16.tiktok.com/x.mp4', subtitle_url: 'https://169.254.169.254/latest' });
    const seen = [];
    const base = fakeApi({ records: [rec, evil] });
    const fetchImpl = async (url, init = {}) => {
        if (url === sub) {
            seen.push(init.headers);
            return { ok: true, status: 200, text: async () => 'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nyou need this\n' };
        }
        if (!url.includes('api.brightdata.com')) throw new Error(`unexpected fetch ${url}`);
        return base.fetchImpl(url, init);
    };
    const adapter = createBrightDataAdapter({ apiKey: 'k', fetchImpl, sleep: async () => {}, pollMs: 0 });
    const out = await adapter.videoStats({ ids: ['1', '2'], videos: [{ externalId: '1', url: 'https://www.tiktok.com/@a/video/1' }, { externalId: '2', url: 'https://www.tiktok.com/@a/video/2' }] });
    const [e1, e2] = out.extras;
    assert.equal(e1.videoUrl, 'https://v16-webapp-prime.us.tiktok.com/video/tos/x.mp4', 'the file link, not the tiktok.com page link');
    assert.deepEqual(e1.subtitle, { url: sub, language: 'eng-US' });
    assert.deepEqual(e1.captions, [{ text: 'you need this', tStart: 0.5, tEnd: 2 }]);
    assert.equal(seen[0].Cookie, 'tt_chain_token=tok123');
    assert.equal(seen[0].Referer, 'https://www.tiktok.com/');
    assert.deepEqual(e1.topComments.map((c) => [c.text, c.likes]), [['wow', 50], ['part 2 please', 5]], 'sorted by likes, empty dropped');
    assert.ok(!('user_handle' in e1.topComments[0]), 'no commenter handles kept');
    assert.equal(e1.coverUrl, 'https://p16-sign.tiktokcdn-us.com/cover.jpeg');
    assert.equal(e2.videoUrl, null, 'non-TikTok and non-https links are ignored');
    assert.equal(e2.subtitle, null);
    assert.equal(seen.length, 1, 'never fetches a non-TikTok captions link');
});

test('media hosts and headers', () => {
    assert.equal(isMediaUrl('https://v16m-webapp.tiktokcdn-us.com/a'), true);
    assert.equal(isMediaUrl('https://www.tiktok.com/@a/video/1'), true);
    assert.equal(isMediaUrl('https://tiktok.com.evil.io/a'), false);
    assert.equal(isMediaUrl('http://v16.tiktokcdn.com/a'), false);
    assert.equal(isMediaUrl('not a url'), false);
    assert.equal(mediaHeaders('bad token\r\nX: y').Cookie, undefined, 'a malformed token is not sent');
});

test('job handling: empty snapshot, failed job, 429 retry', async () => {
    const empty = fakeApi({ snapshot: json(400, 'Snapshot is empty') });
    assert.deepEqual((await empty.adapter.searchVideos({ query: 'x' })).videos, []);

    const failed = fakeApi({ progress: ['running', 'failed'] });
    await assert.rejects(failed.adapter.searchVideos({ query: 'x' }), /failed: Account is suspended/);

    const limited = fakeApi({ records: [post('1')], triggerResponses: [json(429, 'too many running jobs', { 'retry-after': '1' })] });
    const out = await limited.adapter.searchVideos({ query: 'x' });
    assert.equal(out.videos.length, 1);
    assert.equal(limited.calls.filter((c) => c.url.includes('/trigger')).length, 2);

    const bad = fakeApi({ triggerResponses: [json(401, 'Invalid credentials')] });
    await assert.rejects(bad.adapter.searchVideos({ query: 'x' }), /trigger 401: Invalid credentials/);
});

test('registered as LEARNING_PROVIDER=brightdata; needs the key', async () => {
    assert.equal(getProvider({ LEARNING_PROVIDER: 'brightdata' }), null);
    const p = getProvider({ LEARNING_PROVIDER: 'BrightData', BRIGHTDATA_API_KEY: 'k' });
    assert.equal(p.name, 'brightdata');
    assert.equal(typeof p.searchVideos, 'function');
});
