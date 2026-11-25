import { requestClaudeJson } from '../../lib/anthropic.js';
import { MUSIC_MOODS } from '../../model/sound-asset.model.js';
import { SFX_FOR_TRANSITION } from './compose.js';
import { VISUALS, VISUAL_NAMES, validateEdl } from './edl.js';
import { ANIMATION_STYLES, styleLayout } from './skills.js';

/**
 * Story mode of the Skills Editor: the creator types an idea and picks an animation style; Claude writes
 * exactly three storyboard alternatives; the creator picks one (and may touch up its words) and confirms;
 * then the video is built from that storyboard alone. No footage and no cutting: every scene is timed
 * from its words at reading pace, so there is nothing to cut wrong.
 *
 * The finished video is an ordinary edit (plan + word timings), so preview, captions editing, style
 * switching and export all work as for an uploaded video. The composition draws each scene's backdrop
 * (vireact-frontend src/remotion/showcase/screens.tsx) or the style's own animated scene in place of
 * footage (props.storyboard).
 */

export const STORYBOARD_OPTIONS = 3;
export const STORYBOARD_LENGTHS = Object.freeze([15, 30, 45, 60]);
export const MAX_STORYBOARD_ROUNDS = 3;
export const PROMPT_LIMITS = Object.freeze({ min: 12, max: 1500 });

/** Backdrops the composition can draw behind a scene (styles with their own scene ignore them). */
export const BACKDROPS = Object.freeze({
    'city-night': 'a city skyline at night, lit windows and traffic',
    'city-day': 'a sunny city street with buildings and traffic',
    nature: 'mountains, a lake and pine trees under an open sky',
    ocean: 'the open sea with rolling waves to the horizon',
    space: 'outer space with stars, a ringed planet and a moon',
    room: 'a cosy room with a desk, a window, a lamp and a plant',
    'product-dark': 'a product (a drink can) turning in a dark studio',
    'toy-box': 'a toy box being opened on a table',
    game: 'a side-scrolling platform video game',
    race: 'a racing game on a road toward the horizon',
    app: 'a phone app screen being tapped',
    abstract: 'soft shapes and gradients drifting in the style colours',
});
export const BACKDROP_IDS = Object.keys(BACKDROPS);

const GRAPHIC_KINDS = ['none', 'headline', 'list', 'counter', 'chart', 'visual', 'slam', 'pill', 'cta'];
/** The music library's moods (sound-asset.model.js MUSIC_MOODS), so a mood finds a track. */
const MOODS = MUSIC_MOODS;
const BANNED = /\b(guarantee[ds]?|will go viral|go viral for sure|100% viral|viral guaranteed)\b/gi;

const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });

/** Kept small (no enums, lists as "a | b" strings): see the grammar-size note on EDL_SCHEMA. */
export const STORYBOARD_SCHEMA = obj({
    options: arr(obj({
        title: str,
        logline: str,
        angle: str,
        mood: str,
        musicTrackId: str,
        scenes: arr(obj({
            narration: str,
            backdrop: str,
            emphasis: str,
            graphicType: str,
            graphicText: str,
            graphicSubtext: str,
            graphicItems: str,
        })),
    })),
});

