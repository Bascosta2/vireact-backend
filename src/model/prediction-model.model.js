import mongoose from 'mongoose';

/**
 * One row per fit of the views learning model (view-learning.js). The newest version is the one in use;
 * older rows are the learning history (how accuracy changed as results came in).
 */
const predictionModelSchema = new mongoose.Schema({
    version: { type: Number, required: true, unique: true },
    fittedAt: { type: Date, required: true },
    /** Count and newest report time of reported videos at fit time; a change triggers a refit. */
    signature: { type: String, required: true },
    observations: { type: Number, required: true },
    users: { type: Number, default: 0 },
    enabled: { type: Boolean, default: false },
    global: { type: mongoose.Schema.Types.Mixed, default: null },
    platforms: { type: mongoose.Schema.Types.Mixed, default: {} },
    cells: { type: mongoose.Schema.Types.Mixed, default: {} },
    spread: { type: mongoose.Schema.Types.Mixed, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, minimize: false });

export const PredictionModel = mongoose.model('PredictionModel', predictionModelSchema);
