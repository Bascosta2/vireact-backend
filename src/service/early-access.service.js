import { ApiError } from "../utils/ApiError.js"
import { EarlyAccess } from "../model/early-access.model.js"

export const createEarlyAccessService = async (requestBody) => {
    const { name, email, phone, contentGoalNote } = requestBody

    if (!name || !email || !contentGoalNote) {
        throw new ApiError(400, "Name, email and contentGoalNote are required")
    }

    try {
        // Check if email already exists
        const existingEmail = await EarlyAccess.findOne({ email })
        if (existingEmail) {
            throw new ApiError(409, "Email already exists in early access list")
        }

        // Check if phone already exists (if provided)
        if (phone) {
            const existingPhone = await EarlyAccess.findOne({ phone })
            if (existingPhone) {
                throw new ApiError(409, "Phone number already exists in early access list")
            }
        }

        const earlyAccess = new EarlyAccess({
            name,
            email,
            phone,
            contentGoalNote
        })
        const savedEarlyAccess = await earlyAccess.save()
        return savedEarlyAccess
    } catch (error) {
        if (error instanceof ApiError) {
            throw error
        }
        throw new ApiError(500, error?.message || "Failed to create early access")
    }
}