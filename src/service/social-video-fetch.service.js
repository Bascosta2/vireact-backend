import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { ApiError } from '../utils/ApiError.js';
import { isAllowedSocialVideoUrl } from '../lib/social-video-url.js';
import {
    YT_DLP_PATH,
    YT_DLP_TIMEOUT_MS,
    SOCIAL_VIDEO_MAX_BYTES,
} from '../config/index.js';

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number, parseJson?: boolean }} opts
 * @returns {Promise<{ stdout: string, stderr: string } | object>}
 */
function runYtDlp(args, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? YT_DLP_TIMEOUT_MS;
    const parseJson = opts.parseJson ?? false;

    return new Promise((resolve, reject) => {
        const child = spawn(YT_DLP_PATH, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                /* ignore */
            }
            reject(new ApiError(504, 'Video download timed out. Try a shorter public clip or try again later.'));
        }, timeoutMs);

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            if (err.code === 'ENOENT') {
                reject(
                    new ApiError(
                        503,
                        'Video link download is not available (yt-dlp not installed or YT_DLP_PATH misconfigured).'
                    )
                );
                return;
            }
            reject(new ApiError(500, `Failed to run yt-dlp: ${err.message}`));
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                const hint = stderr.trim() || stdout.trim() || `exit ${code}`;
                reject(
                    new ApiError(
                        422,
                        `Could not download this social video. It may be private, region-blocked, or unsupported. ${hint.slice(0, 500)}`
                    )
                );
                return;
            }
            if (parseJson) {
                try {
                    resolve(JSON.parse(stdout.trim()));
                } catch {
                    reject(new ApiError(500, 'Failed to parse yt-dlp metadata JSON'));
                }
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

/**
 * Fetch title/description without downloading the full file.
 * @param {string} pageUrl
 * @returns {Promise<{ title?: string, description?: string }>}
 */
async function fetchYtDlpMetadata(pageUrl) {
    try {
        const json = await runYtDlp(
            ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download', pageUrl],
            { parseJson: true, timeoutMs: Math.min(YT_DLP_TIMEOUT_MS, 120000) }
        );
        return {
            title: typeof json.title === 'string' ? json.title : undefined,
            description: typeof json.description === 'string' ? json.description : undefined,
        };
    } catch {
        return {};
    }
}

/**
 * Download allowlisted social video to a buffer for Twelve Labs direct upload.
 * @param {string} pageUrl
 * @returns {Promise<{ buffer: Buffer, metadata: { title?: string, description?: string }, byteLength: number }>}
 */
export async function downloadSocialVideoForIngest(pageUrl) {
    if (!isAllowedSocialVideoUrl(pageUrl)) {
        throw new ApiError(400, 'URL hostname is not allowed for server-side social download');
    }

    const metadata = await fetchYtDlpMetadata(pageUrl);

    const id = randomUUID();
    const outFile = path.join(os.tmpdir(), `vireact-social-${id}.mp4`);

    try {
        await runYtDlp(
            [
                '--no-playlist',
                '--no-warnings',
                '-f',
                'bv*+ba/bestvideo+bestaudio/best',
                '--remux-video',
                'mp4',
                '-o',
                outFile,
                pageUrl,
            ],
            { parseJson: false }
        );

        const stat = await fs.stat(outFile).catch(() => null);
        if (!stat || !stat.isFile()) {
            throw new ApiError(500, 'Download finished but output file was not found');
        }

        if (stat.size > SOCIAL_VIDEO_MAX_BYTES) {
            throw new ApiError(
                413,
                `Downloaded video exceeds the maximum size (${Math.round(SOCIAL_VIDEO_MAX_BYTES / (1024 * 1024))}MB)`
            );
        }

        const buffer = await fs.readFile(outFile);
        return {
            buffer,
            metadata,
            byteLength: buffer.length,
        };
    } finally {
        await fs.unlink(outFile).catch(() => {});
    }
}
