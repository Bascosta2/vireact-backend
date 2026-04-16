import TwelveLabsClient from './twelve-labs.js';

/**
 * Create a Twelve Labs asset from a readable stream (direct upload).
 * Caller is responsible for waitForAssetReady + indexAssetWithRetry.
 * @param {import('stream').Readable} readable
 * @returns {Promise<object>} Raw Twelve Labs assets.create response
 */
export async function twelveLabsCreateDirectAsset(readable) {
    const assetResponse = await TwelveLabsClient.assets.create({
        method: 'direct',
        file: readable,
    });

    if (assetResponse?.status === 'failed') {
        const err = assetResponse.error || 'Unknown error';
        throw new Error(`TwelveLabs upload failed: ${err}`);
    }

    const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;
    if (!twelveLabsAssetId) {
        throw new Error('Failed to get asset ID from TwelveLabs response');
    }

    return assetResponse;
}

/**
 * Create a Twelve Labs asset from a remote URL (Twelve Labs fetches the URL).
 * @param {string} url
 * @returns {Promise<object>} Raw Twelve Labs assets.create response
 */
export async function twelveLabsCreateUrlAsset(url) {
    const assetResponse = await TwelveLabsClient.assets.create({
        method: 'url',
        url,
    });

    if (assetResponse?.status === 'failed') {
        const err = assetResponse.error || 'Unknown error';
        throw new Error(`TwelveLabs URL upload failed: ${err}`);
    }

    const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;
    if (!twelveLabsAssetId) {
        throw new Error('Failed to get asset ID from TwelveLabs response');
    }

    return assetResponse;
}
