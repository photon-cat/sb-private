import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "demo",
  server: {
    port: 3010,
    open: false,
    fs: {
      // Allow serving files from project root (for src/ imports and test-firmware/)
      allow: [".."],
    },
  },
  plugins: [
    {
      name: "serve-test-firmware",
      configureServer(server) {
        // Serve /test-firmware/* from the project's test-firmware directory
        server.middlewares.use("/test-firmware", (req, res, next) => {
          const filePath = resolve(__dirname, "test-firmware", req.url!.slice(1) || "");
          import("fs").then(fs => {
            if (fs.existsSync(filePath)) {
              const data = fs.readFileSync(filePath);
              res.setHeader("Content-Type", "application/octet-stream");
              res.end(data);
            } else {
              next();
            }
          });
        });
      },
    },
  ],
});
