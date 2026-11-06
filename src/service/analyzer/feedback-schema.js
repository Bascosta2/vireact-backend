/**
 * Canonical shapes for frame-level feedback and script rewrites.
 *
 * Every analyzer and the chat controller emit these through OpenAI structured
 * outputs (`json_schema`, strict) so vague prose cannot reach the database.
 *
 * Timestamps are stored as NUMERIC SECONDS everywhere (consistent with
 * `scenes[].startTime` and the frontend `VideoFeedback.timestamp`). Display
 * strings ("00:00:04.200") are derived at the DTO boundary via `formatTimecode`.
 *
 * Severity is stored as an integer 1-5. `severityToLegacy` maps it back to the
 * documented `critical | important | minor` contract in the video DTO.
 *
 * NOTE on strict `json_schema`: OpenAI strict mode does not support numeric
 * keywords (`minimum`, `maximum`) or optional properties — every key must be
 * listed in `required`, and "optional" is expressed as a nullable type union.
 * Ranges are therefore clamped in `normalize*` below, not declared in schema.
 */

export const FRAME_FEEDBACK_CATEGORIES = ['hook', 'pacing', 'audio', 'caption', 'visual', 'script'];

export const FIX_TYPES = ['replace_line', 'cut', 'trim', 'add_text_overlay', 'reshoot_note', 'add_sound'];

/** Analyzer features that can author feedback; mirrors `Video.analysis[].feature`. */
export const FEEDBACK_SOURCE_FEATURES = [
    'hook',
    'caption',
    'pacing',
    'audio',
    'advanced_analytics',
    'views_predictor',
    'chat',
];

export const SEVERITY_MIN = 1;
export const SEVERITY_MAX = 5;

/** Fix types that describe added content, so `fix.before` is legitimately null. */
const ADDITIVE_FIX_TYPES = new Set(['add_text_overlay', 'add_sound', 'reshoot_note']);

export const isAdditiveFixType = (type) => ADDITIVE_FIX_TYPES.has(type);

/**
 * Map integer severity to the legacy DTO enum so existing report UI keeps working.
 * 5,4 -> critical | 3 -> important | 2,1 -> minor
 */
export const severityToLegacy = (severity) => {
    const n = Number(severity);
    if (n >= 4) return 'critical';
    if (n === 3) return 'important';
    return 'minor';
};

/** Inverse of `severityToLegacy`, used when reading forward-migrated legacy rows. */
export const legacyToSeverity = (legacy) => {
    switch ((legacy || '').toLowerCase()) {
        case 'critical': return 5;
        case 'important': return 3;
        default: return 2;
    }
};

/** Seconds -> "HH:MM:SS.mmm" for display and prompt context. */
export const formatTimecode = (seconds) => {
    const total = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
};

/**
 * Tolerant timecode parser. Accepts numeric seconds or "HH:MM:SS.mmm" / "MM:SS"
 * so a model that ignores the "seconds" instruction still lands on a real time.
 */
export const parseTimecode = (value) => {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
    const text = String(value).trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, parseFloat(text));
    const parts = text.split(':').map((p) => parseFloat(p));
    if (parts.some((p) => !Number.isFinite(p))) return null;
    const seconds = parts.reduce((acc, part) => acc * 60 + part, 0);
    return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
};

const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

/** `fb_0001` — ids are server-assigned so they stay unique and stable per video. */
export const buildFeedbackId = (index) => `fb_${String(index + 1).padStart(4, '0')}`;

/** `line_001` — server-assigned for the same reason. */
export const buildScriptRewriteId = (index) => `line_${String(index + 1).padStart(3, '0')}`;

/** `cfb_0001` — chat-authored fixes, distinguishable from stored analyzer feedback. */
export const buildChatFixId = (index) => `cfb_${String(index + 1).padStart(4, '0')}`;

const stringOrNull = { type: ['string', 'null'] };

