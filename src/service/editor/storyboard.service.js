import { requestClaudeJson } from '../../lib/anthropic.js';
import { MUSIC_MOODS } from '../../model/sound-asset.model.js';
import { SFX_FOR_TRANSITION } from './compose.js';
import { VISUALS, VISUAL_NAMES, validateEdl } from './edl.js';
import { semanticMascotFitEnabled, semanticSubjectMatchesMascot } from './semantic-mascot.service.js';
import { ANIMATION_STYLES, skillFor, styleLayout } from './skills.js';

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

/**
 * Kept small (no enums, lists as "a | b" strings): see the grammar-size note on EDL_SCHEMA. Schema v2
 * (2026-11-27): each option carries a `subjects` registry extracted from the creator's prompt, and
 * every scene names the `subject` and `action` it is about. The registry persists on the project so
 * references stay consistent across scenes and future regenerations; the subject/action fields let
 * the backend compute whether the style's painted mascot fits the story (if not, the ambient scene is
 * auto-disabled so the viewer is not watching a jellyfish while hearing about a whale).
 */
export const STORYBOARD_SCHEMA = obj({
    options: arr(obj({
        title: str,
        logline: str,
        angle: str,
        mood: str,
        musicTrackId: str,
        // Persistent subject registry for this storyboard: the characters, objects and places the
        // story is about. Scenes refer back to these by `subject` (the name field) so one blue whale
        // stays one blue whale across the video.
        subjects: arr(obj({
            name: str,          // 1 to 5 words, the name used in the story ("the blue whale")
            description: str,   // 4 to 20 words naming shape, colour, scale, mood ("huge, slow, deep blue")
            role: str,          // "protagonist" | "supporting" | "object" | "environment"
            visualId: str,      // one illustration from VISUALS that approximates this subject, or ""
        })),
        scenes: arr(obj({
            narration: str,
            // The subject this scene is about, taken from the subjects registry (same name field).
            subject: str,
            // The action happening in this scene, in the creator's words ("descends into the deep").
            action: str,
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
    const skill = skillFor(styleId);
    const mascotSubjects = skill?.mascotSubjects ?? [];
    const t = targetsFor(lengthSec);
    const scene = drawsOwnScene(styleId);
    const mascotWarning = scene && mascotSubjects.length
        ? [
            '',
            `TECHNICAL REALITY — the painted scene behind every scene in ${s.name} is a FIXED animation that always draws: ${mascotSubjects.join(', ')}. It does NOT change based on your narration. It renders the same whether your story is about ${mascotSubjects[0]} or about something completely different.`,
            `- When your story IS about ${mascotSubjects.join(' or ')}, the painted scene reinforces the subject and the ambient atmosphere (colour, light, particles, layering) carries the mood. Lean into it.`,
            `- When your story is NOT about those subjects, the painted scene becomes decorative background — the atmosphere still fits the style, but the specific creature does NOT illustrate your story. In that case, the GRAPHICS layer must carry the subject: every scene names its subject in a headline, list or visual (from the ILLUSTRATIONS vocabulary when one honestly matches), so the viewer reads what the story is about even when the painted scene is unrelated. Do not pretend the painted scene depicts the story's subject; the server auto-dims it when the subject does not match.`,
        ].join('\n')
        : '';
    return [
        'You write storyboards for short vertical (9:16) animated videos for the creator at Vireact. Vireact draws every frame in code in one animation style: the scenes, the on-screen words, graphics, transitions, music and sound. There is no camera footage and no voiceover; the words of each scene appear on screen as captions, so the captions ARE the story. The chosen storyboard is then built, rendered and shown to real viewers; it must stand on its own.',
        '',
        `STYLE: ${s.name}. Look: ${s.look}. Best for ${s.bestFor}. Motion: ${s.motion}.`,
        `LENGTH: about ${t.lengthSec} seconds: ${t.scenes[0]} to ${t.scenes[1]} scenes and about ${t.words} words of narration in total (people read about 2.4 words a second).`,
        mascotWarning,
        '',
        'HOW TO THINK (do this silently before you write anything)',
        '1. NARRATIVE UNDERSTANDING. Read the creator\'s idea and extract: the main subject(s), supporting subjects, environments, key actions and events, chronology (what happens first, then, finally), emotional arc (opening feeling to closing feeling), and anything the creator explicitly asked for. Distinguish what they asked for from what you would like to add.',
        '2. CREATIVE DIRECTION. The style sets the LOOK (colour, light, texture, pacing, sound palette). The creator\'s story sets WHAT HAPPENS. Where the style\'s defaults would push the story in a different direction than the creator\'s idea, follow the creator.',
        '3. SCENE-BY-SCENE PLAN. Break the story into scenes, each with a single subject and a single action. The first scene is the hook; the last scene is the payoff. Scenes follow the creator\'s chronology.',
        '',
        'Write EXACTLY 3 storyboard options for the creator\'s idea. Each must tell the idea well and in full, each from a clearly different angle (e.g. an emotional little story with a turn; a punchy explainer that teaches it step by step; a quiet reflective take that lands on a strong last line). Say the angle in a few words in `angle`.',
        '',
        'FOR EACH OPTION',
        '- title: 2 to 6 words, shown big for the first two seconds. No emoji.',
        '- logline: one sentence saying what the video is.',
        `- mood: one of ${MOODS.join(', ')}.`,
        `- musicTrackId: the id of the track below that fits the mood best, or "" if none fits.`,
        '- subjects: the registry of every character, object and place the story depends on, extracted from the creator\'s idea. 1 to 6 entries, each with:',
        '    name: 1 to 5 words, the way the story names it ("the blue whale", "the squid", "the cave"); the SAME name is used in every scene that is about it, so the viewer meets ONE whale, not a new whale each scene.',
        '    description: 4 to 20 words: shape, scale, colour, mood, anything that keeps the subject consistent across scenes ("huge, slow, deep blue with a pale underside").',
        '    role: one of "protagonist", "supporting", "object", "environment".',
        '    visualId: the ONE illustration from the VISUALS list below whose `about` line most closely approximates this subject, or "" when nothing in VISUALS honestly matches (do not stretch). This is a hint for the graphics layer.',
        '- scenes, in order. Each scene:',
        '  - narration: 5 to 28 words of plain, vivid sentences, the words shown on screen for this scene. Together the scenes tell the whole story from first line to last. No emoji, no hashtags, no stage directions, no "Scene 1".',
        '  - subject: the name of the subject this scene is about, taken from the subjects registry above. One per scene.',
        '  - action: 3 to 10 words naming what the subject is doing ("descends into the deep", "releases a cloud of ink"). Written from the narration.',
        scene
            ? `  - backdrop: "scene" (this style paints its own world behind every scene).`
            : `  - backdrop: what is behind the words, one of: ${BACKDROP_IDS.map((b) => `${b} (${BACKDROPS[b]})`).join('; ')}. Pick what fits each scene; vary them when the story moves.`,
        '  - emphasis: 1 or 2 key words from the narration, separated by " | ".',
        `  - graphicType: one of ${GRAPHIC_KINDS.join(', ')}. Use a graphic in most scenes; it is the layer that carries the story\'s subject on screen. Pick the type by what the scene needs:`,
        '    visual: use when the subject genuinely matches an entry in the ILLUSTRATIONS list below (check the `about` descriptions, do not stretch); graphicItems is the illustration name, graphicText is an optional 1-3 word label naming the subject in the creator\'s words ("THE BLUE WHALE", "THE SQUID");',
        '    headline: use when no illustration fits but the scene still needs to name its subject on screen; graphicText is a 2-6 word title in the creator\'s words ("THE BLUE WHALE", "DEEP OCEAN CAVE"), graphicSubtext optional ("ascending to the surface", "bioluminescent, ancient");',
        '    list: graphicText a short title, graphicItems 2-5 short items separated by " | ", for an ordered process or a set of elements;',
        '    counter: graphicText a number ("87%", "$10,000", "3x"), graphicSubtext what it measures; only when the narration states that number;',
        '    chart: graphicText a title, graphicItems 2-6 bars as "label: value" separated by " | " (only numbers that belong to the story); only when the narration compares real numbers;',
        '    slam: graphicText 1-3 punchy words, at most once per option;',
        '    pill: graphicText a 2-5 word label;',
        '    cta: only in the last scene, graphicText the closing ask ("Follow for part 2").',
        '    none: only when the painted scene\'s mascot IS the subject AND the narration is self-sufficient; otherwise always carry the subject in a graphic.',
        '    Unused fields are "".',
        '',
        'ILLUSTRATIONS (for visual and for subjects.visualId; pick only when the `about` line honestly matches the subject)',
        ...VISUAL_NAMES.map((n) => `- ${n}: ${VISUALS[n].about}`),
        '',
        'MUSIC TRACKS',
        ...(tracks.length ? tracks.map((m) => `- ${m.slug}: "${m.title}", mood ${m.mood ?? '?'}, energy ${m.energy ?? '?'}/5`) : ['(none: use "")']),
        '',
        'RULES',
        '- STORY FIRST: the creator\'s idea decides WHAT the video is about. The style decides HOW it looks and feels. When they conflict, follow the creator.',
        '- Stay true to what the creator asked for; keep facts accurate and never invent statistics; when you are unsure of a number, leave it out.',
        '- Never promise results (no "guaranteed", no "will go viral").',
        '- Keep it suitable for all audiences. If the idea asks for something harmful or hateful, write a safe, kind version of it instead.',
        '- Write in the language the creator wrote in.',
    ].filter(Boolean).join('\n');
}

const SUBJECT_ROLES = new Set(['protagonist', 'supporting', 'object', 'environment']);

/** Clean one option from Claude (or from the creator's touch-ups) into the shape the builder needs. */
export function normalizeOption(o, styleId) {
    const scene = drawsOwnScene(styleId);
    const rawSubjects = Array.isArray(o?.subjects) ? o.subjects : [];
    const subjects = rawSubjects
        .map((sb) => {
            const name = clip(sb?.name, 60);
            if (!name) return null;
            const visualId = String(sb?.visualId ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
            return {
                name,
                description: clip(sb?.description, 160),
                role: SUBJECT_ROLES.has(sb?.role) ? sb.role : 'supporting',
                visualId: VISUAL_NAMES.includes(visualId) ? visualId : '',
            };
        })
        .filter(Boolean)
        .slice(0, 6);
    const subjectNames = new Set(subjects.map((sb) => sb.name.toLowerCase()));
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
            // Scene subject only persists when it matches the registry (keeps references consistent); an
            // unknown name still carries the scene (we fall back to the empty string).
            const rawSubject = clip(sc?.subject, 60);
            const subject = rawSubject && subjectNames.has(rawSubject.toLowerCase()) ? rawSubject : (subjectNames.has(rawSubject.toLowerCase()) ? rawSubject : (subjects[0]?.name ?? ''));
            const action = clip(sc?.action, 120);
            return { narration, subject, action, backdrop: scene ? 'scene' : BACKDROP_IDS.includes(sc?.backdrop) ? sc.backdrop : 'abstract', emphasis, graphic };
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
        subjects,
        scenes,
    };
}

/**
 * Does the story's subject vocabulary overlap the style's painted mascot vocabulary? Simple word
 * overlap (case-insensitive, plurals folded). When this returns false for a scene-layout style,
 * chooseStoryboard auto-sets `edits.sceneOff: true` so the viewer isn't watching the style's fixed
 * mascot (a jellyfish, say) while hearing about a completely different subject (a blue whale).
 * Styles whose Scene draws a generic object (a map, a board) declare no mascot subjects and fit anything.
 */
export function subjectMatchesMascot(subjects, styleId) {
    const skill = skillFor(styleId);
    const mascot = skill?.mascotSubjects ?? [];
    if (!mascot.length) return true;
    const fold = (w) => String(w).toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
    const storyWords = new Set();
    for (const sb of subjects ?? []) {
        for (const w of String(sb?.name ?? '').split(/\s+/)) if (w) storyWords.add(fold(w));
        for (const w of String(sb?.description ?? '').split(/\s+/)) if (w) storyWords.add(fold(w));
    }
    return mascot.some((m) => storyWords.has(fold(m)));
}

/**
 * Async mascot-fit check: uses semantic embeddings when EDITOR_SEMANTIC_MASCOT_FIT is on and the
 * configured provider answers; otherwise falls back to the word-overlap heuristic (`subjectMatchesMascot`
 * above). Callers in code paths that can await (chooseStoryboard, worker jobs) should prefer this.
 * Synchronous callers (validation, tests) keep using the overlap version.
 */
export async function subjectMatchesMascotAsync(subjects, styleId) {
    if (!semanticMascotFitEnabled()) return subjectMatchesMascot(subjects, styleId);
    const skill = skillFor(styleId);
    const mascot = skill?.mascotSubjects ?? [];
    const sem = await semanticSubjectMatchesMascot({ subjects, mascotSubjects: mascot });
    if (sem !== null) return sem;
    return subjectMatchesMascot(subjects, styleId);
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
    // The confirmed option carries `subjects[]` (persistent registry) and `scenes[].subject` +
    // `scenes[].action` (story-first schema v2). Thread them onto each scene so Remotion themes can
    // draw the right subject (Step 1 of the story-first pipeline: SubjectDraw seam). Also surface
    // the subject's generative-image assetUrl when Step 3 has populated it.
    const finalScenes = project.storyboard?.final?.scenes ?? [];
    const subjects = project.storyboard?.final?.subjects ?? project.storyboard?.subjects ?? [];
    const subjectByName = new Map(subjects.map((sb) => [String(sb?.name ?? '').toLowerCase(), sb]));
    const scenes = timing.map((s, k) => {
        const startFrame = Math.round(s.start * fps);
        const endFrame = k === timing.length - 1 ? total : Math.round(timing[k + 1].start * fps);
        const sc = finalScenes[k] ?? {};
        const subjectName = String(sc.subject ?? '').trim();
        const sb = subjectByName.get(subjectName.toLowerCase()) ?? null;
        return {
            startFrame,
            durationFrames: Math.max(1, endFrame - startFrame),
            backdrop: s.backdrop,
            subject: subjectName,
            subjectVisualId: sb?.visualId ?? '',
            subjectRole: sb?.role ?? '',
            subjectAssetUrl: sb?.assetUrl ?? '',
            action: String(sc.action ?? ''),
        };
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
        storyboard: { scenes, subjects: subjects.map((sb) => ({ name: sb?.name ?? '', description: sb?.description ?? '', role: sb?.role ?? '', visualId: sb?.visualId ?? '', assetUrl: sb?.assetUrl ?? '' })) },
    };
}
