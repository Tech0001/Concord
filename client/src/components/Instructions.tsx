import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Instructions() {
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-sm">How to use</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Optionally set a download location at the top.</li>
          <li>Paste a YouTube URL and press Fetch.</li>
          <li>Pick a resolution.</li>
          <li>Click Download. The file lands in your folder, or in the browser's downloads if no path is set.</li>
        </ol>
        <p className="mt-3 text-xs">
          For personal use only. Respect copyright and YouTube's Terms of Service.
        </p>
      </CardContent>
    </Card>
  );
}