export const frameFeedbackJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['tStart', 'tEnd', 'category', 'severity', 'observed', 'issue', 'fix', 'expectedImpact', 'sourceConfidence'],
    properties: {
        tStart: {
            type: 'number',
            description: 'Start time in SECONDS (decimal allowed) taken from the transcript or scene boundaries. Never invent a time.',
        },
        tEnd: {
            type: 'number',
            description: 'End time in SECONDS. Must be greater than or equal to tStart.',
        },
        category: { type: 'string', enum: FRAME_FEEDBACK_CATEGORIES },
        severity: {
            type: 'integer',
            description: 'Integer 1-5. 5 = kills retention outright, 1 = cosmetic polish.',
        },
        observed: {
            type: 'string',
            description: 'What literally happens in this range. Quote spoken words verbatim from the transcript and state measured facts (e.g. "2.1s of dead air"). No adjectives-only descriptions.',
        },
        issue: {
            type: 'string',
            description: 'Why this specific moment costs retention, referencing the concrete pattern it violates.',
        },
        fix: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'before', 'after'],
            properties: {
                type: { type: 'string', enum: FIX_TYPES },
                before: {
                    ...stringOrNull,
                    description: 'The exact existing content being changed, copied verbatim from the transcript or on-screen text. Null ONLY when the fix adds content where none existed (add_text_overlay, add_sound, reshoot_note).',
                },
                after: {
                    type: 'string',
                    description: 'The literal drop-in replacement the creator can use as-is: the exact new script line, overlay text, or a precise cut instruction with times ("cut 00:00:04.200-00:00:06.300"). Never a description of what to do differently.',
                },
            },
        },
        expectedImpact: {
            type: 'string',
            description: 'Plain outcome for this video (e.g. "viewers see the payoff 2s sooner"). Never mention sources, examples or notes. No em dashes.',
        },
        sourceConfidence: {
            type: 'number',
            description: 'Confidence 0-1 that the cited moment and fix are correct.',
        },
    },
};

export const scriptRewriteJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['timestamp', 'originalTranscript', 'rewrittenLine', 'rationale', 'deliveryNote'],
    properties: {
        timestamp: {
            type: 'number',
            description: 'Start time in SECONDS of the line being rewritten, from the transcript.',
        },
        originalTranscript: {
            type: 'string',
            description: 'The spoken line copied VERBATIM from the supplied transcript. Never paraphrase or reconstruct from memory.',
        },
        rewrittenLine: {
            type: 'string',
            description: 'The actual words the creator should say on camera instead. Quotable as-is, no instructions or placeholders.',
        },
        rationale: {
            type: 'string',
            description: 'Why the rewrite performs better, citing the specific mechanism it uses.',
        },
        deliveryNote: {
            type: 'string',
            description: 'Concrete delivery instruction (pace, emphasis, what to cut).',
        },
    },
};

const arrayOf = (schema, description) => ({ type: 'array', description, items: schema });

/** Base analyzer envelope: legacy score fields plus the new structured feedback. */
export const buildAnalyzerJsonSchema = ({ extraProperties = {}, includeScriptRewrites = true } = {}) => {
    const properties = {
        score: { type: 'integer', description: 'Score 0-100.' },
        rating: { type: 'string', description: 'Weak | Medium | Strong.' },
        reasoning: { type: 'string', description: 'One or two short sentences: what is wrong, at which seconds, and why viewers leave there. Never mention sources. No em dashes.' },
        suggestions: arrayOf({ type: 'string' }, 'Short headline suggestions. Each must name the concrete change, not a goal.'),
        frameFeedback: arrayOf(frameFeedbackJsonSchema, 'Every actionable issue, each tied to a real timestamp range with a literal fix.'),
        ...extraProperties,
    };
    if (includeScriptRewrites) {
        properties.scriptRewrites = arrayOf(
            scriptRewriteJsonSchema,
            'Verbatim spoken lines rewritten into literal replacement lines. Empty array when the video has no speech.'
        );
    }
    return {
        type: 'object',
        additionalProperties: false,
        required: Object.keys(properties),
        properties,
    };
};

export const analyzerJsonSchema = buildAnalyzerJsonSchema();

export const advancedAnalyticsJsonSchema = buildAnalyzerJsonSchema({
    extraProperties: {
        emotionalTriggers: arrayOf({ type: 'string' }, 'Emotional triggers actually present in the video.'),
        retentionDrivers: arrayOf({ type: 'string' }, 'Structural elements holding attention.'),
        psychologicalProfile: { ...stringOrNull, description: 'Viewer-psychology read of the video.' },
        weakestMoment: { ...stringOrNull, description: 'Single weakest moment with its timestamp.' },
    },
});

export const viewsPredictorJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: [
        'tier', 'conservativeLow', 'conservativeHigh', 'expectedLow', 'expectedHigh',
        'optimisticLow', 'optimisticHigh', 'confidence', 'reasoning', 'suggestions', 'frameFeedback',
    ],
    properties: {
        tier: { type: 'string', enum: ['low', 'medium', 'high'] },
        conservativeLow: { type: 'integer' },
        conservativeHigh: { type: 'integer' },
        expectedLow: { type: 'integer' },
        expectedHigh: { type: 'integer' },
        optimisticLow: { type: 'integer' },
        optimisticHigh: { type: 'integer' },
        confidence: { type: 'number', description: 'Confidence 0-1 in the predicted band.' },
        reasoning: { type: 'string' },
        suggestions: arrayOf({ type: 'string' }, 'Concrete changes that would move the predicted band.'),
        frameFeedback: arrayOf(frameFeedbackJsonSchema, 'Moments that most constrain the predicted view band.'),
    },
};

