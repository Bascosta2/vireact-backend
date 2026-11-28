/**
 * The edit decision list (EDL) Claude returns, its strict JSON schema, and the server-side checks.
 * Structural problems (bad segments, unknown ids, too short, promises) go back to Claude for one
 * retry; small out-of-range details (a graphic on a cut moment) are dropped quietly.
 *
 * Plans saved before graphics/transitions/effects/look existed are still valid: compose.js fills
 * their defaults and turns legacy `textOverlays` into pill graphics.
 */

export const CAPTION_PRESETS = ['bold_pop', 'highlight', 'impact', 'clean'];
/** Presets that were removed, and the look that plays instead (saved plans and edits keep working). */
const LEGACY_CAPTION_PRESETS = { karaoke: 'bold_pop' };
export const captionPreset = (v, fallback = 'bold_pop') => (CAPTION_PRESETS.includes(v) ? v : LEGACY_CAPTION_PRESETS[v] ?? fallback);

/**
 * Built-in sound effects by family. Each one is synthesized by scripts/generate-sfx.js and ships with
 * the web app at public/sfx/<type>.mp3; the composition's SFX_SECONDS must list every type.
 */
export const SFX_FAMILIES = Object.freeze({
    movement: ['whoosh', 'swoosh', 'swish', 'whip', 'sweep_up', 'sweep_down', 'reverse', 'riser', 'launch'],
    impact: ['boom', 'hit', 'thud', 'impact', 'bass_drop', 'kick', 'snap', 'clap'],
    interface: ['pop', 'click', 'tick', 'tap', 'blip', 'bubble', 'drip', 'typing', 'page', 'shutter'],
    tone: ['ding', 'chime', 'bell', 'sparkle', 'shimmer', 'notify', 'success', 'coin', 'cash', 'power_up'],
    tension: ['suspense', 'glitch', 'static', 'zap', 'error', 'alert', 'power_down', 'pulse', 'heartbeat'],
});
export const SFX_TYPES = Object.values(SFX_FAMILIES).flat();

/**
 * Animated illustrations the composition can draw (vireact-frontend/src/remotion/visuals). Claude picks
 * one by name when the speaker talks about that thing. `about` is shown to Claude; `sfx` plays with it.
 */
