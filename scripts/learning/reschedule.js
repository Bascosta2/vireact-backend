/**
 * Put already-collected public videos on the current re-check schedule (CHECK_AGES_DAYS, isTracked).
 * Needed once after the schedule changes; safe to re-run. Only touches videos with no check pending.
 *
 *   node scripts/learning/reschedule.js           # dry run: counts only
 *   node scripts/learning/reschedule.js --apply   # write nextCheckAt
 *
 * Uses the same database guard as the app (scripts/research/_db.js).
 */
import { connectDb, disconnectDb, flag } from '../research/_db.js';
import { SocialVideo } from '../../src/model/learning.model.js';
import { firstCheckAt } from '../../src/service/learning/social/collector.js';
import { learningConfig } from '../../src/service/learning/learning.service.js';

const apply = flag('--apply');
const now = Date.now();
const { trackShare } = learningConfig();

await connectDb();
try {
    const cursor = SocialVideo.find({ nextCheckAt: null, postedAt: { $ne: null } }).select('externalId postedAt discoveredVia').lean().cursor();
    let seen = 0;
    let tracked = 0;
    const ops = [];
    for await (const v of cursor) {
        seen += 1;
        const at = firstCheckAt({ externalId: v.externalId, postedAt: v.postedAt, via: v.discoveredVia }, { now, trackShare });
        if (!at) continue;
        tracked += 1;
        ops.push({ updateOne: { filter: { _id: v._id, nextCheckAt: null }, update: { $set: { nextCheckAt: at } } } });
    }
    if (apply && ops.length) {
        for (let i = 0; i < ops.length; i += 500) await SocialVideo.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
    console.log(`${apply ? 'Rescheduled' : 'Would reschedule'} ${tracked} of ${seen} videos with no check pending (track share ${trackShare}).`);
} finally {
    await disconnectDb();
}
