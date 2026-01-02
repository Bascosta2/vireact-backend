// import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
// import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
// import { ApiError } from '../utils/ApiError.js';
// import { AWS_ACCESS_KEY_ID, AWS_S3_BUCKET_NAME, AWS_S3_REGION, AWS_SECRET_ACCESS_KEY } from '../config/index.js';
// import { validateS3Key } from '../validator/validate-s3-key.js';

// // Validate AWS configuration
// if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_S3_BUCKET_NAME || !AWS_S3_REGION) {
//     console.error('❌ AWS S3 Configuration Missing:');
//     console.error(`   AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID ? '✓ Set' : '✗ Missing'}`);
//     console.error(`   AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY ? '✓ Set' : '✗ Missing'}`);
//     console.error(`   AWS_S3_BUCKET_NAME: ${AWS_S3_BUCKET_NAME || '✗ Missing'}`);
//     console.error(`   AWS_S3_REGION: ${AWS_S3_REGION || '✗ Missing'}`);
// }

// export const s3 = new S3Client({
//     region: AWS_S3_REGION,
//     credentials: {
//         accessKeyId: AWS_ACCESS_KEY_ID,
//         secretAccessKey: AWS_SECRET_ACCESS_KEY,
//     },
// });

// export const getFileUrl = async (key) => {
//     try {
//         // Validate key to prevent directory traversal
//         const validatedKey = validateS3Key(key);

//         const command = new GetObjectCommand({
//             Bucket: AWS_S3_BUCKET_NAME,
//             Key: validatedKey,
//         });
//         const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // expires in 1 hour
//         return url;
//     } catch (error) {
//         if (error instanceof ApiError) {
//             throw error;
//         }
//         throw new ApiError(500, `Failed to get signed URL: ${error.message}`);
//     }
// };

// export const uploadFileUrl = async (key, contentType = 'video/mp4') => {
//     try {
//         // Validate AWS configuration
//         if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
//             throw new ApiError(500, 'AWS credentials are not configured. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your environment variables.');
//         }

//         if (!AWS_S3_BUCKET_NAME || !AWS_S3_REGION) {
//             throw new ApiError(500, 'AWS S3 bucket configuration is missing. Please set AWS_S3_BUCKET_NAME and AWS_S3_REGION in your environment variables.');
//         }

//         // Validate key to prevent directory traversal
//         const validatedKey = validateS3Key(key);
        
//         console.log(`🔑 Generating presigned URL for S3 upload:`);
//         console.log(`   Bucket: ${AWS_S3_BUCKET_NAME}`);
//         console.log(`   Region: ${AWS_S3_REGION}`);
//         console.log(`   Key: ${validatedKey}`);
//         console.log(`   ContentType: ${contentType}`);
        
//         const command = new PutObjectCommand({
//             Bucket: AWS_S3_BUCKET_NAME,
//             Key: validatedKey,
//             ContentType: contentType, // Include content type for stricter browser handling
//         });
        
//         const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // expires in 1 hour
//         console.log(`✅ Presigned URL generated successfully`);
//         return url;
//     } catch (error) {
//         if (error instanceof ApiError) {
//             throw error;
//         }
        
//         // Enhanced error logging for AWS errors
//         console.error(`❌ S3 Presigned URL Generation Error:`);
//         console.error(`   Error Name: ${error.name}`);
//         console.error(`   Error Message: ${error.message}`);
//         console.error(`   Error Code: ${error.Code || error.code || 'N/A'}`);
        
//         // Provide more specific error messages based on common AWS errors
//         if (error.name === 'AccessDenied' || error.message?.includes('Access Denied')) {
//             throw new ApiError(403, `AWS S3 Access Denied. Please verify:
// 1. AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are correct
// 2. IAM user/role has 's3:PutObject' permission on bucket: ${AWS_S3_BUCKET_NAME}
// 3. Bucket name and region are correct
// 4. Bucket policy allows the operation`);
//         }
        
//         if (error.name === 'NoSuchBucket' || error.message?.includes('does not exist')) {
//             throw new ApiError(404, `S3 bucket '${AWS_S3_BUCKET_NAME}' does not exist in region '${AWS_S3_REGION}'. Please verify the bucket name and region.`);
//         }
        
//         if (error.name === 'InvalidAccessKeyId' || error.message?.includes('Invalid')) {
//             throw new ApiError(401, `Invalid AWS credentials. Please verify AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are correct.`);
//         }
        
//         throw new ApiError(500, `Failed to generate presigned URL: ${error.message || 'Unknown error'}`);
//     }
// };

// /**
//  * Delete an object from S3
//  * @param {string} key - The S3 key of the object to delete
//  * @returns {Promise<boolean>} - True if deletion was successful
//  * @throws {ApiError} - Throws error if deletion fails
//  */
// export const deleteFile = async (key) => {
//     try {
//         // Validate key to prevent directory traversal
//         const validatedKey = validateS3Key(key);
        
//         const command = new DeleteObjectCommand({
//             Bucket: AWS_S3_BUCKET_NAME,
//             Key: validatedKey,
//         });
        
//         const result = await s3.send(command);
//         console.log(`🗑️ Deleted object from S3: ${validatedKey}`);
//         return true;
//     } catch (error) {
//         if (error instanceof ApiError) {
//             throw error;
//         }
//         console.error(`❌ Failed to delete object from S3: ${key}`, error);
//         throw new ApiError(500, `Failed to delete object from S3: ${error.message}`);
//     }
// };
