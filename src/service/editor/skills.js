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

/** Every skill by id. Remotion Reel is below; the animation styles are added after ANIMATION_STYLES, then it is frozen. */
export const SKILLS = {
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
};

/**
 * Animation and painted styles, from the "10 Claude Animation Styles" guide (editor-skills/done/
 * animation-styles in the parent project) and the painting-media prompts (editor-skills/done/
 * painted-styles). Each is a skill: the whole edit (footage treatment, ambient layer, captions, hook,
 * graphics, transitions, progress) is drawn in that style by the composition
 * (vireact-frontend/src/remotion/styles/), and the planner follows the style's rules below.
 *
 * "Lego Style" is Brick Build, "PS2 Style" is Retro 3D and "Ghibli Style" is Painted Anime here:
 * those names are trademarks.
 *
 * `sfx` gives each style its own sound palette (built-in sounds only): `graphic` for graphics, `slam`,
 * `transition`, `countEnd`, `listItem`, `listEnd`, `hook` (one sound on the first frame, or null for
 * none) and `volume` (scales every sound).
 */
export const ANIMATION_STYLES = Object.freeze({
    'glow-sketch': {
        name: 'Glow Sketch',
        accent: '#FFC24B',
        look: 'a dark, night-time look: thin neon outlines, warm golden streetlight glow, a luminous city contour along the bottom, glowing text',
        bestFor: 'futuristic explainers, high-contrast motion graphics, night scenes',
        motion: 'elegant and cinematic: the glow breathes, the streetlight flickers, the skyline lights pulse. Calm pacing; let lines breathe',
        hook: 'like a neon sign: short and striking ("Edits that glow at night")',
        graphics: 'Headlines and counters carry the big claims; the neon look reads best with few elements. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['shimmer', 'sweep_up', 'blip'], slam: ['impact', 'shimmer'], transition: ['sweep_up', 'shimmer', 'whoosh'], countEnd: ['chime', 'sparkle'], listItem: ['tick'], listEnd: ['chime'], hook: 'shimmer' },
    },
    'comic-art': {
        name: 'Comic Art',
        accent: '#FFD400',
        look: 'an editorial comic page: bold black outlines, halftone dots, flat vibrant color, a white panel border and a narrator caption box',
        bestFor: 'story-led social content, playful explainers and pop visuals',
        motion: 'panel-like and punchy: things pop onto the page, slams land on a starburst, jumps turn the page with a panel swipe',
        hook: 'like a comic narrator\'s caption box that sets the scene ("Meanwhile, at my desk...")',
        graphics: 'Slams are comic sound words (BOOM!, WAIT, ZERO) on the 1 or 2 biggest moments only, paired with a shake. Pills read like caption boxes, headlines like title cards.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['pop', 'snap', 'clap'], slam: ['boom', 'impact', 'clap'], transition: ['whoosh', 'swish', 'whip'], countEnd: ['ding', 'clap'], listItem: ['pop'], listEnd: ['ding'], hook: 'pop' },
    },
    'brick-build': {
        name: 'Brick Build',
        accent: '#FFCD00',
        look: 'a bright, toy-like world of plastic bricks: brick plates with studs for cards, a band of bricks top and bottom, glossy primary colors',
        bestFor: 'family-friendly content, product demos and playful brand visuals',
        motion: 'snappy and toy-like, in small stop-motion steps: plates drop and click into place, jumps are covered by a wall of bricks',
        hook: 'like a toy box label: short, bright and playful',
        graphics: 'Lists suit this style best (steps that "build" something), then counters and pills. Slams sit on a red brick plate: at most 1.',
        captions: { maxWords: 3, maxChars: 15 },
        dropGraphicTypes: [],
        sfx: { graphic: ['click', 'snap', 'tap'], slam: ['thud', 'snap'], transition: ['click', 'snap', 'thud'], countEnd: ['ding', 'success'], listItem: ['click'], listEnd: ['success'], hook: 'snap' },
    },
    'pixel-art': {
        name: 'Pixel Art',
        accent: '#FFD43B',
        look: 'a crisp 8/16-bit game: pixel type, a HUD with score, hearts and an XP bar, pixel clouds, dialog boxes',
        bestFor: 'gaming content, retro campaigns, app intros and nostalgic motion',
        motion: 'in small steps, never smooth: things blink and step in, clouds loop, the hook types itself out like a game dialog',
        hook: 'like a game\'s dialog line or quest objective ("Quest: edit a reel / in 60 seconds")',
        graphics: 'Pills are game labels (LEVEL 1, BOSS FIGHT, NEW ITEM), counters are scores and multipliers (+100, x3), lists are quest logs. Pixel text is wide: keep every text short (under 14 characters a line).',
        captions: { maxWords: 2, maxChars: 14 },
        dropGraphicTypes: [],
        sfx: { graphic: ['blip', 'coin', 'power_up'], slam: ['zap', 'power_up'], transition: ['glitch', 'zap', 'static'], countEnd: ['coin'], listItem: ['blip'], listEnd: ['success', 'coin'], hook: 'power_up' },
    },
    chalkboard: {
        name: 'Chalkboard',
        accent: '#FFE66B',
        look: 'a classroom chalkboard: green board, wooden frame and chalk tray, white chalk lines with a dusty edge, colored chalk only for accents',
        bestFor: 'education, tutorials, classroom visuals and simplified explainers',
        motion: 'everything is written in: lines draw themselves, handwriting is revealed left to right in sequence, jumps are an eraser swipe',
        hook: 'like the lesson title written at the top of the board ("Editing 101", "Why hooks work")',
        graphics: 'Lists for steps, headlines as lesson titles ("Lesson 1: the hook"), callouts to point at something like a teacher would. At most 1 slam (it gets a chalk circle).',
        captions: { maxWords: 3, maxChars: 18 },
        dropGraphicTypes: [],
        sfx: { graphic: ['tap', 'page', 'tick'], slam: ['tap', 'thud'], transition: ['swish', 'page'], countEnd: ['ding'], listItem: ['tap'], listEnd: ['ding'], hook: 'tap' },
    },
    'retro-3d': {
        name: 'Retro 3D',
        accent: '#7CFFB2',
        look: 'an early-2000s 3D console game: chunky beveled HUD panels, metal lettering, distance fog, a low-poly crystal turning in the corner',
        bestFor: 'nostalgic gaming edits, retro motion loops and stylized ads',
        motion: 'simple game-camera moves: menus swing in on a hinge, a lock-on reticle for callouts, the camera swings round at each jump',
        hook: 'like a mission objective ("Mission: post every day / for 30 days")',
        graphics: 'Headlines like game banners (NEW AREA UNLOCKED), lists like menus, counters like stats. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 15 },
        dropGraphicTypes: [],
        sfx: { graphic: ['blip', 'power_up', 'click'], slam: ['impact', 'power_up'], transition: ['whoosh', 'sweep_down', 'power_up'], countEnd: ['ding', 'success'], listItem: ['blip'], listEnd: ['success'], hook: 'power_up' },
    },
    'flat-vector': {
        name: 'Flat Vector',
        accent: '#FF6B4A',
        look: 'a modern editorial flat illustration: smooth flat shapes, clean outlines, balanced coral, teal and sunny yellow, simple offset shadows',
        bestFor: 'presentations, startups, explainer videos and clean social graphics',
        motion: 'clean slide-ins, parallax shape layers and tidy easing, like a well-made presentation',
        hook: 'like a clean slide title: clear and friendly',
        graphics: 'Headlines, counters and lists, tidy and evenly spaced. No slams in this style.',
        captions: { maxWords: 3, maxChars: 17 },
        dropGraphicTypes: ['slam'],
        sfx: { graphic: ['pop', 'swoosh', 'tap'], transition: ['swoosh', 'swish'], countEnd: ['ding', 'success'], listItem: ['tap', 'pop'], listEnd: ['ding'], hook: 'pop' },
    },
    'minimal-line': {
        name: 'Minimal Line',
        accent: '#FF3B30',
        look: 'minimal line art: very thin outlines, sparse geometry, lots of negative space, a near-monochrome picture with one red accent, a premium design-system feel',
        bestFor: 'premium UI motion, clean brand systems and modern abstract explainers',
        motion: 'quiet: lines draw, things fade, lots of breathing room. Nothing bounces',
        hook: 'one calm, considered line ("Less, but better")',
        graphics: 'Fewer than usual: about one every 12 to 15 seconds, headlines and counters only. No slams. Few sound effects: plan no beats unless the script really needs one.',
        captions: { maxWords: 3, maxChars: 20, casual: true },
        dropGraphicTypes: ['slam'],
        sfx: { graphic: ['tick', 'click'], transition: ['swish'], countEnd: ['tick'], listItem: ['tick'], listEnd: ['click'], hook: null, volume: 0.7 },
    },
    'cgi-motion': {
        name: 'CGI Motion',
        accent: '#5CE1E6',
        look: 'polished CGI: soft cinematic lighting, a teal-and-orange grade, subtle reflections, glass cards, chrome lettering and shallow-depth bokeh',
        bestFor: 'high-end product ads, premium reels and cinematic motion content',
        motion: 'a slow camera drift the whole time, highlights moving across chrome and glass, lighting sweeps at each jump',
        hook: 'like a premium product tagline: short and confident',
        graphics: 'Counters for the big numbers, headlines for the turns. At most 1 slam (it lands on a lens flare).',
        captions: { maxWords: 3, maxChars: 17 },
        dropGraphicTypes: [],
        sfx: { graphic: ['whoosh', 'shimmer', 'sweep_up'], slam: ['impact', 'boom'], transition: ['whoosh', 'sweep_down', 'riser'], countEnd: ['shimmer', 'chime'], listItem: ['tick'], listEnd: ['chime'], hook: 'impact' },
    },
    'explainer-3d': {
        name: 'Explainer 3D',
        accent: '#FFC93C',
        look: 'soft, rounded 3D in bright daylight: puffy cards, clay lettering with a soft extruded edge, glossy spheres and puffy clouds',
        bestFor: 'SaaS explainers, educational animation and approachable brand content',
        motion: 'soft, rounded and friendly: gentle springs, smooth object motion and clear staging; jumps are a soft bubble',
        hook: 'friendly and clear, like a welcoming explainer title ("How it works, in 30 seconds")',
        graphics: 'Lists for steps, counters for results, and the built-in illustrations (visual) suit this style best. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['pop', 'bubble', 'chime'], slam: ['pop', 'boom'], transition: ['swoosh', 'bubble'], countEnd: ['ding', 'success'], listItem: ['pop', 'bubble'], listEnd: ['success'], hook: 'pop' },
    },
    // The second set: real painting media drawn in code, from the "10 Animation Styles" prompts
    // (Skale Out; one PDF per medium, editor-skills/done/painted-styles in the parent project).
    // "Ghibli Style" is Painted Anime here: that name belongs to a film studio.
    watercolour: {
        name: 'Watercolour',
        accent: '#E0533A',
        look: 'watercolour on cold-press paper: soft washes with blooms and dried edges, pigment granulation, a few colours (warm against cool blue-green), the paper grain showing through',
        bestFor: 'calm explainers, wellness, food, travel and gentle storytelling',
        motion: 'soft and flowing: washes bloom, ripples spread and fade, everything drifts like paint in water. Calm pacing',
        hook: 'a short painted title, like the first line of a storybook ("Slow mornings, better days")',
        graphics: 'Headlines and lists suit the painted look; keep elements few and let them breathe. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['shimmer', 'sweep_up', 'blip'], slam: ['impact', 'shimmer'], transition: ['sweep_up', 'shimmer'], countEnd: ['chime', 'sparkle'], listItem: ['tick'], listEnd: ['chime'], hook: 'shimmer' },
    },
    'roman-mosaic': {
        name: 'Roman Mosaic',
        accent: '#D9A441',
        look: 'a Roman tile mosaic: small stone tiles laid in rows that follow every outline, grout lines, each tile with its own slight colour shift; ochre, terracotta, sea green, slate and cream',
        bestFor: 'history, travel, food and craft content with an old-world feel',
        motion: 'solid and deliberate: tile layers glide over a fixed floor, light shimmers across brighter tiles. Nothing melts or slides through anything else',
        hook: 'like an inscription carved for a floor ("Strength, built daily")',
        graphics: 'Headlines like inscriptions, counters like tallies. Lists read as rows of tiles. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 15 },
        dropGraphicTypes: [],
        sfx: { graphic: ['tap', 'click', 'tick'], slam: ['thud', 'impact'], transition: ['swish', 'thud'], countEnd: ['ding'], listItem: ['tap'], listEnd: ['ding'], hook: 'tap' },
    },
    'sumi-e': {
        name: 'Sumi-e',
        accent: '#C8102E',
        look: 'sumi-e ink wash on rice paper: black ink from deep black to pale grey, wet bleeding edges, dry brush strokes, a lot of empty paper and mist; one red accent',
        bestFor: 'calm, premium storytelling: mindfulness, craft, philosophy, slow brands',
        motion: 'quiet and spacious: mist blooms and fades, ridges slide past in layers. Few elements, generous pauses. Few sound effects: plan almost no beats',
        hook: 'one spare line, like a brush inscription ("Less, but deeper")',
        graphics: 'Very few: about one every 12 to 15 seconds, headlines and counters only. No slams.',
        captions: { maxWords: 3, maxChars: 18, casual: true },
        dropGraphicTypes: ['slam'],
        sfx: { graphic: ['swish', 'shimmer'], transition: ['swish', 'sweep_up'], countEnd: ['chime'], listItem: ['tick'], listEnd: ['chime'], hook: null, volume: 0.8 },
    },
    'impasto-oil': {
        name: 'Impasto Oil',
        accent: '#E9A13B',
        look: 'an impasto oil painting: thick paint with palette-knife and bristle strokes that follow the forms, swirling sea and sky, raised ridges catching the light, canvas weave where the paint is thin',
        bestFor: 'dramatic storytelling, sea and nature content, bold opinion pieces',
        motion: 'heavy and sweeping: waves roll as paint strokes, spray flies as flicks of paint at the big moments',
        hook: 'a bold painted statement ("The sea does not care")',
        graphics: 'Counters and headlines carry the drama; slams land in a splash of strokes on the 1 or 2 biggest moments, paired with a shake.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['whoosh', 'swoosh'], slam: ['boom', 'impact'], transition: ['whoosh', 'sweep_down'], countEnd: ['chime', 'ding'], listItem: ['tap'], listEnd: ['chime'], hook: 'impact' },
    },
    'nocturne-gouache': {
        name: 'Nocturne Gouache',
        accent: '#FFC978',
        look: 'a night painting in gouache: dark opaque layers of blue and green, matte bristle texture, moonlight as a pale edge, fireflies as small warm dabs of paint',
        bestFor: 'night routines, sleep, calm storytelling, evening and outdoors content',
        motion: 'slow and hushed: fireflies rise and blink, grass sways, clouds cross the moon. Gentle pacing',
        hook: 'a quiet night-time line ("What the dark teaches you")',
        graphics: 'Headlines and pills, softly lit. At most 1 slam (it glows like a firefly).',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['shimmer', 'sparkle', 'blip'], slam: ['impact', 'shimmer'], transition: ['shimmer', 'swish'], countEnd: ['sparkle', 'chime'], listItem: ['tick'], listEnd: ['sparkle'], hook: 'sparkle', volume: 0.85 },
    },
    'botanical-plate': {
        name: 'Botanical Plate',
        accent: '#4A7FD4',
        look: 'a botanical illustration plate: fine ink outlines with soft watercolour fills on cream paper, plants laid out airy and readable like a scientific drawing',
        bestFor: 'education, nature, gardening, wellness and careful explainers',
        motion: 'delicate and exact: stems bend from their bases, a butterfly crosses and settles. Lines never flicker',
        hook: 'like the title of a plate in an old book ("Field notes: morning light")',
        graphics: 'Lists read as specimens, headlines as plate titles, callouts point like a label pin. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 17 },
        dropGraphicTypes: [],
        sfx: { graphic: ['tap', 'page', 'tick'], slam: ['tap', 'pop'], transition: ['page', 'swish'], countEnd: ['ding'], listItem: ['tap'], listEnd: ['ding'], hook: 'page' },
    },
    'paper-cut': {
        name: 'Paper Cut',
        accent: '#9FE8F5',
        look: 'a paper cut diorama: layers of cut paper from pale surface blue to near black, each casting a soft shadow on the one behind, visible fibre and uneven knife-cut edges, a glowing tissue-paper jellyfish',
        bestFor: 'playful explainers, kids and family content, ocean and layered storytelling',
        motion: 'layered like a multiplane camera: paper sheets slide at different speeds, pieces hinge and curl but never melt',
        hook: 'short and bright, on a pink paper card ("Deep breath, dive in")',
        graphics: 'Lists and pills as stacked paper cards; counters in deep-sea pink. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['pop', 'snap', 'tap'], slam: ['pop', 'snap'], transition: ['swish', 'swoosh'], countEnd: ['ding', 'coin'], listItem: ['pop'], listEnd: ['ding'], hook: 'pop' },
    },
    'art-nouveau': {
        name: 'Art Nouveau',
        accent: '#C9982F',
        look: 'an Art Nouveau poster: flowing whiplash lines, thick dark outlines, flat muted fills (sage, olive, gold ochre, cream, deep red), a patterned halo and vines growing into the frame on aged lithograph paper',
        bestFor: 'beauty, fashion, food, drink and elegant brand storytelling',
        motion: 'graceful and ornamental: vines sway, the halo turns slowly, shapes move as clean outlined pieces like a poster come to life',
        hook: 'like a poster title in flowing letters ("The art of the morning")',
        graphics: 'Headlines inside the poster frame, lists with leaf markers. At most 1 slam (it lands in the halo).',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['chime', 'shimmer', 'page'], slam: ['impact', 'chime'], transition: ['swoosh', 'shimmer'], countEnd: ['chime'], listItem: ['tick'], listEnd: ['chime'], hook: 'chime' },
    },
    'golden-hour': {
        name: 'Golden Hour',
        accent: '#FF8C42',
        look: 'golden hour gouache: warm opaque paint, the low sun turning everything gold and orange, long shadows, a soft hazy sky and visible brush texture',
        bestFor: 'travel, outdoors, food, gratitude and reflective storytelling',
        motion: 'warm and sweeping: wheat bends in waves, light rakes across, quick arcs of movement against a slow day ending',
        hook: 'a warm reflective line ("The last hour of light")',
        graphics: 'Counters glow like the sun; headlines sit in the warm band. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['whoosh', 'swoosh', 'shimmer'], slam: ['boom', 'impact'], transition: ['sweep_up', 'whoosh'], countEnd: ['chime', 'ding'], listItem: ['tap'], listEnd: ['chime'], hook: 'shimmer' },
    },
    'painted-anime': {
        name: 'Painted Anime',
        accent: '#3D9BE9',
        look: 'a hand-painted anime film background in gouache: lush greens, big white cumulus clouds in a blue sky, tiny flowers in the grass and visible brush texture; clean simple figures with soft flat colour. An original look, not any film',
        bestFor: 'wholesome storytelling, childhood and summer topics, gentle vlogs',
        motion: 'like hand-drawn animation: drawn on twos, background layers slide past at different speeds, hair and grass flutter in the wind',
        hook: 'bright and simple, like the first line of a summer story ("That summer, we ran")',
        graphics: 'Pills and lists on white rounded cards; counters in sunset coral. At most 1 slam.',
        captions: { maxWords: 3, maxChars: 16 },
        dropGraphicTypes: [],
        sfx: { graphic: ['pop', 'bubble', 'blip'], slam: ['pop', 'impact'], transition: ['swoosh', 'bubble'], countEnd: ['ding', 'coin'], listItem: ['pop'], listEnd: ['success'], hook: 'pop' },
    },
});

