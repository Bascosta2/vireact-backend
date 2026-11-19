/**
 * What viewers say (docs/learning-engine/PLAN.md, section 5.7 and 15.1 item 6).
 *
 * Top comments of public videos are labelled from a closed list in batches, then summarized per video as
 * intent shares (SocialVideo.commentIntents). Comments are written AFTER a video is posted, so they are a
 * RESULT, never an input: they are not model features (that would leak the answer into the prediction).
 * They explain engagement: which intents hits draw that misses do not.
 */
import { SocialVideo } from '../../model/learning.model.js';
import { requestStructuredCompletion } from '../openai-response.service.js';
import { withAiContext } from '../../lib/ai-tracking.js';

export const COMMENT_INTENTS = Object.freeze([
    'question', 'wants_more', 'disagrees', 'tags_friend', 'relates', 'praises_edit', 'praises_content', 'funny', 'confused', 'spam', 'other',
]);
const PER_CALL = 150;

export const commentSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['comments'],
    properties: {
        comments: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['ref', 'intent'],
                properties: { ref: { type: 'string' }, intent: { type: 'string', enum: [...COMMENT_INTENTS] } },
            },
        },
    },
};

/** Intent shares for one video, weighting each comment by 1 + log(1 + likes) so liked comments count more. */
export const intentShares = (labelled = []) => {
    const totals = Object.fromEntries(COMMENT_INTENTS.map((k) => [k, 0]));
    let sum = 0;
    for (const { intent, likes } of labelled) {
        if (!COMMENT_INTENTS.includes(intent)) continue;
        const w = 1 + Math.log1p(Math.max(0, Number(likes) || 0));
        totals[intent] += w;
        sum += w;
    }
    if (!sum) return null;
    return { ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round((v / sum) * 1000) / 1000])), n: labelled.length };
};

/** Labels the top comments of up to `limit` videos that have comments and no intents yet. Never throws per batch. */
export const labelComments = async ({ limit = 300, complete = requestStructuredCompletion, log = () => {} } = {}) => {
    const videos = await SocialVideo.find({ 'topComments.0': { $exists: true }, commentIntents: null })
        .sort({ updatedAt: -1 }).limit(limit).select('_id topComments').lean();
    let labelled = 0;
    let failed = 0;
    // Pack whole videos into calls of about PER_CALL comments.
    const batches = [];
    let cur = [];
    let size = 0;
    for (const v of videos) {
        const n = Math.min(20, v.topComments.length);
        if (size + n > PER_CALL && cur.length) { batches.push(cur); cur = []; size = 0; }
        cur.push(v);
        size += n;
    }
    if (cur.length) batches.push(cur);
    for (const batch of batches) {
        const lines = [];
        const refs = new Map();
        batch.forEach((v, vi) => v.topComments.slice(0, 20).forEach((c, ci) => {
            const ref = `${vi}.${ci}`;
            refs.set(ref, { video: v, comment: c });
            lines.push(`${ref} | ${String(c.text).replace(/\s+/g, ' ').slice(0, 200)}`);
        }));
        try {
            const result = await withAiContext({ feature: 'learning_comments' }, () => complete({
                messages: [{ role: 'user', content: `Label the intent of each comment on a short-form video.\n\n${lines.join('\n')}` }],
                schemaName: 'comment_intents',
                jsonSchema: commentSchema,
                systemPrompt: 'You classify social media comments into a fixed list of intents. Return structured data only.',
                role: 'classifier',
                temperature: 0,
                maxTokens: 6000,
            }));
            const byVideo = new Map();
            for (const item of result?.comments ?? []) {
                const hit = refs.get(String(item?.ref));
                if (!hit) continue;
                const key = String(hit.video._id);
                if (!byVideo.has(key)) byVideo.set(key, []);
                byVideo.get(key).push({ intent: item.intent, likes: hit.comment.likes });
            }
            for (const v of batch) {
                const shares = intentShares(byVideo.get(String(v._id)) ?? []);
                await SocialVideo.updateOne({ _id: v._id }, { $set: { commentIntents: shares ?? { n: 0 } } });
                if (shares) labelled += 1;
            }
        } catch (error) {
            failed += batch.length;
            log(`comment intents batch failed: ${error.message}`);
        }
    }
    return { videos: videos.length, labelled, failed };
};
