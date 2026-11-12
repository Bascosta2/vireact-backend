import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';

const storage = multer.memoryStorage();

const videoFilter = (req, file, cb) => {
    const allowed = [
        'video/mp4',
        'video/mpeg',
        'video/quicktime',
        'video/x-msvideo',
        'video/webm',
        'video/x-matroska',
    ];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only video files (MP4, MOV, WEBM, AVI, MKV) are allowed.'), false);
    }
};

/** Creator admin ingest: MP4, MOV, WEBM only per product spec (no AVI/MKV). */
const creatorVideoFilter = (req, file, cb) => {
    const allowed = [
        'video/mp4',
        'video/quicktime',
        'video/webm',
    ];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Use MP4, MOV, or WEBM.'), false);
    }
};

const pdfFilter = (req, file, cb) => {
    const isPdf = file.mimetype === 'application/pdf' ||
        (file.mimetype === 'application/octet-stream' && file.originalname && /\.pdf$/i.test(file.originalname));
    if (isPdf) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF is allowed.'), false);
    }
};

export const uploadAdminVideo = multer({
    storage,
    fileFilter: videoFilter,
    limits: { fileSize: 200 * 1024 * 1024 },
}).single('file');

/** Admin creator video file ingest — max 500MB, field name `videoFile`. */
export const uploadAdminCreatorVideo = multer({
    storage,
    fileFilter: creatorVideoFilter,
    limits: { fileSize: 500 * 1024 * 1024 },
}).single('videoFile');

export const uploadAdminKnowledge = multer({
    storage,
    fileFilter: pdfFilter,
    limits: { fileSize: 50 * 1024 * 1024 },
}).single('file');

// Editor tab admin uploads go to a temp file on disk (not memory): viral examples can be large and
// are processed in the background after the response.
const editorTmp = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(os.tmpdir(), 'vireact-admin-uploads');
        fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
        cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
});

/** Viral example for the editor: video file (field `file`), max 300MB. */
export const uploadAdminExample = multer({
    storage: editorTmp,
    fileFilter: videoFilter,
    limits: { fileSize: 300 * 1024 * 1024 },
}).single('file');

const AUDIO_MIMES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/ogg'];

/** Licensed music or sound effect for the editor (field `file`), max 30MB. */
export const uploadAdminSound = multer({
    storage: editorTmp,
    fileFilter: (req, file, cb) => (AUDIO_MIMES.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type. Upload an MP3, M4A, AAC, WAV or OGG file.'), false)),
    limits: { fileSize: 30 * 1024 * 1024 },
}).single('file');
