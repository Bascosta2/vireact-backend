import mongoose from 'mongoose';
import { SUBSCRIPTION_STATUS, SUBSCRIPTION_PLANS } from '../constants.js';

const subscriptionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },
    plan: {
        type: String,
        enum: Object.values(SUBSCRIPTION_PLANS),
        default: SUBSCRIPTION_PLANS.FREE,
        required: true
    },
    status: {
        type: String,
        enum: Object.values(SUBSCRIPTION_STATUS),
        default: SUBSCRIPTION_STATUS.ACTIVE,
        required: true
    },
    currentPeriodStart: {
        type: Date,
        required: true,
        default: Date.now
    },
    currentPeriodEnd: {
        type: Date,
        required: true
    },
    usage: {
        videosUsed: {
            type: Number,
            default: 0,
            min: 0
        },
        chatMessagesUsed: {
            type: Number,
            default: 0,
            min: 0
        },
        lastResetAt: {
            type: Date,
            default: Date.now
        }
    },
    stripeSubscriptionId: {
        type: String,
        sparse: true,
        index: true
    },
    stripeCustomerId: {
        type: String,
        sparse: true,
        index: true
    },
    stripePriceId: {
        type: String,
        sparse: true
    }
}, { timestamps: true });

// Set default currentPeriodEnd before validation
subscriptionSchema.pre('validate', function(next) {
    if (this.isNew && !this.currentPeriodEnd) {
        const periodEnd = new Date(this.currentPeriodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        this.currentPeriodEnd = periodEnd;
    }
    next();
});

export const Subscription = mongoose.model('Subscription', subscriptionSchema);

