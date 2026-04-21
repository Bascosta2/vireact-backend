import mongoose from "mongoose";
import bcrypt, { compare } from "bcryptjs";
import jwt from "jsonwebtoken";
import { ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET } from "../config/index.js";

const adminSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    password: {
        type: String,
        required: true
    },
    refreshToken: {
        type: String,
        default: null
    }
});

adminSchema.pre("save", async function (next) {
    if (this.isModified("password")) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});

adminSchema.methods.comparePassword = async function (candidatePassword) {
    return compare(candidatePassword, this.password);
};

adminSchema.methods.generateAccessToken = function () {
    return jwt.sign(
        { _id: this._id, email: this.email },
        ACCESS_TOKEN_SECRET,
        { expiresIn: "30m" }
    );
};

adminSchema.methods.generateRefreshToken = function () {
    return jwt.sign(
        { _id: this._id, email: this.email },
        REFRESH_TOKEN_SECRET,
        { expiresIn: "30d" }
    );
};

export const Admin = mongoose.model("Admin", adminSchema);
