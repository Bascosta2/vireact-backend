import { ApiError } from "../utils/ApiError.js"
import { EarlyAccess } from "../model/early-access.model.js"

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** Digits with optional +, spaces, dots, dashes and brackets, e.g. "+1 (555) 123-4567"; at least 6 digits. */
const PHONE_FORMAT = /^\+?[0-9 ().-]{6,25}$/
const isPhoneNumber = (value) => PHONE_FORMAT.test(value) && (value.match(/[0-9]/g) || []).length >= 6
const MAX_EMAIL_LENGTH = 254
const MAX_NAME_LENGTH = 200
const MAX_NOTE_LENGTH = 5000

/**
 * Checks and cleans the public early-access form. Every value must be a string: an object such as
 * {"$regex": "^a"} would otherwise reach the duplicate lookups and let anyone probe stored emails/phones.
 * Returns { name, email, phone, contentGoalNote } with email lowercased and phone undefined when empty.
 */
export const parseEarlyAccessInput = (requestBody) => {
    const { name, email, phone, contentGoalNote } = requestBody ?? {}

    if (!name || !email || !contentGoalNote) {
        throw new ApiError(400, "Name, email and contentGoalNote are required")
    }
    if (typeof name !== "string" || typeof email !== "string" || typeof contentGoalNote !== "string") {
        throw new ApiError(400, "Name, email and contentGoalNote must be text")
    }
    if (phone !== undefined && phone !== null && phone !== "" && typeof phone !== "string") {
        throw new ApiError(400, "Phone number must be text")
    }

    const cleanName = name.trim()
    const cleanEmail = email.trim().toLowerCase()
    const cleanPhone = typeof phone === "string" ? phone.trim() : ""
    const cleanNote = contentGoalNote.trim()

    if (!cleanName || !cleanNote || cleanName.length > MAX_NAME_LENGTH || cleanNote.length > MAX_NOTE_LENGTH) {
        throw new ApiError(400, "Please enter your name and content goal (keep them short)")
    }
    if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_FORMAT.test(cleanEmail)) {
        throw new ApiError(400, "Invalid email format")
    }
    if (cleanPhone && !isPhoneNumber(cleanPhone)) {
        throw new ApiError(400, "Invalid phone number")
    }

    return { name: cleanName, email: cleanEmail, phone: cleanPhone || undefined, contentGoalNote: cleanNote }
}

export const createEarlyAccessService = async (requestBody) => {
    const { name, email, phone, contentGoalNote } = parseEarlyAccessInput(requestBody)

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
        // Unique index on email: the same address was submitted twice at once.
        if (error?.code === 11000) {
            throw new ApiError(409, "Email already exists in early access list")
        }
        console.error("[EarlyAccess] Create failed:", error?.message || error)
        throw new ApiError(500, "Failed to create early access")
    }
}
