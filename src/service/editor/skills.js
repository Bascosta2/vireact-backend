/**
 * Editing skills (Skills tab). A skill is a packaged editing style: rules the AI planner follows and a
 * set of render changes applied to the plan (captions, hook, sound, graphics). The composition draws a
 * skill's own components when props.skill is set (vireact-frontend/src/remotion/skills/).
 *
 * Skills come from the editor-skills inbox (parent project, editor-skills/), reviewed and ported by hand:
 * nothing from a skill file runs here as-is.
 */

/** Words that keep their capitals in casual-case captions. */
const KEEP_CASE = Object.freeze({ i: 'I', "i'm": "I'm", "i'll": "I'll", "i've": "I've", "i'd": "I'd", ai: 'AI', ok: 'OK', tv: 'TV', usa: 'USA', uk: 'UK' });

/** Lowercase except the pronoun I, acronyms in KEEP_CASE, and words written in capitals (likely names or acronyms). */
export const casualCase = (text) => {
    const raw = String(text ?? '');
    const core = raw.replace(/[,.?!:;]+$/, '');
    const tail = raw.slice(core.length);
    const lower = core.toLowerCase();
    if (KEEP_CASE[lower]) return KEEP_CASE[lower] + tail;
    // All-caps words of 2+ letters (NASA, CEO) and words with an inner capital (iPhone, YouTube) stay.
    if (/^[A-Z0-9]{2,}$/.test(core) || /^[a-z]+[A-Z]/.test(core) || /^[A-Z][a-z]+[A-Z]/.test(core)) return raw;
    return lower + tail;
};

export const HOOK_VARIANTS = Object.freeze(['white', 'black', 'plain']);

export const SKILLS = Object.freeze({
    'remotion-reel': {
        id: 'remotion-reel',
        name: 'Remotion Reel',
        version: 1,
        /** Rules from the skill (SKILL.md, captions.md, text-hook.md, motion-graphics.md, audio.md), for the planner. */
        plannerRules: [
            'EDITING SKILL: REMOTION REEL (follow these on top of every rule above; where they conflict, these win)',
            '- Measure, do not guess: every cut, graphic, zoom and sound effect is anchored to a word start from the transcript or to a detected scene change. Never place anything "around" a time.',
            '- Text hook: write hookOverlay.text as a short on-screen text hook in Instagram\'s native text style that frames the video ("How to start content / if you\'re shy"). Use the creator\'s own phrasing, 3 to 9 words, sentence case, no emoji, no hashtags. Put a " / " where the line should break (at most two lines, each under about 24 characters). It stays still on screen from the first frame until the first full-screen graphic, so set hookOverlay.durationSec to how long the opening thought lasts (2 to 6 seconds).',
            '- Captions: 1 to 3 words a line, casual lowercase, no pop or motion. The server sets the look; mark emphasis words sparingly (at most one every few lines).',
            '- Read the story, not the sentences: find hook, setup, turn, payoff and call to action. Graphics go only where a visual adds something the words cannot: about 3 to 6 in a 50-second video, with plain talking head between them. A graphic on every line is noise.',
            '- Give each graphic a job: prove (a claim or number: counter or callout), explain (a list or visual), emphasize (the one line the creator leans on: headline). Do not use slam graphics (stamp text is out for this style).',
            '- Graphics start on the word they illustrate, already moving, and hold until the next graphic replaces them. Keep anything that matters inside the Instagram 4:5 safe band (the middle of the frame).',
            '- Words appear once: when a headline shows the exact words being spoken, the captions for that span are not needed; prefer headlines for lines the captions would not carry well.',
            '- Sound: pops on graphic landings, whooshes on moves. Plan fewer cues than you think (creators cut about a third), never two within one second of each other. Music sits well under the voice: music.volume between 0.12 and 0.2.',
            '- Never put purple in anything (choose look.accent other than pink if unsure). No letterbox bars, no hand-drawn circles or underlines, no glow pooled in the middle of the frame.',
            '- Transitions: whip or none. Framing only jumps on a real cut; zooms are slow, eased pushes.',
        ].join('\n'),
        /** Render rules for this skill (compose.js reads them). */
        render: {
            captions: { maxWords: 3, maxChars: 17, hold: false, capWordSec: 0.55, tailSec: 0.1, casual: true },
            dropGraphicTypes: ['slam'],
            transitionStyles: ['whip', 'none'],
            musicVolume: { min: 0.12, max: 0.2 },
            hookSfx: false,
        },
    },
});

export const isSkill = (id) => typeof id === 'string' && Object.hasOwn(SKILLS, id);
export const skillFor = (id) => (isSkill(id) ? SKILLS[id] : null);

/** The hook text split into its lines: the planner marks the break with " / "; otherwise balanced at a space. */
export const hookLines = (text, maxLine = 24) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const marked = clean.split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    if (marked.length > 1) return marked.slice(0, 3);
    if (clean.length <= maxLine) return [clean];
    const words = clean.split(' ');
    let best = null;
    for (let k = 1; k < words.length; k += 1) {
        const a = words.slice(0, k).join(' ');
        const b = words.slice(k).join(' ');
        const score = Math.max(a.length, b.length);
        if (!best || score < best.score) best = { lines: [a, b], score };
    }
    return best ? best.lines : [clean];
};
