import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { getYouTubeVideoInfo, downloadYouTubeVideo, formatDuration } from "./youtube-dl";
import { probeYtdlpHealth } from "./yt-dlp-bin";
import { getPipeline, Pipeline } from "./pipeline";
import {
  listModels as llmListModels,
  probeStatus as llmProbeStatus,
  LlmConfigError,
  LlmHttpError,
  LlmUnreachableError,
} from "./llm";
import { searchSemantic } from "./semantic-search";
import { embedSegmentsForVideo } from "./embed-segments";
import { summarizeVideo } from "./summarize-video";
import { chat as llmChat } from "./llm";
import {
  getEmbeddingStats, clearAllEmbeddings, setVideoAiSummary, hasVideoEmbeddings,
  getCoveredVideoKeysForModel,
  getVideoSpeakerSummary, getVideoSpeakerSummariesBatch,
  getArchiveStatus,
} from "./db";
import { registerChatRoutes } from "./routes-chat";
import { registerLlmRoutes } from "./routes-llm";
import { registerNotesRoutes } from "./routes-notes";
import { registerSpeakerRoutes } from "./routes-speakers";
import { registerSystemRoutes } from "./routes-system";
import { registerTranscriptionSetupRoutes } from "./routes-transcription-setup";
import {
  countByStatus,
  enqueueVideo,
  getChannelQueue,
  getDb,
  getQueueEntry,
  getQueueEntryByVideoId,
  getQueueList,
  getTranscriptSegmentsForVideo,
  getTranscriptSearchIndexStats,
  refreshTranscriptSearchIndex,
  searchTranscriptSegments,
  setVideoNotes,
  updateQueueStatus,
  type QueueEntry,
} from "./db";
import { copyAudioTrack, encodeAacSidecar, ffmpegBin, getVideoStreamInfo } from "./audio";
import { channelFolderName, datedBaseName, replaceExtension } from "./naming";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

/** Move a file to the OS trash (restorable). Linux uses `gio trash`
 *  (freedesktop trash spec, what Files / Nautilus respects). macOS uses
 *  Finder via AppleScript so "Put Back" works. Windows isn't supported
 *  yet — the route would need a separate IFileOperation call. */
