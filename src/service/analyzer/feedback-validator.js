/**
 * Vagueness gate between generation and persistence/response.
 *
 * Structured outputs guarantee SHAPE; this guarantees CONTENT. A `fix.after` or
 * `rewrittenLine` that hedges ("try tightening your hook"), is empty, or is a
 * placeholder ("[your topic]") is rejected here rather than stored as accepted
 * prose.
 *
 * Two severities:
 * - `errors`   — item is dropped from persistence (logged, never silent).
 * - `warnings` — item is kept but logged, e.g. a `before` string that does not
 *                match the transcript verbatim (segment-level transcripts do
 *                not always align to a spoken clause boundary).
 */

import { isAdditiveFixType } from './feedback-schema.js';

/**
 * Hedge phrasing banned from fields that must BE the literal content.
 * These are intentionally narrow: they target instruction-shaped language,
 * not ordinary words that can legitimately appear in a spoken line.
 */
const HEDGE_PATTERNS = [
    /\btry(?:ing)? to\b/i,
    /\bconsider\b/i,
    /\byou (?:could|should|might|may want to)\b/i,
    /\bmake it (?:more|less)\b/i,
    /\b(?:improve|optimi[sz]e|enhance|strengthen|tighten)(?:\s+(?:your|the|this))\b/i,
    /\bbe more\b/i,
    /\badd some\b/i,
    /\bsomething (?:like|along the lines of)\b/i,
    /\bmore (?:engaging|compelling|dynamic|punchy|interesting)\b/i,
    /\bperhaps\b/i,
    /\bmaybe\b/i,
];

/** Placeholder / non-answer markers. */
const PLACEHOLDER_PATTERNS = [
    /\[[^\]]*\]/,            // [your topic]
    /<[^>]+>/,               // <insert hook>
    /\b(?:TODO|TBD|FIXME)\b/i,
    /_{3,}/,                 // ___
    /\byour (?:topic|niche|product|subject)\b/i,
    /\b(?:insert|replace with|add your)\b/i,
    /^(?:n\/a|none|null|undefined|-+)$/i,
    /\be\.g\.?\s*$/i,
];

const MIN_LITERAL_LENGTH = 8;

const normalizeForCompare = (text) =>
    String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const findHedge = (text) => HEDGE_PATTERNS.find((re) => re.test(text))?.source ?? null;
const findPlaceholder = (text) => PLACEHOLDER_PATTERNS.find((re) => re.test(text))?.source ?? null;

/**
 * Check a field that must be literal, usable content.
 * @returns {string[]} error messages (empty when the field is acceptable)
 */
const checkLiteralField = (label, value) => {
    const errors = [];
    const text = typeof value === 'string' ? value.trim() : '';

    if (!text) {
        errors.push(`${label} is empty; it must contain the literal replacement content.`);
        return errors;
    }
    if (text.length < MIN_LITERAL_LENGTH) {
        errors.push(`${label} is too short to be usable ("${text}").`);
    }
    const placeholder = findPlaceholder(text);
    if (placeholder) {
        errors.push(`${label} contains a placeholder instead of real content ("${text}").`);
    }
    const hedge = findHedge(text);
    if (hedge) {
        errors.push(`${label} uses hedge/instruction phrasing instead of the literal content ("${text}").`);
    }
    return errors;
};

/**
 * `cut` / `trim` fixes are instructions by nature, so they must carry explicit
 * times rather than literal script text.
 */
const checkCutInstruction = (label, value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (/\d/.test(text)) return [];
    return [`${label} describes a ${'cut/trim'} without any explicit timestamp or duration ("${text}").`];
};

const transcriptContains = (transcriptText, candidate) => {
    const needle = normalizeForCompare(candidate);
    if (!needle || needle.length < 4) return true;
    return normalizeForCompare(transcriptText).includes(needle);
};

/**
 * Validate one normalized FrameFeedback item.
 * @param {object} item
 * @param {{ transcriptText?: string }} [context]
 */
export const validateFrameFeedbackItem = (item, { transcriptText = '' } = {}) => {
    const errors = [];
    const warnings = [];
    const fixType = item?.fix?.type;

    if (fixType === 'cut' || fixType === 'trim') {
        errors.push(...checkCutInstruction(`fix.after (${fixType})`, item?.fix?.after));
    } else {
        errors.push(...checkLiteralField('fix.after', item?.fix?.after));
    }

    if (!isAdditiveFixType(fixType) && !item?.fix?.before) {
        errors.push(`fix.before is required for fix type "${fixType}" so the creator can see what is being replaced.`);
    }

    if (!item?.observed || item.observed.trim().length < MIN_LITERAL_LENGTH) {
        errors.push('observed must describe what literally happens in the range.');
    } else if (findHedge(item.observed)) {
        warnings.push('observed uses hedge phrasing.');
    }

    if (!item?.issue || item.issue.trim().length < MIN_LITERAL_LENGTH) {
        errors.push('issue must explain why this moment costs retention.');
    }

    if (item?.fix?.before && transcriptText && !transcriptContains(transcriptText, item.fix.before)) {
        warnings.push('fix.before does not match the transcript verbatim.');
    }

    if (!Number.isFinite(item?.tStart)) {
        errors.push('tStart is not a finite number of seconds.');
    }

    return { valid: errors.length === 0, errors, warnings };
};

