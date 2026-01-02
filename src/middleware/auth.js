import jwt from 'jsonwebtoken';
import { User } from '../model/user.model.js';
import { Admin } from '../model/admin.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ACCESS_TOKEN_SECRET } from '../config/index.js';

/**
 * JWT Authentication Middleware
 * Verifies JWT token and attaches user to req.user
 */
export const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            throw new ApiError(401, 'Access token is required');
        }

        // Verify the token
        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
        
        // Find user by ID from token
        let user = await User.findById(decoded._id).select('-password');
        
        if (!user) {
            // Try admin if user not found
            user = await Admin.findById(decoded._id).select('-password');
            if (!user) {
                throw new ApiError(401, 'Invalid token - user not found');
            }
        }

        // Attach user to request object
        req.user = user;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return next(new ApiError(401, 'Invalid token'));
        } else if (error.name === 'TokenExpiredError') {
            return next(new ApiError(401, 'Token expired'));
        }
        next(error);
    }
};

/**
 * Optional authentication middleware
 * Doesn't throw error if no token, just sets req.user to null
 */
export const optionalAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) {
            req.user = null;
            return next();
        }

        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
        
        let user = await User.findById(decoded._id).select('-password');
        
        if (!user) {
            user = await Admin.findById(decoded._id).select('-password');
        }

        req.user = user || null;
        next();
    } catch (error) {
        // For optional auth, we don't throw errors, just set user to null
        req.user = null;
        next();
    }
};

/**
 * Role-based authorization middleware
 * Must be used after authenticateToken
 */
export const authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return next(new ApiError(401, 'Authentication required'));
        }

        if (!roles.includes(req.user.role)) {
            return next(new ApiError(403, 'Insufficient permissions'));
        }

        next();
    };
};
