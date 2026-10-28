# Web3Task YouTube Watch Party — Real-Time Video Synchronization

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8-010101?logo=socket.io&logoColor=white)](https://socket.io/)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Neon_Serverless-4169E1?logo=postgresql&logoColor=white)](https://neon.tech/)
[![Vercel](https://img.shields.io/badge/Frontend-Vercel-000000?logo=vercel&logoColor=white)](https://web3task-watch-party.vercel.app/)
[![Render](https://img.shields.io/badge/Backend-Render-46E3B7?logo=render&logoColor=black)](https://watchparty-backend-kipa.onrender.com)

A production-ready synchronized YouTube watch room web application built for the **Web3Task Full Stack Intern** assessment. Allows users anywhere in the world to create watch rooms, invite friends via 6-character room codes or shareable links, and enjoy YouTube videos in synchronized lockstep with server-authoritative playback synchronization with drift correction, role-based room governance, and interactive playback requests.

---

## Live Demo

| Service | Environment | URL |
|---|---|---|
| **Frontend Application** | Production (Vercel) | [https://web3task-watch-party.vercel.app/](https://web3task-watch-party.vercel.app/) |
| **Backend REST & WebSocket Server** | Production (Render) | [https://watchparty-backend-kipa.onrender.com](https://watchparty-backend-kipa.onrender.com/) |
| **Health Check Endpoint** | Production (Render) | [https://watchparty-backend-kipa.onrender.com/api/health](https://watchparty-backend-kipa.onrender.com/api/health) |

> **Note on Render Free Tier:** Render spins down free web services after 15 minutes of inactivity. When creating a room for the first time, allow 30–50 seconds for the backend instance to spin up. A live progress notice is displayed in the user interface during cold starts.

---

## Project Overview

Web3Task Watch Party solves the latency and drift challenges of synchronized online video viewing through an authoritative server-side synchronization engine. Rather than relying on peer-to-peer timing or naive client broadcasts, the backend maintains the source of truth for the playback clock, video selection, room state, and participant roles.

### Core Implemented Features

1. **Room Creation & One-Click Joining:**
   - Instantly create watch rooms with an optional custom title and host display name.
   - Generate unique 6-character alphanumeric room codes (e.g., `A9F2E1`) and instant join URLs (`?room=A9F2E1` or `?code=A9F2E1`).
   - Secure double-click and duplicate-submission prevention on room creation forms.

2. **Authoritative Playback Synchronization:**
   - Synchronized actions: `PLAY`, `PAUSE`, `SEEK`, `CHANGE_VIDEO`, and `SET_RATE` (0.25x – 2.0x).
   - Server-calculated timeline drift correction with bounded thresholding (1.2s threshold prevents jarring audio stutter).
   - Late-join synchronization: when a participant joins mid-video, their player immediately syncs to the authoritative timestamp accounting for elapsed server time.

3. **Role-Based Access Control (RBAC):**
   - **Host:** Unrestricted playback control, video changes, participant moderation (promote/demote/kick), host ownership transfer, and request resolution. Exactly one Host exists per room.
   - **Moderator:** Immediate playback control (`PLAY`, `PAUSE`, `SEEK`, `CHANGE_VIDEO`, `SET_RATE`) and control request resolution.
   - **Participant:** Read-only playback synchronization. Submits structured control requests to the room queue.

4. **Participant Management & Host Transfer:**
   - Host can promote participants to `MODERATOR` or demote moderators back to `PARTICIPANT`.
   - Host can kick disruptive participants; kicked sockets are notified and disconnected immediately.
   - Host transfer safely promotes the target participant to `HOST` and transitions the former host to `MODERATOR` using atomic database transactions.

5. **Participant Control Request Queue:**
   - Participants can request playback actions (`Play`, `Pause`, `Seek to timestamp`, `Change Video`).
   - Hosts and Moderators view real-time request notifications and can approve or reject them.
   - Atomic conditional queries (`UPDATE ... WHERE status = 'PENDING'`) prevent double-resolution race conditions between concurrent moderators.

6. **Persistent Rooms & State Storage:**
   - Rooms, participants, session token hashes, playback position, and request history persist across server restarts in Neon PostgreSQL.

7. **Human-Crafted, Responsive UI:**
   - Modern warm dark aesthetic (`#111218` background, `#1B1D27` cards, `#7658E8` violet accents, `#D6AD65` champagne-gold eyebrow typography).
   - Fully responsive watch-room header with dedicated controls and visible "Leave Room" button on mobile viewports.

---

## Technology Stack

### Frontend (`client/`)
- **Framework:** React 19 (Hooks, Context, Functional Components)
- **Language:** TypeScript 5.7+
- **Bundler & Tooling:** Vite 8, Oxlint
- **Animation & Transitions:** Motion for React (`motion/react`)
- **Real-Time Client:** Socket.IO Client 4.8
- **Player Integration:** YouTube IFrame Player API
- **Styling:** Custom Vanilla CSS Design System (CSS Custom Properties, zero runtime overhead)
- **Deployment:** Vercel (Edge CDN, Single Page Application routing)

### Backend (`server/`)
- **Runtime:** Node.js (v20+ LTS / v22 / v24)
- **Framework:** Express 4.21
- **Language:** TypeScript 5.7+
- **Real-Time Engine:** Socket.IO 4.8 (WebSocket + HTTP long-polling fallback)
- **ORM:** Prisma Client 6.19
- **Security:** SHA-256 session token hashing with `crypto.timingSafeEqual` constant-time verification, CORS whitelist with wildcard subdomain support
- **Development Watcher:** `tsx watch`
- **Deployment:** Render (Node.js Web Service)

### Database
- **Engine:** PostgreSQL 16
- **Provider:** Neon Serverless PostgreSQL with PgBouncer connection pooling (`-pooler` endpoint)
- **Schema Migrations:** Prisma Migrate (`prisma migrate deploy`)

---

## Architecture Overview

```mermaid
flowchart TB
    subgraph Clients["Clients (Browsers)"]
        Host["Host Client\n(React 19 + YouTube Player)"]
        Mod["Moderator Client\n(React 19 + YouTube Player)"]
        User["Participant Client\n(React 19 + YouTube Player)"]
    end

    subgraph Hosting["Edge / Cloud Hosting"]
        Vercel["Vercel CDN\n(client/dist - Static SPA)"]
        Render["Render Web Service\n(server/dist - Node.js + Express)"]
    end

    subgraph BackendServices["Backend Application Architecture"]
        REST["REST API Router\n(/api/rooms, /api/health)"]
        SocketEngine["Socket.IO Server\n(Room Channels & Auth Middleware)"]
        SyncEngine["Authoritative Playback Engine\n(Drift Correction & State Clock)"]
        AuthMiddleware["Crypto Token Verifier\n(SHA-256 Constant-Time)"]
    end

    subgraph Database["Neon Serverless PostgreSQL"]
        DB[(PostgreSQL 16 DB\nPgBouncer Pooler)]
        Prisma["Prisma ORM 6"]
    end

    Clients -->|HTTPS Static Load| Vercel
    Clients -->|HTTPS REST Calls| REST
    Clients <===>|WSS / Socket.IO| SocketEngine

    REST --> AuthMiddleware
    SocketEngine --> AuthMiddleware
    SocketEngine <--> SyncEngine

    REST --> Prisma
    SocketEngine --> Prisma
    Prisma <===>|SSL Connection Pool| DB
```

### Communication Flow

1. **Room Creation / Join Flow (HTTP REST):**
   - The client sends a `POST /api/rooms` or `POST /api/rooms/:code/join` request.
   - The server creates or looks up the room in PostgreSQL, generates a cryptographically secure 64-character session token, computes its SHA-256 hash, and stores the hash in the database.
   - The raw token is returned only once to the client in the response payload.
2. **WebSocket Handshake Authentication:**
   - The client initiates a Socket.IO connection providing the token in the `auth` handshake object.
   - The server verifies the token hash against the database in constant time, binds the socket to the room-scoped channel (`room:<roomCode>`), and emits the initial roster and playback state.
3. **Playback Synchronization (WebSocket):**
   - When the Host plays, pauses, or seeks, a Socket.IO event (e.g., `playback:play`) is transmitted to the server.
   - The server computes the authoritative timestamp, updates PostgreSQL, and broadcasts `playback:state` to all sockets in the room channel.
   - Client players apply bounded drift correction: local playback is adjusted if drift exceeds 1.2 seconds, suppressing stutter.
4. **Control Request Resolution:**
   - Participants emit `request:create`. The server writes the request to PostgreSQL and broadcasts `request:created`.
   - Host/Moderator emits `request:approve`. The server executes an atomic database transaction and applies the requested playback update to the entire room.

---

## Playback Synchronization & Real-Time Event Protocol

### 1. Connection & Handshake Authentication
All Socket.IO connections must provide a valid room-scoped session token. Client-supplied participant IDs and roles are never trusted.

```typescript
import { io } from "socket.io-client";

const socket = io("https://watchparty-backend-kipa.onrender.com", {
  auth: {
    token: "<64-character-hex-session-token>",
    roomCode: "ABCDEF", // Cross-verification check
  },
  transports: ["websocket", "polling"],
});
```

### 2. Room Membership Events

| Event | Direction | Payload | Description |
|---|---|---|---|
| `room:join` | Client → Server | `{ roomCode?: string }` | Joins authorized room channel. Acknowledged with current roster and playback state. |
| `room:leave` | Client → Server | `{}` | Leaves room gracefully. Updates online state if last active tab. |
| `room:get-roster` | Client → Server | `{}` | Requests current safe participant roster. |
| `room:joined` | Server → Client | `{ roomCode, participant, roster, playback }` | Emitted to joining socket upon authorization. |
| `room:participant-joined` | Server → Client (Broadcast) | `{ participant: SafeParticipant }` | Broadcast to other room members when a new participant connects. |
| `room:participant-left` | Server → Client (Broadcast) | `{ participantId, displayName }` | Broadcast when a participant's last active socket disconnects. |
| `room:roster` | Server → Client (Broadcast) | `{ participants: SafeParticipant[] }` | Broadcast whenever roster membership or online status changes. |
| `room:kicked` | Server → Client | `{ reason: string }` | Emitted to a participant whose session was removed by the Host via REST API. |

### 3. Authoritative Playback Commands (Host & Moderator Only)
Only the Host or a Moderator may execute playback commands directly. Unselected/empty rooms cannot play or seek until a video is chosen.

| Event | Direction | Payload | Description |
|---|---|---|---|
| `playback:change-video` | Client → Server | `{ videoId: string, syncToken?: string }` | Changes YouTube video. Resets position to 0.0s and pauses. |
| `playback:play` | Client → Server | `{ timestamp?: number, playbackRate?: number, syncToken?: string }` | Starts playback. Broadcasts current authoritative time and `isPlaying = true`. |
| `playback:pause` | Client → Server | `{ timestamp?: number, syncToken?: string }` | Pauses playback. Freezes position and sets `isPlaying = false`. |
| `playback:seek` | Client → Server | `{ timestamp: number, syncToken?: string }` | Seeks playback to the specified non-negative timestamp. |
| `playback:set-rate` | Client → Server | `{ playbackRate: number, syncToken?: string }` | Updates playback rate (`0.25` through `2.0`). Advances time dynamically. |
| `playback:get-state` | Client → Server | `{}` | Available to all room members to fetch current authoritative playback state. |
| `playback:state` | Server → Client (Broadcast) | `{ state: SafePlaybackState }` | Broadcast to all room members on any accepted playback state update. |

#### Safe Playback State Schema (`SafePlaybackState`)
```json
{
  "currentVideoId": "dQw4w9WgXcQ",
  "currentTimestamp": 45.5,
  "isPlaying": true,
  "playbackRate": 1.0,
  "lastSyncAt": "2026-10-27T05:20:00.000Z",
  "serverTime": 1793078400000,
  "syncToken": "optional-client-token"
}
```

### 4. Participant Control Request Workflow
Participants cannot directly alter playback; they submit requests to the room queue. The Host or a Moderator can view and resolve requests.

| Event | Direction | Payload | Description |
|---|---|---|---|
| `request:create` | Client → Server | `{ type: "PLAY" \| "PAUSE" \| "SEEK" \| "CHANGE_VIDEO", targetTimestamp?: number, targetVideoId?: string }` | Submits a playback request. |
| `request:list` | Client → Server | `{ status?: "PENDING" \| "APPROVED" \| "REJECTED" }` | Lists control requests for the room. |
| `request:approve` | Client → Server | `{ requestId: string }` | Approves request. Validates and executes action atomically in a DB transaction. |
| `request:reject` | Client → Server | `{ requestId: string }` | Rejects request with status `REJECTED`. Playback remains unchanged. |
| `request:resolve` | Client → Server | `{ requestId: string, action: "APPROVE" \| "REJECT" }` | Generic resolution endpoint. |
| `request:created` | Server → Client (Broadcast) | `{ request: SafeControlRequest }` | Broadcast to room members when a new request is submitted. |
| `request:resolved` | Server → Client (Broadcast) | `{ request: SafeControlRequest }` | Broadcast to room members when a request is resolved. |

#### Atomic Concurrency & Single-Resolution Guarantee
To prevent race conditions where multiple moderators approve or reject the same request simultaneously, resolution uses atomic conditional updates at the PostgreSQL level:
```sql
UPDATE "ControlRequest"
SET status = $1, "resolvedAt" = $2
WHERE id = $3 AND status = 'PENDING';
```
If another moderator resolved the request first, zero rows are affected and subsequent callers receive an `ALREADY_RESOLVED` error response.

### 5. Host Lifecycle & Ownership Transfer (Host Only)
A room always has exactly **one** Host. When the current Host transfers ownership:
- The target participant is promoted to `HOST`.
- The caller is atomically demoted to `MODERATOR`, retaining playback control capabilities while surrendering room administrative controls.
- The single-host invariant is protected via atomic conditional queries (`updateMany` where `role = 'HOST'`).

| Event / Route | Direction | Payload | Description |
|---|---|---|---|
| `POST /api/rooms/:code/transfer-host` | REST Client → Server | `{ targetParticipantId: string }` | Transfers room host ownership via session-authenticated REST endpoint. |
| `room:transfer-host` | Socket Client → Server | `{ targetParticipantId: string }` | Transfers host ownership via real-time WebSocket event. |
| `room:host-transferred` | Server → Client (Broadcast) | `{ previousHostId, newHostId, newHostDisplayName }` | Broadcast to all room members upon successful host transfer. |

---

## Repository Structure

```
Web3Task/
├── client/                     # Frontend Single Page Application (React 19 + Vite)
│   ├── public/                 # Static public assets (herosection2.png, favicon)
│   ├── src/
│   │   ├── components/         # Reusable UI components
│   │   │   ├── ChangeVideoModal.tsx       # YouTube URL input & video loader modal
│   │   │   ├── CinematicPlayer.tsx        # YouTube IFrame player & playback synchronizer
│   │   │   ├── ControlRequestsModal.tsx   # Request submission & review dialog
│   │   │   ├── LandingPage.tsx            # Hero, How It Works, Features & room creation form
│   │   │   ├── Lobby.tsx                  # Fallback room join/create modal
│   │   │   ├── Navbar.tsx                 # Watch room header & navigation
│   │   │   ├── ParticipantRoster.tsx      # Member roster, role indicators & host controls
│   │   │   ├── RoleRequestPopup.tsx       # Role upgrade request notification popup
│   │   │   └── Toast.tsx                  # Non-blocking notification toasts
│   │   ├── hooks/              # Custom React hooks
│   │   │   ├── useWatchPartySocket.ts     # Socket.IO connection & event synchronization
│   │   │   └── useYouTubeIframe.ts        # YouTube IFrame Player API lifecycle hook
│   │   ├── services/           # REST API client
│   │   │   └── api.ts                     # Fetch client wrapper for /api/rooms
│   │   ├── types/              # Frontend TypeScript definitions
│   │   │   └── room.ts                    # Shared types (Room, Participant, SafePlaybackState)
│   │   ├── App.tsx             # Root application orchestrator
│   │   ├── index.css           # Global design system tokens & watch room styling
│   │   ├── landing.css         # Landing page and hero styles
│   │   └── main.tsx            # React application DOM entry point
│   ├── index.html              # Vite HTML template
│   ├── package.json            # Client dependencies & scripts
│   ├── tsconfig.json           # Client TypeScript configuration
│   └── vercel.json             # Vercel client-scoped rewrite rules
├── server/                     # Backend API & WebSocket Server (Node.js + Express)
│   ├── prisma/
│   │   ├── migrations/         # PostgreSQL database migration history
│   │   └── schema.prisma       # Prisma data model (Room, Participant, ControlRequest)
│   ├── src/
│   │   ├── config/             # Database configuration
│   │   │   └── prisma.ts                  # Shared PrismaClient singleton instance
│   │   ├── controllers/        # REST route handlers
│   │   │   └── room.controller.ts         # Handlers for room creation, join, roles, host transfer
│   │   ├── middleware/         # HTTP request middleware
│   │   │   └── auth.js                    # Session token authentication & role authorization
│   │   ├── routes/             # REST routing definitions
│   │   │   └── room.routes.ts             # Express router mounting /api/rooms endpoints
│   │   ├── services/           # Business logic & security utilities
│   │   │   └── room.service.ts            # Core room lifecycle, code generation & token hashing
│   │   ├── socket/             # Socket.IO real-time event handlers
│   │   │   ├── playback.handler.ts        # Playback sync events (play, pause, seek, rate)
│   │   │   ├── playback.types.ts          # Playback data schemas
│   │   │   ├── registry.ts                # Active socket connection registry
│   │   │   ├── request.handler.ts         # Control request queue handlers (create, approve, reject)
│   │   │   └── room.handler.ts            # Socket auth middleware, room join/leave handlers
│   │   ├── types/              # Server TypeScript interfaces
│   │   ├── utils/              # Cryptographic helper functions
│   │   └── index.ts            # Application bootstrap (Express, HTTP server, Socket.IO)
│   ├── package.json            # Server dependencies & scripts
│   └── tsconfig.json           # Server TypeScript configuration
├── image/                      # Source graphic assets (herosection.png, herosection2.png)
├── render.yaml                 # Render Infrastructure-as-Code deployment blueprint
├── vercel.json                 # Monorepo root Vercel build & routing configuration
├── package-lock.json           # Monorepo dependency lockfile
├── package.json                # Root npm workspaces configuration
└── README.md                   # Comprehensive project documentation
```

---

## Prerequisites

Before running the application locally, ensure you have:

- **Node.js:** v20.x or higher (LTS recommended; compatible with Node 20, 22, and 24).
- **npm:** v10.x or higher (npm workspaces support required).
- **PostgreSQL Database:** A running PostgreSQL instance (PostgreSQL 14+) or a free cloud database instance from [Neon](https://neon.tech/).
- **Git:** Installed on your local machine.

Verify your local Node and npm installations:
```bash
node -v
npm -v
```

---

## Local Development Setup

### 1. Clone the Repository
```bash
git clone https://github.com/parampreet0077/web3task_yt_watch_party.git
cd web3task_yt_watch_party
```

### 2. Install Monorepo Dependencies
From the repository root, install dependencies across both `client` and `server` workspaces using npm:
```bash
npm install
```
*(Dependencies are hoisted to the root `node_modules` via npm workspaces).*

### 3. Configure Environment Variables
Create `.env` files for both the frontend and backend using the provided templates:

#### Backend Environment (`server/.env`)
Create `server/.env`:
```env
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:5173
DATABASE_URL="postgresql://username:password@ep-sample-pooler.region.neon.tech/neondb?sslmode=require"
CHECKPOINT_DISABLE=1
```
> Replace the placeholder `DATABASE_URL` with your actual PostgreSQL connection string.

#### Frontend Environment (`client/.env`)
Create `client/.env`:
```env
VITE_BACKEND_URL=http://localhost:5000
VITE_SOCKET_URL=http://localhost:5000
```

### 4. Database Initialization & Prisma Client Generation
Generate the Prisma Client and apply migrations to your database from the repository root:
```bash
# 1. Generate Prisma Client
npm run prisma:generate

# 2. Apply existing schema migrations to your database
npm run prisma:deploy
```

> **For Local Development Schema Changes:** Use `npm run prisma:migrate --workspace=server` if you are modifying `schema.prisma`. Never use `prisma migrate dev` on production databases.

### 5. Run the Application Locally
You can run both the frontend and backend concurrently from the root directory:
```bash
npm run dev
```

Alternatively, run each workspace in a separate terminal:
```bash
# Terminal 1: Start backend Express & Socket.IO server (http://localhost:5000)
npm run dev:server

# Terminal 2: Start frontend Vite dev server (http://localhost:5173)
npm run dev:client
```

Open [http://localhost:5173](http://localhost:5173) in your browser to view the application.

---

## Environment Variables Reference

### Backend (`server/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | Optional | `5000` | Port on which Express and Socket.IO listen. (Render assigns this automatically in production). |
| `NODE_ENV` | Optional | `development` | Runtime environment mode (`development`, `production`, `test`). |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string. In Neon, use the pooled endpoint (`-pooler` domain with `?sslmode=require`). |
| `CLIENT_URL` | Optional | `http://localhost:5173` | Allowed CORS origins for HTTP and Socket.IO. Supports comma-separated origins and wildcards (e.g. `https://*.vercel.app`). |
| `CHECKPOINT_DISABLE` | Optional | `1` | Disables Prisma CLI telemetry network requests during startup. |

### Frontend (`client/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_BACKEND_URL` | **Yes** | `http://localhost:5000` | Base URL for REST API endpoints (`/api/rooms`, `/api/health`). |
| `VITE_SOCKET_URL` | Optional | `VITE_BACKEND_URL` | Base URL for Socket.IO WebSocket connections. Falls back to `VITE_BACKEND_URL` if omitted. |

> **Security Rule:** Never commit `.env` files to Git. Both `client/.env` and `server/.env` are listed in `.gitignore` to prevent credential exposure.

---

## Production Deployment Guide

### Deployment Architecture Matrix

| Component | Platform | Root Directory | Build Command | Start Command / Output Directory | Key Environment Variables |
|---|---|---|---|---|---|
| **Frontend** | Vercel | `client` | `npm run build` | `dist` | `VITE_BACKEND_URL`, `VITE_SOCKET_URL` |
| **Backend** | Render | *(leave blank / root)* | `npm ci --include=dev && npm run build:server` | `npm run prisma:deploy && npm run start:server` | `NODE_ENV`, `PORT`, `DATABASE_URL`, `CLIENT_URL` |
| **Database** | Neon | *(serverless)* | — | PostgreSQL Port 5432 / 6543 | `DATABASE_URL` (SSL required) |

### 1. Database (Neon Serverless PostgreSQL)
1. Create a project in [Neon Console](https://console.neon.tech/).
2. Copy the **Pooled Connection String** (format: `postgresql://user:password@ep-xyz-pooler.region.neon.tech/neondb?sslmode=require`).
3. Apply migrations to your production database:
   ```bash
   npm run prisma:deploy
   ```

### 2. Backend Web Service (Render)
> **npm Workspaces Notice:** Because dependencies are managed at the monorepo root, do **not** set Render's Root Directory to `server`. Leave it as the root directory so Render has full access to `package-lock.json`.

1. In [Render Dashboard](https://dashboard.render.com/), create a new **Web Service** connected to your repository.
2. Configure settings:
   - **Name:** `watchparty-backend`
   - **Runtime:** `Node`
   - **Branch:** `main`
   - **Root Directory:** *(leave blank / root)*
   - **Build Command:** `npm ci --include=dev && npm run build:server`
   - **Start Command:** `npm run prisma:deploy && npm run start:server`
3. Add Environment Variables:
   - `NODE_ENV`: `production`
   - `DATABASE_URL`: Your Neon pooled connection string.
   - `CLIENT_URL`: `https://web3task-watch-party.vercel.app` (or your Vercel deployment URL).
   - `CHECKPOINT_DISABLE`: `1`
4. Set Health Check Path: `/api/health`.

### 3. Frontend Web Service (Vercel)
1. In [Vercel Dashboard](https://vercel.com/), click **Add New Project** and import the repository.
2. In Project Settings:
   - **Root Directory:** Edit and select `client`. (Vercel automatically detects Vite and the root workspace lockfile).
   - **Framework Preset:** `Vite`
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
3. Add Environment Variables:
   - `VITE_BACKEND_URL`: `https://watchparty-backend-kipa.onrender.com`
   - `VITE_SOCKET_URL`: `https://watchparty-backend-kipa.onrender.com`
4. Deploy. Single Page Application routing is governed by `client/vercel.json` (`/(.*) -> /index.html`).

---

## Testing & Quality Assurance

The backend includes automated test suites verifying REST API contracts, Socket.IO room isolation, playback synchronization, drift bounding, and host ownership transfer:

```bash
# Run all automated test suites across the monorepo
npm run test:all --workspace=server

# Run Host Lifecycle & Concurrency tests
npm run test:host --workspace=server

# Run Playback Synchronization & Drift Correction tests
npm run test:playback --workspace=server

# Run Secure Room Membership & Socket Authentication tests
npm run test:socket --workspace=server

# Run REST API integration tests
npm run test:rest --workspace=server

# Run Frontend Production Build & Typecheck
npm run build:client

# Run Frontend Linter (Oxlint)
npm run lint --workspace=client
```

---

## Troubleshooting & FAQ

### 1. Room creation takes 30–50 seconds on first attempt
- **Cause:** Render Free Tier spins down inactive web services after 15 minutes of idle time. The delay is caused by server cold-booting.
- **Solution:** This is normal behavior on free cloud instances. The UI includes a progress indicator requesting users to keep the page open. Once awake, subsequent room creations and API calls respond promptly.

### 2. CORS Error or WebSocket connection refused
- **Symptom:** Browser console logs `CORS origin 'https://...' not permitted` or Socket.IO fails to connect.
- **Cause:** The backend's `CLIENT_URL` environment variable does not match the frontend's origin URL.
- **Solution:** Verify the `CLIENT_URL` variable in your Render dashboard matches your frontend domain (e.g., `https://web3task-watch-party.vercel.app`). The server automatically handles trailing slashes and supports wildcard subdomains.

### 3. YouTube video does not start playing automatically
- **Cause:** Modern browsers (Chrome, Safari, Edge) block programmatic video playback with sound until the user interacts with the document.
- **Solution:** Click anywhere on the player or use the "Click to sync" overlay button. Once user interaction is registered, synchronized playback proceeds seamlessly.

### 4. Database connection errors (`Can't reach database server` / `SSL required`)
- **Cause:** Neon requires SSL mode, and serverless environments require pooled connections to prevent connection exhaustion.
- **Solution:** Ensure your `DATABASE_URL` uses the pooled endpoint (the hostname includes `-pooler`) and ends with `?sslmode=require`.

### 5. `PrismaClientInitializationError` after pulling changes
- **Cause:** The local Prisma Client has not been generated from the updated schema.
- **Solution:** Run `npm run prisma:generate` from the repository root to regenerate the client bindings.

---

## License

This project was developed for the **Web3Task Full Stack Intern** assessment.
