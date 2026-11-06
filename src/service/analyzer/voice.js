/**
 * How every user-facing sentence should read (analyzers, chat, scripts), plus a safety-net cleaner.
 *
 * The knowledge base is a private playbook: the model applies it but never names it. Earlier prompts
 * called it "Bas's insights and examples", and the model echoed that back to users ("as seen in
 * Bas's examples"). The cleaner below removes anything like that which still slips through.
 */

export const VOICE_RULES = [
    'VOICE (applies to every sentence the creator will read):',
    '- Talk to the creator directly ("you", "your video"). Short, plain sentences, like a blunt human editor leaving notes.',
    '- The REFERENCE NOTES are your private playbook. Apply them, but never mention them, their author, "examples", "insights", "patterns", "data", "research" or "the knowledge base".',
    '- Never use em dashes or en dashes. Use a period or a comma instead.',
    '- No filler or hype words: engaging, captivating, compelling, dynamic, enhance, elevate, resonate, seamless, leverage, impactful, "boost engagement", "grab attention", "take it to the next level".',
    '- No praise padding and no summary sentences that repeat what you already said.',
    '- Every recommendation names the timestamp, the exact action, and the exact words, text or cut. If you cannot say exactly what to do, leave it out.',
    '- Write your explanations in English. Write suggested spoken lines and on-screen text in the language people speak in the video; if nobody speaks, use English, even when on-screen text is in another language.',
    '- Write times as M:SS, where 0:05 means five seconds in. Never "00:00:05.000" or "5:00" for five seconds.',
    '- Hook lines and on-screen text must name something concrete from this video: the place, the action, a number, the stakes, or a question the video answers. Generic hype ("Catch the thrill!", "Surf\'s up!", "Epic ride!", "You won\'t believe this!") is rejected. No exclamation marks.',
    '- Do not explain the benefit with filler like "to enhance the atmosphere" or "to maintain viewer engagement". Say what the viewer will see or hear instead, or stop the sentence.',
    '- Never give "engagement", "context" or "drop-off" as the reason. Say what the viewer actually experiences, e.g. "for 6 seconds there is nothing to read or hear, so nothing tells them why to stay".',
].join('\n');

export const CALIBRATION_RULES = [
    'CALIBRATION (be strict):',
    '- Most videos from typical creators are average or weak. Scores of 25-55 are normal; 75+ means it would clearly outperform most posts in its niche. Do not round up.',
    '- A video with no spoken line and no on-screen text in the first 2 seconds cannot get a hook score above 40.',
    '- The reference notes over-represent viral outliers. Do not treat viral results as typical.',
].join('\n');

/** A phrase that names the private knowledge base (not just "the pattern"). */
const SOURCE =
    "(?:bas(?:'|’)?s?\\b|the\\s+knowledge\\s+base|(?:the\\s+)?(?:retrieved|provided|supplied|reference)\\s+(?:examples?|insights?|notes?|knowledge|data)|(?:the|these|those)\\s+(?:examples|insights))";

/**
 * Clauses that point at the knowledge base ("as seen in Bas's examples", "according to the retrieved
 * insights"). Stops at the next comma or sentence end so the rest of the sentence survives.
 */
const SOURCE_REFERENCE = new RegExp(
    `\\s*,?\\s*\\b(?:as\\s+(?:seen|shown|demonstrated|noted|highlighted|illustrated)\\s+in|according\\s+to|in\\s+line\\s+with|consistent\\s+with|following|based\\s+on|similar\\s+to|per|as\\s+in|like\\s+in|(?:which\\s+|this\\s+|that\\s+)?aligns?\\s+with|aligning\\s+with)\\s+${SOURCE}[^.!?\\n,]*`,
    'gi'
);

const NUMBER_RANGE_DASH = /(\d)\s*[—–]\s*(\d)/g;

