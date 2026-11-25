import test from 'node:test';
import assert from 'node:assert/strict';
import { autoTitleFromTranscript, VIDEO_SUMMARY_FIELDS } from '../src/lib/video-summary.js';

test('automatic names come from the first spoken words, cut at a word', () => {
    assert.equal(autoTitleFromTranscript([{ text: 'So here is why your hooks fail.' }]), 'So here is why your hooks fail');
    assert.equal(autoTitleFromTranscript([{ text: 'Stop' }]), null, 'one word is not a name');
    assert.equal(autoTitleFromTranscript([]), null);
    assert.equal(autoTitleFromTranscript(undefined), null);
    const long = autoTitleFromTranscript([
        { text: 'Three things nobody tells you about growing on TikTok in your first month,' },
        { text: 'and the second one surprised me.' },
    ]);
    assert.ok(long.endsWith('…'));
    assert.ok(long.length <= 61, long);
    assert.doesNotMatch(long, /\s…$|,…$/, 'no dangling space or comma before the ellipsis');
    assert.ok('Three things nobody tells you about growing on TikTok in your first month'.startsWith(long.slice(0, -1)));
});

test('the list sends what the Library needs to name and sort videos', () => {
    for (const f of ['title', 'sourceTitle', 'duration', 'postedAt', 'creatorPlatform', 'actualViews', 'thumbnailUrl']) {
        assert.ok(VIDEO_SUMMARY_FIELDS.split(' ').includes(f), f);
    }
    assert.ok(!VIDEO_SUMMARY_FIELDS.includes('rawTranscript'), 'the transcript itself never goes in the list');
});
