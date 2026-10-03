import { subscribeEmailService } from "../service/subscribe.service.js";
import { ApiResponse } from "../utils/ApiResponse.js";

/**
 * POST /api/subscribe
 * Body: { email: string, source?: string }
 *
 * Single endpoint used by the /viral-hooks PDF lead-gen page. Response shape
 * is intentionally tiny — the frontend only branches on success/failure to
 * decide whether to redirect to /viral-hooks/thank-you.
 */
export const subscribe = async (req, res, next) => {
    try {
        const result = await subscribeEmailService({
            email: req.body?.email,
            source: req.body?.source,
        });
        res.status(200).json(
            ApiResponse.success(200, "Subscribed", result)
        );
    } catch (error) {
        next(error);
    }
};
