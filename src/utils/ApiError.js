export class ApiError extends Error {
    /**
     * @param {number} statusCode
     * @param {string} message
     * @param {object|null} [data] extra machine-readable details for the client (e.g. { code: 'EMAIL_NOT_VERIFIED' })
     */
    constructor(statusCode, message, data = null) {
        super(message);
        this.statusCode = statusCode;
        this.name = "ApiError";
        this.data = data;
    }
}