const clip = (s, n) => String(s ?? '').replace(BANNED, '').replace(/#\w+/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wordsOf = (s) => String(s ?? '').split(/\s+/).filter(Boolean);
const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Scenes and words to aim for at a length (people read about 2.4 words a second on screen). */
export const targetsFor = (lengthSec) => {
    const len = STORYBOARD_LENGTHS.includes(Number(lengthSec)) ? Number(lengthSec) : 30;
    return { lengthSec: len, scenes: { 15: [3, 4], 30: [4, 6], 45: [5, 7], 60: [6, 8] }[len], words: Math.round((len - 3) * 2.1) };
};

/** True when the style draws its own scene, so backdrops do not apply. */
export const drawsOwnScene = (styleId) => ['story', 'explainer'].includes(styleLayout(styleId));

function systemPrompt(styleId, lengthSec, tracks) {
    const s = ANIMATION_STYLES[styleId];
    const t = targetsFor(lengthSec);
    const scene = drawsOwnScene(styleId);
    return [
        'You write storyboards for short vertical (9:16) animated videos. Vireact draws every frame in code in one animation style: the scenes, the on-screen words, graphics, transitions, music and sound. There is no camera footage and no voice: the words of each scene appear on screen as captions, so they are the story.',
        '',
        `STYLE: ${s.name}. Look: ${s.look}. Best for ${s.bestFor}. Motion: ${s.motion}.`,
        `LENGTH: about ${t.lengthSec} seconds: ${t.scenes[0]} to ${t.scenes[1]} scenes and about ${t.words} words of narration in total (people read about 2.4 words a second).`,
        '',
        'Write EXACTLY 3 storyboard options for the creator\'s idea. Each must tell the idea well and in full, and each must take a clearly different angle, for example: a little story with a character and a turn; a punchy explainer that teaches it step by step; an emotional or surprising take that lands on a strong last line. Say the angle in a few words in `angle`.',
        '',
        'FOR EACH OPTION',
        '- title: 2 to 6 words, shown big for the first two seconds. No emoji.',
        '- logline: one sentence saying what the video is.',
        `- mood: one of ${MOODS.join(', ')}.`,
        `- musicTrackId: the id of the track below that fits the mood best, or "" if none fits.`,
        '- scenes, in order. Each scene:',
        '  - narration: 5 to 28 words of plain, vivid sentences, the words shown on screen for this scene. Together the scenes tell the whole story from first line to last; the first scene hooks, the last one pays off. No emoji, no hashtags, no stage directions, no "Scene 1".',
        scene
            ? `  - backdrop: "scene" (this style paints its own world behind every scene).`
            : `  - backdrop: what is behind the words, one of: ${BACKDROP_IDS.map((b) => `${b} (${BACKDROPS[b]})`).join('; ')}. Pick what fits each scene; vary them when the story moves.`,
        '  - emphasis: 1 or 2 key words from the narration, separated by " | ".',
        `  - graphicType: one of ${GRAPHIC_KINDS.join(', ')}. Use a graphic in most scenes, but only one that shows something the words alone do not:`,
        '    headline: graphicText a 2-6 word title, graphicSubtext optional;',
        '    list: graphicText a short title, graphicItems 2-5 short items separated by " | ";',
        '    counter: graphicText a number ("87%", "$10,000", "3x"), graphicSubtext what it measures;',
        '    chart: graphicText a title, graphicItems 2-6 bars as "label: value" separated by " | " (only numbers that belong to the story);',
        '    visual: graphicItems one illustration name from the list below, graphicText an optional 1-3 word label;',
        '    slam: graphicText 1-3 punchy words, at most once per option;',
        '    pill: graphicText a 2-5 word label;',
        '    cta: only in the last scene, graphicText the closing ask ("Follow for part 2").',
        '    Unused fields are "".',
        '',
        'ILLUSTRATIONS (for visual)',
        ...VISUAL_NAMES.map((n) => `- ${n}: ${VISUALS[n].about}`),
        '',
        'MUSIC TRACKS',
        ...(tracks.length ? tracks.map((m) => `- ${m.slug}: "${m.title}", mood ${m.mood ?? '?'}, energy ${m.energy ?? '?'}/5`) : ['(none: use "")']),
        '',
        'RULES',
        '- Stay true to what the creator asked for; keep facts accurate and never invent statistics; when you are unsure of a number, leave it out.',
        '- Never promise results (no "guaranteed", no "will go viral").',
        '- Keep it suitable for all audiences. If the idea asks for something harmful or hateful, write a safe, kind version of it instead.',
        '- Write in the language the creator wrote in.',
    ].join('\n');
}

/** Clean one option from Claude (or from the creator's touch-ups) into the shape the builder needs. */
export function normalizeOption(o, styleId) {
    const scene = drawsOwnScene(styleId);
    const raw = Array.isArray(o?.scenes) ? o.scenes : [];
    const scenes = raw
        .map((sc, k) => {
            const narration = clip(sc?.narration, 260);
            if (wordsOf(narration).length < 3) return null;
            let type = GRAPHIC_KINDS.includes(sc?.graphicType) ? sc.graphicType : 'none';
            if (type === 'cta' && k !== raw.length - 1) type = 'pill';
            const items = String(sc?.graphicItems ?? '').split('|').map((x) => clip(x, 40)).filter(Boolean).slice(0, 6);
            let graphic = null;
            if (type === 'visual') {
                const name = String(items[0] ?? sc?.graphicText ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
                graphic = VISUAL_NAMES.includes(name) ? { type, text: VISUAL_NAMES.includes(norm(sc?.graphicText)) ? '' : clip(sc?.graphicText, 32), subtext: '', items: [], visual: name } : null;
            } else if (type === 'list') {
                graphic = items.length >= 2 ? { type, text: clip(sc?.graphicText, 60), subtext: '', items } : null;
            } else if (type === 'chart') {
                const bars = items.filter((x) => /\d/.test(x));
                graphic = bars.length >= 2 ? { type, text: clip(sc?.graphicText, 60), subtext: '', items: bars } : null;
            } else if (type !== 'none') {
                const text = clip(sc?.graphicText, type === 'slam' || type === 'pill' ? 32 : 60);
                graphic = text ? { type, text, subtext: clip(sc?.graphicSubtext, 60), items: [] } : null;
            }
            const emphasis = String(sc?.emphasis ?? '').split('|').map(norm).filter(Boolean).slice(0, 3);
            return { narration, backdrop: scene ? 'scene' : BACKDROP_IDS.includes(sc?.backdrop) ? sc.backdrop : 'abstract', emphasis, graphic };
        })
        .filter(Boolean)
        .slice(0, 10);
    // At most one slam per video.
    let slams = 0;
    for (const sc of scenes) if (sc.graphic?.type === 'slam' && ++slams > 1) sc.graphic = null;
    return {
        title: clip(o?.title, 60) || clip(scenes[0]?.narration, 40),
        logline: clip(o?.logline, 240),
        angle: clip(o?.angle, 80),
        mood: MOODS.includes(o?.mood) ? o.mood : 'upbeat',
        musicTrackId: clip(o?.musicTrackId, 80),
        scenes,
    };
}

/**
 * Ask Claude for the three storyboards. `previous` + `note` ask for three new ones that follow the
 * creator's note. Throws when fewer than three usable options come back (after one retry).
 */
export async function generateStoryboards({ prompt, styleId, lengthSec, tracks = [], note = '', previous = [] }, deps = {}) {
    const request = deps.request ?? requestClaudeJson;
    const user = [
        `THE CREATOR'S IDEA:\n${String(prompt).trim()}`,
        note ? `\nThey saw these storyboards and asked for three new ones. Their note: "${note}"\nPrevious titles: ${previous.map((p) => `"${p.title}"`).join(', ')}` : '',
        '\nReturn exactly 3 options.',
    ].join('\n');
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const { data, generationId } = await request({
            label: 'storyboard_options',
            system: systemPrompt(styleId, lengthSec, tracks),
            messages: [{ role: 'user', content: attempt ? `${user}\nYour last answer did not have 3 usable options with at least 2 scenes each. Write all 3 in full.` : user }],
            schema: STORYBOARD_SCHEMA,
            effort: 'medium',
            maxTokens: 24000,
        });
        const options = (data?.options ?? []).map((o) => normalizeOption(o, styleId)).filter((o) => o.scenes.length >= 2);
        if (options.length >= STORYBOARD_OPTIONS) {
            const trackIds = new Set(tracks.map((t) => t.slug));
            return {
                options: options.slice(0, STORYBOARD_OPTIONS).map((o) => ({ ...o, musicTrackId: trackIds.has(o.musicTrackId) ? o.musicTrackId : pickTrack(tracks, o.mood) })),
                generationId: generationId ?? null,
            };
        }
        lastError = new Error(`Claude returned ${options.length} usable storyboards`);
    }
    throw lastError;
}

/** A track whose mood matches, else the first one; '' when the library is empty. */
const pickTrack = (tracks, mood) => (tracks.find((t) => t.mood === mood) ?? tracks[0])?.slug ?? '';

/** How long a word stays on screen: longer words a little longer, within a readable range. */
const wordSec = (w) => clamp(0.2 + 0.036 * w.length, 0.28, 0.78);

export const STORYBOARD_TIMING = Object.freeze({ hookSec: 2.3, lead: 0.45, tail: 0.85, minScene: 3.2, gap: 0.07, sentence: 0.35, comma: 0.12 });

/**
 * Build the edit for a confirmed storyboard: word timings at reading pace (the "transcript" the
 * captions follow), one scene after another with room to breathe, a graphic per scene inside its
 * scene, the title as the hook, and the music. Returns a validated plan plus the timings.
 */
export function buildStoryboardEdit(option, { trackIds = new Set() } = {}) {
    const T = STORYBOARD_TIMING;
    const words = [];
    const emphasisWordIdx = [];
    const timing = [];
    const graphics = [];
    let t = 0;
    option.scenes.forEach((sc, k) => {
        const start = t;
        t += k === 0 ? T.hookSec + 0.3 : T.lead;
        const emph = new Set(sc.emphasis ?? []);
        for (const w of wordsOf(sc.narration)) {
            const d = wordSec(w);
            if (emph.has(norm(w))) emphasisWordIdx.push(words.length);
            words.push({ w, start: r3(t), end: r3(t + d) });
            t += d + T.gap;
            if (/[.!?]["')\]]?$/.test(w)) t += T.sentence;
            else if (/[,;:]$/.test(w)) t += T.comma;
        }
        t += T.tail;
        if (t - start < T.minScene) t = start + T.minScene;
        timing.push({ start: r3(start), end: r3(t), backdrop: sc.backdrop });
        if (sc.graphic) {
            const gStart = k === 0 ? T.hookSec + 0.2 : start + 0.3;
            const g = sc.graphic;
            graphics.push({ type: g.type, start: r3(gStart), end: r3(t - 0.25), text: g.text, subtext: g.subtext ?? '', items: g.type === 'visual' ? g.visual : (g.items ?? []).join(' | '), focusX: 0.5, focusY: 0.4 });
        }
    });
    const durationSec = r3(t + 0.4);
    const edl = {
        summary: option.logline || option.title,
        hookStrategy: option.angle || 'The title opens the story.',
        segments: [{ id: 's1', start: 0, end: durationSec, role: 'body', reason: 'The whole storyboard, scene by scene.' }],
        acceptedCandidateIds: [],
        captions: { preset: 'bold_pop', emphasisWordIdx },
        hookOverlay: { enabled: true, text: option.title, durationSec: T.hookSec },
        zooms: [],
        graphics,
        style: { transition: 'none', jumpCutZoom: false, grade: 'none', accent: 'yellow', progressBar: false, motion: true },
        framing: { mode: 'fill', focusX: 0.5 },
        music: { trackId: trackIds.has(option.musicTrackId) ? option.musicTrackId : '', volume: 0.42, reason: `Fits the ${option.mood} mood.` },
        beats: [],
        changes: [],
        expectedEffect: option.logline || '',
    };
    const res = validateEdl(edl, { durationSec, wordCount: words.length, candidateIds: [], candidateRanges: {}, trackIds });
    if (!res.ok) throw new Error(`Storyboard plan invalid: ${res.issues.join('; ')}`);
    return { plan: res.plan, words, durationSec, timing };
}

/**
 * Finish the render props of a storyboard edit: the scenes for the composition to draw (in place of
 * footage), a transition with its sound at every scene change, and music that never ducks (there is
 * no voice to make room for).
 */
export function decorateStoryboardProps(props, project, edits = {}) {
    const fps = props.fps;
    const total = props.durationInFrames;
    const timing = project.storyboard?.final?.timing ?? [];
    const scenes = timing.map((s, k) => {
        const startFrame = Math.round(s.start * fps);
        const endFrame = k === timing.length - 1 ? total : Math.round(timing[k + 1].start * fps);
        return { startFrame, durationFrames: Math.max(1, endFrame - startFrame), backdrop: s.backdrop };
    });
    const styleId = props.skill?.id;
    const pool = ANIMATION_STYLES[styleId]?.sfx?.transition ?? SFX_FOR_TRANSITION.flash;
    const transitions = edits.transitionsOff ? [] : scenes.slice(1).map((s) => ({ type: 'flash', frame: s.startFrame }));
    const sfx = edits.sfxOff ? props.sfx : [...props.sfx, ...transitions.map((tr, k) => ({ type: pool[k % pool.length], frame: Math.max(0, tr.frame - 3), volume: 0.42 }))].sort((a, b) => a.frame - b.frame);
    return {
        ...props,
        videoUrl: '',
        transitions,
        sfx,
        music: props.music ? { ...props.music, duck: [] } : null,
        storyboard: { scenes },
    };
}
