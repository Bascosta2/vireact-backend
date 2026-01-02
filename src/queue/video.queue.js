import { getQStashClient } from '../lib/qstash.js';
import { BACKEND_URL } from '../config/index.js';

/**
 * Publish video analysis job to QStash
 * @param {Object} jobData - Job data containing videoId and videoUrl
 * @returns {Promise<string>} Message ID from QStash
 */
export const publishVideoAnalysisJob = async (jobData) => {
    const qstash = getQStashClient();
    const webhookUrl = `${BACKEND_URL}/api/v1/videos/analyze`;
    
    const messageId = await qstash.publishJSON({
        url: webhookUrl,
        body: jobData,
        retries: 3, // QStash will retry up to 3 times on failure
    });
    
    return messageId;
};

