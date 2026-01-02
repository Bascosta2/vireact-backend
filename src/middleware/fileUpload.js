import multer from 'multer';

// Configure multer for memory storage (file will be in req.file.buffer)
const storage = multer.memoryStorage();

// File filter to only accept video files
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'video/mp4',
        'video/mpeg',
        'video/quicktime',
        'video/x-msvideo',
        'video/webm',
        'video/x-matroska'
    ];

    if (allowedMimes.includes(file.mimetype)) {
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
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// Middleware wrapper for single file upload with error handling
export const uploadSingle = (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            // Multer error occurred - pass to error handler
            // The error handler will set proper CORS headers
            return next(err);
        }
        // No error, continue to next middleware
        next();
    });
};

