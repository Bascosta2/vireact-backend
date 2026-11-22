/**
 * Reading a video's descriptions and transcript (docs/learning-engine/FULL-PLAN.md, section 5.3).
 *
 * One small-model call per video, closed lists only, turns the Twelve Labs scene descriptions (what is
 * visible, the action, on-screen text, audio, tone, purpose) and the timed transcript into:
 *   - speech kinds: each transcript line is 'spoken' (talking, voice-over, dialogue) or 'sung' (song lyrics),
 *     so lyrics never count as speech (speaking speed, opening words, words before the first cut);
 *   - scene tags: setting, subject, shot type, energy and storytelling devices for every scene;
 *   - the video's audio type (voice only, voice over music, music with lyrics, music only, ambient).
 * descriptionFeatures() turns those answers into numbers and categories the model can learn from.
 *
 * When the call fails, lyricsHeuristic() still separates the clear cases (the sound's title sung in the
 * transcript, or scenes described as singing with no one speaking). Never throws. Pure except readContent,
 * which loads the AI client lazily.
 */
/** Bump when the questions, the lists or the derived features change: the daily job re-reads older videos. */
export const CONTENT_READ_VERSION = 1;

export const SPEECH_KINDS = Object.freeze(['spoken', 'sung', 'unclear']);
export const AUDIO_TYPES = Object.freeze(['voice_only', 'voice_over_music', 'music_with_lyrics', 'music_only', 'ambient_or_none', 'mixed']);
export const SETTINGS = Object.freeze([
    'home', 'kitchen', 'gym', 'outdoor_urban', 'outdoor_nature', 'car', 'store_or_restaurant', 'office_or_studio',
    'event_or_venue', 'screen_or_digital', 'other',
]);
export const SUBJECTS = Object.freeze([
    'person_talking', 'person_doing', 'multiple_people', 'animal', 'food', 'product', 'vehicle', 'place_or_scenery',
    'text_or_graphic', 'screen_content', 'other',
]);
export const SHOTS = Object.freeze(['close_up', 'medium', 'wide', 'pov', 'screen_recording', 'other']);
export const ENERGIES = Object.freeze(['calm', 'moderate', 'intense']);
export const DEVICES = Object.freeze([
    'before_after', 'reveal_or_result', 'demonstration', 'reaction', 'humor_or_gag', 'transformation', 'steps_or_list',
    'question_to_viewer', 'product_showcase', 'text_story', 'tension_or_suspense', 'call_to_action',
]);

const MAX_SCENES = 40;
const MAX_LINES = 80;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (x) => (x !== null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
const round = (x, places = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** places) / 10 ** places);
const wordCount = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
const segText = (s) => String(s?.text ?? s?.value ?? '');
const segStart = (s) => num(s?.tStart ?? s?.start);
const segEnd = (s) => num(s?.tEnd ?? s?.end);

export const contentReadSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['audioType', 'speech', 'scenes'],
    properties: {
        audioType: { type: 'string', enum: [...AUDIO_TYPES], description: 'What the soundtrack is overall.' },
        speech: {
            type: 'array',
            description: 'One entry per transcript line, by its number.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['line', 'kind'],
                properties: {
                    line: { type: 'integer' },
                    kind: { type: 'string', enum: [...SPEECH_KINDS], description: 'spoken = someone talking (to camera, voice-over, dialogue); sung = lyrics of a song or music track; unclear = cannot tell.' },
                },
            },
        },
        scenes: {
            type: 'array',
            description: 'One entry per scene, by its number.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['scene', 'setting', 'subject', 'shot', 'energy', 'devices'],
                properties: {
                    scene: { type: 'integer' },
                    setting: { type: 'string', enum: [...SETTINGS] },
                    subject: { type: 'string', enum: [...SUBJECTS], description: 'The main thing the viewer looks at.' },
                    shot: { type: 'string', enum: [...SHOTS] },
                    energy: { type: 'string', enum: [...ENERGIES] },
                    devices: { type: 'array', items: { type: 'string', enum: [...DEVICES] }, description: 'Storytelling devices clearly present in this scene (often none).' },
                },
            },
        },
    },
};

// ---- the fallback: lyrics without a model

