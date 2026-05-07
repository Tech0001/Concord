import { pgTable, text, serial, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Video info table
export const videos = pgTable("videos", {
  id: text("id").primaryKey(), // YouTube video ID
  title: text("title").notNull(),
  thumbnail: text("thumbnail").notNull(),
  duration: text("duration").notNull(),
  views: text("views").notNull(),
  uploadDate: text("upload_date"),
  channelId: text("channel_id"),
  channelName: text("channel_name"),
  channelUrl: text("channel_url"),
  formats: jsonb("formats").notNull().$type<VideoFormat[]>(),
});

// User table (keeping from the original schema)
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

// Schemas for data validation
export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertVideoSchema = createInsertSchema(videos);

// Types for the application
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type VideoInfo = typeof videos.$inferSelect;

export interface VideoFormat {
  format_id: string;
  format: string;
  quality: string;
  ext: string;
  resolution?: string;
  filesize?: number;
  filesize_approx?: number;
}
