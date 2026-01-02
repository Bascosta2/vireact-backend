import { ApiError } from '../utils/ApiError.js';

// Validate key middleware to prevent directory traversal attacks
export const validateS3Key = (key) => {
    if (!key || typeof key !== 'string') {
        throw new ApiError(400, 'Invalid key provided');
    }
    
    // Check for directory traversal patterns
    const dangerousPatterns = ['../', '..\\', './', '.\\'];
    const hasDangerousPattern = dangerousPatterns.some(pattern => key.includes(pattern));
    
    if (hasDangerousPattern) {
        throw new ApiError(400, 'Key contains invalid directory traversal characters');
    }
    
    // Allow forward slashes for directory structure (like 'landlord-signatures/')
    // but prevent absolute paths and other dangerous patterns
    if (key.startsWith('/') || key.startsWith('\\')) {
        throw new ApiError(400, 'Key cannot start with absolute path');
    }
    
    return key;
};