import { Card, CardContent } from "@/components/ui/card";

export default function LoadingIndicator() {
  return (
    <Card className="mb-6">
      <CardContent className="p-6 flex justify-center items-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#FF0000]"></div>
        <span className="ml-3 text-gray-600">Fetching video information...</span>
      </CardContent>
    </Card>
  );
}
