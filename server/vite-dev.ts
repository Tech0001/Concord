// Dev-only Vite integration. Loaded via dynamic import from server/index.ts
// when NODE_ENV !== "production" so the production server bundle (shipped
// inside the Electron .app) never references vite. Vite is a devDependency
// and isn't installed in the packaged app.

import fs from "fs";
import path from "path";
import { type Express } from "express";
import { type Server } from "http";
import { nanoid } from "nanoid";

export async function setupVite(app: Express, server: Server) {
  // Lazy-load vite + the vite config so the production server bundle
  // doesn't carry a static reference to vite. Even with vite-dev.ts
  // hidden behind a dynamic import, esbuild inlines its top-level
  // imports — top-level `import {...} from "vite"` would still pull
  // the package at module load. Keeping it inside the function body
  // means it only resolves when setupVite is actually called (dev only).
  const { createServer: createViteServer, createLogger } = await import("vite");
  const { default: viteConfig } = await import("../vite.config");
  const viteLogger = createLogger();

  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: {
      ...viteConfig.server,
      ...serverOptions,
      watch: viteConfig.server?.watch,
    },
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("/{*splat}", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
