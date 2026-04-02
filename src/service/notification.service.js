import resend from "../lib/resend.js";
import { User } from "../model/user.model.js";
import { FRONTEND_URL } from "../config/index.js";

/**
 * Send shorts ready notification email
 * @param {string} userEmail - User's email address
 * @param {string} videoTitle - Title of the video that is ready
 */
export const notifyUserShortsReady = async (userEmail, videoTitle) => {
    try {
        const user = await User.findOne({ email: userEmail })
            .select("notifyShortsReady")
            .lean();

        if (!user?.notifyShortsReady) {
            console.log(`[Notification] User ${userEmail} has shorts ready notifications disabled`);
            return { skipped: true };
        }

        const appUrl = FRONTEND_URL || "https://vireact.io";
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(to right, #ef4444, #f97316, #fbbf24); padding: 30px; text-align: center;">
                    <h1 style="color: white; font-size: 36px; margin: 0; font-weight: 900;">VIREACT</h1>
                </div>
                <div style="padding: 40px 30px; background: #ffffff;">
                    <h2 style="color: #1f2937; margin-bottom: 20px;">Your Short is Ready! 🎉</h2>
                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                        Great news! Your video "<strong>${videoTitle || "Untitled"}</strong>" has been processed and is ready to view.
                    </p>
                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                        Check out your analytics and see how it's predicted to perform!
                    </p>
                    <a href="${appUrl}/videos" 
                       style="display: inline-block; background: linear-gradient(to right, #ef4444, #f97316); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 20px;">
                        View Your Videos
                    </a>
                </div>
                <div style="padding: 20px 30px; background: #f3f4f6; text-align: center;">
                    <p style="color: #6b7280; font-size: 14px; margin: 0;">© ${new Date().getFullYear()} Vireact. All rights reserved.</p>
                </div>
            </div>
        `;

        const { data, error } = await resend.emails.send({
            from: "support@vireact.io",
            to: userEmail,
            subject: "Your Short is Ready! 🎬",
            html
        });

        if (error) {
            console.error("[Notification] Shorts ready email failed:", error);
            return { success: false, error };
        }

        console.log(`[Notification] Shorts ready email sent to ${userEmail}`);
        return { success: true, messageId: data?.id };
    } catch (error) {
        console.error("[Notification] Error sending shorts ready email:", error);
        return { success: false, error };
    }
};

/**
 * Send export ready notification email
 * @param {string} userEmail - User's email address
 * @param {string} exportType - Type of export (e.g., "Video Export", "Report")
 */
export const notifyUserExportReady = async (userEmail, exportType) => {
    try {
        const user = await User.findOne({ email: userEmail })
            .select("notifyExportReady")
            .lean();

        if (!user?.notifyExportReady) {
            console.log(`[Notification] User ${userEmail} has export ready notifications disabled`);
            return { skipped: true };
        }

        const appUrl = FRONTEND_URL || "https://vireact.io";
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(to right, #ef4444, #f97316, #fbbf24); padding: 30px; text-align: center;">
                    <h1 style="color: white; font-size: 36px; margin: 0; font-weight: 900;">VIREACT</h1>
                </div>
                <div style="padding: 40px 30px; background: #ffffff;">
                    <h2 style="color: #1f2937; margin-bottom: 20px;">Your Export is Ready! 📦</h2>
                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                        Your ${exportType || "export"} has been completed and is ready to download.
                    </p>
                    <a href="${appUrl}/videos" 
                       style="display: inline-block; background: linear-gradient(to right, #ef4444, #f97316); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 20px;">
                        Download Export
                    </a>
                </div>
                <div style="padding: 20px 30px; background: #f3f4f6; text-align: center;">
                    <p style="color: #6b7280; font-size: 14px; margin: 0;">© ${new Date().getFullYear()} Vireact. All rights reserved.</p>
                </div>
            </div>
        `;

        const { data, error } = await resend.emails.send({
            from: "support@vireact.io",
            to: userEmail,
            subject: "Your Export is Ready! 📦",
            html
        });

        if (error) {
            console.error("[Notification] Export ready email failed:", error);
            return { success: false, error };
        }

        console.log(`[Notification] Export ready email sent to ${userEmail}`);
        return { success: true, messageId: data?.id };
    } catch (error) {
        console.error("[Notification] Error sending export ready email:", error);
        return { success: false, error };
    }
};

/**
 * Send product update notification to all users with product updates enabled
 * @param {string} featureName - Name of the new feature
 * @param {string} featureDescription - Description of the feature
 */
export const notifyProductUpdate = async (featureName, featureDescription) => {
    try {
        const users = await User.find({ notifyProductUpdates: true })
            .select("email")
            .lean();

        const appUrl = FRONTEND_URL || "https://vireact.io";
        const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(to right, #ef4444, #f97316, #fbbf24); padding: 30px; text-align: center;">
                    <h1 style="color: white; font-size: 36px; margin: 0; font-weight: 900;">VIREACT</h1>
                </div>
                <div style="padding: 40px 30px; background: #ffffff;">
                    <h2 style="color: #1f2937; margin-bottom: 20px;">New Feature: ${featureName || "Update"} 🚀</h2>
                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                        We're excited to announce a new feature that will help you create even better content!
                    </p>
                    <p style="color: #4b5563; font-size: 16px; line-height: 1.6;">
                        <strong>${featureName || "New Feature"}:</strong> ${featureDescription || "Check it out in the app."}
                    </p>
                    <a href="${appUrl}" 
                       style="display: inline-block; background: linear-gradient(to right, #ef4444, #f97316); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 20px;">
                        Try It Now
                    </a>
                </div>
                <div style="padding: 20px 30px; background: #f3f4f6; text-align: center;">
                    <p style="color: #6b7280; font-size: 14px; margin: 0;">© ${new Date().getFullYear()} Vireact. All rights reserved.</p>
                </div>
            </div>
        `;

        const results = await Promise.allSettled(
            users.map((u) =>
                resend.emails.send({
                    from: "support@vireact.io",
                    to: u.email,
                    subject: "New Feature Released! 🚀",
                    html
                })
            )
        );

        const sentCount = results.filter((r) => r.status === "fulfilled" && !r.value.error).length;
        console.log(`[Notification] Product update sent to ${sentCount}/${users.length} users`);

        return { success: true, sentCount, total: users.length };
    } catch (error) {
        console.error("[Notification] Error sending product update emails:", error);
        return { success: false, error };
    }
};
