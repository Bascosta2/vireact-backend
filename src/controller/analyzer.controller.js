import { uploadVideoToS3 } from '../service/s3.service.js';

export const uploadVideoToS3Controller = async (req, res, next) => {
    try {
        const { videoFile } = req.body;
        const videoUrl = await uploadVideoToS3(videoFile);
        res.status(200).json({ videoUrl });
    } catch (error) {
        next(error);
    }
};