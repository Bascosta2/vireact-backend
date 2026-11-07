/**
 * Requests from this API's own origin (the private /admin/ai page) are same-origin, not cross-origin.
 * Browsers still send an Origin header on same-origin PATCH/POST, which the CORS allowlist (vireact.io
 * only) would reject. Drop it for those requests instead of adding this host to the allowlist.
 * Browsers can't forge Origin, so a different site never matches.
 */
export const stripSameOriginHeader = (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === `${req.protocol}://${req.get('host')}`) delete req.headers.origin;
    next();
};
