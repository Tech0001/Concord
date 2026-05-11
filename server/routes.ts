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
  getSpeakersWithStats, getSpeakerById, createSpeaker, updateSpeaker, deleteSpeaker,
  getUnidentifiedAssignments, getSpeakerAppearances, assignVideoSpeakerToGlobal,
  getVideoSpeakerSummary, getVideoSpeakerSummariesBatch,
  backfillVideoSpeakerMetadata, backfillAllZeroAirtimeAssignments,
  autoMatchUnidentifiedAgainstSpeaker, autoMatchAllUnidentified,
  getOrCreateNoiseSpeaker, pruneAllOrphanedAssignments,
  getArchiveStatus,
} from "./db";
import {
  addClipLink,
  countByStatus,
  createTranscriptClip,
  CLIP_LINK_KINDS,
  type ClipLinkKind,
  deleteClipTag,
  deleteTranscriptClip,
  enqueueVideo,
  getChannelQueue,
  getClipGraph,
  getClipMapLayout,
  type GraphEdgeType,
  getClipLinks,
  getQueueEntry,
  getQueueEntryByVideoId,
  getQueueList,
  listAllClipTags,
  listRelatedTranscriptClips,
  getTranscriptSegmentsForVideo,
  getTranscriptSearchIndexStats,
  listTranscriptClips,
  refreshTranscriptSearchIndex,
  removeClipLink,
  renameClipTag,
  searchTranscriptSegments,
  saveClipMapLayout,
  setClipTags,
  setVideoNotes,
  updateQueueStatus,
} from "./db";
import { copyAudioTrack, getVideoStreamInfo } from "./audio";
import { channelFolderName, datedBaseName, replaceExtension } from "./naming";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { spawn, execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
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
            const dbChannelId = existingEntry?.channel_id || download.channelId || "manual";
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
  app.get("/api/pipeline/status", (_req, res) => {
    res.json(pipeline.getState());
  });

  // Whole-archive status snapshot — powers the Status dashboard. Bundles
  // the pipeline state with coverage counts so the page renders from a
  // single fetch. Cheap aggregate queries; safe to poll every few seconds.
  app.get("/api/status", (_req, res) => {
    try {
      const cfg = pipeline.getConfig();
      const snapshot = getArchiveStatus(cfg.llm.embeddingModel || null);
      res.json({
        pipeline: pipeline.getState(),
        ...snapshot,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to assemble status snapshot",
      });
    }
  });

  // Get pipeline config
  app.get("/api/pipeline/config", (_req, res) => {
    res.json(pipeline.getConfig());
  });

  // Update pipeline config
  app.post("/api/pipeline/config", (req, res) => {
    try {
      pipeline.updateConfig(req.body);
      res.json({ success: true, config: pipeline.getConfig() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid config" });
    }
  });

  // yt-dlp health indicator. We deliberately do NOT auto-update yt-dlp anywhere;
  // this endpoint just probes `yt-dlp --version` so the UI can show whether the
  // binary is reachable and what version is installed. The result is cached for
  // 60s — version doesn't change between user-initiated package upgrades.
  let ytdlpHealthCache: { at: number; data: Awaited<ReturnType<typeof probeYtdlpHealth>> } | null = null;
  app.get("/api/pipeline/ytdlp-health", async (req, res) => {
    const force = req.query.force === "1" || req.query.force === "true";
    if (!force && ytdlpHealthCache && Date.now() - ytdlpHealthCache.at < 60_000) {
      return res.json({ ...ytdlpHealthCache.data, cached: true });
    }
    const data = await probeYtdlpHealth();
    ytdlpHealthCache = { at: Date.now(), data };
    res.json({ ...data, cached: false });
  });

  // ---- System info (for client-side platform-aware UI filtering) ----
  app.get("/api/system/info", (_req, res) => {
    res.json({ platform: process.platform, arch: process.arch });
  });

  // ---- Native folder picker (macOS / future Electron) ----
  // Spawns AppleScript's `choose folder` dialog so users can pick paths in
  // Finder instead of typing them. Server-side because the app runs locally
  // on the user's machine — the dialog appears on their desktop. When we
  // package as Electron later, swap this for dialog.showOpenDialog.
  app.post("/api/dialog/pick-folder", async (req, res) => {
    if (process.platform !== "darwin") {
      return res.status(501).json({
        error: "Folder picker not supported on this platform yet",
        platform: process.platform,
      });
    }
    const { prompt = "Choose folder", defaultPath } = req.body || {};
    const escape = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    let script = `POSIX path of (choose folder with prompt "${escape(prompt)}"`;
    if (defaultPath && fs.existsSync(defaultPath)) {
      script += ` default location POSIX file "${escape(defaultPath)}"`;
    }
    script += `)`;
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      res.json({ path: stdout.trim() });
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const stderr = String(e?.stderr || "");
      // osascript exits 1 with "User canceled. (-128)" when the user dismisses.
      if (stderr.includes("User canceled") || stderr.includes("(-128)")) {
        return res.json({ cancelled: true });
      }
      res.status(500).json({ error: stderr || e?.message || "osascript failed" });
    }
  });

  // ---- LLM (oMLX / Ollama / any OpenAI-compatible) ----

  // Read current LLM config. Never returns the raw API key — only `hasApiKey`.
  app.get("/api/llm/config", (_req, res) => {
    const llm = pipeline.getConfig().llm;
    res.json({
      baseUrl: llm.baseUrl,
      chatModel: llm.chatModel,
      embeddingModel: llm.embeddingModel,
      hasApiKey: Boolean(llm.apiKey),
    });
  });

  // Update LLM config. Body may contain any subset of
  // { baseUrl, apiKey, chatModel, embeddingModel }. Sending apiKey overwrites
  // the stored value (including with "" to clear). Omit apiKey to leave it.
  app.post("/api/llm/config", (req, res) => {
    try {
      const updates: Partial<{ baseUrl: string; apiKey: string; chatModel: string; embeddingModel: string }> = {};
      const body = req.body || {};
      if (typeof body.baseUrl === "string") updates.baseUrl = body.baseUrl.trim();
      if (typeof body.apiKey === "string") updates.apiKey = body.apiKey;
      if (typeof body.chatModel === "string") updates.chatModel = body.chatModel.trim();
      if (typeof body.embeddingModel === "string") updates.embeddingModel = body.embeddingModel.trim();
      pipeline.updateConfig({ llm: { ...pipeline.getConfig().llm, ...updates } });
      const llm = pipeline.getConfig().llm;
      res.json({
        success: true,
        config: {
          baseUrl: llm.baseUrl,
          chatModel: llm.chatModel,
          embeddingModel: llm.embeddingModel,
          hasApiKey: Boolean(llm.apiKey),
        },
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid config" });
    }
  });

  // Quick reachability + identity probe. Always 200; the body says reachable=false on error.
  app.get("/api/llm/status", async (_req, res) => {
    res.json(await llmProbeStatus());
  });

  // ---- Semantic search & embedding management ----

  // Stats: how many videos × segments are embedded, per model.
  app.get("/api/llm/embeddings/stats", (_req, res) => {
    res.json(getEmbeddingStats());
  });

  // Reindex everything. Walks every transcribed video and re-embeds. Slow
  // for big libraries (hundreds of API calls of 50 segments each), so it
  // streams progress over SSE rather than holding a long HTTP request.
  app.post("/api/llm/embeddings/reindex", async (req, res) => {
    const cfg = pipeline.getConfig().llm;
    const model = (req.body?.model as string | undefined) || cfg.embeddingModel;
    if (!model) {
      return res.status(400).json({ error: "No embedding model configured (set on AI page first)" });
    }

    const wipe = req.body?.wipe === true;
    if (wipe) clearAllEmbeddings(model);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Default behavior: catch-up only — skip videos that already have
    // embeddings for this model. Wipe forces a full re-embed (used when
    // changing models or rebuilding from scratch).
    const allVideos = getQueueList({ status: "complete", limit: 100000 }).rows;
    const videos = wipe
      ? allVideos
      : allVideos.filter((v) => !hasVideoEmbeddings(v.video_id, v.channel_id, model));
    const alreadyCovered = allVideos.length - videos.length;
    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sse("start", { total: videos.length, model, alreadyCovered });

    let done = 0;
    let totalSegments = 0;
    let skipped = 0;
    for (const v of videos) {
      try {
        const r = await embedSegmentsForVideo(v.video_id, v.channel_id, model);
        if (r.skipped) skipped++;
        else totalSegments += r.segmentCount;
        sse("video", { ...r, done: ++done, total: videos.length });
      } catch (err) {
        sse("video", {
          videoId: v.video_id, channelId: v.channel_id, model, segmentCount: 0,
          error: err instanceof Error ? err.message : String(err),
          done: ++done, total: videos.length,
        });
      }
    }

    sse("done", { total: videos.length, totalSegments, skipped, model });
    res.end();
  });

  // Regenerate the AI summary for a single video. Used by the per-video
  // "Regenerate" button in the transcript drawer. Synchronous (no SSE)
  // since it's one chat call — the UI can show a spinner.
  app.post("/api/videos/library/:channelId/:videoId/ai-summary/regenerate", async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
    try {
      const cfg = pipeline.getConfig().llm;
      const model = cfg.chatModel;
      if (!model) return res.status(400).json({ error: "No chat model configured (set on AI page first)" });

      // Clear so summarizeVideo's "already populated by this model" guard
      // doesn't short-circuit the regen.
      setVideoAiSummary(req.params.videoId, req.params.channelId, null, null);

      const result = await summarizeVideo(req.params.videoId, req.params.channelId, model);
      if (result.skipped) return res.status(400).json({ error: result.skipped, model: result.model });
      res.json({
        success: true,
        model: result.model,
        charsIn: result.charsIn,
        charsOut: result.charsOut,
      });
    } catch (err) {
      if (err instanceof LlmConfigError) return res.status(400).json({ error: err.message });
      if (err instanceof LlmUnreachableError) return res.status(503).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : "Unknown" });
    }
  });

  // Bulk-generate AI summaries for every transcribed video. SSE-streamed
  // since iterating + calling chat() per video is slow (multi-second per
  // call). By default, skips videos whose notes are already populated;
  // pass `overwrite: true` to regenerate everything (uses are: model
  // changed, prompt tweaked).
  app.post("/api/llm/summaries/regenerate", async (req, res) => {
    const cfg = pipeline.getConfig().llm;
    const model = (req.body?.model as string | undefined) || cfg.chatModel;
    if (!model) {
      return res.status(400).json({ error: "No chat model configured (set on AI page first)" });
    }

    const overwrite = req.body?.overwrite === true;
    const videos = getQueueList({ status: "complete", limit: 100000 }).rows;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    sse("start", { total: videos.length, model, overwrite });

    let done = 0;
    let written = 0;
    let skipped = 0;
    for (const v of videos) {
      try {
        if (overwrite) {
          // Clear so summarizeVideo doesn't short-circuit on the
          // "already populated by this model" idempotency guard.
          setVideoAiSummary(v.video_id, v.channel_id, null, null);
        }
        const r = await summarizeVideo(v.video_id, v.channel_id, model);
        if (r.skipped) skipped++;
        else written++;
        sse("video", { ...r, done: ++done, total: videos.length });
      } catch (err) {
        sse("video", {
          videoId: v.video_id, channelId: v.channel_id, model,
          charsIn: 0, charsOut: 0,
          error: err instanceof Error ? err.message : String(err),
          done: ++done, total: videos.length,
        });
      }
    }

    sse("done", { total: videos.length, written, skipped, model });
    res.end();
  });

  // Semantic search — embeds the query, cosines vs all stored vectors.
  app.post("/api/transcripts/search-semantic", async (req, res) => {
    try {
      const query = String(req.body?.query || "").trim();
      if (!query) return res.status(400).json({ error: "query required" });

      const cfg = pipeline.getConfig().llm;
      const model = cfg.embeddingModel;
      if (!model) {
        return res.status(400).json({ error: "No embedding model configured (set on AI page first)" });
      }

      const out = await searchSemantic({
        query,
        model,
        limit: req.body?.limit,
        minScore: typeof req.body?.minScore === "number" ? req.body.minScore : undefined,
        filters: req.body?.filters,
      });
      res.json(out);
    } catch (err) {
      if (err instanceof LlmConfigError) return res.status(400).json({ error: err.message });
      if (err instanceof LlmUnreachableError) return res.status(503).json({ error: err.message });
      if (err instanceof LlmHttpError) return res.status(err.status).json({ error: err.message, body: err.body });
      res.status(500).json({ error: err instanceof Error ? err.message : "Unknown" });
    }
  });

  // Proxy to provider's /v1/models so the AI page can populate model dropdowns.
  app.get("/api/llm/models", async (_req, res) => {
    try {
      const models = await llmListModels();
      res.json({ models });
    } catch (error) {
      if (error instanceof LlmConfigError) {
        return res.status(400).json({ error: error.message, kind: "config" });
      }
      if (error instanceof LlmUnreachableError) {
        return res.status(503).json({ error: error.message, kind: "unreachable" });
      }
      if (error instanceof LlmHttpError) {
        return res.status(error.status).json({ error: error.message, kind: "http", body: error.body });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : "Unknown" });
    }
  });

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
    pipeline.updateConfig(config);
    res.json({ success: true, channel });
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

  // List all speakers with rolled-up stats (airtime + appearance count).
  app.get("/api/speakers", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ speakers: getSpeakersWithStats() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // One-shot fix-up: scans every video_speaker_assignments row with
  // airtime_seconds = 0 (the stub-row case from labeling on pre-Phase-1
  // transcripts) and recomputes airtime + sample timestamps from each
  // transcript file. Idempotent — calling twice does no extra work the
  // second time.
  // Per-speaker rescan — used by the "Find more matches" button after
  // additional labels update the centroid (centroid moves → new
  // matches possible).
  app.post("/api/speakers/:id/find-matches", (req: Request<{ id: string }>, res) => {
    try {
      res.json({ matched: autoMatchUnidentifiedAgainstSpeaker(req.params.id) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // Bulk rescan — sweeps every unidentified against all known speakers,
  // takes the closest within threshold. Used by "Rescan all" on Speakers.
  app.post("/api/speakers/find-all-matches", (_req, res) => {
    try {
      res.json({ matched: autoMatchAllUnidentified() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // Sweep all videos for orphan video_speaker_assignments rows whose
  // local_speaker no longer appears in the current transcript file.
  // Caused by re-transcribes that produced fewer/different local
  // speakers than the prior run — DB rows persisted but had no chip
  // to render. Cheap (one transcript-parse per video).
  app.post("/api/speakers/prune-orphans", (_req, res) => {
    try {
      res.json(pruneAllOrphanedAssignments());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.post("/api/speakers/backfill-stats", (_req, res) => {
    try {
      res.json(backfillAllZeroAirtimeAssignments());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.get("/api/speakers/unidentified", (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      res.json({ assignments: getUnidentifiedAssignments(limit) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.get("/api/speakers/:id", (req: Request<{ id: string }>, res) => {
    const s = getSpeakerById(req.params.id);
    if (!s) return res.status(404).json({ error: "Speaker not found" });
    res.json({ speaker: s, appearances: getSpeakerAppearances(req.params.id) });
  });

  app.post("/api/speakers", (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "name required" });
      const displayColor = req.body?.displayColor ?? null;
      const notes = req.body?.notes ?? null;
      const id = nanoid();
      const speaker = createSpeaker({ id, name, displayColor, notes });
      res.json({ speaker });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.patch("/api/speakers/:id", (req: Request<{ id: string }>, res) => {
    const fields: { name?: string; displayColor?: string | null; notes?: string | null; isNoise?: boolean } = {};
    if (typeof req.body?.name === "string") fields.name = req.body.name.trim();
    if (req.body?.displayColor !== undefined) fields.displayColor = req.body.displayColor;
    if (req.body?.notes !== undefined) fields.notes = req.body.notes;
    if (typeof req.body?.isNoise === "boolean") fields.isNoise = req.body.isNoise;
    const updated = updateSpeaker(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: "Speaker not found" });
    res.json({ speaker: updated });
  });

  // "Mark as noise" — assigns one or more video-locals in a video to the
  // singleton noise speaker (creating it on first use). Doesn't take a
  // name/color from the user; the noise speaker is a fixed grey "(noise)"
  // bucket. Auto-rescan still fires so similar noise auto-folds in.
  app.post("/api/speakers/mark-noise", (req, res) => {
    try {
      const videoId = String(req.body?.videoId || "");
      const channelId = String(req.body?.channelId || "");
      const localSpeaker = String(req.body?.localSpeaker || "");
      if (!videoId || !channelId || !localSpeaker) {
        return res.status(400).json({ error: "videoId, channelId, localSpeaker required" });
      }
      const additional: string[] = Array.isArray(req.body?.additionalLocalSpeakers)
        ? req.body.additionalLocalSpeakers.filter((x: unknown) => typeof x === "string" && x !== localSpeaker)
        : [];

      const noise = getOrCreateNoiseSpeaker(nanoid());
      assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker, speakerId: noise.id });
      backfillVideoSpeakerMetadata(videoId, channelId, localSpeaker);
      for (const al of additional) {
        assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker: al, speakerId: noise.id });
        backfillVideoSpeakerMetadata(videoId, channelId, al);
      }
      const autoMatched = autoMatchUnidentifiedAgainstSpeaker(noise.id);
      res.json({ success: true, speakerId: noise.id, autoMatched, additionalAssigned: additional.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.delete("/api/speakers/:id", (req: Request<{ id: string }>, res) => {
    const ok = deleteSpeaker(req.params.id);
    res.json({ success: ok });
  });

  // Manually assign (or re-assign) a video-local speaker to a global one.
  // Pass speakerId to link, or null to unlink. If `newName` is provided
  // and `speakerId` is omitted, creates a new speaker first then assigns.
  app.post("/api/speakers/assign", (req, res) => {
    try {
      const videoId = String(req.body?.videoId || "");
      const channelId = String(req.body?.channelId || "");
      const localSpeaker = String(req.body?.localSpeaker || "");
      if (!videoId || !channelId || !localSpeaker) {
        return res.status(400).json({ error: "videoId, channelId, localSpeaker required" });
      }
      let speakerId: string | null;
      let createdSpeaker = null;
      if (typeof req.body?.newName === "string" && req.body.newName.trim()) {
        const id = nanoid();
        createdSpeaker = createSpeaker({
          id,
          name: req.body.newName.trim(),
          displayColor: req.body.displayColor ?? null,
        });
        speakerId = id;
      } else if (req.body?.speakerId === null) {
        speakerId = null;
      } else if (typeof req.body?.speakerId === "string") {
        speakerId = req.body.speakerId;
      } else {
        return res.status(400).json({ error: "Provide speakerId, newName, or speakerId=null" });
      }
      // Multi-select: also label these other local labels in the same
      // video as the same speaker. Handles the over-segmentation case
      // where one person ended up split into S0/S1/.../Sn chips.
      const additional: string[] = Array.isArray(req.body?.additionalLocalSpeakers)
        ? req.body.additionalLocalSpeakers.filter((x: unknown) => typeof x === "string" && x !== localSpeaker)
        : [];

      assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker, speakerId });
      backfillVideoSpeakerMetadata(videoId, channelId, localSpeaker);
      for (const al of additional) {
        assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker: al, speakerId });
        backfillVideoSpeakerMetadata(videoId, channelId, al);
      }

      // Auto-rescan whenever an assignment lands a video-local on a
      // global speaker — both new speakers AND re-assignments to existing
      // ones. The latter case matters because the assignVideoSpeakerToGlobal
      // call updates the speaker's centroid (count-weighted average from
      // this new sample), so other unidentified videos might NOW match
      // even though they didn't before. Only operates on rows that are
      // currently UNIDENTIFIED — already-labeled assignments aren't
      // touched, so prior user decisions are preserved.
      let autoMatched = 0;
      if (speakerId !== null) {
        autoMatched = autoMatchUnidentifiedAgainstSpeaker(speakerId);
      }
      res.json({ success: true, speakerId, createdSpeaker, autoMatched, additionalAssigned: additional.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

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

  app.get("/api/videos/library/:channelId/:videoId/stream", (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
    try {
      const entry = getQueueEntry(req.params.videoId, req.params.channelId);
      if (!entry?.video_path) {
        return res.status(404).json({ error: "Video file is not recorded in the library" });
      }

      const videoPath = path.resolve(entry.video_path);
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

  app.get("/api/clips", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const requestedLimit = Number(req.query.limit);
      const requestedOffset = Number(req.query.offset);
      const tagsParam = typeof req.query.tags === "string" ? req.query.tags : "";
      const tags = tagsParam
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
      const result = listTranscriptClips({
        q: req.query.q ? String(req.query.q) : "",
        channelId: String(req.query.channelId || "all"),
        tags,
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 100,
        offset: Number.isFinite(requestedOffset) ? requestedOffset : 0,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list clips" });
    }
  });

  app.get("/api/clips/graph", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const tagsParam = typeof req.query.tags === "string" ? req.query.tags : "";
      const edgeTypesParam = typeof req.query.edgeTypes === "string" ? req.query.edgeTypes : "";
      const tags = tagsParam.split(",").map(t => t.trim()).filter(Boolean);
      const knownEdgeTypes = new Set<GraphEdgeType>(["manual", "shared_tag", "same_video"]);
      const edgeTypes = edgeTypesParam
        .split(",")
        .map(t => t.trim())
        .filter((t): t is GraphEdgeType => knownEdgeTypes.has(t as GraphEdgeType));
      const requestedLimit = Number(req.query.limit);
      res.json(getClipGraph({
        q: req.query.q ? String(req.query.q) : undefined,
        channelId: req.query.channelId ? String(req.query.channelId) : undefined,
        tags,
        edgeTypes: edgeTypes.length ? edgeTypes : undefined,
        limit: Number.isFinite(requestedLimit) ? requestedLimit : undefined,
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to build graph" });
    }
  });

  app.get("/api/clips/graph/layout", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const mapKey = typeof req.query.mapKey === "string" ? req.query.mapKey.trim() : "";
      if (!mapKey) return res.status(400).json({ error: "mapKey is required" });
      res.json({ nodes: getClipMapLayout(mapKey) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load graph layout" });
    }
  });

  app.put("/api/clips/graph/layout", (req, res) => {
    try {
      const mapKey = String(req.body?.mapKey || "").trim();
      const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
      if (!mapKey) return res.status(400).json({ error: "mapKey is required" });
      const result = saveClipMapLayout(mapKey, nodes.map((node: any) => ({
        nodeId: String(node.nodeId || ""),
        x: Number(node.x),
        y: Number(node.y),
        width: Number(node.width),
        height: Number(node.height),
      })));
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save graph layout" });
    }
  });

  app.get("/api/clips/tags", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ tags: listAllClipTags() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list tags" });
    }
  });

  // AI tag suggestions for a clip quote. Best-effort — the TagPicker shows
  // a "Suggested" row when this returns; if anything goes wrong it just
  // doesn't show, no error toast (the user can still type tags by hand).
  app.post("/api/clips/suggest-tags", async (req, res) => {
    const quote = String(req.body?.quote || "").trim();
    if (!quote) return res.status(400).json({ error: "quote required" });

    const cfg = pipeline.getConfig().llm;
    const model = cfg.chatModel;
    if (!model) return res.status(400).json({ error: "no_chat_model", message: "No chat model configured" });

    // Cap the existing-tag list and the quote so we don't blow context on
    // big libraries / very long clips.
    const allTags = listAllClipTags();
    const existing = allTags.slice(0, 200);
    const existingList = existing.length
      ? existing.map((t) => `${t.tag} (${t.count})`).join("\n")
      : "(no tags exist yet — propose 3-5 reasonable starter tags)";
    const cappedQuote = quote.length > 2000 ? quote.slice(0, 2000) + "…" : quote;

    const systemPrompt = [
      "You suggest 3-5 short tags for a transcript clip in a personal research archive.",
      "Tags use lowercase with hyphens for spaces (e.g. \"oil\", \"middle-east\", \"fed-rate\").",
      "Hierarchical tags use dots (e.g. \"religion.end-times.rapture\").",
      "STRONGLY prefer tags from the EXISTING list. Propose new tags only when none of the existing ones fit.",
      "Output ONLY a JSON array of strings — no prose, no markdown, no explanation.",
      "Example output: [\"oil\", \"commodities\", \"middle-east\"]",
    ].join(" ");

    const userPrompt = `EXISTING TAGS:\n${existingList}\n\nCLIP:\n"${cappedQuote}"`;

    try {
      const reply = await llmChat({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        maxTokens: 120,
      });

      // Parse the first JSON array we find. Models sometimes wrap output in
      // prose despite our instructions; the regex is forgiving.
      const match = reply.match(/\[[\s\S]*?\]/);
      let suggestions: string[] = [];
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            suggestions = parsed
              .filter((s) => typeof s === "string")
              .map((s) => String(s).trim().toLowerCase().replace(/\s+/g, "-"))
              .filter(Boolean);
          }
        } catch { /* fall through to empty */ }
      }
      // Dedupe and cap.
      suggestions = Array.from(new Set(suggestions)).slice(0, 8);

      res.json({ suggestions, model });
    } catch (err) {
      if (err instanceof LlmConfigError) return res.status(400).json({ error: err.message });
      if (err instanceof LlmUnreachableError) return res.status(503).json({ error: err.message });
      if (err instanceof LlmHttpError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : "Unknown" });
    }
  });

  app.post("/api/clips/tags/rename", (req, res) => {
    try {
      const { from, to, includeDescendants } = req.body || {};
      if (!from || !to) {
        return res.status(400).json({ error: "from and to are required" });
      }
      const result = renameClipTag(String(from), String(to), Boolean(includeDescendants));
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to rename tag" });
    }
  });

  app.delete("/api/clips/tags/:tag", (req: Request<{ tag: string }>, res: Response) => {
    try {
      const removed = deleteClipTag(
        decodeURIComponent(req.params.tag),
        req.query.includeDescendants === "true",
      );
      res.json({ success: true, removed });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete tag" });
    }
  });

  app.post("/api/clips", (req, res) => {
    try {
      const {
        videoId,
        channelId,
        startSeconds,
        endSeconds,
        quote,
        note,
        title,
        channelName,
        uploadDate,
        tags,
      } = req.body;

      if (!videoId || !channelId || !quote) {
        return res.status(400).json({ error: "videoId, channelId, and quote are required" });
      }

      const entry = getQueueEntry(String(videoId), String(channelId));
      const clip = createTranscriptClip({
        id: nanoid(),
        videoId: String(videoId),
        channelId: String(channelId),
        title: String(title || entry?.title || "Untitled video"),
        channelName: channelName !== undefined ? String(channelName) : null,
        uploadDate: uploadDate || entry?.upload_date || null,
        startSeconds: Number(startSeconds) || 0,
        endSeconds: Number(endSeconds) || Number(startSeconds) || 0,
        quote: String(quote),
        note: note ? String(note) : null,
        tags: Array.isArray(tags) ? tags.map(String) : undefined,
      });

      res.json({ success: true, clip });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save clip" });
    }
  });

  app.patch("/api/clips/:clipId/tags", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const { tags } = req.body || {};
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: "tags array is required" });
      }
      const stored = setClipTags(req.params.clipId, tags.map(String));
      res.json({ success: true, tags: stored });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update tags" });
    }
  });

  app.get("/api/clips/related/:channelId/:videoId", (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const result = listRelatedTranscriptClips(
        req.params.videoId,
        req.params.channelId,
        req.query.excludeId ? String(req.query.excludeId) : undefined,
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list related clips" });
    }
  });

  app.delete("/api/clips/:clipId", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const deleted = deleteTranscriptClip(req.params.clipId);
      if (!deleted) return res.status(404).json({ error: "Clip not found" });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete clip" });
    }
  });

  app.get("/api/clips/:clipId/links", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ links: getClipLinks(req.params.clipId), kinds: CLIP_LINK_KINDS });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load links" });
    }
  });

  app.post("/api/clips/:clipId/links", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const { toId, kind, note } = req.body || {};
      if (!toId || !kind) return res.status(400).json({ error: "toId and kind are required" });
      if (!CLIP_LINK_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${CLIP_LINK_KINDS.join(", ")}` });
      }
      const result = addClipLink(req.params.clipId, String(toId), kind as ClipLinkKind, note ? String(note) : null);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to add link" });
    }
  });

  app.delete(
    "/api/clips/:clipId/links/:toId/:kind",
    (req: Request<{ clipId: string; toId: string; kind: string }>, res: Response) => {
      try {
        if (!CLIP_LINK_KINDS.includes(req.params.kind as ClipLinkKind)) {
          return res.status(400).json({ error: "Unknown link kind" });
        }
        const result = removeClipLink(req.params.clipId, req.params.toId, req.params.kind as ClipLinkKind);
        res.json({ success: true, ...result });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to remove link" });
      }
    },
  );

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
