import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <h1 className="text-base font-semibold">404 — page not found</h1>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            That route isn't wired up. Try the navigation in the top bar.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