export const VISUALS = Object.freeze({
    brain: { about: 'a brain with firing neural connections: the brain, mind, thinking, memory, focus, psychology, dopamine', sfx: 'pulse' },
    heart: { about: 'a beating heart with a pulse line: heart, health, cardio, love, emotion', sfx: 'heartbeat' },
    dna: { about: 'a turning DNA helix: genetics, biology, what you are born with', sfx: 'shimmer' },
    strength: { about: 'a dumbbell being lifted: gym, workout, muscle, strength, discipline', sfx: 'thud' },
    sleep: { about: 'a moon with stars: sleep, rest, night, tiredness, recovery', sfx: 'chime' },
    eye: { about: 'an eye that opens and looks around: attention, views, watching, first impressions', sfx: 'blip' },
    water: { about: 'a water drop with ripples: water, hydration, a single drop', sfx: 'drip' },
    plant: { about: 'a seedling growing leaves: habits, patience, compounding, slow growth, nature', sfx: 'bubble' },
    money: { about: 'banknotes and coins: money, income, revenue, salary, price, profit', sfx: 'cash' },
    growth: { about: 'a chart climbing with an arrow: numbers going up, more sales, gains', sfx: 'sweep_up' },
    decline: { about: 'a chart falling with an arrow: numbers dropping, a loss, a crash', sfx: 'sweep_down' },
    target: { about: 'an arrow hitting a bullseye: a goal, aim, one focus, precision, a niche', sfx: 'thud' },
    trophy: { about: 'a gold trophy: winning, first place, success, an achievement', sfx: 'success' },
    rocket: { about: 'a rocket taking off: a launch, fast growth, a startup, momentum', sfx: 'launch' },
    house: { about: 'a house: home, real estate, rent, a mortgage', sfx: 'tap' },
    idea: { about: 'a light bulb switching on: an idea, insight, a tip, a realization, creativity', sfx: 'ding' },
    book: { about: 'an open book with turning pages: reading, learning, study, a lesson', sfx: 'page' },
    search: { about: 'a magnifying glass scanning: searching, research, finding, looking closer', sfx: 'blip' },
    question: { about: 'a glowing question mark: a question, a mystery, why, the unknown', sfx: 'suspense' },
    warning: { about: 'a warning triangle: a mistake, danger, risk', sfx: 'alert' },
    check: { about: 'a green check mark: correct, do this, yes, done', sfx: 'success' },
    cross: { about: 'a red cross: wrong, do not do this, no, a myth', sfx: 'error' },
    lock: { about: 'a padlock closing: a secret, security, privacy, exclusive', sfx: 'click' },
    time: { about: 'a clock with moving hands: time, hours, speed, a deadline, waiting', sfx: 'tick' },
    phone: { about: 'a phone with a scrolling feed and likes: social media, scrolling, an app, notifications', sfx: 'notify' },
    ai: { about: 'a glowing AI chip with signals: AI, automation, technology, an algorithm', sfx: 'power_up' },
    code: { about: 'a code window typing itself: coding, software, a website', sfx: 'typing' },
    chat: { about: 'two chat bubbles: a conversation, comments, messages, feedback', sfx: 'bubble' },
    audience: { about: 'a network of people growing: followers, community, customers, an audience', sfx: 'chime' },
    video: { about: 'a video player with a play button: a video, content, a channel', sfx: 'blip' },
    globe: { about: 'a turning globe: the world, global, the internet, travel, countries', sfx: 'shimmer' },
    fire: { about: 'a flame: hot, trending, burning, intensity, a streak', sfx: 'whoosh' },
    lightning: { about: 'a lightning bolt: energy, power, speed, a shock', sfx: 'zap' },
    battery: { about: 'a battery charging: energy levels, burnout, recharging', sfx: 'power_up' },
    star: { about: 'gold stars: a rating, quality, reviews, a favourite', sfx: 'sparkle' },
    shield: { about: 'a shield with a check: protection, safety, immunity, trust', sfx: 'chime' },
    atom: { about: 'an atom with orbiting electrons: science, physics, chemistry', sfx: 'shimmer' },
    gears: { about: 'two turning gears: a system, a process, how something works', sfx: 'tick' },
    calendar: { about: 'a calendar with a marked day: a date, a schedule, consistency, a plan', sfx: 'page' },
    mountain: { about: 'a mountain with a flag on top: a challenge, a journey, a long-term goal', sfx: 'sweep_up' },
    music: { about: 'bouncing music notes: music, a song, sound, rhythm', sfx: 'chime' },

    // --- Story-grade subjects (Stage 2 of the story-first pipeline) ---
    // Marine
    whale: { about: 'a massive blue whale swimming: whale, leviathan, ocean giant, deep sea mammal', sfx: 'whoosh' },
    shark: { about: 'a shark cutting through water: shark, predator, fin, jaws', sfx: 'whoosh' },
    squid: { about: 'a squid with trailing tentacles: squid, cephalopod, ink', sfx: 'bubble' },
    octopus: { about: 'an octopus with eight arms: octopus, tentacles, cephalopod', sfx: 'bubble' },
    dolphin: { about: 'a leaping dolphin: dolphin, porpoise, playful sea mammal', sfx: 'whoosh' },
    turtle: { about: 'a sea turtle gliding: turtle, tortoise, shell', sfx: 'whoosh' },
    jellyfish: { about: 'a pulsing jellyfish: jellyfish, medusa, glowing bell and tentacles', sfx: 'bubble' },
    fish_school: { about: 'a school of small fish swimming together: fish school, shoal, swarm', sfx: 'whoosh' },
    coral: { about: 'a coral reef: coral, reef, underwater garden', sfx: 'bubble' },
    submarine: { about: 'a submarine underwater: submarine, submersible, underwater vessel', sfx: 'thud' },
    underwater_cave: { about: 'an underwater cave or ruins: cave, ruins, sunken temple, grotto', sfx: 'suspense' },

    // Characters
    person: { about: 'a person standing: person, human, someone, figure', sfx: 'tap' },
    child: { about: 'a child: kid, child, young person', sfx: 'chime' },
    elder: { about: 'an older person: elder, grandparent, wise figure', sfx: 'chime' },
    runner: { about: 'a person running: runner, sprint, athlete in motion', sfx: 'whoosh' },
    silhouette: { about: 'a human silhouette: silhouette, shadow figure, outline of a person', sfx: 'whoosh' },
    crowd: { about: 'a crowd of people: crowd, audience in person, group, gathering', sfx: 'chime' },

    // Vehicles and built environment
    car: { about: 'a car on the road: car, vehicle, automobile, drive', sfx: 'whoosh' },
    plane: { about: 'an airplane in the sky: plane, aircraft, flight', sfx: 'whoosh' },
    ship: { about: 'a ship on the sea: ship, boat, vessel, sail', sfx: 'whoosh' },
    city: { about: 'a city skyline: city, skyline, buildings, urban', sfx: 'tap' },
    bridge: { about: 'a bridge spanning a gap: bridge, crossing, span', sfx: 'thud' },
    factory: { about: 'a factory with chimneys: factory, plant, industry, manufacturing', sfx: 'tick' },
    desk: { about: 'a desk with work on it: desk, workspace, office table', sfx: 'tap' },
    laptop: { about: 'an open laptop: laptop, notebook computer, screen', sfx: 'blip' },

    // Nature and environment
    tree: { about: 'a tree: tree, trunk and canopy, woodland tree', sfx: 'whoosh' },
    forest: { about: 'a dense forest: forest, woods, many trees', sfx: 'whoosh' },
    river: { about: 'a flowing river: river, stream, flowing water', sfx: 'drip' },
    desert: { about: 'a desert dune: desert, sand, arid landscape', sfx: 'whoosh' },
    storm: { about: 'a storm with dark clouds: storm, thunderstorm, tempest', sfx: 'zap' },
    sun: { about: 'a bright sun: sun, daylight, solar', sfx: 'sparkle' },
    moon: { about: 'a moon in the night sky: moon, lunar, night light', sfx: 'chime' },
    stars: { about: 'a field of stars: stars, night sky, constellation', sfx: 'sparkle' },
    cloud: { about: 'a drifting cloud: cloud, sky, weather', sfx: 'whoosh' },
    wave: { about: 'an ocean wave cresting: wave, surf, breaker', sfx: 'whoosh' },
    cave: { about: 'a cave entrance: cave, cavern, dark opening in rock', sfx: 'suspense' },

    // Land flora and fauna
    bird: { about: 'a bird in flight: bird, wings, flying animal', sfx: 'whoosh' },
    wolf: { about: 'a wolf: wolf, wild canine, pack animal', sfx: 'whoosh' },
    deer: { about: 'a deer: deer, stag, antlers', sfx: 'whoosh' },
    fox: { about: 'a fox: fox, red fox, cunning animal', sfx: 'whoosh' },
    horse: { about: 'a horse: horse, stallion, galloping animal', sfx: 'whoosh' },
    lion: { about: 'a lion: lion, big cat, mane', sfx: 'whoosh' },
    butterfly: { about: 'a butterfly: butterfly, wings, flutter', sfx: 'sparkle' },
    bee: { about: 'a bee: bee, honeybee, pollinator', sfx: 'blip' },
    flower: { about: 'a flower in bloom: flower, blossom, bloom', sfx: 'sparkle' },
    seedling: { about: 'a small seedling: seedling, sprout, young plant', sfx: 'bubble' },

    // Abstract / concept
    path: { about: 'a winding path forward: path, road ahead, journey line', sfx: 'sweep_up' },
    door: { about: 'an open door: door, doorway, entrance, opportunity', sfx: 'click' },
    bridge_concept: { about: 'a conceptual bridge between two ideas: connecting bridge, link, span between points', sfx: 'chime' },
    clock: { about: 'a clock face: clock, timepiece, hours', sfx: 'tick' },
    ladder: { about: 'a ladder climbing up: ladder, steps upward, ascent', sfx: 'sweep_up' },
});
export const VISUAL_NAMES = Object.keys(VISUALS);

