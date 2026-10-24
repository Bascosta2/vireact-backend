import { PostHog } from 'posthog-node';
import { POSTHOG_HOST, POSTHOG_KEY } from '../config/index.js';

let client = null;

const getClient = () => {
    if (!POSTHOG_KEY) return null;
    if (!client) {
        client = new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST, flushAt: 20, flushInterval: 10000 });
    }
    return client;
};

export const isServerAnalyticsEnabled = () => Boolean(POSTHOG_KEY);

/**
 * Fire-and-forget server event. distinctId must be the internal user id so it
 * joins the client-side identify(); never pass email or name in properties.
 * Analytics failures must never break the request that triggered them.
 */
export const captureServerEvent = (distinctId, event, properties = {}) => {
    const posthog = getClient();
    if (!posthog || !distinctId || !event) return false;
    try {
        posthog.capture({ distinctId: String(distinctId), event, properties });
        return true;
    } catch (error) {
        console.warn(`[analytics] capture failed for ${event}:`, error?.message);
        return false;
    }
};

/** Plan name for captureServerEvent: capture(distinctId, event, props). */
export const capture = captureServerEvent;

export const shutdownAnalytics = async () => {
    if (!client) return;
    try {
        await client.shutdown();
    } catch (error) {
        console.warn('[analytics] shutdown failed:', error?.message);
    } finally {
        client = null;
    }
};
