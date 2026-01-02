import {
    // generatePresignedUploadUrlService,
    confirmVideoUploadService,
    getUserVideosService,
    deleteVideoService,
    markAnalysisViewedService,
    uploadVideoToTwelveLabsService,
    uploadVideoUrlToTwelveLabsService
} from '../service/video.service.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Video } from '../model/video.model.js';
import { Chat } from '../model/chat.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { Receiver } from '@upstash/qstash';
import { QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY } from '../config/index.js';
import TwelveLabsClient from '../lib/twelve-labs.js';
import { analyzeHook } from '../service/analyzer/hook.analyzer.js';
import { analyzeCaption } from '../service/analyzer/caption.analyzer.js';
import { analyzePacing } from '../service/analyzer/pacing.analyzer.js';
import { analyzeAudio } from '../service/analyzer/audio.analyzer.js';
import { analyzeAdvancedAnalytics } from '../service/analyzer/advanced-analytics.analyzer.js';
import { analyzeViewsPredictor } from '../service/analyzer/views-predictor.analyzer.js';
import { requestChatCompletion } from '../service/openai-response.service.js';
import { checkVideoLimit, incrementVideoUsage } from '../service/subscription.service.js';

const receiver = new Receiver({
    currentSigningKey: QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: QSTASH_NEXT_SIGNING_KEY,
});

// export const getPresignedUploadUrl = async (req, res, next) => {
//     try {
//         const { filename, contentType, selectedFeatures } = req.body;
//         const userId = req.user._id;

//         if (!filename || !contentType) {
//             throw new ApiError(400, 'Filename and content type are required');
//         }

//         const result = await generatePresignedUploadUrlService(
//             userId,
//             filename,
//             contentType,
//             selectedFeatures
//         );

//         console.log("Pre Signed URL Generation Response", result)

//         res.status(200).json(
//             ApiResponse.success(
//                 200,
//                 'Presigned URL generated successfully',
//                 result
//             )
//         );
//     } catch (error) {
//         // console.log("Pre Signed URL Generation Error", error)
//         next(error);
//     }
// };

export const confirmVideoUpload = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const { fileSize } = req.body;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const video = await confirmVideoUploadService(videoId, userId, fileSize);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video upload confirmed successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const getUserVideos = async (req, res, next) => {
    try {
        const userId = req.user._id;

        const videos = await getUserVideosService(userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Videos fetched successfully',
                { videos }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const deleteVideo = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        await deleteVideoService(videoId, userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video deleted successfully',
                null
            )
        );
    } catch (error) {
        next(error);
    }
};