const VOCAL_MUSIC = /\b(sing|sings|singing|sung|singer|lyric|lyrics|vocals?|vocal track|song with (male|female)?\s*vocals?|rap|rapping)\b/i;
const SPEECH_CUE = /\b(voice[- ]?over|narrat\w*|speak\w*|talk\w*|says|said|explain\w*|dialogue|conversation|interview\w*|addresses)\b/i;
const NOT_TITLE = /^(original|sound|sonido|son|som|audio|feat|ft|remix|edit|sped|slowed|version|official|the|and|with|from|that|this|your|you|for)$/i;
const normWords = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

/** Words of a sound title worth matching against a transcript (no "original sound", handles or filler). */
export const titleWords = (soundTitle) => {
    const title = String(soundTitle ?? '');
    if (!title || /original sound|son original|sonido original|som original|originalton|suono originale/i.test(title)) return [];
    const main = title.split(/\s[-–—]\s|\s\(|\[/)[0];
    return [...new Set(normWords(main).filter((w) => w.length >= 3 && !NOT_TITLE.test(w)))];
};

/**
 * Per transcript line: 'sung' when the line contains the song title, or when the scenes describe singing
 * or vocals and nobody speaking; otherwise 'spoken'. Returns { speech: [kind per line], audioType|null }.
 */
export const lyricsHeuristic = ({ transcript = [], scenes = [], soundTitle = null } = {}) => {
    const lines = Array.isArray(transcript) ? transcript : [];
    const audio = (Array.isArray(scenes) ? scenes : []).map((s) => `${s?.audioSummary ?? ''} ${s?.primaryAction ?? ''}`).join(' ');
    const vocals = VOCAL_MUSIC.test(audio);
    const speechCue = SPEECH_CUE.test(audio);
    const title = titleWords(soundTitle);
    const need = Math.min(2, title.length);
    const speech = lines.map((s) => {
        const words = new Set(normWords(segText(s)));
        if (need > 0 && title.filter((w) => words.has(w)).length >= need) return 'sung';
        if (vocals && !speechCue) return 'sung';
        return 'spoken';
    });
    const sung = speech.filter((k) => k === 'sung').length;
    const audioType = !lines.length ? null : sung === lines.length ? 'music_with_lyrics' : sung ? 'mixed' : null;
    return { speech, audioType };
};

// ---- the model call

const sceneLine = (s, n) => {
    const t = Number.isFinite(s?.startTime) ? `[${round(s.startTime, 1)}-${round(s.endTime, 1)}s] ` : '';
    return `${n}. ${t}visual: ${clip(s?.visualDescription, 260)} | action: ${clip(s?.primaryAction, 100)} | text: ${clip(s?.onScreenText, 100)} | audio: ${clip(s?.audioSummary, 120)} | tone: ${clip(s?.emotionalTone, 40)} | purpose: ${clip(s?.purpose, 20)}`;
};
const transcriptLine = (s, i) => `${i}. [${round(segStart(s), 1) ?? '?'}-${round(segEnd(s), 1) ?? '?'}s] "${clip(segText(s), 220)}"`;

/** The prompt for one video. Exported for tests. */
export const buildReadPrompt = ({ scenes = [], transcript = [], soundTitle = null, caption = null } = {}) => [
    'Read this short-form video from its scene descriptions and transcript.',
    '1) For every transcript line, decide if it is spoken (someone talking: to camera, voice-over, dialogue) or sung (lyrics of a song or the music track). A line that matches the sound title, rhymes like a song, or plays while the audio is described as a song with vocals and nobody speaks is sung.',
    '2) For every scene, tag the setting, the main subject, the shot type, the energy, and any storytelling devices clearly present.',
    '3) Say what the soundtrack is overall.',
    `Sound: "${clip(soundTitle, 100) || 'unknown'}"`,
    `Caption: "${clip(caption, 200)}"`,
    'Scenes:',
    ...scenes.slice(0, MAX_SCENES).map((s, i) => sceneLine(s, i + 1)),
    'Transcript lines:',
    ...(transcript.length ? transcript.slice(0, MAX_LINES).map((s, i) => transcriptLine(s, i + 1)) : ['(none)']),
].join('\n');

/** Model answer (+ the heuristic for lines it did not cover) -> the stored read. */
export const normalizeRead = (answer, { transcript = [], scenes = [], heuristic } = {}) => {
    const lines = Array.isArray(transcript) ? transcript : [];
    const h = heuristic ?? lyricsHeuristic({ transcript: lines, scenes });
    const byLine = new Map((answer?.speech ?? []).map((x) => [Number(x?.line), SPEECH_KINDS.includes(x?.kind) ? x.kind : null]));
    const speech = lines.map((_, i) => byLine.get(i + 1) ?? h.speech[i] ?? 'spoken');
    const byScene = new Map((answer?.scenes ?? []).map((x) => [Number(x?.scene), x]));
    const tags = (Array.isArray(scenes) ? scenes : []).slice(0, MAX_SCENES).map((_, i) => {
        const x = byScene.get(i + 1);
        if (!x) return null;
        return {
            setting: SETTINGS.includes(x.setting) ? x.setting : 'other',
            subject: SUBJECTS.includes(x.subject) ? x.subject : 'other',
            shot: SHOTS.includes(x.shot) ? x.shot : 'other',
            energy: ENERGIES.includes(x.energy) ? x.energy : null,
            devices: [...new Set((Array.isArray(x.devices) ? x.devices : []).filter((d) => DEVICES.includes(d)))],
        };
    });
    return {
        version: CONTENT_READ_VERSION,
        source: answer ? 'model' : 'heuristic',
        audioType: AUDIO_TYPES.includes(answer?.audioType) ? answer.audioType : h.audioType ?? null,
        speech,
        scenes: tags,
        at: new Date(),
    };
};

/**
 * Reads one video. Returns the stored read: { version, source, audioType, speech[], scenes[], at }.
 * With no scenes and no transcript there is nothing to read: returns null.
 */
export const readContent = async ({ scenes = [], transcript = [], soundTitle = null, caption = null } = {}, { complete } = {}) => {
    const sc = Array.isArray(scenes) ? scenes : [];
    const tr = Array.isArray(transcript) ? transcript.filter((s) => segText(s).trim()) : [];
    if (!sc.length && !tr.length) return null;
    const heuristic = lyricsHeuristic({ transcript: tr, scenes: sc, soundTitle });
    try {
        const run = complete ?? (await import('../openai-response.service.js')).requestStructuredCompletion;
        const { withAiContext } = await import('../../lib/ai-tracking.js');
        const answer = await withAiContext({ feature: 'learning_content_read' }, () => run({
            messages: [{ role: 'user', content: buildReadPrompt({ scenes: sc, transcript: tr, soundTitle, caption }) }],
            schemaName: 'content_read',
            label: 'learning_content_read',
            jsonSchema: contentReadSchema,
            systemPrompt: 'You tag short-form videos factually from closed lists, using only the descriptions given. Return structured data only.',
            role: 'classifier',
            temperature: 0,
            maxTokens: 3000,
        }));
        return normalizeRead(answer, { transcript: tr, scenes: sc, heuristic });
    } catch {
        return normalizeRead(null, { transcript: tr, scenes: sc, heuristic });
    }
};

// ---- applying a read

/** Transcript lines that are speech (lyrics removed). No read = every line counts, as before. */
export const spokenTranscript = (transcript = [], read = null) => {
    const lines = (Array.isArray(transcript) ? transcript : []).filter((s) => segText(s).trim());
    if (!read?.speech?.length) return lines;
    return lines.filter((_, i) => read.speech[i] !== 'sung');
};

/** Lines that are lyrics. */
export const sungTranscript = (transcript = [], read = null) => {
    const lines = (Array.isArray(transcript) ? transcript : []).filter((s) => segText(s).trim());
    if (!read?.speech?.length) return [];
    return lines.filter((_, i) => read.speech[i] === 'sung');
};

const PERSON = new Set(['person_talking', 'person_doing', 'multiple_people']);
const DEVICE_KEYS = {
    before_after: 'descBeforeAfter', reveal_or_result: 'descReveal', demonstration: 'descDemonstration', reaction: 'descReaction',
    humor_or_gag: 'descHumor', transformation: 'descTransformation', steps_or_list: 'descSteps', question_to_viewer: 'descQuestionToViewer',
    product_showcase: 'descProductShown', text_story: 'descTextStory', tension_or_suspense: 'descTension', call_to_action: 'descCallToAction',
};

/**
 * Features from a read: lyrics vs speech, and what the descriptions show (setting, subject, shot types,
 * energy, devices, how often the picture changes). Shares are weighted by scene time when scenes are timed.
 */
export const descriptionFeatures = (read, { scenes = [], transcript = [], durationSec = null } = {}) => {
    if (!read) return {};
    const out = {};
    const lines = (Array.isArray(transcript) ? transcript : []).filter((s) => segText(s).trim());
    if (read.audioType) out.audioType = read.audioType;
    if (lines.length && read.speech?.length) {
        const total = lines.reduce((sum, s) => sum + wordCount(segText(s)), 0);
        const sung = lines.reduce((sum, s, i) => sum + (read.speech[i] === 'sung' ? wordCount(segText(s)) : 0), 0);
        out.lyricsShare = total ? round(sung / total) : null;
        out.hasSpokenWords = lines.some((_, i) => read.speech[i] !== 'sung');
    } else if (read.speech) {
        out.hasSpokenWords = false;
    }
    const sc = (Array.isArray(scenes) ? scenes : []).slice(0, MAX_SCENES);
    const tagged = sc.map((s, i) => ({ s, t: read.scenes?.[i] })).filter((x) => x.t);
    if (!tagged.length) return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
    const timed = tagged.every(({ s }) => Number.isFinite(s?.startTime) && Number.isFinite(s?.endTime) && s.endTime > s.startTime);
    const weight = ({ s }) => (timed ? s.endTime - s.startTime : 1);
    const totalW = tagged.reduce((sum, x) => sum + weight(x), 0);
    const share = (test) => (totalW > 0 ? round(tagged.filter(test).reduce((sum, x) => sum + weight(x), 0) / totalW) : null);
    const settingTime = new Map();
    for (const x of tagged) settingTime.set(x.t.setting, (settingTime.get(x.t.setting) ?? 0) + weight(x));
    const dominant = [...settingTime.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    let subjectChanges = 0;
    let settingChanges = 0;
    for (let i = 1; i < tagged.length; i++) {
        if (tagged[i].t.subject !== tagged[i - 1].t.subject) subjectChanges += 1;
        if (tagged[i].t.setting !== tagged[i - 1].t.setting) settingChanges += 1;
    }
    const duration = num(durationSec) > 0 ? num(durationSec) : timed ? tagged.at(-1).s.endTime - tagged[0].s.startTime : null;
    const first = tagged[0].t;
    Object.assign(out, {
        descSetting: dominant,
        openingSubject: first.subject,
        openingShot: first.shot,
        descSettingCount: settingTime.size,
        descSubjectChangesPerMin: duration > 0 ? round((subjectChanges / duration) * 60, 2) : null,
        descSettingChangesPerMin: duration > 0 ? round((settingChanges / duration) * 60, 2) : null,
        descVariety: tagged.length >= 2 ? round(new Set(tagged.map((x) => `${x.t.subject}|${x.t.shot}`)).size / tagged.length) : null,
        descPersonShare: share((x) => PERSON.has(x.t.subject)),
        descTalkingShare: share((x) => x.t.subject === 'person_talking'),
        descCloseUpShare: share((x) => x.t.shot === 'close_up'),
        descWideShare: share((x) => x.t.shot === 'wide'),
        descPovShare: share((x) => x.t.shot === 'pov'),
        descIntenseShare: tagged.some((x) => x.t.energy) ? share((x) => x.t.energy === 'intense') : null,
    });
    for (const [device, key] of Object.entries(DEVICE_KEYS)) out[key] = tagged.some((x) => x.t.devices.includes(device));
    const reveal = tagged.find((x) => x.t.devices.includes('reveal_or_result') || x.t.devices.includes('before_after'));
    if (reveal && timed) out.descRevealSec = round(reveal.s.startTime, 2);
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
};

/** Feature keys computed from speech: recomputed (or removed) when a read changes which lines are speech. */
export const SPEECH_KEYS = Object.freeze([
    'firstSpeechSec', 'speechWpm', 'speechCoverage', 'openingWords', 'wordsBeforeFirstCut', 'textWhileSpeakingShare', 'hookTextAndSpeech',
]);
