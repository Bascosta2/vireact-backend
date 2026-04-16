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
        }
    },
    { timestamps: true }
);

export const StripeWebhookEvent = mongoose.model('StripeWebhookEvent', stripeWebhookEventSchema);