export const markAnalysisViewed = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const video = await markAnalysisViewedService(videoId, userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Analysis marked as viewed successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const processVideoAnalysis = async (req, res, next) => {
    try {
        // Verify QStash signature for security
        // Note: For production, you may want to use raw body buffer for more accurate verification
        // For now, we'll verify with the parsed body
        // if (QSTASH_CURRENT_SIGNING_KEY || QSTASH_NEXT_SIGNING_KEY) {
        //     try {
        //         const signature = req.headers['Upstash-Signature'];
        //         const body = req.body;

        //         if (!signature) {
        //             console.warn('[QStash] Missing signature header');
        //             // In development, allow without signature if keys are not set
        //             if (QSTASH_CURRENT_SIGNING_KEY || QSTASH_NEXT_SIGNING_KEY) {
        //                 return res.status(401).json(
        //                     ApiResponse.error(401, 'Missing QStash signature')
        //                 );
        //             }
        //         } else {
        //             const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        //             const isValid = await receiver.verify({
        //                 body,
        //                 signature,
        //                 url,
        //             });

        //             if (!isValid) {
        //                 console.error('[QStash] Signature verification failed');
        //                 return res.status(401).json(
        //                     ApiResponse.error(401, 'Invalid QStash signature')
        //                 );
        //             }
        //         }
        //     } catch (signatureError) {
        //         console.error('[QStash] Signature verification error:', signatureError.message);
        //         return res.status(401).json(
        //             ApiResponse.error(401, 'Invalid QStash signature')
        //         );
        //     }
        // }

        const { videoId, twelveLabsVideoId, userId } = req.body;

        if (!videoId) {
            return res.status(400).json(
                ApiResponse.error(400, 'Video ID is required')
            );
        }

        // Update video status to processing
        const video = await Video.findById(videoId);
        if (!video) {
            return res.status(404).json(
                ApiResponse.error(404, `Video ${videoId} not found`)
            );
        }

        // Use the video ID from the database (indexed video ID), not the asset ID
        // The twelveLabsVideoId field should contain the indexed video ID, not the asset ID
        const indexedVideoId = video.twelveLabsVideoId || twelveLabsVideoId;

        if (!indexedVideoId) {
            // If we have an asset ID but no video ID, we need to index it first
            if (video.twelveLabsAssetId) {
                console.log(`[QStash] Video ${videoId} has asset ID but not indexed. Attempting to index...`);
                // This should have been done during upload, but handle it here as fallback
                return res.status(400).json(
                    ApiResponse.error(400, 'Video has not been indexed yet. Please wait for indexing to complete.')
                );
            }
            return res.status(400).json(
                ApiResponse.error(400, 'TwelveLabs video ID is required. Video may not have been uploaded to TwelveLabs.')
            );
        }

        // Log the TwelveLabs video ID (from index)
        console.log(`[QStash] Processing analysis for video ${videoId}`);
        console.log(`[QStash] TwelveLabs Video ID (indexed): ${indexedVideoId}`);
        if (video.twelveLabsAssetId) {
            console.log(`[QStash] TwelveLabs Asset ID: ${video.twelveLabsAssetId}`);
        }
        if (userId) {
            console.log(`[QStash] User ID: ${userId}`);
        }

        video.analysisStatus = ANALYSIS_STATUS.PROCESSING;
        await video.save();

        try {
            // Use the TwelveLabs video ID (from index) to analyze the video
            // The indexedVideoId is the video ID from the index, not the asset ID
            console.log(`[QStash] Analyzing video using indexed video ID: ${indexedVideoId}`);

            const videoAnalysisResult = await TwelveLabsClient.analyze({
                videoId: indexedVideoId,
                prompt: `
Analyze this short-form social media video and break it into clear chronological scenes.

For EACH scene, return in this EXACT format:
Scene Number: [number]
- Start Time: [X]s ([XX:XX])
- End Time: [X]s ([XX:XX])
- What is Visually Happening: [description]
- On-Screen Text/Captions: [text or "None"]
- Audio/Speech Summary: [description or "None"]
- Primary Action or Hook: [description]
- Emotional Tone: [tone, e.g., excitement, tension, humor]
- Purpose of the Scene: [hook, buildup, reveal, CTA, filler]

IMPORTANT AUDIO INSTRUCTIONS:
- Audio/Speech Summary MUST include ALL audio elements: spoken dialogue, voiceover narration, background music, sound effects, and any other audio
- If there is on-screen text/captions, it often represents what is being spoken - include this spoken content in the Audio/Speech Summary
- Describe background music, sound effects, or any ambient audio present
- Only use "None" if there is truly no audio at all in the scene

Focus on fast cuts, transitions, camera changes, text overlays, and beat changes typical of reels/shorts.
Be concise but precise. Ignore general feedback and do NOT summarize the whole video.
Only output structured scene-by-scene analysis.
              `,
                temperature: 0.2
            });

            console.log("Video Analysis Result", videoAnalysisResult);
            console.log("Video Analysis Result Type:", typeof videoAnalysisResult);
            if (typeof videoAnalysisResult === 'object') {
                console.log("Video Analysis Result Keys:", Object.keys(videoAnalysisResult));
            }

            // Parse scenes from TwelveLabs response using OpenAI
            const scenes = await parseScenesWithOpenAI(videoAnalysisResult);
            console.log(`[QStash] Parsed ${scenes.length} scenes from analysis`);
            
            if (scenes.length === 0) {
                console.warn('[QStash] No scenes were parsed from the analysis result. Raw result:', JSON.stringify(videoAnalysisResult, null, 2));
            }
            
            // Store scenes in video document
            video.scenes = scenes;
            console.log(`[QStash] Storing ${video.scenes.length} scenes in video document`);
            await video.save();
            
            // Verify scenes were saved
            const savedVideo = await Video.findById(videoId);
            console.log(`[QStash] Verified: Video document now has ${savedVideo?.scenes?.length || 0} scenes`);

            // Get selected features from video (default to all if not specified)
            const selectedFeatures = video.selectedFeatures && video.selectedFeatures.length > 0
                ? video.selectedFeatures
                : ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor'];

            // Extract hook from scenes (first scene with purpose "hook" or first scene)
            const hookScene = scenes.find(s => s.purpose?.toLowerCase() === 'hook') || scenes[0];
            const hook = hookScene?.primaryAction || hookScene?.visualDescription || '';

            // Perform feature-based analysis and store in video.analysis array
            video.analysis = [];
            const featureOutputs = {};

            // Helper to extract rating, feedback, and suggestions from analysis result
            const extractAnalysisData = (result, featureName) => {
                const analysisData = {
                    feature: featureName,
                    rating: null,
                    feedback: null,
                    suggestions: [],
                    analyzedAt: new Date()
                };

                if (typeof result === 'string') {
                    // Parse text response for rating, reasoning, suggestions
                    const ratingMatch = result.match(/rating[:\-\s]*([^\n]+)/i);
                    const reasoningMatch = result.match(/reasoning[:\-\s]*([^\n]+)/i);
                    const suggestionsMatch = result.match(/suggestions?:[\s\S]*?(-[^\n]+(?:[\s\S]*?-.*?)?)/i);
                    
                    if (ratingMatch) {
                        analysisData.rating = ratingMatch[1].trim();
                    }
                    if (reasoningMatch) {
                        analysisData.feedback = reasoningMatch[1].trim();
                    }
                    if (suggestionsMatch) {
                        const suggestionsText = suggestionsMatch[1] || '';
                        const suggestionLines = suggestionsText.match(/-[^\n]+/g) || [];
                        analysisData.suggestions = suggestionLines.map(s => s.replace(/^-\s*/, '').trim()).filter(s => s);
                    } else {
                        // If no structured suggestions, use full feedback
                        analysisData.feedback = result;
                    }
                } else if (typeof result === 'object' && result !== null) {
                    analysisData.rating = result.rating || null;
                    analysisData.feedback = result.feedback || null;
                    analysisData.suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
                }

                return analysisData;
            };

            for (const feature of selectedFeatures) {
                try {
                    let analysisResult = null;
                    switch (feature) {
                        case 'hook':
                            if (hook) {
                                analysisResult = await analyzeHook(hook, scenes);
                                featureOutputs.hook = analysisResult;
                            }
                            break;
                        case 'caption':
                            analysisResult = await analyzeCaption(scenes);
                            featureOutputs.caption = analysisResult;
                            break;
                        case 'pacing':
                            analysisResult = await analyzePacing(scenes);
                            featureOutputs.pacing = analysisResult;
                            break;
                        case 'audio':
                            analysisResult = await analyzeAudio(scenes);
                            featureOutputs.audio = analysisResult;
                            break;
                        case 'advanced_analytics':
                            analysisResult = await analyzeAdvancedAnalytics(scenes);
                            featureOutputs.advanced_analytics = analysisResult;
                            break;
                        case 'views_predictor':
                            analysisResult = await analyzeViewsPredictor(scenes);
                            featureOutputs.views_predictor = analysisResult;
                            break;
                        default:
                            console.warn(`[QStash] Unknown feature: ${feature}`);
                    }

                    if (analysisResult !== null) {
                        const analysisData = extractAnalysisData(analysisResult, feature);
                        video.analysis.push(analysisData);
                    }
                } catch (featureError) {
                    console.error(`[QStash] Error analyzing feature ${feature}:`, featureError.message);
                    featureOutputs[feature] = {
                        error: `Analysis failed: ${featureError.message}`
                    };
                    // Still push error to analysis array for tracking
                    video.analysis.push({
                        feature,
                        rating: null,
                        feedback: `Analysis failed: ${featureError.message}`,
                        suggestions: [],
                        analyzedAt: new Date()
                    });
                }
            }

            // Update video status and mark analysis ready
            video.analysisStatus = ANALYSIS_STATUS.COMPLETED;
            video.isAnalysisReady = true;
            await video.save();

            // Increment video usage after successful analysis
            try {
                await incrementVideoUsage(userId);
            } catch (usageError) {
                console.error(`[QStash] Failed to increment video usage for user ${userId}:`, usageError.message);
            }

            // Store initial analysis summary in chat as first message
            try {
                // Reload video to get the updated analysis array
                const updatedVideo = await Video.findById(videoId);
                const initialMessage = buildInitialAnalysisMessage(updatedVideo);
                if (initialMessage) {
                    const chat = await Chat.findOneAndUpdate(
                        { videoId, userId },
                        {
                            videoId,
                            userId,
                            $setOnInsert: { messages: [] }
                        },
                        { upsert: true, new: true }
                    );
                    chat.messages.push({
                        text: initialMessage,
                        isUser: false
                    });
                    await chat.save();
                }
            } catch (chatError) {
                console.error(`[QStash] Failed to save initial analysis message to chat for video ${videoId}:`, chatError.message);
            }

            console.log(`[QStash] Analysis completed for video ${videoId}, TwelveLabs video ID: ${indexedVideoId}`);

            return res.status(200).json(
                ApiResponse.success(
                    200,
                    'Video analysis completed successfully',
                    { videoId, twelveLabsVideoId: indexedVideoId, analysisResults: featureOutputs }
                )
            );
        } catch (error) {
            // Update video status to failed
            video.analysisStatus = ANALYSIS_STATUS.FAILED;
            await video.save();

            console.error(`[QStash] Analysis failed for video ${videoId}:`, error.message);

            // Return error but don't throw - QStash will retry if needed
            return res.status(500).json(
                ApiResponse.error(500, `Analysis failed: ${error}`)
            );
        }
    } catch (error) {
        console.error('[QStash] Error processing video analysis:', error);
        next(error);
    }
};

export const uploadVideoToTwelveLabs = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const file = req.file || req.files?.file;

        if (!file) {
            throw new ApiError(400, 'Video file is required');
        }

        // Check video upload limit before processing
        await checkVideoLimit(userId);

        // Use original filename from multer if available, otherwise from body
        const filename = file.originalname || req.body.filename;
        const { selectedFeatures } = req.body;

        if (!filename) {
            throw new ApiError(400, 'Filename is required');
        }

        // Log file info for debugging
        console.log(`📁 File received: ${filename}, size: ${file.size}, mimetype: ${file.mimetype}, buffer size: ${file.buffer?.length || 'N/A'}`);

        const selectedFeaturesArray = selectedFeatures
            ? (Array.isArray(selectedFeatures) ? selectedFeatures : JSON.parse(selectedFeatures))
            : [];

        // Pass the entire file object so service can handle buffer/stream conversion
        const video = await uploadVideoToTwelveLabsService(
            userId,
            file,
            filename,
            selectedFeaturesArray
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video uploaded to TwelveLabs successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const uploadVideoUrlToTwelveLabs = async (req, res, next) => {
    try {
        const { url, filename, selectedFeatures } = req.body;
        const userId = req.user._id;

        if (!url || !filename) {
            throw new ApiError(400, 'URL and filename are required');
        }

        // Check video upload limit before processing
        await checkVideoLimit(userId);

        const selectedFeaturesArray = Array.isArray(selectedFeatures)
            ? selectedFeatures
            : [];

        const video = await uploadVideoUrlToTwelveLabsService(
            userId,
            url,
            filename,
            selectedFeaturesArray
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video URL uploaded to TwelveLabs successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

// Helper function to parse scenes from TwelveLabs analysis response using OpenAI
async function parseScenesWithOpenAI(analysisResult) {
    // Extract text content from TwelveLabs response
    let text = '';
    if (typeof analysisResult === 'string') {
        text = analysisResult;
    } else if (analysisResult.data) {
        if (typeof analysisResult.data === 'string') {
            text = analysisResult.data;
        } else if (analysisResult.data.data && typeof analysisResult.data.data === 'string') {
            text = analysisResult.data.data;
        } else if (analysisResult.data.response && typeof analysisResult.data.response === 'string') {
            text = analysisResult.data.response;
        } else if (analysisResult.data.message && typeof analysisResult.data.message === 'string') {
            text = analysisResult.data.message;
        } else {
            text = JSON.stringify(analysisResult.data);
        }
    } else if (analysisResult.response && typeof analysisResult.response === 'string') {
        text = analysisResult.response;
    } else if (analysisResult.message && typeof analysisResult.message === 'string') {
        text = analysisResult.message;
    } else if (analysisResult.text && typeof analysisResult.text === 'string') {
        text = analysisResult.text;
    } else {
        text = JSON.stringify(analysisResult);
    }

    if (!text || text.trim().length === 0) {
        console.warn('[parseScenesWithOpenAI] No text content found in analysis result');
        return [];
    }

    // Use OpenAI to convert text to JSON
    const prompt = `Convert the following video scene analysis into a JSON array. Each scene should have these exact fields:
- sceneNumber (number)
- startTime (number, in seconds)
- endTime (number, in seconds)
- visualDescription (string, or empty string if not provided)
- onScreenText (string, or empty string if "None" or "N/A")
- audioSummary (string, or empty string if "None" or "N/A")
- primaryAction (string, or empty string if not provided)
- emotionalTone (string, or empty string if not provided)
- purpose (string, or empty string if not provided)

IMPORTANT: For audioSummary field:
- Include ALL audio elements: spoken dialogue, voiceover narration, background music, sound effects
- If on-screen text/captions are present, they often represent spoken words - include this in audioSummary when the source text indicates speech
- Only use empty string if there is truly no audio at all in the scene

Input text:
${text}

Return ONLY a valid JSON array of scenes, no other text. Example format:
[
  {
    "sceneNumber": 1,
    "startTime": 0,
    "endTime": 5,
    "visualDescription": "A man in a red hoodie...",
    "onScreenText": "",
    "audioSummary": "Background music with spoken dialogue",
    "primaryAction": "Offers money",
    "emotionalTone": "humor",
    "purpose": "hook"
  }
]`;

    try {
        const response = await requestChatCompletion({
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1,
            maxTokens: 2000,
            systemPrompt: "You are a JSON formatter. Return only valid JSON arrays, no markdown, no explanations."
        });

        // Try to extract JSON from response (handle markdown code blocks if present)
        let jsonText = response.trim();
        const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            jsonText = jsonMatch[0];
        }

        const scenes = JSON.parse(jsonText);
        if (Array.isArray(scenes) && scenes.length > 0) {
            console.log(`[parseScenesWithOpenAI] Successfully parsed ${scenes.length} scenes using OpenAI`);
            return scenes;
        }
    } catch (error) {
        console.warn('[parseScenesWithOpenAI] OpenAI parsing failed, falling back to regex:', error.message);
    }

    // Fallback to regex parsing if OpenAI fails
    return parseScenesFromAnalysis(analysisResult);
}

// Helper function to parse scenes from TwelveLabs analysis response (fallback regex method)
function parseScenesFromAnalysis(analysisResult) {
    const scenes = [];
    
    if (!analysisResult) {
        console.warn('[parseScenesFromAnalysis] analysisResult is null or undefined');
        return scenes;
    }

    // Extract text content (TwelveLabs returns response in various formats)
    let text = '';
    if (typeof analysisResult === 'string') {
        text = analysisResult;
    } else if (analysisResult.data) {
        // Handle nested data structures
        if (typeof analysisResult.data === 'string') {
            text = analysisResult.data;
        } else if (analysisResult.data.data && typeof analysisResult.data.data === 'string') {
            text = analysisResult.data.data;
        } else if (analysisResult.data.response && typeof analysisResult.data.response === 'string') {
            text = analysisResult.data.response;
        } else if (analysisResult.data.message && typeof analysisResult.data.message === 'string') {
            text = analysisResult.data.message;
        } else {
            text = JSON.stringify(analysisResult.data);
        }
    } else if (analysisResult.response && typeof analysisResult.response === 'string') {
        text = analysisResult.response;
    } else if (analysisResult.message && typeof analysisResult.message === 'string') {
        text = analysisResult.message;
    } else if (analysisResult.text && typeof analysisResult.text === 'string') {
        text = analysisResult.text;
    } else {
        // Try to stringify and parse
        text = JSON.stringify(analysisResult);
    }
    
    console.log(`[parseScenesFromAnalysis] Extracted text length: ${text.length} characters`);
    if (text.length > 500) {
        console.log(`[parseScenesFromAnalysis] First 500 chars: ${text.substring(0, 500)}...`);
    } else {
        console.log(`[parseScenesFromAnalysis] Full text: ${text}`);
    }

    // Parse scenes using regex pattern matching
    // Handle format: "1. Scene Number: 1\n   - Start Time: 0s..." (from example file)
    // Also handle: "Scene Number: 1\n- Start Time: 0s..."
    
    // Split by numbered list items (1., 2., 3., etc.)
    const sceneBlocks = text.split(/(?=\d+\.\s*Scene Number:)/gi);
    
    for (let i = 0; i < sceneBlocks.length; i++) {
        const block = sceneBlocks[i].trim();
        if (!block) continue;
        
        // Extract scene number
        const sceneNumMatch = block.match(/Scene Number:\s*(\d+)/i);
        if (!sceneNumMatch) continue;
        
        const sceneNumber = parseInt(sceneNumMatch[1], 10);
        
        // Extract all fields using flexible matching
        const extractField = (pattern, defaultValue = '') => {
            const match = block.match(new RegExp(pattern, 'i'));
            if (!match) return defaultValue;
            const value = match[1]?.trim() || defaultValue;
            // Handle "None" or "N/A" as empty
            if (value.toLowerCase() === 'none' || value.toLowerCase() === 'n/a') {
                return '';
            }
            return value;
        };
        
        const scene = {
            sceneNumber: sceneNumber,
            startTime: parseFloat(extractField(/Start Time:\s*(\d+(?:\.\d+)?)s?/i, '0')) || 0,
            endTime: parseFloat(extractField(/End Time:\s*(\d+(?:\.\d+)?)s?/i, '0')) || 0,
            visualDescription: extractField(/What is Visually Happening:\s*([^\n]+)/i, ''),
            onScreenText: extractField(/On-Screen Text\/Captions:\s*([^\n]+)/i, ''),
            audioSummary: extractField(/Audio\/Speech Summary:\s*([^\n]+)/i, ''),
            primaryAction: extractField(/Primary Action or Hook:\s*([^\n]+)/i, ''),
            emotionalTone: extractField(/Emotional Tone:\s*([^\n]+)/i, ''),
            purpose: extractField(/Purpose of the Scene:\s*([^\n]+)/i, '')
        };
        
        scenes.push(scene);
    }
    
    // If the above didn't work, try a simpler regex-based approach
    if (scenes.length === 0) {
        const simpleRegex = /Scene Number:\s*(\d+)[\s\S]*?Start Time:\s*(\d+(?:\.\d+)?)s?[^\n]*?End Time:\s*(\d+(?:\.\d+)?)s?[^\n]*?What is Visually Happening:\s*([^\n]+)[^\n]*?On-Screen Text\/Captions:\s*([^\n]+)[^\n]*?Audio\/Speech Summary:\s*([^\n]+)[^\n]*?Primary Action or Hook:\s*([^\n]+)[^\n]*?Emotional Tone:\s*([^\n]+)[^\n]*?Purpose of the Scene:\s*([^\n]+)/gi;
        
        let match;
        let lastIndex = -1;
        while ((match = simpleRegex.exec(text)) !== null) {
            if (match.index === lastIndex) break;
            lastIndex = match.index;
            
            const cleanValue = (val) => {
                const cleaned = val?.trim() || '';
                return (cleaned.toLowerCase() === 'none' || cleaned.toLowerCase() === 'n/a') ? '' : cleaned;
            };
            
            scenes.push({
                sceneNumber: parseInt(match[1], 10),
                startTime: parseFloat(match[2]) || 0,
                endTime: parseFloat(match[3]) || 0,
                visualDescription: cleanValue(match[4]),
                onScreenText: cleanValue(match[5]),
                audioSummary: cleanValue(match[6]),
                primaryAction: cleanValue(match[7]),
                emotionalTone: cleanValue(match[8]),
                purpose: cleanValue(match[9])
            });
        }
    }

    // If regex parsing failed, try alternative parsing
    if (scenes.length === 0) {
        // Try to find numbered scenes
        const numberedSceneRegex = /(\d+)\.?\s*Scene[^\n]*?Start Time[^\n]*?End Time[^\n]*?([\s\S]*?)(?=\d+\.?\s*Scene|$)/gi;
        let altMatch;
        let sceneNum = 1;
        
        while ((altMatch = numberedSceneRegex.exec(text)) !== null && sceneNum <= 20) {
            const sceneText = altMatch[2] || altMatch[0];
            
            // Extract basic info
            const startMatch = sceneText.match(/Start Time[:\s]*(\d+(?:\.\d+)?)s?/i);
            const endMatch = sceneText.match(/End Time[:\s]*(\d+(?:\.\d+)?)s?/i);
            const visualMatch = sceneText.match(/What is Visually Happening[:\s]*([^\n]+)/i);
            const textMatch = sceneText.match(/On-Screen Text\/Captions[:\s]*([^\n]+)/i);
            const audioMatch = sceneText.match(/Audio\/Speech Summary[:\s]*([^\n]+)/i);
            const actionMatch = sceneText.match(/Primary Action[^\n]*[:\s]*([^\n]+)/i);
            const toneMatch = sceneText.match(/Emotional Tone[:\s]*([^\n]+)/i);
            const purposeMatch = sceneText.match(/Purpose of the Scene[:\s]*([^\n]+)/i);
            
            scenes.push({
                sceneNumber: sceneNum++,
                startTime: startMatch ? parseFloat(startMatch[1]) : 0,
                endTime: endMatch ? parseFloat(endMatch[1]) : 0,
                visualDescription: visualMatch ? visualMatch[1].trim() : '',
                onScreenText: textMatch ? textMatch[1].trim() : '',
                audioSummary: audioMatch ? audioMatch[1].trim() : '',
                primaryAction: actionMatch ? actionMatch[1].trim() : '',
                emotionalTone: toneMatch ? toneMatch[1].trim() : '',
                purpose: purposeMatch ? purposeMatch[1].trim() : ''
            });
        }
    }

    return scenes;
}

// Build initial analysis message for chat from video.analysis array
function buildInitialAnalysisMessage(video) {
    const parts = [];
    const analysisArray = video.analysis || [];

    // Feature name mapping
    const featureLabels = {
        hook: 'Hook',
        caption: 'Caption',
        pacing: 'Pacing',
        audio: 'Audio',
        advanced_analytics: 'Advanced Analytics',
        views_predictor: 'Views Predictor'
    };

    // Process each analyzed feature
    analysisArray.forEach((analysis, index) => {
        const featureName = featureLabels[analysis.feature] || analysis.feature;
        
        // Add feature name
        parts.push(featureName);
        parts.push("");
        
        // Add "What's wrong" section
        parts.push("What's wrong:");
        const feedback = analysis.feedback && analysis.feedback.trim() 
            ? analysis.feedback 
            : "No specific issues identified";
        parts.push(feedback);
        parts.push("");
        
        // Add "Suggestions to improve" section
        parts.push("Suggestions to improve:");
        if (analysis.suggestions && analysis.suggestions.length > 0) {
            analysis.suggestions.forEach(suggestion => {
                parts.push(`- ${suggestion}`);
            });
        } else {
            parts.push("- No suggestions available");
        }
        
        // Add spacing between features (except after the last one)
        if (index < analysisArray.length - 1) {
            parts.push("");
            parts.push("");
        }
    });

    return parts.join('\n');
}