export const ANIMATION_STYLE_IDS = Object.freeze(Object.keys(ANIMATION_STYLES));
export const isAnimationStyle = (id) => typeof id === 'string' && Object.hasOwn(ANIMATION_STYLES, id);

/** The planner rules for an animation style. */
const stylePlannerRules = (s) => [
    `EDITING SKILL: ${s.name.toUpperCase()} ANIMATION STYLE (follow these on top of every rule above; where they conflict, these win)`,
    `- The whole edit is drawn in the ${s.name} style: ${s.look}. The server draws the captions, the hook, every graphic, the transitions and the frame in this style. You decide what goes where and when.`,
    `- Best for ${s.bestFor}. Motion in this style is ${s.motion}. Pace the edit to match.`,
    `- Hook: write hookOverlay.text ${s.hook}, 3 to 8 words in the creator's own phrasing, no emoji or hashtags. Put " / " where a second line should start (at most two lines, each under about 24 characters).`,
    `- Graphics: ${s.graphics} Everything in DENSITY still applies.`,
    '- Transitions: set style.transition to any value except none to turn on this style\'s own transition; it plays only where the edit really jumps. Use none when the talk is one continuous take.',
    '- The style sets the palette and the picture treatment: style.grade and style.accent are ignored, so any valid value is fine. Mark emphasis words as usual; they take the style\'s accent.',
    '- Sound: the style has its own sound palette for graphics and transitions. Plan only a few beats of your own.',
].join('\n');

