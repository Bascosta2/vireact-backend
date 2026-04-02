import { Video } from '../model/video.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { requestChatCompletion } from './openai-response.service.js';

/**
 * Generate timestamp-specific feedback for a video based on its analysis
 */
export const generateVideoFeedbackService = async (videoId, userId) => {
    if (!videoId || !userId) {
        throw new ApiError(400, 'Video ID and User ID are required');
    }

    // Verify video belongs to user
    const video = await Video.findOne({ _id: videoId, uploader_id: userId });
    if (!video) {
        throw new ApiError(404, 'Video not found');
    }

    // Check if analysis is completed
    if (video.analysisStatus !== ANALYSIS_STATUS.COMPLETED) {
        throw new ApiError(400, 'Video analysis is not completed yet');
    }

    // If feedback already exists, return it
    if (video.timestampFeedback && video.timestampFeedback.length > 0) {
        return formatFeedbackResponse(video);
    }

    // Generate feedback from analysis and scenes
    const feedback = await analyzeVideoForTimestampFeedback(video);
    
    // Save feedback to video
    video.timestampFeedback = feedback;
    await video.save();

    return formatFeedbackResponse(video);
};

/**
 * Analyze video and generate timestamp-specific feedback
 */
async function analyzeVideoForTimestampFeedback(video) {
    const feedback = [];
    const duration = video.duration || 60; // Default to 60 seconds if not available
    
    // Analyze hook (0-3 seconds)
    if (video.scenes && video.scenes.length > 0) {
        const firstScene = video.scenes[0];
        if (firstScene.startTime < 3) {
            const hookAnalysis = video.analysis?.find(a => a.feature === 'hook');
            if (hookAnalysis && hookAnalysis.rating && hookAnalysis.rating.toLowerCase().includes('weak')) {
                feedback.push({
                    timestamp: 0,
                    endTimestamp: 3,
                    category: 'hook',
                    severity: 'critical',
                    issue: 'The opening 3 seconds lack a compelling visual or statement. Viewers typically decide to stay within 3 seconds.',
                    suggestion: 'Start with your most interesting footage or a provocative question. Example: "What if I told you..."',
                    example: 'Consider opening with: "What if I told you that in the next 30 seconds, you\'ll learn something that will change how you think about [topic]?"'
                });
            }
        }
    }

    // Analyze pacing issues from scenes
    if (video.scenes && video.scenes.length > 1) {
        for (let i = 0; i < video.scenes.length - 1; i++) {
            const currentScene = video.scenes[i];
            const nextScene = video.scenes[i + 1];
            const gap = nextScene.startTime - currentScene.endTime;
            
            // Detect dead air or slow pacing
            if (gap > 2) {
                feedback.push({
                    timestamp: currentScene.endTime,
                    endTimestamp: nextScene.startTime,
                    category: 'pacing',
                    severity: gap > 5 ? 'critical' : 'important',
                    issue: `${Math.round(gap)}-second pause with minimal visual interest. Engagement typically drops during extended pauses.`,
                    suggestion: 'Add B-roll, text overlay, or trim this section to 3-4 seconds maximum.',
                    example: 'Consider adding a text overlay with a key point or quick cut to B-roll footage.'
                });
            }
            
            // Detect rushed sections
            const sceneDuration = currentScene.endTime - currentScene.startTime;
            if (sceneDuration < 1 && currentScene.visualDescription && currentScene.visualDescription.length > 50) {
                feedback.push({
                    timestamp: currentScene.startTime,
                    endTimestamp: currentScene.endTime,
                    category: 'pacing',
                    severity: 'important',
                    issue: 'Scene feels rushed with too much information packed into a short time.',
                    suggestion: 'Slow down the pacing or split this into multiple scenes to allow viewers to process the information.',
                    example: 'Consider extending this scene by 2-3 seconds or breaking it into two separate scenes.'
                });
            }
        }
    }

    // Analyze audio issues
    const audioAnalysis = video.analysis?.find(a => a.feature === 'audio');
    if (audioAnalysis && audioAnalysis.feedback) {
        // Extract timestamp information from audio feedback if available
        const audioFeedbackLower = audioAnalysis.feedback.toLowerCase();
        if (audioFeedbackLower.includes('inconsistent') || audioFeedbackLower.includes('volume')) {
            feedback.push({
                timestamp: 0,
                endTimestamp: duration,
                category: 'audio',
                severity: 'important',
                issue: 'Audio levels are inconsistent throughout the video.',
                suggestion: 'Normalize audio levels in post-production or use a compressor to maintain consistent volume.',
                example: 'Use tools like Audacity or Adobe Premiere Pro to normalize audio levels.'
            });
        }
        if (audioFeedbackLower.includes('noise') || audioFeedbackLower.includes('background')) {
            feedback.push({
                timestamp: 0,
                endTimestamp: duration,
                category: 'audio',
                severity: 'minor',
                issue: 'Background noise detected that may distract viewers.',
                suggestion: 'Use noise reduction filters or record in a quieter environment.',
                example: 'Tools like Audacity\'s Noise Reduction or Adobe\'s DeNoise can help clean up audio.'
            });
        }
    }

    // Analyze visual quality from scenes
    if (video.scenes && video.scenes.length > 0) {
        for (const scene of video.scenes) {
            if (scene.visualDescription) {
                const descLower = scene.visualDescription.toLowerCase();
                if (descLower.includes('blur') || descLower.includes('unclear')) {
                    feedback.push({
                        timestamp: scene.startTime,
                        endTimestamp: scene.endTime,
                        category: 'visual',
                        severity: 'important',
                        issue: 'Visual clarity issues detected in this segment.',
                        suggestion: 'Ensure proper focus and lighting. Consider reshooting if necessary.',
                        example: 'Use manual focus and ensure adequate lighting for better visual quality.'
                    });
                }
                if (descLower.includes('dark') || descLower.includes('poor lighting')) {
                    feedback.push({
                        timestamp: scene.startTime,
                        endTimestamp: scene.endTime,
                        category: 'visual',
                        severity: 'important',
                        issue: 'Poor lighting detected in this segment.',
                        suggestion: 'Increase lighting or adjust exposure in post-production.',
                        example: 'Use natural light from a window or add a ring light for better illumination.'
                    });
                }
            }
        }
    }

    // Analyze CTA/ending (last 5 seconds)
    if (duration > 5) {
        const lastScene = video.scenes && video.scenes.length > 0 
            ? video.scenes[video.scenes.length - 1] 
            : null;
        
        if (lastScene && lastScene.endTime >= duration - 5) {
            const hasCTA = lastScene.onScreenText && (
                lastScene.onScreenText.toLowerCase().includes('subscribe') ||
                lastScene.onScreenText.toLowerCase().includes('like') ||
                lastScene.onScreenText.toLowerCase().includes('follow') ||
                lastScene.onScreenText.toLowerCase().includes('comment')
            );
            
            if (!hasCTA && !lastScene.audioSummary?.toLowerCase().includes('subscribe')) {
                feedback.push({
                    timestamp: Math.max(0, duration - 5),
                    endTimestamp: duration,
                    category: 'cta',
                    severity: 'important',
                    issue: 'Missing clear call-to-action in the final seconds.',
                    suggestion: 'Add a clear CTA asking viewers to like, subscribe, comment, or follow.',
                    example: 'End with: "If you found this helpful, hit the like button and subscribe for more!"'
                });
            }
        }
    }

    // Use AI to generate additional timestamp-specific feedback if we have analysis data
    if (video.analysis && video.analysis.length > 0 && video.scenes && video.scenes.length > 0) {
        try {
            const aiFeedback = await generateAITimestampFeedback(video);
            feedback.push(...aiFeedback);
        } catch (error) {
            console.error('[Video Feedback] Error generating AI feedback:', error.message);
            // Continue with manual feedback if AI fails
        }
    }

    // Sort feedback by timestamp
    feedback.sort((a, b) => a.timestamp - b.timestamp);

    return feedback;
}

