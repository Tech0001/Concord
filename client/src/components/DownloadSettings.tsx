import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DownloadSettings } from "@/types/video";
import { useToast } from "@/hooks/use-toast";

interface DownloadSettingsProps {
  onSettingsChange: (settings: DownloadSettings) => void;
}

export default function DownloadSettingsComponent({ onSettingsChange }: DownloadSettingsProps) {
  const [downloadLocation, setDownloadLocation] = useState<string>("");
  const { toast } = useToast();
  
  // Load saved settings on component mount
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
    const value = e.target.value;
    console.log("Input value changed to:", value);
    setDownloadLocation(value);
  };
  
  const saveSettings = () => {
    console.log("Saving download location:", downloadLocation);
    
    const settings: DownloadSettings = {
      downloadLocation: downloadLocation
    };
    
    // Save to local storage
    localStorage.setItem("downloadSettings", JSON.stringify(settings));
    
    // Notify parent component
    onSettingsChange(settings);
    
    // Show confirmation toast
    toast({
      title: "Settings saved",
      description: downloadLocation 
        ? `Videos will be saved to: ${downloadLocation}` 
        : "Videos will be saved to your downloads folder",
      duration: 3000,
    });
  };
  
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Download Settings</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="downloadLocation">Download Location</Label>
            <div className="flex w-full items-center space-x-2">
              <input
                id="downloadLocation"
                type="text"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="Downloads folder path"
                value={downloadLocation}
                onChange={handleInputChange}
                onClick={e => e.currentTarget.select()}
              />
              <Button onClick={saveSettings}>Save</Button>
            </div>
            <p className="text-sm text-gray-500">
              Enter the folder where you want downloaded videos to be saved (e.g. C:\Users\YourName\Videos)
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
} 