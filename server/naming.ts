import path from "path";

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\s_-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

export function formatUploadDate(uploadDate?: string | null): string | null {
  if (!uploadDate) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(uploadDate)) {
    return uploadDate;
  }

  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }

  return null;
}

export function datedBaseName(title: string, uploadDate?: string | null): string {
  const formattedDate = formatUploadDate(uploadDate);
  const prefix = formattedDate ? `${formattedDate} - ` : "";
  return `${prefix}${sanitizeFileName(title)}`;
}

export function channelFolderName(channelName?: string | null): string {
  return sanitizeFileName(channelName?.trim() || "Manual") || "Manual";
}

export function replaceExtension(filePath: string, extension: string): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${extension.startsWith(".") ? extension : `.${extension}`}`);
}