/**
 * Validate one normalized ScriptRewrite item.
 * @param {object} item
 * @param {{ transcriptText?: string }} [context]
 */
export const validateScriptRewriteItem = (item, { transcriptText = '' } = {}) => {
    const errors = [];
    const warnings = [];

    errors.push(...checkLiteralField('rewrittenLine', item?.rewrittenLine));

    if (!item?.originalTranscript) {
        errors.push('originalTranscript is empty; it must quote the spoken line verbatim.');
    } else if (transcriptText && !transcriptContains(transcriptText, item.originalTranscript)) {
        warnings.push('originalTranscript does not match the transcript verbatim.');
    }

    if (item?.originalTranscript && item?.rewrittenLine &&
        normalizeForCompare(item.originalTranscript) === normalizeForCompare(item.rewrittenLine)) {
        errors.push('rewrittenLine is identical to originalTranscript; it is not a rewrite.');
    }

    if (!item?.rationale || item.rationale.trim().length < MIN_LITERAL_LENGTH) {
        errors.push('rationale must state the mechanism the rewrite uses.');
    }

    return { valid: errors.length === 0, errors, warnings };
};

/**
 * Validate a whole normalized payload, partitioning items into kept/rejected.
 *
 * @param {{ frameFeedback?: object[], scriptRewrites?: object[] }} payload
 * @param {{ transcriptText?: string }} [context]
 */
export const validateFeedbackPayload = (payload, context = {}) => {
    const kept = { frameFeedback: [], scriptRewrites: [] };
    const rejected = [];
    const warnings = [];

    for (const item of payload?.frameFeedback || []) {
        const result = validateFrameFeedbackItem(item, context);
        result.warnings.forEach((w) => warnings.push({ id: item?.id, kind: 'frameFeedback', message: w }));
        if (result.valid) kept.frameFeedback.push(item);
        else rejected.push({ id: item?.id, kind: 'frameFeedback', errors: result.errors, item });
    }

    for (const item of payload?.scriptRewrites || []) {
        const result = validateScriptRewriteItem(item, context);
        result.warnings.forEach((w) => warnings.push({ id: item?.lineId, kind: 'scriptRewrite', message: w }));
        if (result.valid) kept.scriptRewrites.push(item);
        else rejected.push({ id: item?.lineId, kind: 'scriptRewrite', errors: result.errors, item });
    }

    return { valid: rejected.length === 0, kept, rejected, warnings };
};

/**
 * Build the correction prompt for the single retry. Quotes the offending text so
 * the model corrects the specific field rather than regenerating blind.
 */
export const buildCorrectionPrompt = (rejected) => {
    const lines = rejected.slice(0, 8).map((entry) => {
        const offending = entry.kind === 'scriptRewrite'
            ? entry.item?.rewrittenLine
            : entry.item?.fix?.after;
        return `- ${entry.kind} at ${entry.item?.tStart ?? entry.item?.timestamp ?? '?'}s rejected: ${entry.errors.join(' ')} Offending text: "${offending ?? ''}"`;
    });

    return [
        'Your previous response was rejected by the specificity gate. Fix ONLY these problems and return the full corrected object:',
        ...lines,
        '',
        'Rules you must satisfy:',
        '- fix.after and rewrittenLine must contain the literal words/content the creator uses as-is, never a description of what to change.',
        '- No hedge phrasing ("try to", "consider", "make it more", "improve your ..."), no placeholders ("[topic]", "<insert>").',
        '- For cut/trim fixes, state explicit timestamps or durations.',
        '- fix.before and originalTranscript must be copied verbatim from the supplied transcript.',
        '- Drop any item you cannot make specific rather than padding it with vague text.',
    ].join('\n');
};

/**
 * Structured log for rejected output so prompt quality is trackable over time.
 * Deliberate operational logging (not debug noise) — see SLASH_DOC section 8.
 */
export const logFeedbackValidationFailure = ({ scope, videoId, attempt, rejected, warnings = [] }) => {
    if (rejected.length === 0 && warnings.length === 0) return;
    console.warn('[FeedbackValidator]', JSON.stringify({
        scope,
        videoId: videoId ? String(videoId) : null,
        attempt,
        rejectedCount: rejected.length,
        warningCount: warnings.length,
        rejected: rejected.map((entry) => ({ id: entry.id, kind: entry.kind, errors: entry.errors })),
        warnings,
    }));
};
