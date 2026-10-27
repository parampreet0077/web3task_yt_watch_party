import http from "node:http";
import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Server as SocketIOServer } from "socket.io";

import roomRouter from "./routes/room.routes.js";
import { setupSocketIO } from "./socket/room.handler.js";
import { prisma } from "./config/prisma.js";

dotenv.config();
// Monorepo root execution fallback for local development
dotenv.config({ path: "server/.env" });

const app = express();
const port = Number(process.env.PORT) || 5000;
const isProd = process.env.NODE_ENV === "production";
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";

const configuredClientUrls = clientUrl
  .split(",")
  .map((u) => u.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const allowedOrigins = Array.from(
  new Set([
    ...configuredClientUrls,
    ...(isProd ? [] : ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"]),
  ])
);

/**
 * Checks whether an incoming request/socket origin matches configured origins.
 * Supports exact origin matches, wildcard subdomains (e.g. https://*.vercel.app),
 * and handles trailing slashes consistently.
 */
function isOriginAllowed(origin?: string): boolean {
  if (!origin) return true;
  if (!isProd) return true;
  const clean = origin.replace(/\/+$/, "");
  return allowedOrigins.some((allowed) => {
    if (allowed === clean) return true;
    if (allowed.includes("*")) {
      const regexPattern =
        "^" +
        allowed
          .split("*")
          .map((part) => part.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
          .join(".*") +
        "$";
      return new RegExp(regexPattern).test(clean);
    }
    return false;
  });
}

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server health checks)
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS origin '${origin}' not permitted`));
    },
    credentials: true,
  })
);

app.use(express.json());

// Health check endpoint (safe, does not expose credentials or database internals)
app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    service: "watch-party-backend",
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Mount Room API endpoints
app.use("/api/rooms", roomRouter);

// Production-safe global error handling middleware (prevents stack traces & secret leakage)
app.use((err: any, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error("[Server Error]", err?.message || err);
  const statusCode =
    typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;

  res.status(statusCode).json({
    error: statusCode === 500 ? "Internal Server Error" : (err.name || "Error"),
    message:
      isProd && statusCode === 500
        ? "An unexpected error occurred. Please try again later."
        : (err.message || "Unknown error"),
  });
});

const httpServer = http.createServer(app);

// Attach Socket.IO
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS origin '${origin}' not permitted`), false);
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Initialize authenticated room membership handlers and connection state tracking
setupSocketIO(io);

// Graceful shutdown handling for cloud platforms (Render, Docker, Kubernetes)
async function gracefulShutdown(signal: string) {
  console.log(`[Server] Received ${signal}. Initiating graceful shutdown...`);
  httpServer.close(async () => {
    console.log("[Server] Closed HTTP and Socket.IO servers.");
    try {
      await prisma.participant.updateMany({
        where: { isConnected: true },
        data: { isConnected: false },
      });
      await prisma.$disconnect();
      console.log("[Server] Cleaned up database connections.");
    } catch (err) {
      console.error("[Server] Error during shutdown cleanup:", err);
    } finally {
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.error("[Server] Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

if (process.env.NODE_ENV !== "test") {
  // Reset any lingering connection flags from previous server runs
  prisma.participant
    .updateMany({
      where: { isConnected: true },
      data: { isConnected: false },
    })
    .catch((err) => {
      console.error("[Server] Warning: Failed to reset connection states:", err);
    });

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`[Server] Watch Party Backend listening on 0.0.0.0:${port}`);
    console.log(`[Server] Health check: http://localhost:${port}/api/health`);
  });
}

export { app, httpServer, io };
