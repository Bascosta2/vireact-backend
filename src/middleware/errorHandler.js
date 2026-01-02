import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

export const errorHandler = (err, req, res, next) => {
    // Ensure CORS headers are set even for error responses
    // This is critical for file upload errors and other failures
    const origin = req.headers.origin;
    const allowedOrigins = [
        "https://vireact.io",
        "https://vireact-frontend.vercel.app",
        "vireact-frontend.vercel.app",
        "https://www.vireact.io",
        "http://localhost:5173",
        "http://192.168.1.112:5173"
    ];

    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    }

    if (err instanceof ApiError) {
        res.status(err.statusCode).json(
            ApiResponse.error(err.statusCode, err.message, err.data)
        );
    } else {
        // Handle multer errors with specific messages
        if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json(
                ApiResponse.error(413, "File size exceeds the maximum limit of 100MB", null)
            );
        } else if (err.message && err.message.includes('Invalid file type')) {
            res.status(400).json(
                ApiResponse.error(400, err.message, null)
            );
        } else {
            res.status(500).json(
                ApiResponse.error(500, "Internal Server Error", null)
            );
        }
    }
    console.log(err);
};
