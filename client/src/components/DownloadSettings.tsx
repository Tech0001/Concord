import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DownloadSettings } from "@/types/video";
import { useToast } from "@/hooks/use-toast";
import { FolderCog } from "lucide-react";

interface DownloadSettingsProps {
  onSettingsChange: (settings: DownloadSettings) => void;
}

export default function DownloadSettingsComponent({ onSettingsChange }: DownloadSettingsProps) {
  const [downloadLocation, setDownloadLocation] = useState<string>("");
  const { toast } = useToast();

  useEffect(() => {
    const savedSettings = localStorage.getItem("downloadSettings");
    if (savedSettings) {
      try {
        const parsedSettings = JSON.parse(savedSettings) as DownloadSettings;
        setDownloadLocation(parsedSettings.downloadLocation || "");
        onSettingsChange(parsedSettings);
      } catch (error) {
        console.error("Error parsing saved download settings:", error);
      }
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDownloadLocation(e.target.value);
  };

  const saveSettings = () => {
    const settings: DownloadSettings = { downloadLocation };
    localStorage.setItem("downloadSettings", JSON.stringify(settings));
    onSettingsChange(settings);
    toast({
      title: "Settings saved",
      description: downloadLocation
        ? `Videos will be saved to: ${downloadLocation}`
        : "Videos will be saved to your downloads folder",
      duration: 3000,
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <FolderCog className="h-4 w-4" />
          Download settings
        </CardTitle>
      </CardHeader>
      <CardContent>
        <label htmlFor="downloadLocation" className="text-xs font-medium text-muted-foreground">
          Download location
        </label>
        <div className="mt-1.5 flex w-full items-center gap-2">
          <Input
            id="downloadLocation"
            type="text"
            className="flex-1 font-mono text-xs"
            placeholder="e.g. C:\Users\YourName\Videos"
            value={downloadLocation}
            onChange={handleInputChange}
            onClick={(e) => e.currentTarget.select()}
          />
          <Button size="sm" onClick={saveSettings}>
            Save
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Leave empty to use the browser's default downloads folder.
        </p>
      </CardContent>
    </Card>
  );
}
