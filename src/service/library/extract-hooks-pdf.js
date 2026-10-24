/**
 * Splits the owner's hooks PDF (8 KB chunks, plan §5.2) into draft library items.
 * Pure: takes chunk documents, returns drafts plus counts. No DB access.
 *
 * Text stays verbatim apart from removing the bullet glyph, the `-- N of 8 --`
 * page markers and line wraps. Blanks such as `___` are kept as written.
 */

const BULLET = /^\s*[\u25CF\u2022\u25AA\u25E6]\s*/;
const PAGE_MARKER = /^--\s*\d+\s+of\s+\d+\s*--$/;
const RULE_LINE = /^_{8,}$/;
const EXAMPLE_PREFIX = /^\(EX#(\d+)\)\s*/;
const STRUCTURE_START = /^Viral Storytelling structure/i;

/** Storytelling sections whose bullets are reusable sentence templates. */
const TEMPLATE_SECTIONS = [
    { match: /^Proven Viral-Worthy Examples for Introducing the Story/i, category: 'Introducing the story' },
    { match: /^After introducing the conflict/i, category: 'Leading to the climax' },
    { match: /^Below are examples of my most effective plot twists/i, category: 'Plot twist and call to action' },
];

/** Prose sections kept whole as one item each. */
const PROSE_SECTIONS = [
    { match: /^Main Structure of My Shorts/i, type: 'structure', title: 'Main Structure of My Shorts' },
    { match: /^The Fundamentals of Hooks/i, type: 'insight', title: 'The Fundamentals of Hooks' },
    { match: /^The Storytelling Secrets/i, type: 'insight', title: 'The Storytelling Secrets' },
    { match: /^Fundamentals of the Resolution \/ Plot Twist/i, type: 'insight', title: 'Fundamentals of the Resolution / Plot Twist' },
];

const STRUCTURE_CATEGORY = 'Viral Storytelling structure';

const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const stripQuotes = (text) => text.replace(/^[\u201C"]\s*/, '').replace(/\s*[\u201D"]$/, '').trim();
const headingName = (text) => collapse(text).replace(/:$/, '').trim();

export const slugify = (text, max = 60) => {
    const base = String(text || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return (base.slice(0, max).replace(/-+$/g, '') || 'item');
};

/** Short label from a hook line: drop trailing blanks and ellipses. Owner can replace it. */
export const titleFromLine = (line) => {
    const cleaned = line.replace(/_{2,}/g, ' ').replace(/[\u2026]|\.{3}/g, ' ').replace(/[?!.,:;\s]+$/g, '');
    const words = collapse(cleaned).split(' ');
    return words.length > 9 ? `${words.slice(0, 9).join(' ')}…` : collapse(cleaned);
};

/** Concatenate chunk text in chunk order, tagging each line with its source chunk id. */
const linesFromChunks = (chunks) => {
    const ordered = [...chunks].sort((a, b) => (a.metadata?.chunkIndex ?? 0) - (b.metadata?.chunkIndex ?? 0));
    const lines = [];
    for (const chunk of ordered) {
        for (const raw of String(chunk.content || '').split(/\r?\n/)) {
            const text = raw.trim();
            if (!text || PAGE_MARKER.test(text)) continue;
            lines.push({ text, kbId: String(chunk._id) });
        }
    }
    return lines;
};

const uniqueSlug = (base, used) => {
    let slug = base;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
};

/**
 * @param {Array<{ _id: any, content: string, metadata?: { chunkIndex?: number } }>} chunks
 * @param {{ sourceLabel?: string }} [options]
 */
export function extractHookPdfDrafts(chunks, { sourceLabel = 'Viral Creator' } = {}) {
    const lines = linesFromChunks(chunks);
    const used = new Set();
    const items = [];

    // Hooks: everything after the intro rule line and before the storytelling structure.
    const ruleIdx = lines.findIndex((l) => RULE_LINE.test(l.text));
    const structureIdx = lines.findIndex((l) => STRUCTURE_START.test(l.text));
    const hookLines = lines.slice(ruleIdx + 1, structureIdx === -1 ? lines.length : structureIdx);

    let category = null;
    let headingParts = [];
    let order = 0;
    for (const line of hookLines) {
        if (BULLET.test(line.text)) {
            if (headingParts.length) {
                category = headingName(headingParts.join(' '));
                headingParts = [];
            }
            const displayText = collapse(line.text.replace(BULLET, ''));
            if (!displayText) continue;
            order += 1;
            items.push({
                slug: uniqueSlug(slugify(`${category || 'hook'} ${titleFromLine(displayText)}`), used),
                type: 'hook',
                title: titleFromLine(displayText),
                displayText,
                category: category || 'Uncategorized',
                sourceKbIds: [line.kbId],
                order,
            });
        } else {
            headingParts.push(line.text);
        }
    }

    // Storytelling structure: prose sections and (EX#n) templates.
    if (structureIdx !== -1) {
        const structureLines = lines.slice(structureIdx);
        let current = null;
        const flush = () => {
            if (!current) return;
            if (current.kind === 'prose') {
                const body = collapse(current.body.join(' '));
                if (body) {
                    items.push({
                        slug: uniqueSlug(slugify(current.title), used),
                        type: current.type,
                        title: current.title,
                        displayText: current.title,
                        body,
                        category: STRUCTURE_CATEGORY,
                        sourceKbIds: [...current.kbIds],
                        order: ++order,
                    });
                }
            }
            current = null;
        };

        let template = null;
        const flushTemplate = () => {
            if (!template) return;
            const displayText = stripQuotes(collapse(template.parts.join(' ')));
            items.push({
                slug: uniqueSlug(slugify(`${template.category} ${titleFromLine(displayText)}`), used),
                type: 'structure',
                title: `${template.category} #${template.n}`,
                displayText,
                category: template.category,
                sourceKbIds: [...template.kbIds],
                order: ++order,
            });
            template = null;
        };

        for (const line of structureLines) {
            const prose = PROSE_SECTIONS.find((s) => s.match.test(line.text));
            const templateSection = TEMPLATE_SECTIONS.find((s) => s.match.test(line.text));
            if (prose) {
                flushTemplate();
                flush();
                current = { kind: 'prose', type: prose.type, title: prose.title, body: [], kbIds: new Set([line.kbId]) };
                continue;
            }
            if (templateSection) {
                flushTemplate();
                flush();
                current = { kind: 'templates', category: templateSection.category };
                continue;
            }
            if (current?.kind === 'templates' && BULLET.test(line.text)) {
                flushTemplate();
                const text = line.text.replace(BULLET, '');
                const n = Number(text.match(EXAMPLE_PREFIX)?.[1] || 0);
                template = { category: current.category, n, parts: [text.replace(EXAMPLE_PREFIX, '')], kbIds: new Set([line.kbId]) };
                continue;
            }
            if (template) {
                // Wrapped continuation of the current template line.
                template.parts.push(line.text);
                template.kbIds.add(line.kbId);
                continue;
            }
            if (current?.kind === 'prose') {
                current.body.push(line.text);
                current.kbIds.add(line.kbId);
            }
        }
        flushTemplate();
        flush();
    }

    for (const item of items) item.sourceLabel = sourceLabel;

    const hooksPerCategory = {};
    for (const item of items.filter((i) => i.type === 'hook')) {
        hooksPerCategory[item.category] = (hooksPerCategory[item.category] || 0) + 1;
    }
    const counts = {
        hooks: items.filter((i) => i.type === 'hook').length,
        hookCategories: Object.keys(hooksPerCategory).length,
        hooksPerCategory,
        structureTemplates: items.filter((i) => i.type === 'structure' && i.category !== STRUCTURE_CATEGORY).length,
        structureSections: items.filter((i) => i.category === STRUCTURE_CATEGORY).length,
        total: items.length,
    };
    return { items, counts };
}
