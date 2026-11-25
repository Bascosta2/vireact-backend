import mongoose from 'mongoose';
import { SUBSCRIPTION_PLANS } from '../constants.js';

/** One row per account per promo code redeemed. The unique index makes each code single-use per account. */
const promoRedemptionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    code: { type: String, required: true },
    plan: { type: String, enum: Object.values(SUBSCRIPTION_PLANS), required: true },
    grantedAt: { type: Date, required: true },
    /** Null for a plan that never expires. */
    endsAt: { type: Date, default: null },
}, { timestamps: true });

promoRedemptionSchema.index({ userId: 1, code: 1 }, { unique: true });
promoRedemptionSchema.index({ code: 1 });

export const PromoRedemption = mongoose.model('PromoRedemption', promoRedemptionSchema);

/**
 * Redemptions claimed per capped code (`_id` is the code). Updated with a conditional $inc so that
 * parallel redemptions can never take a code past its cap.
 */
const promoCodeCounterSchema = new mongoose.Schema({
    _id: { type: String },
    count: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

export const PromoCodeCounter = mongoose.model('PromoCodeCounter', promoCodeCounterSchema);
