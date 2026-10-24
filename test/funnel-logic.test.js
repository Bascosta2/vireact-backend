import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchHooks } from '../src/service/library/matcher.js';
import { PROBLEM_CATEGORY_MAP, MID_VIDEO_TEXT_CATEGORY } from '../src/constants/problem-category-map.js';
import { PROBLEMS } from '../src/constants/library.js';
import {
    QUIZ_OPTIONS,
    sanitizeAnswers,
    isQuizComplete,
    isHighIntent,
    recommendedPlanFor,
} from '../src/constants/funnel-quiz.js';
import { buildDiagnosis } from '../src/constants/funnel-diagnosis.js';
import { screenRewrites, rewriteHook } from '../src/service/hook-rewriter.service.js';
import { getAccessState, computePostAuthPath, isEntitledState } from '../src/service/access.service.js';

const hook = (slug, category, extra = {}) => ({ slug, type: 'hook', category, order: 1, niches: [], problemTags: [], platforms: [], ...extra });

test('every problem maps to at least one category and every problem is mapped', () => {
    assert.deepEqual(Object.keys(PROBLEM_CATEGORY_MAP).sort(), [...PROBLEMS].sort());
    for (const categories of Object.values(PROBLEM_CATEGORY_MAP)) assert.ok(categories.length > 0);
});

test('matcher hides the block when fewer than 3 public hooks exist', () => {
    const result = matchHooks([hook('a', 'Relatable Hooks'), hook('b', 'Relatable Hooks')], { problem: 'swipe_first_3s' });
    assert.deepEqual(result, { items: [], strongMatches: 0, hooksHidden: true });
});

test('matcher orders featured problem-tagged hooks first, then mapped categories, then the rest', () => {
    const pool = [
        hook('other', 'Money and Success Hooks'),
        hook('mapped-2', 'Suspense Shock Hooks'),
        hook('mapped-1', 'Content, Curiosity hooks (powerful)'),
        hook('featured', 'Relatable Hooks', { featuredFree: true, problemTags: ['swipe_first_3s'] }),
    ];
    const result = matchHooks(pool, { problem: 'swipe_first_3s' });
    assert.deepEqual(result.items.map((i) => i.slug), ['featured', 'mapped-1', 'mapped-2']);
    assert.equal(result.strongMatches, 3);
});

test('matcher returns 5 only with at least 5 strong matches, and prefers niche matches', () => {
    const cat = 'Content, Curiosity hooks (powerful)';
    const five = ['a', 'b', 'c', 'd', 'e'].map((s) => hook(s, cat));
    five[4].niches = ['food'];
    const result = matchHooks(five, { problem: 'swipe_first_3s', niche: 'food' });
    assert.equal(result.items.length, 5);
    assert.equal(result.items[0].slug, 'e');

    const fewStrong = [hook('a', cat), hook('x', 'Relatable Hooks'), hook('y', 'Relatable Hooks'), hook('z', 'Relatable Hooks'), hook('w', 'Relatable Hooks')];
    assert.equal(matchHooks(fewStrong, { problem: 'swipe_first_3s' }).items.length, 3);
});

test('mid-video text lines only fill results for the mid-video problem', () => {
    const pool = [hook('m1', MID_VIDEO_TEXT_CATEGORY), hook('m2', MID_VIDEO_TEXT_CATEGORY), hook('r1', 'Relatable Hooks'), hook('r2', 'Money and Success Hooks')];
    const swipe = matchHooks(pool, { problem: 'swipe_first_3s' });
    assert.ok(swipe.items.every((i) => i.category !== MID_VIDEO_TEXT_CATEGORY));
    const mid = matchHooks(pool, { problem: 'mid_video_dropoff' });
    assert.deepEqual(mid.items.slice(0, 2).map((i) => i.slug), ['m1', 'm2']);
});

test('matcher puts a valid entry item first', () => {
    const pool = ['a', 'b', 'c', 'd'].map((s) => hook(s, 'Relatable Hooks'));
    assert.equal(matchHooks(pool, { problem: 'views_plateau', preferSlug: 'd' }).items[0].slug, 'd');
});

test('quiz answers are enum-checked', () => {
    assert.deepEqual(sanitizeAnswers({ platform: 'tiktok', niche: 'nope', extra: 1 }), { answers: { platform: 'tiktok' }, errors: ['niche is invalid'] });
    const full = Object.fromEntries(Object.entries(QUIZ_OPTIONS).map(([k, v]) => [k, v[0]]));
    assert.equal(isQuizComplete(full), true);
    assert.equal(isQuizComplete({ ...full, persona: undefined }), false);
});