for (const [id, s] of Object.entries(ANIMATION_STYLES)) {
    SKILLS[id] = Object.freeze({
        id,
        name: s.name,
        version: 1,
        kind: 'animation',
        plannerRules: stylePlannerRules(s),
        render: {
            captions: { maxWords: s.captions.maxWords, maxChars: s.captions.maxChars, casual: s.captions.casual === true },
            dropGraphicTypes: s.dropGraphicTypes,
            accent: s.accent,
            sfx: s.sfx,
            hookSfx: s.sfx.hook ?? false,
        },
    });
}
Object.freeze(SKILLS);

export const isSkill = (id) => typeof id === 'string' && Object.hasOwn(SKILLS, id);
export const skillFor = (id) => (isSkill(id) ? SKILLS[id] : null);

/**
 * The skill an edit follows now: an edit made with an animation style can be switched to another style
 * on the review page (edits.animationStyle); other skills never change.
 */
export const activeSkillId = (skill, edits = {}) => (isAnimationStyle(skill) && isAnimationStyle(edits?.animationStyle) ? edits.animationStyle : skill ?? null);

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

/**
 * Brand sheet fonts a creator can pick (EDITOR_FEATURES_V2). Each name is a module of
 * @remotion/google-fonts that the frontend composition loads (vireact-frontend/src/remotion/brand.ts).
 */
