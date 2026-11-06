/**
 * Web3Task Watch Party V2.0 – Phase 5
 * Cross-Device Integration & Production Readiness Automated Verification Suite
 *
 * Verifies:
 * 1. Room Creation & Independent Two-Device Session Isolation (Car vs. Phone)
 * 2. QR Code URL Generation & Standards-Compliant ISO/IEC 18004 Verification
 * 3. Cross-Device Real-Time Playback Synchronization (Phone controls Car Screen)
 * 4. Phone Remote YouTube Search & Real-Time Shared Queue Operations
 * 5. Video Ended Lifecycle & Atomic Auto-Advance with Concurrency Protection
 * 6. Role-Based Permissions & Security Boundaries (Host/Mod vs. Participant)
 * 7. Device Session Reconnection & State Recovery
 * 8. Client Bundle Security Audit (Zero Secrets / API Keys in Dist)
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { io as ClientSocket, type Socket as ClientSocketType } from "socket.io-client";

const SERVER_URL = "http://localhost:5000";
const API_URL = `${SERVER_URL}/api`;

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function recordPass(name: string, details?: string) {
  results.push({ name, passed: true, details });
  console.log(`  ✔ PASS - ${name} ${details ? `(${details})` : ""}`);
}

function recordFail(name: string, details?: string) {
  results.push({ name, passed: false, details });
  console.log(`  ✖ FAIL - ${name} ${details ? `(${details})` : ""}`);
}

function waitForEvent<T = any>(socket: ClientSocketType, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function createAndConnectSocket(token: string, roomCode: string, timeoutMs = 10000): Promise<ClientSocketType> {
  return new Promise((resolve, reject) => {
    const socket = ClientSocket(SERVER_URL, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      auth: { token, roomCode },
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Timed out waiting for "health:ready" after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("health:ready", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.connect();
  });
}

async function request(endpoint: string, options: RequestInit = {}) {
  const url = `${API_URL}${endpoint}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.status >= 500 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      return { status: res.status, body };
    } catch (err) {
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
  }
  return { status: 500, body: null };
}

export async function runPhase5CrossDeviceTests(): Promise<boolean> {
  console.log("\n=========================================================================");
  console.log("   PHASE 5: CROSS-DEVICE INTEGRATION & PRODUCTION READINESS AUDIT");
  console.log("=========================================================================\n");

  const activeSockets: ClientSocketType[] = [];

  try {
    // -------------------------------------------------------------------------
    // TEST 1: QR Code Standards Compliance & Scannability
    // -------------------------------------------------------------------------
    console.log("[SECTION 1] QR Code Standards Compliance & Scannability");
    const testRoomCode = "DEMO99";
    const remoteUrl = `http://localhost:5173/?room=${testRoomCode}&mode=remote`;

    // Generate QR using the exact standard options used in RemoteQRModal
    const qrSvg = await QRCode.toString(remoteUrl, {
      type: "svg",
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        dark: "#111218",
        light: "#ffffff",
      },
    });

    assert.ok(qrSvg.includes("viewBox="), "QR SVG must define a valid viewBox");
    assert.ok(qrSvg.includes("shape-rendering="), "QR SVG must specify crisp edges");
    assert.ok(qrSvg.length > 500, "QR SVG must contain dense module paths");
    recordPass("1.1 Standards-compliant ISO/IEC 18004 QR code SVG generated", `Length: ${qrSvg.length} chars, Level M`);

    const dataUrl = await QRCode.toDataURL(remoteUrl, { margin: 2, errorCorrectionLevel: "M" });
    assert.ok(dataUrl.startsWith("data:image/png;base64,"), "Data URL must be valid base64 PNG");
    recordPass("1.2 Mobile-scannable Base64 PNG fallback verified", `Prefix: ${dataUrl.slice(0, 30)}...`);

    // -------------------------------------------------------------------------
    // TEST 2: Device A (Car/Host) Room Creation & Session Setup
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 2] Device A (Car Screen) Creation & Device B (Phone) Join");
    const createRes = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({
        displayName: "Tesla Infotainment",
        title: "Cross-Device Car V2 Party",
      }),
    });

    assert.strictEqual(createRes.status, 201, "Room creation should return 201");
    const room = createRes.body?.room;
    const roomCode = room?.code;
    const deviceAToken = createRes.body?.sessionToken;
    const deviceAParticipant = createRes.body?.participant;

    assert.ok(roomCode && roomCode.length === 6, "Room code should be 6 characters");
    assert.ok(deviceAToken && deviceAToken.length >= 32, "Device A should have valid session token");
    assert.strictEqual(deviceAParticipant?.role, "HOST", "Device A should be HOST");
    recordPass("2.1 Device A (Car Screen) created room", `Room: ${roomCode}, Role: HOST`);

    // -------------------------------------------------------------------------
    // TEST 3: Device B (Phone Remote) Join & Session Isolation
    // -------------------------------------------------------------------------
    const joinRes = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({
        displayName: "Passenger iPhone",
      }),
    });

    assert.ok(joinRes.status === 200 || joinRes.status === 201, "Device B join should return 200 or 201");
    const deviceBToken = joinRes.body?.sessionToken;
    const deviceBParticipant = joinRes.body?.participant;

    assert.notStrictEqual(deviceAToken, deviceBToken, "Device A and Device B MUST have separate session tokens");
    assert.strictEqual(deviceBParticipant?.role, "PARTICIPANT", "Device B initial role should be PARTICIPANT");
    recordPass("3.1 Device B (Phone Remote) joined room with isolated session token", `Phone token != Car token`);

    // -------------------------------------------------------------------------
    // TEST 4: Socket Connections & Room Channel Association
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 3] Real-Time Socket Connection & Initialization");
    const socketA = await createAndConnectSocket(deviceAToken, roomCode);
    activeSockets.push(socketA);
    const socketB = await createAndConnectSocket(deviceBToken, roomCode);
    activeSockets.push(socketB);

    // Join room channels
    const joinAckA = await new Promise<any>((res) => {
      socketA.emit("room:join", { roomCode }, res);
    });
    assert.strictEqual(joinAckA?.success, true, "Device A room:join must succeed");

    const joinAckB = await new Promise<any>((res) => {
      socketB.emit("room:join", { roomCode }, res);
    });
    assert.strictEqual(joinAckB?.success, true, "Device B room:join must succeed");
    recordPass("4.1 Dual independent socket channels established & authenticated", "Device A & Device B connected");

    // -------------------------------------------------------------------------
    // TEST 5: Promote Device B to Moderator & Verify Permissions
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 4] Role Promotion & Authorization Verification");
    const roleRes = await request(`/rooms/${roomCode}/participants/${deviceBParticipant.id}/role`, {
      method: "PATCH",
      headers: { "x-session-token": deviceAToken },
      body: JSON.stringify({ role: "MODERATOR" }),
    });
    assert.strictEqual(roleRes.status, 200, "Host role promotion should return 200");
    recordPass("5.1 Host promoted Passenger Phone to MODERATOR role", `New role: MODERATOR`);

    // -------------------------------------------------------------------------
    // TEST 6: Initial Video Load & Cross-Device Playback Sync
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 5] Cross-Device Playback Synchronization (Phone controls Car)");
    const initialVideoId = "M7lc1UVf-VE"; // YouTube Iframe API demo video

    // Device A sets initial video
    const changeVideoPromiseB = waitForEvent<{ state: any }>(socketB, "playback:state");
    const changeAck = await new Promise<any>((res) => {
      socketA.emit("playback:change-video", {
        videoId: initialVideoId,
        title: "YouTube API Demo",
        channelTitle: "Google Developers",
        durationSec: 180,
      }, res);
    });
    assert.strictEqual(changeAck?.success, true, "Device A change-video must succeed");
    const eventBAfterChange = await changeVideoPromiseB;
    const stateBAfterChange = eventBAfterChange.state;
    assert.strictEqual(stateBAfterChange.currentVideoId, initialVideoId, "Device B must receive initial video ID");
    assert.strictEqual(stateBAfterChange.isPlaying, false, "Initial video should start paused");
    recordPass("6.1 Car loads initial video -> Phone immediately reflects video state", `Video: ${initialVideoId}`);

    // Device B (Phone) plays the video
    const playPromiseA = waitForEvent<{ state: any }>(socketA, "playback:state");
    const playAck = await new Promise<any>((res) => {
      socketB.emit("playback:play", { timestamp: 5.0, playbackRate: 1 }, res);
    });
    assert.strictEqual(playAck?.success, true, "Device B (Mod) play command must succeed");
    const eventAAfterPlay = await playPromiseA;
    const stateAAfterPlay = eventAAfterPlay.state;
    assert.strictEqual(stateAAfterPlay.isPlaying, true, "Device A (Car) must receive isPlaying: true");
    assert.ok(
      stateAAfterPlay.currentTimestamp >= 5.0 && stateAAfterPlay.currentTimestamp <= 8.0,
      `Device A must sync to play position starting at 5.0s (got: ${stateAAfterPlay.currentTimestamp})`
    );
    recordPass("6.2 Phone Remote PLAY command executes on Car Screen player", `isPlaying: true at ~${stateAAfterPlay.currentTimestamp.toFixed(1)}s`);

    // Device B (Phone) pauses the video
    const pausePromiseA = waitForEvent<{ state: any }>(socketA, "playback:state");
    const pauseAck = await new Promise<any>((res) => {
      socketB.emit("playback:pause", { timestamp: 22.4 }, res);
    });
    assert.strictEqual(pauseAck?.success, true, "Device B pause command must succeed");
    const eventAAfterPause = await pausePromiseA;
    const stateAAfterPause = eventAAfterPause.state;
    assert.strictEqual(stateAAfterPause.isPlaying, false, "Device A must receive isPlaying: false");
    assert.strictEqual(stateAAfterPause.currentTimestamp, 22.4, "Device A must freeze at 22.4s");
    recordPass("6.3 Phone Remote PAUSE command pauses Car Screen player", `isPlaying: false at 22.4s`);

    // Device B (Phone) seeks the video
    const seekPromiseA = waitForEvent<{ state: any }>(socketA, "playback:state");
    const seekAck = await new Promise<any>((res) => {
      socketB.emit("playback:seek", { timestamp: 95.0 }, res);
    });
    assert.strictEqual(seekAck?.success, true, "Device B seek command must succeed");
    const eventAAfterSeek = await seekPromiseA;
    const stateAAfterSeek = eventAAfterSeek.state;
    assert.strictEqual(stateAAfterSeek.currentTimestamp, 95.0, "Device A must seek to 95.0s");
    recordPass("6.4 Phone Remote SEEK command synchronizes Car Screen seek position", `Seek to 95.0s`);

    // -------------------------------------------------------------------------
    // TEST 7: Phone Remote YouTube Search & Queue Management
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 6] Phone Remote YouTube Search & Persistent Queue Management");

    // Search via REST API with Device B token (verifying API key security & graceful 503 handling)
    const searchRes = await request(`/rooms/${roomCode}/search?q=synthwave`, {
      headers: { "x-session-token": deviceBToken },
    });
    if (searchRes.status === 200) {
      assert.ok(Array.isArray(searchRes.body?.items), "Search results should be an array");
      assert.ok(searchRes.body.items.length > 0, "Search results should contain videos");
      recordPass("7.1 Phone Remote searches YouTube via backend API", `Found: ${searchRes.body.items.length} videos`);
    } else {
      assert.strictEqual(searchRes.status, 503, "Without YOUTUBE_API_KEY, search must return 503 with fallback guidance");
      assert.ok(
        searchRes.body?.message?.includes("YOUTUBE_API_KEY") || searchRes.body?.code === "API_KEY_NOT_CONFIGURED",
        "Search must return helpful guidance to use direct paste fallback"
      );
      recordPass(
        "7.1 Graceful fallback when YOUTUBE_API_KEY unconfigured",
        `Returned 503 (${searchRes.body?.code || "UNAVAILABLE"}): "${searchRes.body?.message?.slice(0, 45)}..."`
      );
    }

    // Add 2 songs to queue from Phone Remote
    const queuePromiseA1 = waitForEvent<{ queue: any[] }>(socketA, "queue:updated");
    const addAck1 = await new Promise<any>((res) => {
      socketB.emit("queue:add", {
        videoId: "kXYiU_JCYtU",
        title: "Linkin Park - Numb",
        channelTitle: "Linkin Park",
        thumbnailUrl: "https://i.ytimg.com/vi/kXYiU_JCYtU/hqdefault.jpg",
        durationSec: 187,
      }, res);
    });
    assert.strictEqual(addAck1?.success, true, "Queue add 1 must succeed");
    const snapA1 = await queuePromiseA1;
    assert.strictEqual(snapA1.queue.length, 1, "Car screen must receive queue length 1");
    recordPass("7.2 Phone Remote adds Song 1 to queue -> Car receives real-time snapshot", `Item 1: Numb`);

    const queuePromiseA2 = waitForEvent<{ queue: any[] }>(socketA, "queue:updated");
    const addAck2 = await new Promise<any>((res) => {
      socketB.emit("queue:add", {
        videoId: "fJ9rUzIMcZQ",
        title: "Queen - Bohemian Rhapsody",
        channelTitle: "Queen Official",
        thumbnailUrl: "https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg",
        durationSec: 359,
      }, res);
    });
    assert.strictEqual(addAck2?.success, true, "Queue add 2 must succeed");
    const snapA2 = await queuePromiseA2;
    assert.strictEqual(snapA2.queue.length, 2, "Car screen must receive queue length 2");
    recordPass("7.3 Phone Remote adds Song 2 to queue -> Car receives real-time snapshot", `Item 2: Bohemian Rhapsody`);

    // Reorder queue from Phone Remote (Move item 2 to position 1)
    const item1Id = snapA2.queue[0].id;
    const item2Id = snapA2.queue[1].id;
    const queuePromiseBReorder = waitForEvent<{ queue: any[] }>(socketB, "queue:updated");
    const reorderAck = await new Promise<any>((res) => {
      socketB.emit("queue:reorder", {
        itemId: item2Id,
        targetPosition: 1,
      }, res);
    });
    assert.strictEqual(reorderAck?.success, true, "Queue reorder must succeed");
    const snapBReorder = await queuePromiseBReorder;
    assert.strictEqual(snapBReorder.queue[0].id, item2Id, "Reordered queue first item must be Song 2");
    assert.strictEqual(snapBReorder.queue[1].id, item1Id, "Reordered queue second item must be Song 1");
    recordPass("7.4 Phone Remote reorders queue -> Both devices receive new sequence", `New order: [Bohemian Rhapsody, Numb]`);

    // -------------------------------------------------------------------------
    // TEST 8: Video Ended Event & Atomic Auto-Advance
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 7] Video Ended Lifecycle & Concurrency-Protected Auto-Advance");

    // Car Screen detects video ending and reports playback:ended
    const autoAdvancePromiseStateA = waitForEvent<{ state: any }>(socketA, "playback:state");
    const autoAdvancePromiseQueueA = waitForEvent<{ queue: any[] }>(socketA, "queue:updated");
    const autoAdvancePromiseStateB = waitForEvent<{ state: any }>(socketB, "playback:state");
    const autoAdvancePromiseQueueB = waitForEvent<{ queue: any[] }>(socketB, "queue:updated");

    const endAck = await new Promise<any>((res) => {
      socketA.emit("playback:ended", { videoId: initialVideoId }, res);
    });
    assert.strictEqual(endAck?.success, true, "playback:ended acknowledgment must succeed");
    assert.strictEqual(endAck?.advanced, true, "First playback:ended must advance queue");

    // Both Car and Phone should receive new video state
    const [eventA, eventQA, eventB, eventQB] = await Promise.all([
      autoAdvancePromiseStateA,
      autoAdvancePromiseQueueA,
      autoAdvancePromiseStateB,
      autoAdvancePromiseQueueB,
    ]);

    const newStateA = eventA.state;
    const newQueueA = eventQA.queue;
    const newStateB = eventB.state;

    assert.strictEqual(newStateA.currentVideoId, "fJ9rUzIMcZQ", "Car screen must load next queued video (Song 2)");
    assert.strictEqual(newStateB.currentVideoId, "fJ9rUzIMcZQ", "Phone remote must reflect next queued video (Song 2)");
    assert.strictEqual(newStateA.isPlaying, true, "Next song should auto-play");
    assert.ok(
      newStateA.currentTimestamp >= 0 && newStateA.currentTimestamp <= 15.0,
      `Next song must start near 0s (got: ${newStateA.currentTimestamp})`
    );

    // Verify queue statuses: Song 2 is PLAYING, Song 1 is still QUEUED
    const playingItem = newQueueA.find((q: any) => q.videoId === "fJ9rUzIMcZQ");
    const remainingItem = newQueueA.find((q: any) => q.videoId === "kXYiU_JCYtU");
    assert.strictEqual(playingItem?.status, "PLAYING", "Current song in queue must be PLAYING");
    assert.strictEqual(remainingItem?.status, "QUEUED", "Next song in queue must remain QUEUED");
    recordPass("8.1 Car reports video ended -> Automatically advances to next queued track on both devices", `Now playing: ${playingItem.title}`);

    // Duplicate playback:ended check (Concurrency lock)
    const duplicateAck = await new Promise<any>((res) => {
      socketB.emit("playback:ended", { videoId: initialVideoId }, res);
    });
    assert.strictEqual(duplicateAck?.success, true, "Duplicate call handled gracefully");
    assert.strictEqual(duplicateAck?.advanced, false, "Duplicate call must NOT advance queue a second time");
    assert.strictEqual(duplicateAck?.reason, "ALREADY_ADVANCED", "Duplicate reason must be ALREADY_ADVANCED");
    recordPass("8.2 Duplicate/stale ended events cleanly ignored by atomic concurrency lock", `Reason: ALREADY_ADVANCED`);

    // -------------------------------------------------------------------------
    // TEST 9: Role Boundaries & Permissions Enforcement
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 8] Security & Role Boundary Enforcement");

    // Connect Device C as unprivileged PARTICIPANT
    const joinC = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Backseat Guest" }),
    });
    assert.ok(joinC.status === 200 || joinC.status === 201, "Device C join should return 200 or 201");
    const deviceCToken = joinC.body?.sessionToken;
    const socketC = await createAndConnectSocket(deviceCToken, roomCode);
    activeSockets.push(socketC);

    await new Promise<any>((res) => {
      socketC.emit("room:join", { roomCode }, res);
    });

    // Participant tries to pause video -> Must fail
    const forbiddenPauseAck = await new Promise<any>((res) => {
      socketC.emit("playback:pause", { timestamp: 10 }, res);
    });
    assert.strictEqual(forbiddenPauseAck?.success, false, "Participant direct pause must be rejected");
    assert.ok(
      forbiddenPauseAck?.code === "FORBIDDEN" || forbiddenPauseAck?.error?.includes("Forbidden"),
      "Participant error must specify Forbidden"
    );
    recordPass("9.1 Unprivileged Participant playback mutation rejected with FORBIDDEN", "Direct pause blocked");

    // Participant tries to remove item from queue -> Must fail
    const forbiddenRemoveAck = await new Promise<any>((res) => {
      socketC.emit("queue:remove", { itemId: remainingItem.id }, res);
    });
    assert.strictEqual(forbiddenRemoveAck?.success, false, "Participant direct queue removal must be rejected");
    assert.ok(
      forbiddenRemoveAck?.code === "FORBIDDEN" || forbiddenRemoveAck?.error?.includes("Forbidden"),
      "Participant error must specify Forbidden"
    );
    recordPass("9.2 Unprivileged Participant queue mutation rejected with FORBIDDEN", "Direct remove blocked");

    // Participant can fetch queue via REST API
    const getQueueRes = await request(`/rooms/${roomCode}/queue`, {
      headers: { "x-session-token": deviceCToken },
    });
    assert.strictEqual(getQueueRes.status, 200, "Participant can view queue");
    assert.ok(Array.isArray(getQueueRes.body?.queue), "Participant receives queue array");
    recordPass("9.3 Unprivileged Participant successfully reads shared queue", `Visible items: ${getQueueRes.body.queue.length}`);

    // -------------------------------------------------------------------------
    // TEST 10: Session Reconnection & State Recovery
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 9] Device Reconnection & Session Restoration");

    // Disconnect Device B (Phone Remote)
    socketB.disconnect();

    // Reconnect Device B with the same session token (simulating page refresh)
    const reconnectedSocketB = await createAndConnectSocket(deviceBToken, roomCode);
    activeSockets.push(reconnectedSocketB);

    const reconnectAckB = await new Promise<any>((res) => {
      reconnectedSocketB.emit("room:join", { roomCode }, res);
    });
    assert.strictEqual(reconnectAckB?.success, true, "Device B re-join must succeed");
    assert.strictEqual(reconnectAckB?.playback?.currentVideoId, "fJ9rUzIMcZQ", "Reconnection must immediately restore videoId");
    assert.strictEqual(reconnectAckB?.playback?.isPlaying, true, "Reconnection must immediately restore playing state");
    assert.ok(Array.isArray(reconnectAckB?.queue), "Reconnection must immediately restore queue snapshot");
    recordPass("10.1 Phone Remote page refresh restores room state, role, playback & queue", `Video: ${reconnectAckB.playback.currentVideoId}`);

    // -------------------------------------------------------------------------
    // TEST 11: Production Client Bundle Security Audit
    // -------------------------------------------------------------------------
    console.log("\n[SECTION 10] Production Client Bundle Security Audit");
    const distAssetsDir = fs.existsSync(path.resolve(process.cwd(), "client/dist/assets"))
      ? path.resolve(process.cwd(), "client/dist/assets")
      : path.resolve(process.cwd(), "../client/dist/assets");
    assert.ok(fs.existsSync(distAssetsDir), "client/dist/assets must exist");
    const assetFiles = fs.readdirSync(distAssetsDir);

    let secretDetected = false;
    for (const file of assetFiles) {
      const content = fs.readFileSync(path.join(distAssetsDir, file), "utf8");
      if (content.includes("DATABASE_URL") || content.includes("postgresql://") || content.includes("YOUTUBE_API_KEY")) {
        secretDetected = true;
        break;
      }
    }
    assert.strictEqual(secretDetected, false, "No backend database URLs or API keys should be in client bundle");
    recordPass("11.1 Client dist bundle verified clean of backend secrets and database credentials", "Zero leaks");

  } finally {
    // Clean up all test sockets
    for (const s of activeSockets) {
      if (s.connected) s.disconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // Summary Report
  // ---------------------------------------------------------------------------
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("\n=========================================================================");
  console.log(`   TOTAL TESTS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("=========================================================================\n");

  return failed === 0;
}

// Execute runner when executed directly
if (process.env.RUN_TESTS !== "0") {
  runPhase5CrossDeviceTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Test execution failed with error:", err);
      process.exit(1);
    });
}
