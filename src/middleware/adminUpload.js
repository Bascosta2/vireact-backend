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