export const BRAND_FONTS = Object.freeze([
    'Anton', 'Archivo Black', 'Bebas Neue', 'DM Sans', 'Inter', 'Lora', 'Manrope', 'Montserrat', 'Oswald', 'Outfit',
    'Playfair Display', 'Poppins', 'Roboto', 'Space Grotesk', 'Fredoka', 'Bangers',
]);

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The first invalid field of a brand sheet input (so a save can be refused with its name), or null. */
export function brandProblem(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'brand';
    for (const key of ['accent', 'secondary']) if (input[key] != null && !HEX.test(String(input[key]))) return key;
    for (const key of ['displayFont', 'bodyFont']) if (input[key] != null && !BRAND_FONTS.includes(input[key])) return key;
    const known = new Set(['accent', 'secondary', 'displayFont', 'bodyFont']);
    return Object.keys(input).find((k) => !known.has(k)) ?? null;
}

/** Clean brand sheet input: only known fonts and 6-digit hex colors survive; null when nothing is left. */
export function sanitizeBrand(input) {
    if (!input || typeof input !== 'object') return null;
    const out = {};
    for (const key of ['accent', 'secondary']) if (HEX.test(String(input[key] ?? ''))) out[key] = String(input[key]).toUpperCase();
    for (const key of ['displayFont', 'bodyFont']) if (BRAND_FONTS.includes(input[key])) out[key] = input[key];
    return Object.keys(out).length ? out : null;
}
