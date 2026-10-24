import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractHookPdfDrafts, slugify, titleFromLine } from '../src/service/library/extract-hooks-pdf.js';
import { classifyKbProvenance, isThirdPartyProvenance } from '../src/service/library/kb-readonly.js';
import { normalizeReviewedItem, importReviewedItems } from '../src/service/library/import-items.js';
import { buildAdminPatch } from '../src/service/library/admin-library.js';

const KB_A = '64b000000000000000000001';
const KB_B = '64b000000000000000000002';

// Synthetic two-chunk fixture shaped like the hooks PDF (not owner text).
const FIXTURE = [
    {
        _id: KB_B,
        metadata: { chunkIndex: 1 },
        content: [
            '\u25CF Nobody tells you this about ___',
            'Viral Storytelling structure',
            'Main Structure of My Shorts',
            'Start with the conflict.',
            'Then raise the stakes.',
            'Proven Viral-Worthy Examples for Introducing the Story',
            '\u25CF (EX#1) \u201CIt started as a normal',
            'morning\u201D',
            '\u25CF (EX#2) "Then the door opened"',
            '-- 2 of 2 --',
        ].join('\n'),
    },
    {
        _id: KB_A,
        metadata: { chunkIndex: 0 },
        content: [
            'Intro text that is not a hook.',
            '________________',
            'Curiosity',
            'Hooks:',
            '\u25CF You won\u2019t believe what happened next',
            '\u25CF Stop scrolling if you ___',
            'Relatable',
            '\u25CF POV: you ___',
            '-- 1 of 2 --',
        ].join('\n'),
    },
];

test('extractor splits hooks by heading, joins wrapped headings and keeps blanks verbatim', () => {
    const { items, counts } = extractHookPdfDrafts(FIXTURE);
    const hooks = items.filter((i) => i.type === 'hook');
    assert.equal(counts.hooks, 4);
    assert.deepEqual(counts.hooksPerCategory, { 'Curiosity Hooks': 2, Relatable: 2 });
    assert.equal(hooks[1].displayText, 'Stop scrolling if you ___');
    assert.equal(hooks[3].displayText, 'Nobody tells you this about ___');
    assert.deepEqual(hooks[3].sourceKbIds, [KB_B]);
    assert.ok(hooks.every((h) => h.sourceLabel === 'Viral Creator'));
});

test('extractor emits prose sections and quote-stripped (EX#n) templates', () => {
    const { items, counts } = extractHookPdfDrafts(FIXTURE);
    const section = items.find((i) => i.title === 'Main Structure of My Shorts');
    assert.equal(section.type, 'structure');
    assert.equal(section.body, 'Start with the conflict. Then raise the stakes.');
    const templates = items.filter((i) => i.category === 'Introducing the story');
    assert.deepEqual(templates.map((t) => t.displayText), ['It started as a normal morning', 'Then the door opened']);
    assert.equal(templates[0].title, 'Introducing the story #1');
    assert.equal(counts.structureTemplates, 2);
    assert.equal(counts.structureSections, 1);
    assert.equal(new Set(items.map((i) => i.slug)).size, items.length);
});

test('slugify and titleFromLine are stable', () => {
    assert.equal(slugify('Café: Hooks & More!'), 'cafe-hooks-more');
    assert.equal(slugify(''), 'item');
    assert.equal(titleFromLine('Stop scrolling if you ___...'), 'Stop scrolling if you');
});

test('provenance: only positively identified owner content is not third-party', () => {
    const pdf = { metadata: { source: 'Viral Creator', totalChunks: 8, contentType: 'algorithm_breakdown' } };
    assert.equal(classifyKbProvenance(pdf), 'owner');
    assert.equal(classifyKbProvenance({ metadata: { sourceType: 'own_video' } }), 'owner');
    assert.equal(classifyKbProvenance({ metadata: { source: 'manual_note' } }), 'owner');
    assert.equal(classifyKbProvenance({ metadata: { source: 'admin_creator_ingest' } }), 'third_party_derived');
    assert.equal(classifyKbProvenance({ metadata: { source: 'Some Book', totalChunks: 40 } }), 'third_party');
    assert.equal(classifyKbProvenance({}), 'unknown');
    assert.equal(isThirdPartyProvenance('unknown'), true);
    assert.equal(isThirdPartyProvenance('owner'), false);
});

test('normalizeReviewedItem filters enums and only takes visibility when set', () => {
    const ok = normalizeReviewedItem({
        slug: 'curiosity-hook', type: 'hook', displayText: ' Hi ', sourceKbIds: [KB_A],
        niches: ['education', 'bogus'], problemTags: ['swipe_first_3s'],
    });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.set.displayText, 'Hi');
    assert.deepEqual(ok.set.niches, ['education']);
    assert.equal('visibility' in ok.set, false);
    assert.equal('reviewStatus' in ok.set, false);

    const bad = normalizeReviewedItem({ slug: 'X', type: 'meme', displayText: '', sourceKbIds: [], visibility: 'world' });
    assert.equal(bad.errors.length, 5);
});

const fakeKbDb = (docs) => ({
    collection: (name) => {
        assert.equal(name, 'knowledgebases');
        return {
            find: (filter) => ({
                toArray: async () => docs.filter((d) => filter._id.$in.some((id) => String(id) === String(d._id))),
            }),
        };
    },
});

test('import refuses public on third-party sources without confirmThirdParty (dry run, no writes)', async () => {
    const db = fakeKbDb([{ _id: KB_A, metadata: { source: 'Some Book', totalChunks: 12 } }]);
    const base = { type: 'hook', displayText: 'x', sourceKbIds: [KB_A], visibility: 'public' };
    const refused = await importReviewedItems(db, [{ ...base, slug: 'third-party-hook' }], { apply: false });
    assert.equal(refused.invalid.length, 1);
    assert.match(refused.invalid[0].errors[0], /third-party/);

    const missing = await importReviewedItems(fakeKbDb([]), [{ ...base, slug: 'missing-src', visibility: undefined }], { apply: false });
    assert.match(missing.invalid[0].errors[0], /do not exist/);
});

test('admin patch: public on a third-party item needs explicit confirmation', () => {
    const current = { thirdPartySource: true };
    assert.equal(buildAdminPatch(current, { visibility: 'public' }).errors.length, 1);
    assert.deepEqual(buildAdminPatch(current, { visibility: 'public', confirmThirdParty: true }).errors, []);
    assert.deepEqual(buildAdminPatch({ thirdPartySource: false }, { visibility: 'public' }).errors, []);
    assert.deepEqual(buildAdminPatch(current, { visibility: 'members' }).errors, []);

    const patch = buildAdminPatch({}, { niches: ['food', 'nope'], reviewStatus: 'approved', featuredFree: true, order: 3 });
    assert.deepEqual(patch.set, { niches: ['food'], reviewStatus: 'approved', featuredFree: true, order: 3 });
    assert.equal(buildAdminPatch({}, { displayText: '  ' }).errors.length, 1);
    assert.equal(buildAdminPatch({}, { reviewStatus: 'published' }).errors.length, 1);
});
