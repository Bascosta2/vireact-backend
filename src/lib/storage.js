import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Private object storage for the Editor tab (S3). Everything is private; clients only ever get
 * short-lived signed URLs. Keys: editor/<kind>/<userId>/<projectId>/<name>.
 *
 * Tests swap the whole implementation with setStorageForTests().
 */

const bucket = () => process.env.AWS_S3_BUCKET_NAME || '';
const region = () => process.env.AWS_S3_REGION || process.env.AWS_REGION || '';

export const isStorageConfigured = () => Boolean(bucket() && region() && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

export const editorKey = (kind, userId, projectId, name) => `editor/${kind}/${userId}/${projectId}/${name}`;
export const editorPrefixes = (userId, projectId) => ['sources', 'proxies', 'frames', 'renders'].map((k) => `editor/${k}/${userId}/${projectId}/`);

let client = null;
const s3 = () => {
    if (!client) client = new S3Client({ region: region() });
    return client;
};

const notFound = (err) => err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;

const real = {
    async presignUpload({ key, contentType, sizeBytes, expiresIn = 900 }) {
        const cmd = new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, ContentLength: sizeBytes });
        return getSignedUrl(s3(), cmd, { expiresIn });
    },
    async presignDownload(key, { expiresIn = 3600, filename } = {}) {
        const cmd = new GetObjectCommand({
            Bucket: bucket(),
            Key: key,
            ...(filename ? { ResponseContentDisposition: `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"` } : {}),
        });
        return getSignedUrl(s3(), cmd, { expiresIn });
    },
    async head(key) {
        try {
            const r = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
            return { sizeBytes: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
        } catch (err) {
            if (notFound(err)) return null;
            throw err;
        }
    },
    async downloadToFile(key, filePath) {
        const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
        await pipeline(r.Body, fs.createWriteStream(filePath));
    },
    async uploadFile(filePath, key, contentType) {
        const { size } = await fs.promises.stat(filePath);
        await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: fs.createReadStream(filePath), ContentType: contentType, ContentLength: size }));
        return { key, sizeBytes: size };
    },
    async uploadBuffer(buffer, key, contentType) {
        await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer, ContentType: contentType }));
        return { key, sizeBytes: buffer.length };
    },
    async readBuffer(key) {
        const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
    },
    async deletePrefix(prefix) {
        let token;
        let deleted = 0;
        do {
            const list = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
            const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key }));
            if (keys.length) {
                await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys, Quiet: true } }));
                deleted += keys.length;
            }
            token = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (token);
        return deleted;
    },
};

let impl = real;

/** Replace storage in tests (pass null to restore S3). */
export const setStorageForTests = (fake) => {
    impl = fake ?? real;
};

export const storage = {
    presignUpload: (args) => impl.presignUpload(args),
    presignDownload: (key, opts) => impl.presignDownload(key, opts),
    head: (key) => impl.head(key),
    downloadToFile: (key, filePath) => impl.downloadToFile(key, filePath),
    uploadFile: (filePath, key, contentType) => impl.uploadFile(filePath, key, contentType),
    uploadBuffer: (buffer, key, contentType) => impl.uploadBuffer(buffer, key, contentType),
    readBuffer: (key) => impl.readBuffer(key),
    deletePrefix: (prefix) => impl.deletePrefix(prefix),
};
