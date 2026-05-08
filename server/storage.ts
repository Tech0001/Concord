export interface User {
  id: number;
  username: string;
  password: string;
}

export type InsertUser = Omit<User, "id">;

export interface VideoInfo {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: string | number;
  views?: string;
  uploadDate?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  channelUrl?: string | null;
  formats: {
    format_id: string;
    format?: string;
    quality?: string;
    ext?: string;
    resolution?: string;
    filesize?: number;
    filesize_approx?: number;
  }[];
}

// Interface for storage operations
export interface IStorage {
  // User operations (keeping from the original schema)
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Video operations
  getVideoInfo(videoId: string): Promise<VideoInfo | undefined>;
  storeVideoInfo(videoInfo: VideoInfo): Promise<VideoInfo>;
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private videos: Map<string, VideoInfo>;
  currentId: number;

  constructor() {
    this.users = new Map();
    this.videos = new Map();
    this.currentId = 1;
  }

  // User methods (keeping from the original schema)
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentId++;
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }
  
  // Video methods
  async getVideoInfo(videoId: string): Promise<VideoInfo | undefined> {
    return this.videos.get(videoId);
  }

  async storeVideoInfo(videoInfo: VideoInfo): Promise<VideoInfo> {
    this.videos.set(videoInfo.id, videoInfo);
    return videoInfo;
  }
}

export const storage = new MemStorage();