export const chatResponseJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'coverage', 'citedFeedbackIds', 'citedRewriteIds', 'fixes', 'scriptRewrites'],
    properties: {
        reply: {
            type: 'string',
            description: 'Plain-text answer grounded in this video\'s data. No markdown, no emojis. When coverage is not_covered, say plainly that the analysis does not cover it.',
        },
        coverage: {
            type: 'string',
            enum: ['grounded', 'partially_grounded', 'not_covered'],
            description: 'grounded = fully answerable from supplied video data; not_covered = the analysis contains no data for this question.',
        },
        citedFeedbackIds: arrayOf({ type: 'string' }, 'Ids of supplied stored feedback items referenced in the reply.'),
        citedRewriteIds: arrayOf({ type: 'string' }, 'lineIds of supplied stored script rewrites referenced in the reply.'),
        fixes: arrayOf(frameFeedbackJsonSchema, 'New frame-level fixes authored in this reply. Empty array when only citing stored items or when coverage is not_covered.'),
        scriptRewrites: arrayOf(scriptRewriteJsonSchema, 'New verbatim line rewrites authored in this reply. Empty array when not applicable.'),
    },
};

/**
 * Clamp/normalize one model-emitted frame feedback item into storage shape.
 * Returns null when the item has no usable timestamp.
 */
export const normalizeFrameFeedback = (raw, { index, sourceFeature, duration, idBuilder = buildFeedbackId } = {}) => {
    if (!raw || typeof raw !== 'object') return null;

    const tStart = parseTimecode(raw.tStart);
    if (tStart == null) return null;
    const parsedEnd = parseTimecode(raw.tEnd);
    const upperBound = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : null;

    let start = tStart;
    let end = parsedEnd == null ? start : parsedEnd;
    if (end < start) [start, end] = [end, start];
    if (upperBound) {
        start = Math.min(start, upperBound);
        end = Math.min(end, upperBound);
    }

    const category = FRAME_FEEDBACK_CATEGORIES.includes(raw.category) ? raw.category : 'visual';
    const fixType = FIX_TYPES.includes(raw?.fix?.type) ? raw.fix.type : 'reshoot_note';
    const before = typeof raw?.fix?.before === 'string' && raw.fix.before.trim() ? raw.fix.before.trim() : null;
    const after = typeof raw?.fix?.after === 'string' ? raw.fix.after.trim() : '';

    return {
        id: idBuilder(index),
        tStart: start,
        tEnd: end,
        category,
        severity: Math.round(clamp(raw.severity, SEVERITY_MIN, SEVERITY_MAX, 3)),
        sourceFeature: FEEDBACK_SOURCE_FEATURES.includes(sourceFeature) ? sourceFeature : 'advanced_analytics',
        observed: typeof raw.observed === 'string' ? raw.observed.trim() : '',
        issue: typeof raw.issue === 'string' ? raw.issue.trim() : '',
        fix: { type: fixType, before, after },
        expectedImpact: typeof raw.expectedImpact === 'string' ? raw.expectedImpact.trim() : '',
        sourceConfidence: clamp(raw.sourceConfidence, 0, 1, 0.5),
    };
};

/** Clamp/normalize one model-emitted script rewrite into storage shape. */
export const normalizeScriptRewrite = (raw, { index, sourceFeature, duration } = {}) => {
    if (!raw || typeof raw !== 'object') return null;

    const timestamp = parseTimecode(raw.timestamp);
    if (timestamp == null) return null;
    const upperBound = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Number(duration) : null;

    return {
        lineId: buildScriptRewriteId(index),
        timestamp: upperBound ? Math.min(timestamp, upperBound) : timestamp,
        originalTranscript: typeof raw.originalTranscript === 'string' ? raw.originalTranscript.trim() : '',
        rewrittenLine: typeof raw.rewrittenLine === 'string' ? raw.rewrittenLine.trim() : '',
        rationale: typeof raw.rationale === 'string' ? raw.rationale.trim() : '',
        deliveryNote: typeof raw.deliveryNote === 'string' ? raw.deliveryNote.trim() : '',
        sourceFeature: FEEDBACK_SOURCE_FEATURES.includes(sourceFeature) ? sourceFeature : 'hook',
    };
};
