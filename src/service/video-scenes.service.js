import { analyzeVideoScenes, analyzeVideoScenesStructured } from '../lib/twelve-labs-analyze.js';
import { TWELVE_LABS_SCENE_PROMPT, parseScenesWithOpenAI } from './scene-parser.service.js';

/**
 * Scene breakdown for a video.
 *
 * 1. Pegasus returns the scene list as JSON directly (one call, no parsing model).
 * 2. If that fails or comes back empty, the older route runs: Pegasus writes the labelled text
 *    breakdown and a text model converts it, with a regex parser behind that.
 *
 * @param {{ assetId?: string|null, streamUrl?: string|null }} source
 * @returns {Promise<{ scenes: object[], via: 'structured'|'text'|'none', error?: string }>}
 */
export const getVideoScenes = async (source, { log = console } = {}) => {
    try {
        const scenes = await analyzeVideoScenesStructured(source);
        if (scenes.length > 0) return { scenes, via: 'structured' };
        log.warn('[Scenes] Structured Pegasus breakdown came back empty; trying the text breakdown');
    } catch (error) {
        log.warn(`[Scenes] Structured Pegasus breakdown failed (${error?.statusCode ?? ''} ${error?.message}); trying the text breakdown`);
    }

    try {
        const text = await analyzeVideoScenes(source, TWELVE_LABS_SCENE_PROMPT);
        const scenes = await parseScenesWithOpenAI(text);
        return { scenes: Array.isArray(scenes) ? scenes : [], via: scenes?.length ? 'text' : 'none' };
    } catch (error) {
        return { scenes: [], via: 'none', error: `${error?.statusCode ?? ''} ${error?.message ?? error}`.trim() };
    }
};