async function moveToTrash(absPath: string): Promise<void> {
  if (process.platform === "linux") {
    try {
      await execFileAsync("gio", ["trash", absPath]);
      return;
    } catch (err) {
      // gio not installed (rare on modern Ubuntu but possible on minimal
      // installs). Fall through to a friendlier error.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`gio trash failed — install gvfs-bin / glib2.0-bin? (${msg})`);
    }
  }
  if (process.platform === "darwin") {
    // AppleScript via Finder. Escape quotes so a filename with " in it
    // doesn't break the script.
    const escaped = absPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "Finder" to delete POSIX file "${escaped}"`;
    await execFileAsync("osascript", ["-e", script]);
    return;
  }
  throw new Error(`Trash is not implemented on ${process.platform}`);
}

// Track active downloads and their progress
const activeDownloads = new Map<string, {
  percent: number;
  downloadPath: string;
  videoId: string;
  finalLocation?: string;
  uploadDate?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  isComplete: boolean;
}>();

type ExportMode = "fast" | "accurate";

function formatSecondsForFile(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hours, minutes, secs].map(part => String(part).padStart(2, "0")).join("-");
}

function uniquePath(filePath: string): string {
  if (!fs.existsSync(filePath)) return filePath;
  const parsed = path.parse(filePath);
  for (let i = 2; i < 1000; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function exportVideoSegment(options: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  duration: number;
  mode: ExportMode;
  quality: string;
}): Promise<void> {
  const start = String(Math.max(0, options.startSeconds));
  const duration = String(Math.max(0.1, options.duration));
  const args =
    options.mode === "fast"
      ? [
          "-ss", start,
          "-i", options.inputPath,
          "-t", duration,
          "-map", "0:v:0?",
          "-map", "0:a:0?",
          "-c", "copy",
          "-avoid_negative_ts", "make_zero",
          "-y",
          options.outputPath,
        ]
      : [
          "-ss", start,
          "-i", options.inputPath,
          "-t", duration,
          "-map", "0:v:0?",
          "-map", "0:a:0?",
          ...(options.quality !== "same" ? ["-vf", `scale=-2:${options.quality}`] : []),
          "-c:v", "libx264",
          "-preset", "veryfast",
          "-crf", "20",
          "-c:a", "aac",
          "-b:a", "160k",
          "-movflags", "+faststart",
          "-y",
          options.outputPath,
        ];

  console.log(`[export] ffmpeg ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", data => {
      stderr += data.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    proc.on("error", err => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));
    proc.on("close", code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Create temp directory for downloads
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  // Set up periodic cleanup of temp directory
  const cleanupTempFiles = () => {
    console.log("Running scheduled temp directory cleanup...");
    try {
      // Get all files in temp directory
      const files = fs.readdirSync(tempDir);
      
      // Get current active download paths to avoid deleting in-use files
      const activeFilePaths = new Set<string>();
      activeDownloads.forEach(download => {
        activeFilePaths.add(download.downloadPath);
      });
      
      let deletedCount = 0;
      let totalSize = 0;
      
      // Check each file
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        
        // Skip if this is an active download
        if (activeFilePaths.has(filePath)) {
          console.log(`Skipping active download: ${file}`);
          continue;
        }
        
        try {
          // Get file stats
          const stats = fs.statSync(filePath);
          
          // Only delete files older than 30 minutes (1800000ms)
          const fileAge = Date.now() - stats.mtimeMs;
          if (fileAge > 1800000) {
            totalSize += stats.size;
            fs.unlinkSync(filePath);
            deletedCount++;
            console.log(`Deleted old temp file: ${file} (${Math.round(stats.size / 1024)} KB, ${Math.round(fileAge / 60000)} minutes old)`);
          }
        } catch (error) {
          console.error(`Error processing temp file ${file}:`, error);
        }
      }
      
      if (deletedCount > 0) {
        console.log(`Cleanup complete: Removed ${deletedCount} files, freed ${Math.round(totalSize / (1024 * 1024))} MB of space`);
      } else {
        console.log("No files needed cleanup");
      }
    } catch (error) {
      console.error("Error during temp directory cleanup:", error);
    }
  };
  
  // Run cleanup on startup
  cleanupTempFiles();
  
  // Set up interval to clean temp files every 15 minutes
  const cleanupInterval = setInterval(cleanupTempFiles, 15 * 60 * 1000);

  // API route to get video info
  app.post("/api/videos/info", async (req, res) => {
    try {
      const { url } = req.body;
      
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      const videoInfo = await getYouTubeVideoInfo(url);
      
      if (!videoInfo) {
        return res.status(404).json({ error: "Could not retrieve video information" });
      }

      // Format data to match our schema
      const formattedInfo = {
        id: videoInfo.id,
        title: videoInfo.title,
        thumbnail: videoInfo.thumbnail,
        duration: formatDuration(videoInfo.duration),
        views: `${Math.round((videoInfo.view_count || 0) / 1000)}K views`,
        uploadDate: videoInfo.upload_date || null,
        channelId: videoInfo.channel_id || videoInfo.uploader_id || null,
        channelName: videoInfo.channel || videoInfo.uploader || null,
        channelUrl: videoInfo.channel_url || null,
        formats: videoInfo.formats.map(format => ({
          format_id: format.format_id,
          format: format.format,
          quality: format.quality || "unknown",
          ext: format.ext,
          resolution: format.resolution,
          filesize: format.filesize,
          filesize_approx: format.filesize_approx
        }))
      };

      // Store the video info for later use
      storage.storeVideoInfo(formattedInfo);

      res.json(formattedInfo);
    } catch (error) {
      console.error("Error fetching video info:", error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to fetch video information" 
      });
    }
  });

  // API route to download video
  app.post("/api/videos/download", async (req, res) => {
    try {
      const { videoId, formatId, downloadLocation, uploadDate, channelId, channelName } = req.body;
      
      if (!videoId || !formatId) {
        return res.status(400).json({ error: "Video ID and format ID are required" });
      }

      // Get video info from storage
      const videoInfo = await storage.getVideoInfo(videoId);
      
      if (!videoInfo) {
        return res.status(404).json({ error: "Video information not found" });
      }

      // Generate a unique download ID
      const downloadId = nanoid();
      
      // Always use the temp directory for the initial download and processing
      const timestamp = Date.now();
      const tempDownloadPath = path.join(tempDir, `${videoId}-${formatId}-${timestamp}.mp4`);
      
      // Store the user's desired final location, if provided
      const finalDownloadLocation = downloadLocation && downloadLocation.trim() !== "" 
        ? downloadLocation.trim()
        : null;
      
      console.log(`Starting download process for ${videoId} with format ${formatId}`);
      console.log(`Temporary download path: ${tempDownloadPath}`);
      if (finalDownloadLocation) {
        console.log(`User requested final location: ${finalDownloadLocation}`);
      }
      
      // Initialize download tracking
      activeDownloads.set(downloadId, {
        percent: 0,
        downloadPath: tempDownloadPath, 
        finalLocation: finalDownloadLocation, 
        videoId,
        uploadDate: uploadDate || videoInfo.uploadDate || null,
        channelId: channelId || videoInfo.channelId || null,
        channelName: channelName || videoInfo.channelName || null,
        isComplete: false,
      });

      // Start the download process
      downloadYouTubeVideo(
        videoId, 
        formatId, 
        // Always download to the temp path
        tempDownloadPath,
        (progress) => {
          // Update the download progress
          const download = activeDownloads.get(downloadId);
          if (download && !download.isComplete) { // Only update progress if not fully complete
            console.log(`Download ${downloadId} progress: ${progress.percent}%`);
            
            let adjustedPercent = progress.percent;
            if (progress.percent === 100) {
              adjustedPercent = 90;
              console.log(`Download finished, merging audio/video. Display progress: ${adjustedPercent}%`);
            } else if (progress.percent > 0) {
              adjustedPercent = Math.floor(progress.percent * 0.9);
            }
            
            activeDownloads.set(downloadId, {
              ...download,
              percent: adjustedPercent
            });
          }
        }
      )
      .then(async () => {
        // This is called after the entire process is complete (download + ffmpeg merging)
        console.log(`Download ${downloadId} (ffmpeg processing) complete.`);
        
        const download = activeDownloads.get(downloadId);
        if (!download) {
          console.error(`Download ${downloadId} not found after completion.`);
          return; 
        }

        // Check if the temp file exists and is valid before proceeding
        if (!fs.existsSync(tempDownloadPath)) {
          console.error(`Temp file missing after download completion: ${tempDownloadPath}`);
          throw new Error("Temporary download file was not created properly.");
        }
        const stats = fs.statSync(tempDownloadPath);
        if (stats.size === 0) {
          console.error(`Temp file is empty after download completion: ${tempDownloadPath}`);
          throw new Error("Temporary download file is empty.");
        }
        console.log(`Temp file validated: ${tempDownloadPath}, size: ${stats.size} bytes`);

        let finalPath = tempDownloadPath; // Assume final path is temp unless moved

        // --- Move file if custom location is set ---
        if (download.finalLocation) {
          console.log(`Attempting to move file to custom location: ${download.finalLocation}`);
          try {
            const videoInfo = await storage.getVideoInfo(download.videoId);
            
            const title = videoInfo?.title || `youtube-video-${download.videoId}`;
            const safeFileName = `${datedBaseName(title, download.uploadDate)}.mp4`;
            
            const targetDir = path.resolve(download.finalLocation, channelFolderName(download.channelName));
            const destinationPath = path.join(targetDir, safeFileName);
            const destinationAudioPath = replaceExtension(destinationPath, ".m4a");
            
            // Ensure target directory exists
            if (!fs.existsSync(targetDir)) {
              console.log(`Creating target directory: ${targetDir}`);
              fs.mkdirSync(targetDir, { recursive: true });
            }
            
            // Copy + delete (works across different drives/devices)
            console.log(`Moving file from ${tempDownloadPath} to ${destinationPath}`);
            fs.copyFileSync(tempDownloadPath, destinationPath);
            fs.unlinkSync(tempDownloadPath);
            console.log(`Successfully moved file to ${destinationPath}`);

            if (pipeline.getConfig().processing.keepAudio && !fs.existsSync(destinationAudioPath)) {
              await copyAudioTrack(destinationPath, destinationAudioPath);
            }

            const existingEntry = getQueueEntryByVideoId(download.videoId);
            // Prefer the readable channel name (yt-dlp's `channel` field,
            // e.g. "Rick Joyner") over the UC... id so the Library shows
            // the human-friendly name and matches the on-disk folder
            // (which is already named via channelFolderName(channelName)
            // above). Manual one-off downloads don't create a channels
            // row, so the channel_id IS the only signal the UI has.
            const dbChannelId = existingEntry?.channel_id
              || (download.channelName ? String(download.channelName) : null)
              || download.channelId
              || "manual";
            enqueueVideo({
              videoId: download.videoId,
              channelId: dbChannelId,
              title,
              url: `https://www.youtube.com/watch?v=${download.videoId}`,
              duration: null,
              isLive: false,
              isShorts: false,
              uploadDate: download.uploadDate || null,
            });
            updateQueueStatus(download.videoId, dbChannelId, {
              status: "complete",
              videoPath: destinationPath,
              error: null,
            });
            
            // Update the final path
            finalPath = destinationPath;
            
          } catch (moveError) {
            console.error(`Failed to move file to ${download.finalLocation}:`, moveError);
            // If move fails, keep the file in the temp directory and update the state
            // The user will have to download it via the browser
            finalPath = tempDownloadPath; 
            // Potentially update the state with an error message for the client?
            // For now, just log it and proceed with temp path.
          }
        }
        // --- End move file logic ---
        
        // Update the download state to 100% and mark as fully complete
        // Also update the downloadPath to the final location (temp or custom)
        activeDownloads.set(downloadId, {
          ...download,
          percent: 100,
          downloadPath: finalPath, // Reflect the actual final location
          isComplete: true,
        });
        console.log(`Download ${downloadId} fully complete. Final path: ${finalPath}`);
        
      })
      .catch(error => {
        console.error(`Download ${downloadId} failed:`, error);
        
        // Set progress to -1 to indicate error
        const download = activeDownloads.get(downloadId);
        if (download) {
          activeDownloads.set(downloadId, {
            ...download,
            percent: -1, // Indicate error
            isComplete: true, // Mark as complete (though failed)
          });
        }
      });

      res.json({ downloadId });
    } catch (error) {
      console.error("Error starting download:", error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : "Failed to start download" 
      });
    }
  });

  // API route to get download progress
  app.get("/api/videos/download-progress/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    
    console.log(`Progress tracking started for download: ${downloadId}`);
    
    // Set up headers for SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    // Check if download exists initially
    const initialDownload = activeDownloads.get(downloadId);
    if (!initialDownload) {
      console.error(`Download ${downloadId} not found when starting progress tracking`);
      res.write(`data: ${JSON.stringify({ error: "Download not found", percent: 0 })}\n\n`);
      return res.end();
    }
    
    // Function to send progress updates
    const sendProgress = () => {
      const download = activeDownloads.get(downloadId);
      
      if (!download) {
        console.error(`Download ${downloadId} was lost during progress tracking`);
        clearInterval(interval);
        res.write(`data: ${JSON.stringify({ error: "Download was lost during processing", percent: 0 })}\n\n`);
        return res.end();
      }
      
      // Send the current progress
      res.write(`data: ${JSON.stringify({ percent: download.percent })}\n\n`);
      
      // If download is complete, check the file and end connection
      if (download.isComplete) { // Use the isComplete flag
        clearInterval(interval);
        console.log(`Download ${downloadId} processing complete. Final path: ${download.downloadPath}`);
        
        // Check if the final file actually exists at the expected location
        if (!fs.existsSync(download.downloadPath)) {
          console.error(`Final download file missing at completion: ${download.downloadPath}`);
          // Send error status to client
          res.write(`data: ${JSON.stringify({ 
            error: "Download file was not created properly or failed to move",
            percent: -1, // Indicate error
            completed: true
          })}

`);
          return res.end();
        }
        
        // Check if the final file has content
        try {
          const stats = fs.statSync(download.downloadPath);
          if (stats.size === 0) {
            console.error(`Final download file is empty: ${download.downloadPath}`);
            res.write(`data: ${JSON.stringify({ 
              error: "Download file is empty",
              percent: -1, // Indicate error
              completed: true
            })}

`);
            return res.end();
          }
          console.log(`Final download file validated: ${download.downloadPath}, size: ${stats.size} bytes`);
        } catch (error) {
          console.error(`Error checking final file stats: ${error}`);
          res.write(`data: ${JSON.stringify({ 
            error: "Error validating final file",
            percent: -1, // Indicate error
            completed: true
          })}

`);
          return res.end();
        }
        
        // Get the file name for the download (based on final path)
        const finalFileName = path.basename(download.downloadPath);
        
        // Determine if the file was saved to a custom location
        const savedToCustomLocation = download.finalLocation && download.downloadPath.startsWith(path.resolve(download.finalLocation));
        
        console.log(`Sending completion event for ${downloadId}: filename=${finalFileName}, customLocation=${savedToCustomLocation}`);
            
        // Send final event with download complete status and final path info
        res.write(`data: ${JSON.stringify({ 
          percent: 100, 
          fileName: finalFileName,
          finalPath: download.downloadPath, // Send the actual final path
          savedToCustom: savedToCustomLocation,
          completed: true 
        })}

`);
            
        res.end();
          
        // Keep the download info for a while to allow browser download if needed
        setTimeout(() => {
          console.log(`Cleaning up download ${downloadId} from active downloads map`);
          activeDownloads.delete(downloadId);
        }, 5 * 60 * 1000); // Keep for 5 minutes 
          
        return; // Stop sending updates
      }
    };
    
    // Send progress every second
    const interval = setInterval(sendProgress, 1000);
    sendProgress(); // Send initial progress
    
    // Clean up on client disconnect
    req.on("close", () => {
      console.log(`Client disconnected from progress updates for ${downloadId}`);
      clearInterval(interval);
    });
  });

  // API route to serve downloaded file
  app.get("/api/videos/download/:downloadId", (req, res) => {
    const { downloadId } = req.params;
    console.log(`Download request received for ID: ${downloadId}`);
    
    // First, check if this is a HEAD request (for checking if the file exists)
    const isHeadRequest = req.method === 'HEAD';
    console.log(`Request type: ${req.method}`);
    
    // Make sure we have a download with this ID
    const download = activeDownloads.get(downloadId);
    if (!download) {
      console.error(`Download ID not found: ${downloadId}`);
      return res.status(404).json({ error: "Download not found" });
    }
    
    console.log(`Download found with path: ${download.downloadPath}`);
    
    // Check if the file actually exists
    if (!fs.existsSync(download.downloadPath)) {
      console.error(`File not found at path: ${download.downloadPath}`);
      return res.status(404).json({ error: "Download file not found on server" });
    }
    
    // Get file size to check if it's a valid file
    let stats;
    try {
      stats = fs.statSync(download.downloadPath);
      if (stats.size === 0) {
        console.error(`Empty file found: ${download.downloadPath}`);
        return res.status(500).json({ error: "Downloaded file is empty" });
      }
      console.log(`File exists with size: ${stats.size} bytes`);
    } catch (error) {
      console.error(`Error checking file stats: ${error}`);
      return res.status(500).json({ error: "Error accessing file" });
    }
    
    // For HEAD requests, we just need to respond with a success status
    if (isHeadRequest) {
      console.log(`HEAD request successful for: ${downloadId}`);
      return res.status(200).end();
    }
    
    // Check if file is in a custom location (not in temp directory)
    const isCustomLocation = !download.downloadPath.startsWith(tempDir);
    
    // For GET requests, if it's in a custom location, just respond with success
    // since the file is already in the user's desired location
    if (isCustomLocation) {
      console.log(`File is in custom location: ${download.downloadPath}. No need to download.`);
      return res.status(200).json({ 
        message: "File saved to your specified location", 
        path: download.downloadPath,
        alreadySaved: true
      });
    }
    
    // Otherwise serve the file as usual for files in the temp directory
    console.log(`Serving file: ${download.downloadPath}, size: ${stats.size} bytes`);
    
    // Get video info to determine filename
        storage.getVideoInfo(download.videoId)
      .then(videoInfo => {
        let fileName = `youtube-video-${download.videoId}.mp4`;
        if (videoInfo && videoInfo.title) {
          fileName = `${datedBaseName(videoInfo.title, download.uploadDate)}.mp4`;
        }
        
        console.log(`Using filename: ${fileName} for download`);
        
        // Set headers for file download
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Length", stats.size);
        
        // Create a read stream for the file
        try {
          const fileStream = fs.createReadStream(download.downloadPath);
          
          // Handle errors during streaming
          fileStream.on('error', (err) => {
            console.error(`Error streaming file: ${err.message}`);
            if (!res.headersSent) {
              res.status(500).json({ error: "Error streaming file" });
            } else {
              res.end();
            }
          });
          
          // Track bytes sent
          let bytesSent = 0;
          fileStream.on('data', (chunk) => {
            bytesSent += chunk.length;
            // Log progress for large files
            if (stats.size > 10 * 1024 * 1024 && bytesSent % (5 * 1024 * 1024) === 0) { // log every 5MB
              console.log(`Download progress: ${Math.round((bytesSent / stats.size) * 100)}%`);
            }
          });
          
          // Pipe the file to the response
          fileStream.pipe(res);
          
          // Delete file and clean up after sending
          fileStream.on("end", () => {
            console.log(`Finished streaming file: ${download.downloadPath}`);
            // Use setTimeout to ensure file is fully sent before deletion
            setTimeout(() => {
              try {
                if (fs.existsSync(download.downloadPath)) {
                  fs.unlinkSync(download.downloadPath);
                  console.log(`Deleted file: ${download.downloadPath}`);
                }
              } catch (error) {
                console.error("Error cleaning up download:", error);
              }
            }, 2000); // Wait longer before deleting
          });
          
          // Even if the download finishes successfully, keep the download info in the map for a while
          // This helps if the browser makes a second request or if the first attempt fails
          setTimeout(() => {
            console.log(`Removing download ${downloadId} from active downloads`);
            activeDownloads.delete(downloadId);
          }, 60000); // Keep for 1 minute after serving successfully
        } catch (error) {
          console.error(`Error creating file stream: ${error}`);
          return res.status(500).json({ error: "Could not read the file" });
        }
      })
      .catch(error => {
        console.error("Error serving download:", error);
        return res.status(500).json({ error: "Failed to prepare download" });
      });
  });

  // ============================================
  // Pipeline API Routes
  // ============================================

  const pipeline = getPipeline();

  // Get pipeline state
  // ---- System / status / config / dialog ----
  // /api/pipeline/status, /api/status, /api/pipeline/config (get+post),
  // /api/pipeline/ytdlp-health, /api/system/*, /api/dialog/pick-folder
  // — all registered in routes-system.ts.
  registerSystemRoutes(app, pipeline, httpServer);

  // ---- LLM (config, status, embeddings reindex, summaries, semantic
  // search, models proxy) ---- registered in routes-llm.ts.
  registerLlmRoutes(app, pipeline);

  // ---- AI chat (RAG over the archive) ----
  // /api/chat/* + /api/llm/ask registered in routes-chat.ts.
  registerChatRoutes(app, pipeline);

  // Start pipeline
  app.post("/api/pipeline/start", (_req, res) => {
    pipeline.start();
    res.json({ success: true, status: pipeline.getState().status });
  });

  // Stop pipeline
  app.post("/api/pipeline/stop", (_req, res) => {
    pipeline.stop();
    res.json({ success: true, status: pipeline.getState().status });
  });

  // Trigger immediate channel check
  app.post("/api/pipeline/check-now", async (_req, res) => {
    try {
      const result = await pipeline.checkNow();
      res.json({ success: true, message: "Check complete. New videos were queued but downloads were not started.", ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Check failed" });
    }
  });

  // Process a single video through the pipeline (for manual transcription)
  app.post("/api/pipeline/process", async (req, res) => {
    try {
      const { url, quality } = req.body;
      if (!url) {
        return res.status(400).json({ error: "URL is required" });
      }

      // Respond immediately — job runs in background with SSE progress
      res.json({ accepted: true, message: "Processing started" });

      // Run in background
      try {
        await pipeline.processSingleVideo(url, quality);
      } catch (error) {
        console.error("[pipeline] Manual process failed:", error);
      }
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to process video"
      });
    }
  });

  // SSE endpoint for pipeline events
  app.get("/api/pipeline/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const onStateChange = () => {
      res.write(`event: state\ndata: ${JSON.stringify(pipeline.getState())}\n\n`);
    };

    const onJobUpdate = (job: any) => {
      res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    };

    pipeline.on("jobStarted", onJobUpdate);
    pipeline.on("jobUpdated", onJobUpdate);
    pipeline.on("jobComplete", onJobUpdate);
    pipeline.on("jobError", onJobUpdate);
    pipeline.on("checkComplete", onStateChange);
    pipeline.on("configChanged", onStateChange);

    // Send initial state
    res.write(`event: state\ndata: ${JSON.stringify(pipeline.getState())}\n\n`);

    req.on("close", () => {
      pipeline.off("jobStarted", onJobUpdate);
      pipeline.off("jobUpdated", onJobUpdate);
      pipeline.off("jobComplete", onJobUpdate);
      pipeline.off("jobError", onJobUpdate);
      pipeline.off("checkComplete", onStateChange);
      pipeline.off("configChanged", onStateChange);
    });
  });

  // Serve transcript files
  app.get("/api/pipeline/transcripts", (_req, res) => {
    const config = pipeline.getConfig();
    const transcriptDir = config.transcriptDir;

    try {
      if (!fs.existsSync(transcriptDir)) {
        return res.json([]);
      }

      const files = fs.readdirSync(transcriptDir)
        .filter(f => f.endsWith(".md") || f.endsWith(".json"))
        .map(f => ({
          name: f,
          path: path.join(transcriptDir, f),
          size: fs.statSync(path.join(transcriptDir, f)).size,
          modified: fs.statSync(path.join(transcriptDir, f)).mtime.toISOString(),
        }))
        .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

      res.json(files);
    } catch (error) {
      res.status(500).json({ error: "Failed to list transcripts" });
    }
  });

  // Serve a specific transcript file
  app.get("/api/pipeline/transcripts/:filename", (req, res) => {
    const config = pipeline.getConfig();
    const filePath = path.join(config.transcriptDir, req.params.filename);

    // Security: ensure the file is within the transcript directory
    const resolved = path.resolve(filePath);
    const resolvedDir = path.resolve(config.transcriptDir);
    if (!resolved.startsWith(resolvedDir)) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(fs.readFileSync(filePath, "utf-8"));
  });

  // Add channel to monitor
  app.post("/api/pipeline/channels", (req, res) => {
    try {
      const { name, url, diarize } = req.body;
      if (!name || !url) {
        return res.status(400).json({ error: "Name and URL are required" });
      }

      const config = pipeline.getConfig();
      const newChannel = {
        id: `ch-${Date.now()}`,
        name,
        url,
        enabled: true,
        diarize: diarize === false ? false : true,
      };

      config.channels.push(newChannel);
      pipeline.updateConfig(config);

      res.json({ success: true, channel: newChannel });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to add channel" });
    }
  });

  // Remove channel
  app.delete("/api/pipeline/channels/:channelId", (req, res) => {
    const config = pipeline.getConfig();
    const idx = config.channels.findIndex(c => c.id === req.params.channelId);
    if (idx === -1) {
      return res.status(404).json({ error: "Channel not found" });
    }

    config.channels.splice(idx, 1);
    pipeline.updateConfig(config);
    res.json({ success: true });
  });

  // Toggle channel enabled / diarize state
  app.patch("/api/pipeline/channels/:channelId", (req, res) => {
    const config = pipeline.getConfig();
    const channel = config.channels.find(c => c.id === req.params.channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    if (req.body.enabled !== undefined) channel.enabled = req.body.enabled;
    if (req.body.diarize !== undefined) channel.diarize = !!req.body.diarize;
    if (req.body.include_shorts !== undefined) channel.include_shorts = !!req.body.include_shorts;
    if (typeof req.body.name === "string" && req.body.name.trim()) {
      // The folder on disk uses the OLD name as its name. We don't move
      // the folder here because every video's video_path is absolute —
      // the path keeps working regardless of channel display name. New
      // videos go to a folder built from the new name, which can create
      // a second folder for the channel; the user can manually merge
      // those if they care, but functionally everything resolves fine.
      channel.name = req.body.name.trim();
    }
    pipeline.updateConfig(config);
    res.json({ success: true, channel });
  });

  /**
   * Scan a channel's local save folder for video files not yet tracked
   * in video_queue, and queue them as local-import entries. Use case:
   * user has a manually-downloaded video sitting in the channel folder
   * that should be indexed/transcribed alongside the rest.
   *
   * The channel's expected folder is
   *   `<videoSaveDir>/<channelFolderName(channel.name)>/`
   * Anything that isn't already in video_queue (by path match) gets a
   * fresh local-* video_id and a "pending" status; the pipeline picks
   * them up on its next run like any other queued entry.
   */
  app.post("/api/pipeline/channels/:channelId/import-folder", (req, res) => {
    try {
      const config = pipeline.getConfig();
      const configured = config.channels.find(c => c.id === req.params.channelId);

      // Fall back to treating channelId itself as the channel name when no
      // channels-table row exists. This covers "virtual" channels created
      // by one-off manual downloads: the user never explicitly subscribed
      // to the channel, but they have a folder of files under their
      // name and want this scanner to pick up additional local copies.
      const channelIdKey = configured?.id ?? req.params.channelId;
      const channelName = configured?.name ?? req.params.channelId;

      const channelFolder = channelFolderName(channelName);
      const folder = path.join(config.videoSaveDir, channelFolder);
      if (!fs.existsSync(folder)) {
        return res.status(404).json({ error: `Channel folder not found: ${folder}` });
      }

      // Pull existing paths once so the per-file lookup is in-memory.
      const existing = new Set<string>(
        (getDb()
          .prepare("SELECT video_path FROM video_queue WHERE channel_id = ? AND video_path IS NOT NULL AND video_path <> ''")
          .all(channelIdKey) as { video_path: string }[])
          .map(r => r.video_path),
      );

      // Filter passes:
      //   1. Skip dotfiles and non-media extensions.
      //   2. Skip our own derivative files: <stem>.playback.<ext>
      //      (browser-friendly AAC sidecar) and <stem>.vp9.bak (rollback
      //      file from the VP9→H.264 transcode script).
      //   3. Skip audio files whose stem matches an existing video file
      //      in the same folder — that's a keepAudio sidecar
      //      (<videoStem>.m4a alongside <videoStem>.mp4), not a
      //      standalone audio item the user wants to import.
      const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v"]);
      const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".flac", ".aac", ".opus", ".ogg"]);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(folder, { withFileTypes: true });
      } catch (err) {
        return res.status(500).json({ error: `Read folder failed: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Two-pass: first collect every video-file stem we'll see so the
      // audio-pass can skip any with a matching video sibling.
      const videoStems = new Set<string>();
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith(".")) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        const stem = path.basename(e.name, ext);
        if (stem.toLowerCase().endsWith(".playback")) continue;
        if (stem.toLowerCase().endsWith(".vp9.bak")) continue;
        videoStems.add(stem);
      }

      const found: string[] = [];
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith(".")) continue;
        const ext = path.extname(e.name).toLowerCase();
        const stem = path.basename(e.name, ext);
        const stemLower = stem.toLowerCase();
        if (stemLower.endsWith(".playback")) continue;
        if (stemLower.endsWith(".vp9.bak")) continue;
        if (VIDEO_EXTS.has(ext)) {
          // pass
        } else if (AUDIO_EXTS.has(ext)) {
          // Skip if there's a video with the same stem (it's a sidecar,
          // not a standalone item).
          if (videoStems.has(stem)) continue;
        } else {
          continue;
        }
        const full = path.join(folder, e.name);
        if (existing.has(full)) continue;
        found.push(full);
      }

      const added: { videoId: string; title: string; videoPath: string }[] = [];
      const skipped: { videoPath: string; reason: string }[] = [];
      for (const full of found) {
        const stem = path.basename(full, path.extname(full));
        // Filename pattern is `YYYY-MM-DD - Title` (datedBaseName output).
        // Strip the prefix when present; fall back to the bare stem.
        const dateMatch = stem.match(/^(\d{4})-(\d{2})-(\d{2})\s+-\s+(.+)$/);
        const uploadDate = dateMatch ? `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}` : null;
        const title = dateMatch ? dateMatch[4].replace(/_/g, " ") : stem;

        // Stable id derived from the absolute path; same scheme as
        // local-folder channels so a path-based dedup still works.
        const hash = crypto.createHash("sha256").update(full).digest("hex");
        const videoId = `local-${hash.substring(0, 11)}`;

        const inserted = enqueueVideo({
          videoId,
          channelId: channelIdKey,
          title,
          url: `file://${full}`,
          duration: null,
          isLive: false,
          isShorts: false,
          uploadDate,
        });
        if (!inserted) {
          skipped.push({ videoPath: full, reason: "Already queued under this id" });
          continue;
        }
        updateQueueStatus(videoId, channelIdKey, { videoPath: full });
        added.push({ videoId, title, videoPath: full });
      }

      res.json({
        ok: true,
        folder,
        scanned: found.length,
        added: added.length,
        skipped: skipped.length,
        details: { added, skipped },
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Import folder failed" });
    }
  });

  /**
   * "Virtual" channels: distinct channel_id values present in
   * video_queue that don't correspond to a row in the configured
   * channels list. These appear when a user does a one-off manual
   * download of a video — the download flow stamps the readable
   * channel name (e.g. "Rick Joyner") into video_queue.channel_id
   * without creating a channels row (which would have triggered
   * auto-archive of the whole channel).
   *
   * The UI uses this to surface those channels alongside the
   * configured ones so Rename / Import-folder actions are still
   * reachable. Each row carries a video count + a representative
   * video_path so the UI can sanity-check the folder location.
   */
  app.get("/api/pipeline/channels/virtual", (_req, res) => {
    try {
      const configuredIds = new Set(pipeline.getConfig().channels.map(c => c.id));
      const rows = getDb()
        .prepare(`
          SELECT channel_id, COUNT(*) AS video_count
          FROM video_queue
          GROUP BY channel_id
        `)
        .all() as { channel_id: string; video_count: number }[];
      const virtual = rows
        .filter(r => !configuredIds.has(r.channel_id))
        .map(r => ({ channelId: r.channel_id, videoCount: r.video_count }))
        .sort((a, b) => b.videoCount - a.videoCount);
      res.json({ channels: virtual });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Virtual channel list failed" });
    }
  });

  /**
   * Rename a virtual channel — UPDATEs video_queue rows referencing the
   * old channel_id string. Unlike the configured-channel PATCH at
   * /api/pipeline/channels/:id which edits the channels-table row,
   * virtual channels only exist as a string in video_queue, so the
   * rename is purely a SQL UPDATE. Used to fix the UC... → "Rick
   * Joyner" case after a manual download captured the wrong identifier.
   */
  app.patch("/api/pipeline/channels/virtual/:channelId", (req, res) => {
    try {
      const oldId = req.params.channelId;
      const newName = (req.body?.name ?? "").toString().trim();
      if (!newName) return res.status(400).json({ error: "name required" });
      if (newName === oldId) return res.json({ ok: true, updated: 0 });

      const configuredIds = new Set(pipeline.getConfig().channels.map(c => c.id));
      if (configuredIds.has(oldId)) {
        return res.status(400).json({ error: "Use /api/pipeline/channels/:id PATCH for configured channels" });
      }

      const r = getDb()
        .prepare("UPDATE video_queue SET channel_id = ? WHERE channel_id = ?")
        .run(newName, oldId);
      res.json({ ok: true, updated: r.changes });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Virtual channel rename failed" });
    }
  });

  // Re-transcribe a video with an optional different model
  app.post("/api/pipeline/retranscribe", async (req, res) => {
    try {
      const { videoId, channelId, model } = req.body;
      if (!videoId || !channelId) {
        return res.status(400).json({ error: "videoId and channelId required" });
      }
      const job = await pipeline.retranscribeVideo(videoId, channelId, model);
      res.json(job);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Re-transcribe failed" });
    }
  });

  // Transcribe an already-downloaded video file
  app.post("/api/pipeline/transcribe-file", async (req, res) => {
    try {
      const { filePath, title, uploadDate, videoId, channelId, channelName } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: "filePath required" });
      }

      res.json({ accepted: true, message: "Transcription started" });

      try {
        await pipeline.processDownloadedFile(filePath, title || path.basename(filePath), uploadDate, videoId, channelId, channelName);
      } catch (error) {
        console.error("[pipeline] Transcribe-file failed:", error);
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Transcription failed" });
    }
  });

  // Full scan a channel — scan ALL videos and enqueue missing records
  app.post("/api/pipeline/archive/:channelId", async (req, res) => {
    try {
      const result = await pipeline.archiveChannel(req.params.channelId);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Archive failed" });
    }
  });

  // Search transcript segments across indexed markdown/json transcript files
  app.get("/api/transcripts/search", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const query = String(req.query.q || "");
      const liveFilter = String(req.query.type || "all");
      const tagsParam = typeof req.query.tags === "string" ? req.query.tags : "";
      const tags = tagsParam.split(",").map(t => t.trim()).filter(Boolean);
      const speakerIdParam = typeof req.query.speakerId === "string" && req.query.speakerId ? req.query.speakerId : undefined;
      const results = searchTranscriptSegments(query, {
        channelId: String(req.query.channelId || "all"),
        status: String(req.query.status || "complete"),
        isLive: liveFilter === "live" ? true : liveFilter === "video" ? false : undefined,
        dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : undefined,
        dateTo: req.query.dateTo ? String(req.query.dateTo) : undefined,
        tags,
        speakerId: speakerIdParam,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      });
      res.json({ results, index: getTranscriptSearchIndexStats() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Transcript search failed" });
    }
  });

  // ---- Speakers (cross-video voice identity) ----
  // /api/speakers/* registered in routes-speakers.ts.
  registerSpeakerRoutes(app);

  // Library badge data — speakers identified in a single video, ordered by airtime.
  app.get("/api/videos/library/:channelId/:videoId/speakers",
    (req: Request<{ channelId: string; videoId: string }>, res) => {
      res.json({ speakers: getVideoSpeakerSummary(req.params.videoId, req.params.channelId) });
    });

  // Batched per-video speaker summary for the Library list. POST so the
  // request body can carry the (potentially long) list of (video_id, channel_id)
  // pairs without hitting URL length limits.
  app.post("/api/videos/library/speakers-batch", (req, res) => {
    try {
      const items = Array.isArray(req.body?.videos) ? req.body.videos : [];
      const pairs = items
        .map((v: any) => ({ video_id: String(v?.videoId || ""), channel_id: String(v?.channelId || "") }))
        .filter((p: any) => p.video_id && p.channel_id);
      res.json({ speakers: getVideoSpeakerSummariesBatch(pairs) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // Force-refresh the local transcript search index
  app.post("/api/transcripts/search/reindex", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, ...refreshTranscriptSearchIndex() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Transcript reindex failed" });
    }
  });

  app.get("/api/transcripts/search/stats", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(getTranscriptSearchIndexStats());
  });

  app.get("/api/videos/library/:channelId/:videoId/transcript", async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const entry = getQueueEntry(req.params.videoId, req.params.channelId);
      if (!entry) {
        return res.status(404).json({ error: "Video not found" });
      }

      // Probe the actual file for codec / resolution / size so the drawer
      // can show a "Decoder" badge. Best-effort — if probing fails for any
      // reason (file moved, codec unknown), the drawer just hides the badges.
      let video = null;
      if (entry.video_path && fs.existsSync(entry.video_path)) {
        try {
          video = await getVideoStreamInfo(entry.video_path);
        } catch {}
      }

      res.json({
        videoId: entry.video_id,
        channelId: entry.channel_id,
        segments: getTranscriptSegmentsForVideo(entry.video_id, entry.channel_id),
        notes: entry.notes ?? "",
        aiSummary: entry.ai_summary ?? "",
        aiSummaryModel: entry.ai_summary_model ?? null,
        video,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Transcript load failed" });
    }
  });

  /**
   * Rename the on-disk video file (and its transcript MD + .playback.m4a
   * sidecar) while keeping the DB linked. The user provides a new
   * basename (no path, no extension); the server preserves the existing
   * directory + extension. All related files are renamed atomically-ish:
   * if any rename fails partway through, attempts to roll back the ones
   * already moved so we don't leave a half-renamed state.
   */
  app.post(
    "/api/videos/library/:channelId/:videoId/rename",
    async (req: Request<{ channelId: string; videoId: string }, unknown, { newBasename?: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });

        const rawNewName = (req.body?.newBasename ?? "").trim();

        // Reject anything with a path separator, leading dot, or filesystem
        // metacharacters that would let the user climb out of the channel
        // folder or shadow hidden files. Length cap keeps Linux's 255-byte
        // filename limit safely far away (with room for extensions / suffixes).
        if (!rawNewName) return res.status(400).json({ error: "newBasename required" });
        if (rawNewName.length > 200) return res.status(400).json({ error: "Name too long (max 200 chars)" });
        if (/[\\\/]/.test(rawNewName)) return res.status(400).json({ error: "Name may not contain / or \\" });
        if (rawNewName.startsWith(".")) return res.status(400).json({ error: "Name may not start with ." });
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f]/.test(rawNewName)) return res.status(400).json({ error: "Name contains control characters" });

        // We need an existing on-disk video to rename — without one, the
        // request is meaningless.
        if (!entry.video_path) return res.status(400).json({ error: "Entry has no video_path" });
        if (!fs.existsSync(entry.video_path)) return res.status(404).json({ error: `Video file missing: ${entry.video_path}` });

        const videoDir = path.dirname(entry.video_path);
        const videoExt = path.extname(entry.video_path);
        const oldVideoStem = path.basename(entry.video_path, videoExt);

        // Refuse a no-op rename so we don't pretend to do work.
        if (oldVideoStem === rawNewName) {
          return res.status(400).json({ error: "New name matches existing name" });
        }

        const newVideoPath = path.join(videoDir, `${rawNewName}${videoExt}`);
        if (fs.existsSync(newVideoPath)) {
          return res.status(409).json({ error: `A file already exists at ${newVideoPath}` });
        }

        // Group all the files we want to move together so a failure on
        // any one rolls back the others. The transcript MD lives in its
        // own dir (transcriptDir/channelFolder) with the same stem as
        // the video; the playback sidecar (when present) lives in
        // entry.playback_path. The md_path stem must match the video
        // stem for naming downstream (datedBaseName collisions etc.),
        // so we keep them in sync.
        type Move = { from: string; to: string };
        const planned: Move[] = [{ from: entry.video_path, to: newVideoPath }];

        if (entry.md_path && fs.existsSync(entry.md_path)) {
          const mdDir = path.dirname(entry.md_path);
          const mdExt = path.extname(entry.md_path); // ".md"
          const newMdPath = path.join(mdDir, `${rawNewName}${mdExt}`);
          if (fs.existsSync(newMdPath)) {
            return res.status(409).json({ error: `Transcript already exists at ${newMdPath}` });
          }
          planned.push({ from: entry.md_path, to: newMdPath });
        }

        if (entry.playback_path && fs.existsSync(entry.playback_path)) {
          const pbDir = path.dirname(entry.playback_path);
          // Playback sidecars are conventionally `<videoStem>.playback.m4a`
          // (see encodeAacSidecar) — preserve that pattern by reading the
          // existing basename and substituting the stem.
          const pbBase = path.basename(entry.playback_path);
          const stripStem = pbBase.startsWith(oldVideoStem) ? pbBase.slice(oldVideoStem.length) : pbBase;
          const newPlaybackPath = path.join(pbDir, `${rawNewName}${stripStem}`);
          if (fs.existsSync(newPlaybackPath)) {
            return res.status(409).json({ error: `Sidecar already exists at ${newPlaybackPath}` });
          }
          planned.push({ from: entry.playback_path, to: newPlaybackPath });
        }

        const completed: Move[] = [];
        try {
          for (const move of planned) {
            fs.renameSync(move.from, move.to);
            completed.push(move);
          }
        } catch (renameErr) {
          // Roll back: rename completed moves back to their originals.
          for (const m of completed.reverse()) {
            try { fs.renameSync(m.to, m.from); } catch { /* best effort */ }
          }
          const msg = renameErr instanceof Error ? renameErr.message : String(renameErr);
          return res.status(500).json({ error: `Rename failed and rolled back: ${msg}` });
        }

        // Sync the DB to the new paths. Pull the planned moves back out
        // by index so we know which entry corresponds to which column.
        const updates: { videoPath?: string; mdPath?: string; playbackPath?: string } = {};
        updates.videoPath = planned[0].to;
        let nextIdx = 1;
        if (entry.md_path && fs.existsSync(planned[nextIdx]?.to ?? "")) {
          updates.mdPath = planned[nextIdx].to;
          nextIdx++;
        }
        if (entry.playback_path && planned[nextIdx]) {
          updates.playbackPath = planned[nextIdx].to;
        }
        updateQueueStatus(entry.video_id, entry.channel_id, updates);

        res.json({
          ok: true,
          videoPath: updates.videoPath,
          mdPath: updates.mdPath,
          playbackPath: updates.playbackPath,
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Rename failed" });
      }
    },
  );

  /**
   * List entries whose video_path no longer points at a file on disk
   * (orphans). Most common cause: user renamed the file outside the app.
   * Each returned row carries enough info for the UI to either re-link
   * to a new path or forget the row entirely. Heavy-ish for huge
   * libraries because we stat every row — paginate on the client if
   * that's ever a problem.
   */
  app.get("/api/videos/library/orphans", (_req, res) => {
    try {
      const rows = getDb()
        .prepare(`SELECT * FROM video_queue
                  WHERE video_path IS NOT NULL AND video_path <> ''`)
        .all() as QueueEntry[];
      const orphans = rows
        .filter((r) => r.video_path && !fs.existsSync(r.video_path))
        .map((r) => ({
          videoId: r.video_id,
          channelId: r.channel_id,
          title: r.title,
          uploadDate: r.upload_date,
          videoPath: r.video_path,
          mdPath: r.md_path,
          mdExists: !!r.md_path && fs.existsSync(r.md_path),
          status: r.status,
          wordCount: r.word_count,
        }));
      res.json({ orphans, total: orphans.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Orphan scan failed" });
    }
  });

  /**
   * Re-link an orphan to a renamed/moved file. The user provides the new
   * absolute path; we verify the file exists, then update video_path on
   * the queue row. We do NOT touch md_path or playback_path here because
   * those are independent — the transcript MD likely still exists at its
   * original path; the playback sidecar is regenerated on demand from
   * the stream endpoint if missing.
   */
  app.post(
    "/api/videos/library/:channelId/:videoId/relink",
    (req: Request<{ channelId: string; videoId: string }, unknown, { newVideoPath?: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });

        const newVideoPath = (req.body?.newVideoPath ?? "").trim();
        if (!newVideoPath) return res.status(400).json({ error: "newVideoPath required" });
        if (!path.isAbsolute(newVideoPath)) return res.status(400).json({ error: "Path must be absolute" });
        if (!fs.existsSync(newVideoPath)) return res.status(404).json({ error: `File does not exist: ${newVideoPath}` });

        const stat = fs.statSync(newVideoPath);
        if (!stat.isFile()) return res.status(400).json({ error: "Path is not a regular file" });

        updateQueueStatus(entry.video_id, entry.channel_id, { videoPath: newVideoPath });
        res.json({ ok: true, videoPath: newVideoPath });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Relink failed" });
      }
    },
  );

  /**
   * Remove an entry from the library entirely — DELETE FROM video_queue.
   * Used for orphans the user has decided are unrecoverable. Does NOT
   * cascade to notes / clips / vec_segments — those rows still reference
   * the videoId and would dangle. The UI calls this out before
   * confirming. Future work could offer a "forget + cascade" variant.
   */
  app.post(
    "/api/videos/library/:channelId/:videoId/forget",
    (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });
        getDb()
          .prepare("DELETE FROM video_queue WHERE video_id = ? AND channel_id = ?")
          .run(entry.video_id, entry.channel_id);
        res.json({ ok: true });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Forget failed" });
      }
    },
  );

  /**
   * Move the video file (+ transcript MD + .playback.m4a sidecar) to
   * the OS trash. Soft delete — restorable from the user's Trash UI.
   *
   * The DB row stays: video_path / md_path / playback_path are nulled
   * out and status flips to "archived", which keeps notes / clips /
   * transcripts linked to the same video_id for future research.
   *
   * Linux uses `gio trash` (freedesktop trash spec). macOS uses
   * AppleScript via Finder so the file lands in ~/.Trash with the
   * proper "Put Back" metadata.
   */
  app.post(
    "/api/videos/library/:channelId/:videoId/trash",
    async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry) return res.status(404).json({ error: "Video not found" });

        // Collect every file we're about to trash so the response can
        // tell the user exactly what moved.
        const targets: string[] = [];
        if (entry.video_path && fs.existsSync(entry.video_path)) targets.push(entry.video_path);
        if (entry.md_path && fs.existsSync(entry.md_path)) targets.push(entry.md_path);
        if (entry.playback_path && fs.existsSync(entry.playback_path)) targets.push(entry.playback_path);

        if (targets.length === 0) {
          return res.status(400).json({ error: "No files on disk to trash (entry already orphaned?)" });
        }

        const trashed: string[] = [];
        const failed: { path: string; error: string }[] = [];
        for (const target of targets) {
          try {
            await moveToTrash(target);
            trashed.push(target);
          } catch (err) {
            failed.push({ path: target, error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Even if one of the sidecars failed to trash, the main file
        // probably succeeded — clear those paths in the DB so the row
        // doesn't try to stream a non-existent file. The user can
        // manually clean up any leftovers via Files / Trash.
        const dbUpdate: { videoPath?: string | null; mdPath?: string | null; playbackPath?: string | null; status?: string } = {};
        if (entry.video_path && trashed.includes(entry.video_path)) dbUpdate.videoPath = null;
        if (entry.md_path && trashed.includes(entry.md_path)) dbUpdate.mdPath = null;
        if (entry.playback_path && trashed.includes(entry.playback_path)) dbUpdate.playbackPath = null;
        // Mark archived only if the main video actually made it to trash.
        if (entry.video_path && trashed.includes(entry.video_path)) {
          dbUpdate.status = "archived";
        }
        if (Object.keys(dbUpdate).length > 0) {
          updateQueueStatus(entry.video_id, entry.channel_id, dbUpdate);
        }

        if (failed.length > 0 && trashed.length === 0) {
          return res.status(500).json({ error: failed[0].error, failed });
        }
        res.json({ ok: true, trashed, failed });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Trash failed" });
      }
    },
  );

  app.get("/api/videos/library/:channelId/:videoId/stream", async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
    try {
      const entry = getQueueEntry(req.params.videoId, req.params.channelId);
      if (!entry?.video_path) {
        return res.status(404).json({ error: "Video file is not recorded in the library" });
      }

      // Prefer the browser-friendly playback sidecar when one exists (set
      // at ingestion for Ogg-Speex / Ogg-FLAC / other codecs Firefox can't
      // decode). Falls back to the original if the sidecar's missing on
      // disk (e.g. workingDir was cleaned).
      let sidecar = entry.playback_path ? path.resolve(entry.playback_path) : null;
      let usingSidecar = !!sidecar && fs.existsSync(sidecar);

      // Lazy fallback for entries that predate the playback-sidecar feature.
      // If the source is an extension Firefox / Safari may not decode (Ogg,
      // Opus standalone, etc.), generate a sidecar on first stream and save
      // the path so subsequent streams are instant. Sidecar lives next to
      // the source file; falls back to the app's working dir if the source
      // folder is read-only.
      const NEEDS_SIDECAR_EXTS = new Set([".ogg", ".oga", ".opus", ".flac", ".webm"]);
      const sourceExt = path.extname(entry.video_path).toLowerCase();
      if (!usingSidecar && NEEDS_SIDECAR_EXTS.has(sourceExt) && fs.existsSync(entry.video_path)) {
        const sourceStem = path.basename(entry.video_path, sourceExt);
        const beside = path.join(path.dirname(entry.video_path), `${sourceStem}.playback.m4a`);
        const cacheDir = path.join(pipeline.getConfig().workingDir, "playback-cache");
        const fallback = path.join(cacheDir, `${entry.video_id}.playback.m4a`);
        let sidecarPath: string | null = null;
        try {
          if (fs.existsSync(beside)) {
            sidecarPath = beside;
          } else {
            await encodeAacSidecar(entry.video_path, beside);
            sidecarPath = beside;
          }
        } catch (err) {
          console.warn(`[stream] Cannot write sidecar beside source for ${entry.video_id}; using ${fallback}:`, err);
          try {
            if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
            if (!fs.existsSync(fallback)) await encodeAacSidecar(entry.video_path, fallback);
            sidecarPath = fallback;
          } catch (err2) {
            console.error(`[stream] Sidecar fallback also failed for ${entry.video_id}:`, err2);
          }
        }
        if (sidecarPath) {
          updateQueueStatus(entry.video_id, entry.channel_id, { playbackPath: sidecarPath });
          sidecar = sidecarPath;
          usingSidecar = true;
        }
      }

      const videoPath = usingSidecar ? sidecar! : path.resolve(entry.video_path);
      if (!fs.existsSync(videoPath)) {
        return res.status(404).json({ error: "Video file not found on disk" });
      }

      const stat = fs.statSync(videoPath);
      const fileSize = stat.size;
      const ext = path.extname(videoPath).toLowerCase();
      const contentType =
        ext === ".webm" ? "video/webm" :
        ext === ".mkv" ? "video/x-matroska" :
        ext === ".m4v" ? "video/x-m4v" :
        ext === ".mp3" ? "audio/mpeg" :
        ext === ".m4a" ? "audio/mp4" :
        ext === ".wav" ? "audio/wav" :
        ext === ".flac" ? "audio/flac" :
        ext === ".aac" ? "audio/aac" :
        ext === ".opus" ? "audio/ogg" :
        ext === ".ogg" ? "audio/ogg" :
        "video/mp4";
      const range = req.headers.range;

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "no-store");

      if (!range) {
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": contentType,
        });
        fs.createReadStream(videoPath).pipe(res);
        return;
      }

      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
        return res.end();
      }

      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : fileSize - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= fileSize || end >= fileSize || start > end) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
        return res.end();
      }

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
      });
      fs.createReadStream(videoPath, { start, end }).pipe(res);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Video stream failed" });
    }
  });

  app.post(
    "/api/videos/library/:channelId/:videoId/export-segment",
    async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const entry = getQueueEntry(req.params.videoId, req.params.channelId);
        if (!entry?.video_path) {
          return res.status(404).json({ error: "Video file is not recorded in the library" });
        }

        const inputPath = path.resolve(entry.video_path);
        if (!fs.existsSync(inputPath)) {
          return res.status(404).json({ error: "Video file not found on disk" });
        }

        const startSeconds = Number(req.body?.startSeconds);
        const endSeconds = Number(req.body?.endSeconds);
        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) {
          return res.status(400).json({ error: "Valid startSeconds and endSeconds are required" });
        }

        const requestedMode = String(req.body?.mode || "fast") === "accurate" ? "accurate" : "fast";
        const quality = ["same", "480", "720", "1080"].includes(String(req.body?.quality))
          ? String(req.body.quality)
          : "same";
        const mode = quality === "same" ? requestedMode : "accurate";
        const duration = endSeconds - startSeconds;
        const outputDir = path.resolve(process.cwd(), "exports", "clips", channelFolderName(entry.channel_id));
        fs.mkdirSync(outputDir, { recursive: true });

        const baseName = datedBaseName(entry.title, entry.upload_date);
        const startLabel = formatSecondsForFile(startSeconds);
        const endLabel = formatSecondsForFile(endSeconds);
        const outputPath = uniquePath(path.join(outputDir, `${baseName} - ${startLabel}_to_${endLabel}.mp4`));

        await exportVideoSegment({
          inputPath,
          outputPath,
          startSeconds,
          duration,
          mode,
          quality,
        });

        res.json({
          success: true,
          outputPath,
          fileName: path.basename(outputPath),
          mode,
          quality,
          startSeconds,
          endSeconds,
        });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Video export failed" });
      }
    },
  );

  // ---- Notes (transcript_clips) + tags + links + graph ----
  // /api/clips/* registered in routes-notes.ts.
  registerNotesRoutes(app, pipeline);

  // ---- Transcription setup wizard ----
  // /api/transcription/* — first-launch venv install, engine select, etc.
  registerTranscriptionSetupRoutes(app);

  app.patch(
    "/api/videos/library/:channelId/:videoId/notes",
    (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const { notes } = req.body || {};
        const value = notes === null || notes === undefined ? null : String(notes);
        setVideoNotes(req.params.videoId, req.params.channelId, value);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save notes" });
      }
    },
  );

  // Get queue statistics for a channel
  app.get("/api/pipeline/queue/:channelId", (req, res) => {
    const counts = countByStatus(req.params.channelId);
    const recent = getChannelQueue(req.params.channelId, 50);
    res.json({ counts, recent });
  });

  // Get full queue overview
  app.get("/api/pipeline/queue", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    const requestedOffset = Number(req.query.offset);
    const offset = Number.isFinite(requestedOffset) ? requestedOffset : 0;
    const result = getQueueList({
      limit,
      offset,
      status: String(req.query.status || "all"),
      channelId: String(req.query.channelId || "all"),
      type: String(req.query.type || "all"),
      hasTranscript: String(req.query.hasTranscript || "all"),
      q: req.query.q ? String(req.query.q) : "",
      sort: String(req.query.sort || "upload_desc"),
    });
    res.json({
      counts: result.counts,
      recent: result.rows,
      total: result.total,
      limit: Math.min(Math.max(Math.floor(limit), 1), 250),
      offset: Math.max(Math.floor(offset), 0),
    });
  });

  // Set up cleanup for the interval when server shuts down
  httpServer.on('close', () => {
    console.log("Server shutting down, clearing temp file cleanup interval");
    clearInterval(cleanupInterval);
    pipeline.stop();
  });
  
  return httpServer;
}
