import { getQStashClient } from '../lib/qstash.js';
import { BACKEND_URL } from '../config/index.js';

/**
 * Publish video analysis job to QStash
 * @param {Object} jobData - Job data containing videoId and twelveLabsVideoId / userId
 * @returns {Promise<string>} Message ID (normalized string for v1 or v2 SDK)
 */
export const publishVideoAnalysisJob = async (jobData) => {
    if (!BACKEND_URL || String(BACKEND_URL).trim() === '') {
        throw new Error('BACKEND_URL is required to publish QStash video analysis jobs');
    }
    const qstash = getQStashClient();
    const webhookUrl = `${BACKEND_URL}/api/v1/videos/analyze`;

    console.log('[QStash] Publishing job to webhook URL:', webhookUrl);
    console.log('[QStash] Job data:', JSON.stringify(jobData));

    const result = await qstash.publishJSON({
        url: webhookUrl,
        body: jobData,
        retries: 3,
    });

    const messageId =
        typeof result === 'string'
            ? result
            : result?.messageId ?? JSON.stringify(result);

    console.log('[QStash] Job published successfully, messageId:', messageId);
    return messageId;
};
