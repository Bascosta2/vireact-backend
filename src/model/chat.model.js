import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    text: {
        type: String,
        required: true
    },
    isUser: {
        type: Boolean,
        required: true
    }
}, { timestamps: true });

const chatSchema = new mongoose.Schema({
    videoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Video',
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    messages: {
        type: [messageSchema],
        default: []
    }
}, { timestamps: true });

// Compound index for efficient querying
chatSchema.index({ videoId: 1, userId: 1 }, { unique: true });

export const Chat = mongoose.model('Chat', chatSchema);

