import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import Pipeline from "@/pages/Pipeline";
import Library from "@/pages/Library";
import Search from "@/pages/Search";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, Activity, Database, Search as SearchIcon } from "lucide-react";

function Navigation() {
  const [location, setLocation] = useLocation();

  return (
    <div className="flex justify-center mb-4">
      <Tabs
        value={location === "/pipeline" ? "pipeline" : location === "/library" ? "library" : location === "/search" ? "search" : "home"}
        onValueChange={v => setLocation(v === "pipeline" ? "/pipeline" : v === "library" ? "/library" : v === "search" ? "/search" : "/")}
      >
        <TabsList>
          <TabsTrigger value="home" className="gap-1">
            <Download className="h-4 w-4" /> Download
          </TabsTrigger>
          <TabsTrigger value="pipeline" className="gap-1">
            <Activity className="h-4 w-4" /> Pipeline
          </TabsTrigger>
          <TabsTrigger value="library" className="gap-1">
            <Database className="h-4 w-4" /> Library
          </TabsTrigger>
          <TabsTrigger value="search" className="gap-1">
            <SearchIcon className="h-4 w-4" /> Search
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/pipeline" component={Pipeline} />
      <Route path="/library" component={Library} />
      <Route path="/search" component={Search} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="bg-gray-100 min-h-screen">
        <Navigation />
        <Router />
        <Toaster />
      </div>
    </QueryClientProvider>
  );
}

export default App;
