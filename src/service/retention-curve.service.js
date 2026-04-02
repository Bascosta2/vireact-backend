/**
 * Compute a heuristic retention curve (one value per 5-second bucket) from scenes and analysis.
 * Used when no frame-level data is available. Values are 0-100 (percentage).
 * @param {{ scenes: Array<{ startTime: number; endTime: number; purpose?: string; onScreenText?: string; emotionalTone?: string }>; analysis?: Array<{ feature: string; score?: number }>; duration?: number }} video
 * @returns {number[]}
 */
export function computeRetentionCurve(video) {
    const scenes = video.scenes || [];
    const duration = video.duration ?? (scenes.length > 0 ? scenes[scenes.length - 1].endTime : 60);
    const bucketSeconds = 5;
    const numBuckets = Math.max(1, Math.ceil(duration / bucketSeconds));
    const curve = [];

    const hookScore = video.analysis?.find((a) => a.feature === 'hook')?.score ?? 50;
    const pacingScore = video.analysis?.find((a) => a.feature === 'pacing')?.score ?? 50;
    const hasTextCoverage = scenes.some((s) => s.onScreenText && s.onScreenText.trim() && s.onScreenText.toLowerCase() !== 'none');
    const emotionalVariety = new Set(scenes.map((s) => s.emotionalTone).filter(Boolean)).size > 1;

    for (let i = 0; i < numBuckets; i++) {
        const tStart = i * bucketSeconds;
        const tEnd = Math.min((i + 1) * bucketSeconds, duration);
        const mid = (tStart + tEnd) / 2;

        let score = 70;
        if (mid < 3) {
            score = 40 + (hookScore / 100) * 50;
        } else {
            const decay = (mid / duration) * 25;
            score = 75 - decay;
            if (!hasTextCoverage) score -= 10;
            if (!emotionalVariety) score -= 5;
            score += (pacingScore - 50) * 0.2;
        }

        const sceneInBucket = scenes.find((s) => s.endTime > tStart && s.startTime < tEnd);
        if (sceneInBucket?.purpose === 'hook' && mid < 5) score = Math.max(score, 50 + (hookScore / 100) * 40);
        if (sceneInBucket?.purpose === 'cta' && mid > duration - 10) score = Math.min(100, score + 10);

        curve.push(Math.round(Math.min(100, Math.max(0, score))));
    }

    return curve;
}