test('high intent and recommended plan follow plan §6.4', () => {
    assert.equal(isHighIntent({ persona: 'agency_multi_creator', followers: 'lt_1k', cadence: '0_1' }), true);
    assert.equal(isHighIntent({ persona: 'solo_creator', followers: '100k_1m', cadence: '0_1' }), true);
    assert.equal(isHighIntent({ persona: 'brand_business', followers: 'lt_1k', cadence: '5_10' }), true);
    assert.equal(isHighIntent({ persona: 'brand_business', followers: 'lt_1k', cadence: '2_4' }), false);
    assert.equal(isHighIntent({ persona: 'solo_creator', followers: '10k_100k', cadence: '10_plus' }), false);

    assert.equal(recommendedPlanFor({ persona: 'solo_creator', followers: '1k_10k' }), 'premium');
    assert.equal(recommendedPlanFor({ persona: 'solo_creator', followers: '10k_100k' }), 'pro');
    assert.equal(recommendedPlanFor({ persona: 'brand_business', followers: 'lt_1k' }), 'pro');
});

test('diagnosis copy exists for every problem and contains no numbers', () => {
    for (const problem of PROBLEMS) {
        for (const platform of QUIZ_OPTIONS.platform) {
            const d = buildDiagnosis({ problem, niche: 'other', platform });
            assert.ok(d.headline && d.body && d.nextStep);
            assert.doesNotMatch(`${d.headline} ${d.body} ${d.nextStep}`, /\d|%/);
        }
    }
    assert.equal(buildDiagnosis({ problem: 'unknown' }), null);
});

const HOOK = 'today I made pasta';
const exemplars = [{ slug: 'curiosity-1', displayText: 'You won\u2019t believe ___' }];

test('screenRewrites drops placeholders, copies of the original and unknown slugs', () => {
    const { accepted, rejected } = screenRewrites(
        {
            diagnosis: 'The line gives no reason to keep watching.',
            rewrites: [
                { line: 'This pasta trick broke every rule my grandmother taught me', sourceItemSlug: 'curiosity-1' },
                { line: 'You won\u2019t believe ___', sourceItemSlug: 'curiosity-1' },
                { line: 'Today I made pasta', sourceItemSlug: null },
                { line: 'I ruined pasta three times before this worked', sourceItemSlug: 'made-up' },
            ],
        },
        { hookLine: HOOK, exemplarSlugs: new Set(['curiosity-1']) }
    );
    assert.equal(accepted.length, 2);
    assert.equal(accepted[1].sourceItemSlug, null);
    assert.equal(rejected.length, 2);
});

test('rewriteHook retries once with corrections, then fails closed', async () => {
    const calls = [];
    const good = { diagnosis: 'It describes the dish but not the stakes.', rewrites: [
        { line: 'My pasta went viral for the wrong reason', sourceItemSlug: 'curiosity-1' },
        { line: 'I almost threw this pasta away', sourceItemSlug: null },
        { line: 'Nobody expected this pasta to work', sourceItemSlug: null },
    ] };
    const complete = async (args) => {
        calls.push(args);
        return calls.length === 1 ? { diagnosis: 'x', rewrites: [{ line: '[your hook]', sourceItemSlug: null }] } : good;
    };
    const result = await rewriteHook({ hookLine: HOOK }, { complete, exemplars });
    assert.equal(calls.length, 2);
    assert.equal(result.rewrites.length, 3);
    assert.match(calls[1].messages.at(-1).content, /rejected/);

    const bad = async () => ({ diagnosis: 'x', rewrites: [] });
    await assert.rejects(rewriteHook({ hookLine: HOOK }, { complete: bad, exemplars }), (e) => e.code === 'REWRITE_FAILED');
});

test('access state before Phase 6 and post-auth paths', () => {
    const user = { _id: 'u' };
    assert.equal(getAccessState(user, null, { model: 'legacy_free' }), 'legacy_free');
    assert.equal(getAccessState(user, null, { model: 'card_trial' }), 'lead');
    assert.equal(getAccessState({ ...user, legacyFree: true }, null, { model: 'card_trial' }), 'legacy_free');
    assert.equal(getAccessState(user, { plan: 'pro', status: 'active' }), 'active');
    assert.equal(getAccessState(user, { plan: 'pro', status: 'active', paymentFailed: true }), 'past_due');
    assert.equal(getAccessState(user, { plan: 'free', status: 'active' }, { model: 'legacy_free' }), 'legacy_free');
    assert.equal(isEntitledState('past_due'), false);
    assert.equal(getAccessState(null, null), null);

    assert.equal(computePostAuthPath('lead'), '/start/trial');
    assert.equal(computePostAuthPath('legacy_free', { hasUploaded: false }), '/upload?onboarding=1');
    assert.equal(computePostAuthPath('active', { hasUploaded: true }), '/dashboard');
    assert.equal(computePostAuthPath('past_due'), '/dashboard');
});