/** "00:00:02.000" / "00:01:05" -> "0:02" / "1:05" (M:SS, the format the report uses). */
const LONG_TIMECODE = /\b(\d{1,2}):(\d{2}):(\d{2})(?:[.,]\d{1,3})?\b/g;
const toClock = (_, h, m, s) => {
    const total = Number(h) * 3600 + Number(m) * 60 + Number(s);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Internal fix-type ids sometimes leak into prose ("0:00-0:06 add_text_overlay '...'"). */
const FIX_TYPE_PLAIN = {
    add_text_overlay: 'put this text on screen:',
    replace_line: 'say instead:',
    add_sound: 'add the sound:',
    reshoot_note: 'reshoot:',
};
const FIX_TYPE_WORDS = /\b(?:add_text_overlay|replace_line|add_sound|reshoot_note)\b/gi;

/** Trailing benefit filler: ", to enhance the ocean atmosphere", " to maintain viewer engagement". */
const FILLER_PURPOSE =
    /,?\s+(?:in order\s+)?(?:to|and|which will|that will|helping to)\s+(?:further\s+)?(?:enhance|boost|maintain|increase|improve|keep|heighten|elevate|drive|create|add|capture|grab|emphasize|strengthen)\s+(?:the\s+|a\s+|more\s+|viewer\s+|viewers'?\s+|audience\s+|overall\s+)*(?:[a-z]+\s+){0,2}(?:engagement|interest|attention|excitement|atmosphere|experience|story|storytelling|impact|energy|vibe|immersion|curiosity|emotional connection|connection|clarity)\b[^.!?]*/gi;
const DASHES = /\s*[—–]\s*/g;

/**
 * Clean one user-facing string: no em/en dashes, no knowledge-base references, tidy spacing.
 * Safe on non-strings (returned unchanged).
 */
export const cleanUserText = (value) => {
    if (typeof value !== 'string' || value === '') return value;
    let text = value
        .replace(SOURCE_REFERENCE, '')
        .replace(/\s*\b(?:from|in|using|via|with|per)\s+(?:the\s+)?(?:reference\s+notes|knowledge\s+base|retrieved\s+(?:insights|examples|notes))\b/gi, '');
    // Any remaining direct mention of the KB author.
    text = text.replace(/\bBas(?:'s|’s)\s+/g, 'proven ').replace(/\bBas\b/g, 'top creators');
    // Ranges keep a plain hyphen: "0:04–0:06" -> "0:04-0:06".
    text = text.replace(NUMBER_RANGE_DASH, '$1-$2');
    text = text.replace(LONG_TIMECODE, toClock);
    // "00:12" -> "0:12"
    text = text.replace(/\b0(\d):(\d{2})\b/g, '$1:$2');
    text = text.replace(FIX_TYPE_WORDS, (word) => FIX_TYPE_PLAIN[word.toLowerCase()] ?? word);
    text = text.replace(FILLER_PURPOSE, '');
    // Hype punctuation inside quoted overlay/line text: 'Catch the wave!' -> 'Catch the wave'.
    text = text.replace(/!+(['"”])/g, '$1');
    // "word — word" -> "word, word"; a dash before a capital starts a new sentence.
    text = text.replace(DASHES, (match, offset, whole) => {
        const next = whole.slice(offset + match.length, offset + match.length + 1);
        return next && /[A-Z]/.test(next) ? '. ' : ', ';
    });
    text = text
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/,\s*\./g, '.')
        .replace(/\.{2,}/g, '.')
        .replace(/ {2,}/g, ' ')
        // A removed leading clause ("According to X, open on...") leaves ", open on...".
        .replace(/(^|[.!?]\s+),\s*([a-z])/g, (_, lead, ch) => `${lead}${ch.toUpperCase()}`)
        .replace(/^,\s*/, '')
        .trim();
    if (text && /^[a-z]/.test(text) && /^[A-Z]/.test(value.trim())) {
        text = text[0].toUpperCase() + text.slice(1);
    }
    return text;
};

/** Keys whose values must stay verbatim (quotes from the transcript, ids, enums). */
const VERBATIM_KEYS = new Set([
    'before',
    'observed',
    'originalTranscript',
    'id',
    'lineId',
    'type',
    'category',
    'sourceFeature',
    'rating',
    'tier',
    'coverage',
]);

/** Deep-clean an analyzer / chat payload in place-safe fashion (returns a new value). */
export const cleanUserFacing = (value, key = '') => {
    if (key === 'observed' && typeof value === 'string') return value.replace(LONG_TIMECODE, toClock);
    if (VERBATIM_KEYS.has(key)) return value;
    if (typeof value === 'string') return cleanUserText(value);
    if (Array.isArray(value)) return value.map((item) => cleanUserFacing(item, key));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanUserFacing(v, k)]));
    }
    return value;
};

/**
 * Repair timecodes that cannot exist in a video this long. Models write "6:00-12:00" or "5:00-5:11"
 * meaning seconds 6-12 / 5-11. A token longer than the video, whose minutes value is itself a valid
 * second, is read as seconds: "6:00" -> "0:06"; "5:11" (after "5:00") -> "0:11".
 */
export const retimeForDuration = (value, durationSeconds, key = '') => {
    const limit = Number(durationSeconds);
    if (!Number.isFinite(limit) || limit <= 0 || limit >= 600) return value;
    if (VERBATIM_KEYS.has(key) && key !== 'observed') return value;
    if (typeof value === 'string') {
        return value.replace(/\b(\d{1,2}):(\d{2})\b/g, (token, m, sec) => {
            const minutes = Number(m);
            const seconds = Number(sec);
            if (minutes * 60 + seconds <= limit + 1) return token;
            const asSeconds = seconds === 0 ? minutes : seconds;
            if (asSeconds > limit + 1) return token;
            return `0:${String(asSeconds).padStart(2, '0')}`;
        });
    }
    if (Array.isArray(value)) return value.map((item) => retimeForDuration(item, limit, key));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, retimeForDuration(v, limit, k)]));
    }
    return value;
};