export const GRAPHIC_TYPES = ['slam', 'pill', 'headline', 'lower_third', 'counter', 'list', 'callout', 'cta', 'visual', 'chart'];
export const TRANSITION_STYLES = ['punch', 'whip', 'flash', 'glitch', 'none'];
export const EFFECT_TYPES = ['shake', 'flash'];
export const GRADES = ['vivid', 'warm', 'cool', 'punchy_bw', 'none'];
export const ACCENTS = ['yellow', 'green', 'pink', 'orange', 'blue', 'red'];
export const CHANGE_KINDS = ['cut', 'reorder', 'captions', 'zoom', 'hook', 'overlay', 'graphics', 'transition', 'effects', 'music', 'sfx', 'framing', 'look'];
export const EVIDENCE = ['knowledge', 'viral_example', 'footage'];
export const SEGMENT_ROLES = ['hook', 'setup', 'body', 'payoff', 'cta'];

const BANNED = /\b(guarantee[ds]?|will go viral|go viral for sure|100% viral|viral guaranteed)\b/i;
const MIN_SEGMENT_SEC = 0.4;
const MIN_OUTPUT_SEC = 3;
const EDGE_TOLERANCE = 0.25;
export const LIMITS = Object.freeze({ graphics: 40, sfx: 80, effects: 30, zooms: 40, listItems: 6 });

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
/**
 * Claude's structured outputs compile this schema into a grammar with a size limit ("The compiled
 * grammar is too large" fails every request). Measured against the API on 2026-11-13, so keep it lean:
 * - allowed values live in descriptions, not `enum` (validateEdl maps anything else to a default);
 * - no arrays nested inside arrays (list items are one "a | b | c" string);
 * - transitions + look share one `style` object, sound effects + shake/flash share one `beats` list;
 * - long lists of names (sounds, illustrations) live in the system prompt, not here; an illustration
 *   reuses the graphic's `items` string for its name instead of adding a field.
 * The schema below fits with room for about one more small array; test any addition against the API
 * before shipping it.
 */
