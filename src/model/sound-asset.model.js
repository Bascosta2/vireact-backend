import mongoose from 'mongoose';

/**
 * Licensed music and sound effects the editor may use (Editor tab). Uploaded by the admin with the
 * license source recorded; only `active` assets are offered to Claude and the renderer.
 */
export const SOUND_KINDS = ['music', 'sfx'];
export const MUSIC_MOODS = ['upbeat', 'energetic', 'chill', 'emotional', 'dramatic', 'funny', 'inspiring', 'dark', 'corporate'];

const soundAssetSchema = new mongoose.Schema({
    kind: { type: String, enum: SOUND_KINDS, required: true },
    /** Short stable id used in edit plans, e.g. "m_upbeat_01" or "sfx_whoosh_02". */
    slug: { type: String, required: true, unique: true, match: /^[a-z0-9_]{3,40}$/ },
    title: { type: String, required: true, maxlength: 120 },
    key: { type: String, required: true },
    contentType: { type: String, default: 'audio/mpeg' },
    durationSec: Number,
    sizeBytes: Number,
    // Music
    mood: { type: String, enum: [...MUSIC_MOODS, null], default: null },
    energy: { type: Number, min: 1, max: 5, default: null },
    bpm: { type: Number, default: null },
    genre: { type: String, maxlength: 60, default: null },
    // Sound effects
    sfxType: { type: String, enum: ['whoosh', 'pop', 'riser', 'ding', 'boom', null], default: null },
    // Licensing: required so nothing unlicensed is ever offered.
    licenseSource: { type: String, required: true, maxlength: 200 },
    attribution: { type: String, maxlength: 300, default: null },
    active: { type: Boolean, default: true },
}, { timestamps: true });

soundAssetSchema.index({ kind: 1, active: 1 });

export const SoundAsset = mongoose.model('SoundAsset', soundAssetSchema);