/**
 * Generate AI-powered timestamp-specific feedback. Uses scene indices so timestamps are grounded in scene boundaries.
 */
async function generateAITimestampFeedback(video) {
    const scenes = video.scenes || [];
    const sceneList = scenes.map((scene, index) =>
        `Scene ${index} (${scene.startTime}s - ${scene.endTime}s): ${scene.visualDescription || 'No description'}`
    ).join('\n');

    const analysisSummary = (video.analysis || []).map(a =>
        `${a.feature}: ${a.rating || a.score} - ${a.feedback}`
    ).join('\n');

    const prompt = `Analyze this video and provide timestamp-specific feedback. Focus on critical issues that occur in specific SCENES.

Video Duration: ${video.duration || 'Unknown'} seconds

Scenes (use the scene INDEX 0-based to reference which scene each feedback refers to):
${sceneList}

Analysis Summary:
${analysisSummary}

Return a JSON array of feedback objects. Each item MUST use "sceneIndex" (number, 0-based) to reference a single scene. Do NOT use "timestamp" or "endTimestamp" — we will derive those from the scene.

Format:
[
  {
    "sceneIndex": <0-based scene number>,
    "category": "pacing" | "visual" | "audio" | "engagement" | "hook" | "cta",
    "severity": "critical" | "important" | "minor",
    "issue": "<specific issue description>",
    "suggestion": "<actionable suggestion>",
    "example": "<optional example>"
  }
]

Focus on: hook (scene 0), pacing issues, visual/audio problems, engagement drops, CTA (last scene). Return ONLY valid JSON array, no other text.`;

    try {
        const response = await requestChatCompletion({
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            maxTokens: 2000,
            systemPrompt: "You are a video analysis expert. Return only valid JSON arrays with sceneIndex, category, severity, issue, suggestion."
        });
        const jsonMatch = response.match(/\[[\s\S]*\]/);
        if (jsonMatch && scenes.length > 0) {
            const raw = JSON.parse(jsonMatch[0]);
            return raw
                .filter(f => f.sceneIndex !== undefined && f.category && f.severity && f.issue && f.suggestion)
                .map(f => {
                    const idx = Math.min(scenes.length - 1, Math.max(0, parseInt(f.sceneIndex, 10) || 0));
                    const scene = scenes[idx];
                    return {
                        timestamp: scene.startTime,
                        endTimestamp: scene.endTime,
                        category: f.category,
                        severity: f.severity,
                        issue: f.issue,
                        suggestion: f.suggestion,
                        example: f.example
                    };
                });
        }
    } catch (error) {
        console.error('[Video Feedback] AI feedback generation error:', error.message);
    }

    return [];
}

/**
 * Format feedback response with summary statistics
 */
function formatFeedbackResponse(video) {
    const feedback = video.timestampFeedback || [];
    
    const criticalIssues = feedback.filter(f => f.severity === 'critical').length;
    const importantIssues = feedback.filter(f => f.severity === 'important').length;
    const minorIssues = feedback.filter(f => f.severity === 'minor').length;

    return {
        videoId: video._id.toString(),
        feedback,
        totalIssues: feedback.length,
        criticalIssues,
        importantIssues,
        minorIssues,
        summary: generateFeedbackSummary(feedback, criticalIssues, importantIssues, minorIssues)
    };
}

/**
 * Generate a summary of feedback
 */
function generateFeedbackSummary(feedback, critical, important, minor) {
    if (feedback.length === 0) {
        return 'No issues detected. Great job!';
    }

    const parts = [];
    if (critical > 0) {
        parts.push(`${critical} critical issue${critical > 1 ? 's' : ''}`);
    }
    if (important > 0) {
        parts.push(`${important} important issue${important > 1 ? 's' : ''}`);
    }
    if (minor > 0) {
        parts.push(`${minor} minor issue${minor > 1 ? 's' : ''}`);
    }

    return `Found ${parts.join(', ')} that need attention.`;
}
