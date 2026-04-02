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

export const uploadAdminKnowledge = multer({
    storage,
    fileFilter: pdfFilter,
    limits: { fileSize: 50 * 1024 * 1024 },
}).single('file');
