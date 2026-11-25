/** Fields and names for the video list (Home, Library, search). No database or API clients here. */

/** Fields the Home, Library and "analyzing" badge need. Keeps polling cheap as libraries grow. */
export const VIDEO_SUMMARY_FIELDS = '_id filename title sourceTitle thumbnailUrl uploadStatus analysisStatus selectedFeatures viralityScore isAnalysisReady createdAt updatedAt lastError actualViews duration postedAt creatorPlatform';
const AUTO_TITLE_MAX = 60;

/**
 * A readable name from what is said first in the video ("So here is why your hooks fail"), used when the
 * file name is only an id or a screen-recording stamp. Cut at a word boundary. Null when nothing was said.
 */
export const autoTitleFromTranscript = (segments) => {
    const text = (Array.isArray(segments) ? segments : [])
        .map((s) => (typeof s?.text === 'string' ? s.text : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.split(' ').filter(Boolean).length < 2) return null;
    if (text.length <= AUTO_TITLE_MAX) return text.replace(/[\s,;:.-]+$/, '');
    const cut = text.slice(0, AUTO_TITLE_MAX + 1);
    const atWord = cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).replace(/[\s,;:.-]+$/, '');
    return `${atWord}…`;
};
