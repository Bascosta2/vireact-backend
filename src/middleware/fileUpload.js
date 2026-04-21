import multer from 'multer';
import { fileTypeFromBuffer } from 'file-type';

// Configure multer for memory storage (file will be in req.file.buffer)
const storage = multer.memoryStorage();

const allowedMimes = [
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    'video/x-matroska'
];
const allowedMimeSet = new Set(allowedMimes);

// File filter: MIME hint only; magic-byte check runs in uploadSingle after buffer is available
const fileFilter = (req, file, cb) => {
    if (allowedMimeSet.has(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only video files are allowed.'), false);
    }
};

// Configure multer
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 200 * 1024 * 1024 // 200MB limit
    }
});

// Middleware wrapper for single file upload with error handling
export const uploadSingle = (req, res, next) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            return next(err);
        }
        if (!req.file?.buffer?.length) {
            return next();
        }
        try {
            const detected = await fileTypeFromBuffer(req.file.buffer);
            const mime = detected?.mime;
            if (!mime || !allowedMimeSet.has(mime)) {
                return next(
                    new Error(
                        'Invalid file type. Only video files (MP4, MOV, WEBM, AVI, MKV) are allowed.'
                    )
                );
            }
            next();
        } catch (detectErr) {
            next(detectErr);
        }
    });
};

