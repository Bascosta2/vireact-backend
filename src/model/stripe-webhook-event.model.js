import mongoose from 'mongoose';

const stripeWebhookEventSchema = new mongoose.Schema(
    {
        eventId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        type: {
            type: String,
            required: true
        },
        processed: {
            type: Boolean,
            default: false,
            index: true
        }
    },
    { timestamps: true }
);

export const StripeWebhookEvent = mongoose.model('StripeWebhookEvent', stripeWebhookEventSchema);

