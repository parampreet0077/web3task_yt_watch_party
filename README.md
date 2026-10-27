# YouTube Watch Party — Real-Time Video Synchronization

A production-ready synchronized YouTube watch room application built for the Web3Task Full Stack Intern assignment.

## Current Status: Phase 5.1 — Authoritative Playback Synchronization Backend

The application implements a secure, monolithic, real-time backend supporting:
- REST APIs for room creation, participant joining, role updates, and member removal.
- Cryptographically hashed room-scoped session tokens (SHA-256 with constant-time verification).
- Socket.IO connection authentication, server-enforced room isolation, and multi-tab connection tracking.
- Authoritative server-side playback synchronization (`PLAY`, `PAUSE`, `SEEK`, `CHANGE_VIDEO`, `SET_RATE`).
- Participant control request & approval workflow with atomic status transitions.

---

### Architecture Overview

- **Monorepo:** npm workspaces (`client`, `server`)
- **Frontend (`client/`):** React 19, TypeScript, Vite, Motion for React, Socket.IO Client
- **Backend (`server/`):** Node.js, Express, TypeScript, Socket.IO, Prisma Client 6, `tsx` watcher
- **Database:** PostgreSQL (Neon serverless connection pooler) via Prisma ORM
- **Styling:** Custom CSS design system with cinematic surfaces, off-white background, and indigo accents
- **Deployment:** Vercel (Frontend) and Render (Backend)

---

## Playback Synchronization & Real-Time Event Protocol

### 1. Connection & Handshake Authentication
All Socket.IO connections must provide a valid room-scoped session token. Client-supplied participant IDs and roles are never trusted.

```typescript
const socket = io("http://localhost:5000", {
  auth: {
    token: "<64-character-hex-session-token>",
    roomCode: "ABCDEF", // Optional cross-verification
  },
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
Participants cannot directly alter playback; they must submit requests. The Host or a Moderator can view and resolve requests.

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
`UPDATE "ControlRequest" SET status = $1, "resolvedAt" = $2 WHERE id = $3 AND status = 'PENDING'`
If another moderator resolved the request first, zero rows are affected and subsequent callers receive an `ALREADY_RESOLVED` error.

---

### 5. Host Lifecycle & Ownership Transfer (Host Only)
A room always has exactly **one** Host. When the current Host transfers ownership:
- The caller is atomically demoted to `MODERATOR`.
- The target participant is promoted to `HOST`.
- The single-host invariant is protected via atomic conditional queries (`updateMany` where `role = 'HOST'`).
- The former Host transitions to `MODERATOR`, retaining playback control capabilities while surrendering room administrative controls.

| Event / Route | Direction | Payload | Description |
|---|---|---|---|
| `POST /api/rooms/:code/transfer-host` | REST Client → Server | `{ targetParticipantId: string }` | Transfers room host ownership via session-authenticated REST endpoint. |
| `room:transfer-host` | Socket Client → Server | `{ targetParticipantId: string }` | Transfers host ownership via real-time WebSocket event. |
| `room:host-transferred` | Server → Client (Broadcast) | `{ previousHostId, newHostId, newHostDisplayName }` | Broadcast to all room members upon successful host transfer. |

---

## Testing & Quality Assurance

Run all test suites across the monorepo:

```bash
# Run all automated tests (107 tests across REST, Sockets, Playback, and Host Lifecycle)
npm run test:all --workspace=server

# Run Phase 6.1 Host Lifecycle & Concurrency tests (30 tests)
npm run test:host --workspace=server

# Run Phase 5.1 Playback Synchronization tests (33 tests)
npm run test:playback --workspace=server

# Run Phase 4.2 Secure Room Membership tests (24 tests)
npm run test:socket --workspace=server

# Run Phase 4.1 REST API tests (20 tests)
npm run test:rest --workspace=server
```

---

## Production Deployment Guide

### Architecture Matrix
| Component | Platform | Root Directory | Build Command | Start Command / Output Directory | Key Environment Variables |
|---|---|---|---|---|---|
| **Frontend** | Vercel | `client` | `npm run build` | `dist` | `VITE_BACKEND_URL`, `VITE_SOCKET_URL` |
| **Backend** | Render | *(leave blank / root)* | `npm ci && npm run build:server` | `npm run start:server` | `NODE_ENV=production`, `PORT=10000`, `DATABASE_URL`, `CLIENT_URL` |
| **Database** | Neon | *(serverless)* | — | Port 5432 / 6543 pooler | `DATABASE_URL` (SSL required) |

### 1. Database (Neon PostgreSQL)
1. Ensure your Neon database project is active.
2. In production, always use the **pooled connection string** (the domain containing `-pooler` with `?sslmode=require`).
3. Apply existing schema migrations safely from the repository root:
   ```bash
   npm run prisma:deploy
   ```
   *(Internally invokes `prisma migrate deploy` inside `server/`. Never use `prisma migrate dev` or `prisma migrate reset` in production).*

### 2. Backend (Render Web Service)
> **Important npm Workspaces Note:** Because this repository uses npm workspaces, dependencies are hoisted and locked in the repository root (`package-lock.json`). Do **not** set Render's Root Directory to `server`. Leave it as the repository root so Render has full access to the root lockfile.

1. Create a new **Web Service** on Render connected to this repository.
2. Configure core settings:
   - **Name:** `watchparty-backend`
   - **Region:** Nearest region to your Neon DB (e.g. `Oregon (US West)` or `Frankfurt (EU)`)
   - **Branch:** `main` (or `master`)
   - **Root Directory:** *(leave completely blank / default root)*
   - **Runtime:** `Node`
   - **Build Command:** `npm ci --include=dev && npm run build:server`
   - **Start Command:** `npm run start:server`
3. Configure Environment Variables:
   - `NODE_ENV`: `production`
   - `DATABASE_URL`: `postgresql://<user>:<password>@<neon-host>-pooler.tech/neondb?sslmode=require`
   - `CLIENT_URL`: `https://<your-vercel-app>.vercel.app` (supports comma-separated origins)
4. Set **Health Check Path**: `/api/health`.
5. Pre-Deploy / Migration Step: In the Render dashboard, under **Settings > Pre-Deploy Command**, enter:
   ```bash
   npm run prisma:deploy
   ```

### 3. Frontend (Vercel)
1. Import this Git repository into **Vercel**.
2. In the project configuration screen:
   - **Root Directory:** Click `Edit` and select `client`. (Vercel automatically detects the root `package-lock.json` and configures Vite monorepo workspace caching).
   - **Framework Preset:** `Vite`
   - **Build Command:** `npm run build` (or leave default)
   - **Output Directory:** `dist`
3. Configure Environment Variables:
   - `VITE_BACKEND_URL`: `https://<your-render-service>.onrender.com`
   - `VITE_SOCKET_URL`: `https://<your-render-service>.onrender.com`
4. Deploy. Single-page application route rewrites are automatically governed by `client/vercel.json` (`/(.*) -> /index.html`).

---

## Verification & Health Endpoints

- **Backend Health Check:** `GET /api/health`
  - Returns `{ status: "ok", service: "watch-party-backend", uptimeSeconds: <number>, timestamp: "<iso-string>" }`
- **Socket.IO Event Handshake:** Emits `health:ready` event upon client connection with active socket ID.
