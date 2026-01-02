import mongoose from "mongoose"

const earlyAccessSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    phone: {
        type: String,
        required: false,
        trim: true
    },
    contentGoalNote: {
        type: String,
        required: true
    }
})

export const EarlyAccess = mongoose.model("EarlyAccess", earlyAccessSchema);