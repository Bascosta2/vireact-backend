import {
    createEarlyAccessService
} from "../service/early-access.service.js"
import { ApiResponse } from "../utils/ApiResponse.js"

export const createEarlyAccess = async (req, res, next) => {
    try {
        const earlyAccess = await createEarlyAccessService(req.body)
        res.status(201)
            .json(
                ApiResponse.success(
                    201,
                    "Early access created successfully",
                    earlyAccess
                )
            )

    } catch (error) {
        next(error)
    }
}