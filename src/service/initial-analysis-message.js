import { cleanUserText } from './analyzer/voice.js';

/**
 * First coach message posted to the chat when an analysis completes.
 *
 * Built from the validated, timestamped frame feedback (not from the analyzers' prose), so it reads
 * like a short edit list: the score, the three most severe fixes with the literal change, and where
 * to focus. Plain text, no markdown, no em dashes, no mention of the knowledge base.
 */

const FEATURE_LABELS = {
    hook: 'hook',
    caption: 'captions',
    pacing: 'pacing',
    audio: 'audio',
    views_predictor: 'view potential',
    advanced_analytics: 'retention',
};

const pad = (n) => String(n).padStart(2, '0');
export const formatClock = (seconds) => {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};

const quote = (text) => `"${String(text).trim().replace(/^"+|"+$/g, '')}"`;

/** The literal change for one fix, phrased as an instruction. */
/** On-screen text changes, whichever fix type the analyzer picked. */
const isTextFix = (fix, category) =>
    fix?.type === 'add_text_overlay' || (fix?.type === 'replace_line' && (category === 'caption' || category === 'visual'));

/** Fixes that compete for the same thing on screen or in the edit count as one kind when de-duplicating. */
const fixKind = (item) => (isTextFix(item?.fix, item?.category) ? 'text' : item?.fix?.type);

export const describeFix = (fix, category) => {
    const after = typeof fix?.after === 'string' ? fix.after.trim() : '';
    if (!after) return '';
    // The model often already wrote the instruction ("add a splash at 0:12"): don't prefix it twice.
    if (/^(?:add|put|say|cut|trim|reshoot|replace|move|show|start|end|open)\b/i.test(after) && fix.type !== 'replace_line' && fix.type !== 'add_text_overlay') {
        return `${after[0].toUpperCase()}${after.slice(1)}`;
    }
    switch (fix.type) {
        case 'replace_line':
            // A caption/visual "line" is on-screen text, not something said out loud.
            return isTextFix(fix, category) ? `Change the on-screen text to: ${quote(after)}` : `Say this instead: ${quote(after)}`;
        case 'add_text_overlay':
            return `Put this text on screen: ${quote(after)}`;
        case 'cut':
        case 'trim':
            return /^cut|^trim/i.test(after) ? `${after[0].toUpperCase()}${after.slice(1)}` : `Cut: ${after}`;
        case 'add_sound':
            return `Add sound: ${after}`;
        case 'reshoot_note':
            return `Reshoot: ${after}`;
        default:
            return after;
    }
};

const sentence = (text) => {
    const t = cleanUserText(String(text || '').trim());
    if (!t) return '';
    return /[.!?"]$/.test(t) ? t : `${t}.`;
};

/**
 * @param {object} video Video document (plain object or Mongoose doc)
 * @param {{ maxFixes?: number }} [options]
 * @returns {string} message text ('' when there is nothing to say)
 */
export function buildInitialAnalysisMessage(video, { maxFixes = 3 } = {}) {
    const analysis = Array.isArray(video?.analysis) ? video.analysis : [];
    const scored = analysis
        .filter((a) => a.feature !== 'advanced_analytics' && typeof a.score === 'number' && Number.isFinite(a.score))
        .map((a) => ({ label: FEATURE_LABELS[a.feature] || a.feature, score: a.score, entry: a }));

    // Advanced items are Pro-only in the report, so they never go into the shared first message.
    // Different analyzers often flag the same moment with the same kind of fix (e.g. hook and captions
    // both want an overlay at 0:00-0:05); keep only the most severe one per moment.
    const overlaps = (a, b) => (a.tStart ?? 0) < (b.tEnd ?? b.tStart ?? 0) && (b.tStart ?? 0) < (a.tEnd ?? a.tStart ?? 0);
    const fixes = [];
    (video?.timestampFeedback || [])
        .filter((item) => item && item.sourceFeature !== 'advanced_analytics' && describeFix(item.fix, item.category))
        .slice()
        .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0) || (a.tStart ?? 0) - (b.tStart ?? 0))
        .forEach((item) => {
            if (fixes.length >= maxFixes) return;
            if (fixes.some((kept) => fixKind(kept) === fixKind(item) && overlaps(kept, item))) return;
            fixes.push(item);
        });
    fixes.sort((a, b) => (a.tStart ?? 0) - (b.tStart ?? 0));

    const lines = [];
    const score = typeof video?.viralityScore === 'number' ? video.viralityScore : null;
    if (score != null) {
        const verdict = score >= 75 ? 'This is close to ready.' : score >= 50 ? 'Fix a few things before you post.' : 'Fix this before you post.';
        lines.push(`Virality score: ${score}/100. ${verdict}`);
    }

    if (fixes.length > 0) {
        lines.push('', fixes.length === 1 ? 'Do this first:' : `Do these ${fixes.length} things first:`);
        fixes.forEach((item, index) => {
            const range = `${formatClock(item.tStart)}-${formatClock(item.tEnd ?? item.tStart)}`;
            const issue = sentence(item.issue);
            const change = sentence(describeFix(item.fix, item.category));
            lines.push(`${index + 1}. ${range}. ${issue} ${change}`.replace(/\s+/g, ' ').trim());
        });
    } else {
        // No validated timestamped fixes: fall back to the two weakest areas' concrete suggestions.
        const weakest = scored.slice().sort((a, b) => a.score - b.score).slice(0, 2);
        const steps = weakest
            .map((w) => (Array.isArray(w.entry.suggestions) ? w.entry.suggestions[0] : null))
            .filter(Boolean)
            .map(sentence);
        if (steps.length > 0) {
            lines.push('', 'Do this first:');
            steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
        }
    }

    if (scored.length > 0) {
        const sorted = scored.slice().sort((a, b) => a.score - b.score);
        const weakest = sorted[0];
        const strongest = sorted[sorted.length - 1];
        lines.push('');
        if (sorted.length > 1 && strongest.score > weakest.score) {
            lines.push(
                strongest.score >= 50
                    ? `Weakest: ${weakest.label} (${weakest.score}). Strongest: ${strongest.label} (${strongest.score}).`
                    : `Weakest: ${weakest.label} (${weakest.score}). Nothing scored 50 or above yet; closest is ${strongest.label} (${strongest.score}).`
            );
        } else {
            lines.push(`Weakest: ${weakest.label} (${weakest.score}).`);
        }
    }

    if (lines.length === 0) return '';
    lines.push('Ask me about any second of the video and I will give you the exact change. The Scripts tab has full rewrites.');
    return lines.join('\n');
}
