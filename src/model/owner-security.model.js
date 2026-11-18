import mongoose from 'mongoose';

/**
 * Owner console security state (one document, _id "owner").
 * The authenticator secret is stored encrypted (AES-256-GCM, key derived from ADMIN_SESSION_SECRET).
 */
const encrypted = new mongoose.Schema({ iv: String, tag: String, data: String }, { _id: false });

const ownerSecuritySchema = new mongoose.Schema({
    _id: { type: String, default: 'owner' },
    totp: { type: encrypted, default: null },
    enrolledAt: { type: Date, default: null },
    /** Last accepted time step, so one code can't be used twice. */
    lastTotpCounter: { type: Number, default: 0 },
    /** Setup in progress: secret shown once, confirmed by entering a code from the app. */
    pendingTotp: { type: encrypted, default: null },
    pendingExpiresAt: { type: Date, default: null },
}, { timestamps: true });

/** One row per signed-in session. Only a hash of the cookie value is stored. */
const ownerSessionSchema = new mongoose.Schema({
    sidHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
}, { timestamps: true });
ownerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

/** Every sign-in attempt and every record opened in the owner console. */
const ownerAuditSchema = new mongoose.Schema({
    action: { type: String, required: true },
    ok: { type: Boolean, default: true },
    detail: { type: String, default: null },
    videoId: { type: String, default: null },
    userId: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });
ownerAuditSchema.index({ createdAt: -1 });
ownerAuditSchema.index({ action: 1, ok: 1, createdAt: -1 });

export const OwnerSecurity = mongoose.model('OwnerSecurity', ownerSecuritySchema);
export const OwnerSession = mongoose.model('OwnerSession', ownerSessionSchema);
export const OwnerAudit = mongoose.model('OwnerAudit', ownerAuditSchema);
