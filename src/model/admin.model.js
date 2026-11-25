import mongoose from "mongoose";
import bcrypt, { compare } from "bcryptjs";
import { signToken, TOKEN_TYPE } from "../utils/jwt.js";
import { BCRYPT_COST } from "../constants.js";

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
        this.password = await bcrypt.hash(this.password, BCRYPT_COST);
    }
    next();
});

adminSchema.methods.comparePassword = async function (candidatePassword) {
    return compare(candidatePassword, this.password);
};

adminSchema.methods.generateAccessToken = function () {
    return signToken(TOKEN_TYPE.ACCESS, { _id: this._id, email: this.email }, "30m");
};

adminSchema.methods.generateRefreshToken = function () {
    return signToken(TOKEN_TYPE.REFRESH, { _id: this._id, email: this.email }, "30d");
};

export const Admin = mongoose.model("Admin", adminSchema);
