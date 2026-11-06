import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';

/**
 * User video uploads are written to a temporary file on disk instead of being held in memory.
 * Previously each upload (up to 200 MB) sat in RAM until it reached Twelve Labs, so a few large
 * uploads at once could run the server out of memory and restart it (killing other users' jobs).
 * The file is streamed from disk to Twelve Labs and deleted afterwards (see removeUploadedFile).
 */
export const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'vireact-uploads');
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const allowedMimes = [
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    'video/x-matroska'
];
const allowedMimeSet = new Set(allowedMimes);

const SAFE_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mpeg', '.mpg', '.avi', '.webm', '.mkv']);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdir(UPLOAD_TMP_DIR, { recursive: true }, (err) => cb(err, UPLOAD_TMP_DIR));
    },
    // Random name, original extension (Twelve Labs reads the extension from the streamed file's name).
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${SAFE_EXTENSIONS.has(ext) ? ext : '.mp4'}`);
    },
});

// File filter: MIME hint only; the magic-byte check runs in uploadSingle once the file is on disk
const fileFilter = (req, file, cb) => {
    if (allowedMimeSet.has(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only video files are allowed.'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: MAX_UPLOAD_BYTES
    }
});

/** Delete an uploaded temp file. Never throws. */
export const removeUploadedFile = async (file) => {
    if (!file?.path) return;
    try {
        await fs.promises.unlink(file.path);
    } catch (error) {
        if (error?.code !== 'ENOENT') console.warn(`[Upload] Could not delete temp file ${file.path}: ${error.message}`);
    }
};

// Middleware wrapper for single file upload with error handling
export const uploadSingle = (req, res, next) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            await removeUploadedFile(req.file);
            return next(err);
        }
        if (!req.file?.path || !req.file.size) {
            await removeUploadedFile(req.file);
            return next();
        }
        try {
            const detected = await fileTypeFromFile(req.file.path);
            const mime = detected?.mime;
            if (!mime || !allowedMimeSet.has(mime)) {
                await removeUploadedFile(req.file);
                return next(
                    new Error(
                        'Invalid file type. Only video files (MP4, MOV, WEBM, AVI, MKV) are allowed.'
                    )
                );
            }
            next();
        } catch (detectErr) {
            await removeUploadedFile(req.file);
            next(detectErr);
        }
    });
};

/** Delete temp files older than an hour (left behind if the server stopped mid-request). */
export const cleanStaleUploads = async (maxAgeMs = 60 * 60 * 1000) => {
    let removed = 0;
    try {
        const names = await fs.promises.readdir(UPLOAD_TMP_DIR);
        const cutoff = Date.now() - maxAgeMs;
        for (const name of names) {
            const full = path.join(UPLOAD_TMP_DIR, name);
            try {
                const stat = await fs.promises.stat(full);
                if (stat.mtimeMs < cutoff) {
                    await fs.promises.unlink(full);
                    removed++;
                }
            } catch {
                /* already gone */
            }
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') console.warn(`[Upload] Temp cleanup failed: ${error.message}`);
    }
    return removed;
};
