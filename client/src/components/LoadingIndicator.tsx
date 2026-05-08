import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function LoadingIndicator() {
  return (
    <Card className="mb-4">
      <CardContent className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Fetching video information…</span>
      </CardContent>
    </Card>
  );
}
