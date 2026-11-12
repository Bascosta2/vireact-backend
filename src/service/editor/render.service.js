/**
 * Final MP4 renders on Remotion Lambda (AWS). The composition lives in the frontend repo
 * (src/remotion) and is deployed as a Remotion "site"; the same props drive the in-browser preview.
 * The Lambda client is loaded lazily so the API runs without it until rendering is configured.
 */

export const COMPOSITION_ID = 'VireactEdit';

export const isRenderConfigured = () =>
    Boolean(process.env.REMOTION_FUNCTION_NAME && process.env.REMOTION_SERVE_URL && (process.env.REMOTION_REGION || process.env.AWS_S3_REGION));

const region = () => process.env.REMOTION_REGION || process.env.AWS_S3_REGION;

let override = null;
/** Tests: `{ renderMediaOnLambda, getRenderProgress }` fakes. Pass null to restore. */
export const setRenderClientForTests = (fake) => {
    override = fake;
};

const lambdaClient = async () => {
    if (override) return override;
    const mod = await import('@remotion/lambda-client');
    return { renderMediaOnLambda: mod.renderMediaOnLambda, getRenderProgress: mod.getRenderProgress };
};

/**
 * Start a render. The output goes to our own bucket under `outKey`.
 * @param {object} inputProps composition props: buildRenderProps(...) + media URLs
 */
export async function startRender({ inputProps, outKey }) {
    const client = await lambdaClient();
    const res = await client.renderMediaOnLambda({
        region: region(),
        functionName: process.env.REMOTION_FUNCTION_NAME,
        serveUrl: process.env.REMOTION_SERVE_URL,
        composition: COMPOSITION_ID,
        inputProps,
        codec: 'h264',
        imageFormat: 'jpeg',
        jpegQuality: 85,
        crf: 20,
        maxRetries: 2,
        privacy: 'private',
        framesPerLambda: 120,
        downloadBehavior: { type: 'download', fileName: 'vireact-edit.mp4' },
        outName: { key: outKey, bucketName: process.env.AWS_S3_BUCKET_NAME },
        ...(process.env.REMOTION_LICENSE_KEY ? { licenseKey: process.env.REMOTION_LICENSE_KEY } : {}),
    });
    return { remotionRenderId: res.renderId, bucketName: res.bucketName };
}

/** @returns {{done:boolean, progress:number, error:string|null, sizeBytes:number|null, costUsd:number|null}} */
export async function renderProgress({ remotionRenderId, bucketName }) {
    const client = await lambdaClient();
    const p = await client.getRenderProgress({ renderId: remotionRenderId, bucketName, functionName: process.env.REMOTION_FUNCTION_NAME, region: region() });
    const fatal = (p.errors ?? []).find((e) => e.isFatal);
    return {
        done: Boolean(p.done),
        progress: Math.round((p.overallProgress ?? 0) * 100),
        error: p.fatalErrorEncountered ? (fatal?.message || 'Render failed') : null,
        sizeBytes: p.outputSizeInBytes ?? null,
        costUsd: p.costs?.accruedSoFar ?? null,
    };
}
