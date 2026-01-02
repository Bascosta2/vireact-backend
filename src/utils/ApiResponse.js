export class ApiResponse {
    constructor(statusCode, message = "API call successful", data = null, success = true) {
        this.success = success;
        this.message = message;
        this.data = data;
        this.statusCode = statusCode;
    }

    static success(statusCode = 200, message = "OK", data = null) {
        return new ApiResponse(statusCode, message, data, true);
    }

    static error(statusCode = 500, message = "Error", data = null) {
        return new ApiResponse(statusCode, message, data, false);
    }
}