const enumOf = (values) => ({ type: 'string', description: `One of: ${values.join(', ')}` });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });

export const EDL_SCHEMA = obj({
    summary: str,
    hookStrategy: str,
    segments: arr(obj({ id: str, start: num, end: num, role: enumOf(SEGMENT_ROLES), reason: str })),
    acceptedCandidateIds: arr(str),
    captions: obj({ preset: enumOf(CAPTION_PRESETS), emphasisWordIdx: arr({ type: 'integer' }) }),
    hookOverlay: obj({ enabled: bool, text: str, durationSec: num }),
    zooms: arr(obj({ at: num, duration: num, scale: num, focusX: num, focusY: num })),
    // Animated on-screen graphics. Unused fields: "" or 0.5. `items`: "First | Second | Third" for a
    // list, the illustration name for a visual.
    graphics: arr(obj({
        type: enumOf(GRAPHIC_TYPES),
        start: num,
        end: num,
        text: str,
        subtext: str,
        items: { type: 'string', description: 'list: items separated by " | "; chart: "label: value" bars separated by " | "; visual: the illustration name' },
        focusX: num,
        focusY: num,
    })),
    style: obj({
        transition: enumOf(TRANSITION_STYLES),
        jumpCutZoom: bool,
        grade: enumOf(GRADES),
        accent: enumOf(ACCENTS),
        progressBar: bool,
        motion: bool,
    }),
    framing: obj({ mode: enumOf(['fill', 'fit_blur']), focusX: num }),
    music: obj({ trackId: str, volume: num, reason: str }),
    // Timed beats: a sound effect type or a visual effect (shake, flash).
    beats: arr(obj({ type: { type: 'string', description: 'a sound name, or shake, or flash' }, at: num })),
    changes: arr(obj({ kind: enumOf(CHANGE_KINDS), label: str, why: str, evidence: enumOf(EVIDENCE) })),
    expectedEffect: str,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const pick = (v, values, fallback) => (values.includes(v) ? v : fallback);

const inSegments = (t, segments) => segments.some((s) => t >= s.start && t < s.end);

/** What a graphic needs before it is worth showing: an illustration we can draw, list items, or text. */
const graphicHasContent = (g) => (g.type === 'visual' ? Boolean(g.visual) : g.type === 'list' ? g.items.length > 0 : g.type === 'chart' ? g.items.filter((x) => /\d/.test(x)).length >= 2 : Boolean(g.text));

/** Shortest and longest on-screen time per graphic type, in seconds. */
const GRAPHIC_DURATION = { slam: [0.6, 2.5], pill: [0.8, 4], headline: [1.2, 5], lower_third: [1.5, 5], counter: [1.2, 4], list: [1.5, 8], callout: [0.8, 3.5], cta: [1.5, 5], visual: [1.4, 4.5], chart: [2.2, 7] };

/** "Light Bulb" / "light-bulb" → a known illustration name, or null. */
const visualName = (v) => {
    const name = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    return VISUAL_NAMES.includes(name) ? name : null;
};

export function normalizeGraphic(g) {
    const type = pick(g?.type, GRAPHIC_TYPES, 'pill');
    const [lo, hi] = GRAPHIC_DURATION[type];
    const start = r3(g?.start);
    const rawItems = Array.isArray(g?.items) ? g.items : String(g?.items ?? '').split('|');
    const items = rawItems.map((x) => clip(x, 40)).filter(Boolean).slice(0, LIMITS.listItems);
    // A list needs time to reveal every item, a chart to grow every bar.
    const minDur = type === 'list' ? Math.max(lo, 0.6 + items.length * 0.45) : type === 'chart' ? Math.max(lo, 1.4 + items.length * 0.4) : lo;
    const out = {
        type,
        start,
        end: r3(start + clamp((Number(g?.end) || start) - start, minDur, hi)),
        text: clip(g?.text, type === 'slam' || type === 'pill' || type === 'visual' ? 32 : 60),
        subtext: clip(g?.subtext, 60),
        items,
        focusX: r3(clamp(g?.focusX ?? 0.5, 0, 1)),
        focusY: r3(clamp(g?.focusY ?? 0.5, 0, 1)),
    };
    if (type !== 'visual') return out;
    // The illustration's name arrives in `items` (or already as `visual` in a saved plan). A name we
    // cannot draw leaves `visual` null and the graphic is dropped.
    const visual = visualName(g?.visual) ?? visualName(rawItems[0]) ?? visualName(g?.text);
    return { ...out, items: [], visual, text: visualName(out.text) === visual ? '' : out.text };
}

/**
 * @param {object} edl raw model output
 * @param {{durationSec:number, wordCount:number, candidateIds:Set<string>|string[], trackIds:Set<string>|string[], candidateRanges?:Record<string,{start:number,end:number}>}} ctx
 * @returns {{ok:boolean, issues:string[], plan:object|null}}
 */
export function validateEdl(edl, ctx) {
    const issues = [];
    const duration = Number(ctx.durationSec) || 0;
    const candidateIds = new Set(ctx.candidateIds ?? []);
    const trackIds = new Set(ctx.trackIds ?? []);
    if (!edl || typeof edl !== 'object') return { ok: false, issues: ['Response was not an object'], plan: null };

    const segments = (edl.segments ?? []).map((s) => ({ ...s, start: r3(s.start), end: r3(s.end) }));
    if (segments.length === 0) issues.push('segments is empty: keep at least one part of the footage');
    const ids = new Set();
    for (const s of segments) {
        if (!s.id || ids.has(s.id)) issues.push(`segment id "${s.id}" is missing or repeated`);
        ids.add(s.id);
        if (s.start < -EDGE_TOLERANCE || s.end > duration + EDGE_TOLERANCE) issues.push(`segment ${s.id} (${s.start}-${s.end}) is outside the video (0-${duration})`);
        if (s.end - s.start < MIN_SEGMENT_SEC) issues.push(`segment ${s.id} is shorter than ${MIN_SEGMENT_SEC}s`);
        s.start = clamp(s.start, 0, duration);
        s.end = clamp(s.end, 0, duration);
    }
    const bySource = [...segments].sort((a, b) => a.start - b.start);
    for (let i = 1; i < bySource.length; i += 1) {
        if (bySource[i].start < bySource[i - 1].end - 0.05) issues.push(`segments ${bySource[i - 1].id} and ${bySource[i].id} overlap: each moment of footage can be used once`);
    }

    const accepted = [...new Set(edl.acceptedCandidateIds ?? [])];
    const unknown = accepted.filter((id) => !candidateIds.has(id));
    if (unknown.length) issues.push(`acceptedCandidateIds has unknown ids: ${unknown.slice(0, 5).join(', ')}`);

    // Output length after accepted cuts.
    const ranges = ctx.candidateRanges ?? {};
    const cutInside = (s) => accepted.reduce((n, id) => {
        const c = ranges[id];
        if (!c) return n;
        return n + Math.max(0, Math.min(c.end, s.end) - Math.max(c.start, s.start));
    }, 0);
    const outputSec = segments.reduce((n, s) => n + Math.max(0, s.end - s.start - cutInside(s)), 0);
    const minOut = Math.min(MIN_OUTPUT_SEC, duration * 0.5);
    if (segments.length && outputSec < minOut) issues.push(`the edit is only ${outputSec.toFixed(1)}s long; keep at least ${minOut.toFixed(1)}s`);

    const emphasis = (edl.captions?.emphasisWordIdx ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < (ctx.wordCount ?? 0));
    const musicId = String(edl.music?.trackId ?? '').trim();
    if (musicId && !trackIds.has(musicId)) issues.push(`music.trackId "${musicId}" is not in the sound library; use one of the listed ids or ""`);

    const graphicsIn = (edl.graphics ?? []).map(normalizeGraphic);
    const beats = Array.isArray(edl.beats) ? edl.beats : [];
    const sfxIn = [...(edl.sfx ?? []), ...beats.filter((b) => SFX_TYPES.includes(b?.type))];
    const effectsIn = [...(edl.effects ?? []), ...beats.filter((b) => EFFECT_TYPES.includes(b?.type))];
    const style = edl.style ?? {};
    const transitionStyle = style.transition ?? edl.transitions?.style;
    const jumpCutZoom = style.jumpCutZoom ?? edl.transitions?.jumpCutZoom;
    const look = { ...(edl.look ?? {}), ...Object.fromEntries(['grade', 'accent', 'progressBar', 'motion'].filter((k) => k in style).map((k) => [k, style[k]])) };
    const texts = [
        edl.summary, edl.hookStrategy, edl.expectedEffect, edl.hookOverlay?.text,
        ...(edl.changes ?? []).flatMap((c) => [c.label, c.why]),
        ...graphicsIn.flatMap((g) => [g.text, g.subtext, ...g.items]),
        ...(edl.textOverlays ?? []).map((o) => o.text),
    ];
    if (texts.some((t) => BANNED.test(String(t ?? '')))) issues.push('remove promises such as "guaranteed" or "will go viral"; describe the expected effect without guarantees');

    if (issues.length) return { ok: false, issues, plan: null };

    const kept = segments;
    const plan = {
        summary: clip(edl.summary, 600),
        hookStrategy: clip(edl.hookStrategy, 400),
        segments: kept.map((s) => ({ id: s.id, start: s.start, end: s.end, role: pick(s.role, SEGMENT_ROLES, 'body'), reason: clip(s.reason, 200) })),
        acceptedCandidateIds: accepted,
        captions: { preset: captionPreset(edl.captions?.preset), emphasisWordIdx: [...new Set(emphasis)] },
        hookOverlay: {
            enabled: Boolean(edl.hookOverlay?.enabled && clip(edl.hookOverlay?.text, 60)),
            text: clip(edl.hookOverlay?.text, 60),
            durationSec: r3(clamp(edl.hookOverlay?.durationSec ?? 2, 1, 3)),
        },
        zooms: (edl.zooms ?? [])
            .filter((z) => inSegments(z.at, kept))
            .slice(0, LIMITS.zooms)
            .map((z) => ({ at: r3(z.at), duration: r3(clamp(z.duration, 0.3, 4)), scale: r3(clamp(z.scale, 1.0, 1.35)), focusX: r3(clamp(z.focusX, 0, 1)), focusY: r3(clamp(z.focusY, 0, 1)), reason: clip(z.reason, 160) })),
        graphics: graphicsIn.filter((g) => graphicHasContent(g) && inSegments(g.start, kept)).slice(0, LIMITS.graphics),
        transitions: { style: pick(transitionStyle, TRANSITION_STYLES, 'punch'), jumpCutZoom: jumpCutZoom !== false },
        effects: effectsIn.filter((e) => EFFECT_TYPES.includes(e.type) && inSegments(e.at, kept)).slice(0, LIMITS.effects).map((e) => ({ type: e.type, at: r3(e.at) })),
        look: {
            grade: pick(look.grade, GRADES, 'vivid'),
            accent: pick(look.accent, ACCENTS, 'yellow'),
            progressBar: look.progressBar !== false,
            motion: look.motion !== false,
        },
        // Legacy field; new plans put text in `graphics`.
        textOverlays: [],
        framing: { mode: edl.framing?.mode === 'fit_blur' ? 'fit_blur' : 'fill', focusX: r3(clamp(edl.framing?.focusX ?? 0.5, 0, 1)) },
        music: { trackId: musicId || null, volume: r3(clamp(edl.music?.volume ?? 0.15, 0, 0.6)), reason: clip(edl.music?.reason, 200) },
        sfx: sfxIn.filter((s) => SFX_TYPES.includes(s.type) && inSegments(s.at, kept)).slice(0, LIMITS.sfx).map((s) => ({ type: s.type, at: r3(s.at) })),
        changes: (edl.changes ?? []).slice(0, 24).map((c) => ({ kind: pick(c.kind, CHANGE_KINDS, 'cut'), label: clip(c.label, 120), why: clip(c.why, 300), evidence: pick(c.evidence, EVIDENCE, 'footage') })),
        expectedEffect: clip(edl.expectedEffect, 400),
    };
    return { ok: true, issues: [], plan };
}

/**
 * A validated plan in the shape EDL_SCHEMA asks Claude for (style, beats, "a | b" items), so a
 * regeneration shows Claude its previous plan in the same format it must answer in. Works for plans
 * saved before graphics existed.
 */
export function toSchemaShape(plan) {
    const transitions = plan.transitions ?? { style: 'punch', jumpCutZoom: true };
    const look = plan.look ?? { grade: 'vivid', accent: 'yellow', progressBar: true, motion: true };
    const graphics = plan.graphics ?? (plan.textOverlays ?? []).map((o) => normalizeGraphic({ type: 'pill', start: o.start, end: o.end, text: o.text }));
    return {
        summary: plan.summary,
        hookStrategy: plan.hookStrategy,
        segments: plan.segments,
        acceptedCandidateIds: plan.acceptedCandidateIds,
        captions: { ...plan.captions, preset: captionPreset(plan.captions?.preset) },
        hookOverlay: plan.hookOverlay,
        zooms: (plan.zooms ?? []).map(({ at, duration, scale, focusX, focusY }) => ({ at, duration, scale, focusX, focusY })),
        graphics: graphics.map(({ visual, ...g }) => ({ ...g, items: g.type === 'visual' ? visual ?? '' : (g.items ?? []).join(' | ') })),
        style: { transition: transitions.style, jumpCutZoom: transitions.jumpCutZoom, ...look },
        framing: plan.framing,
        music: { ...plan.music, trackId: plan.music?.trackId ?? '' },
        beats: [...(plan.sfx ?? []), ...(plan.effects ?? [])].sort((a, b) => a.at - b.at),
        changes: plan.changes,
        expectedEffect: plan.expectedEffect,
    };
}
