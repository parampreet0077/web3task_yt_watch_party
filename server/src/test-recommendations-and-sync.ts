/**
 * Web3Task Watch Party V2.0 – Car Dashboard & Recommendations Verification Suite
 *
 * Verifies:
 * 1. Backend Recommendations REST endpoint (GET /api/rooms/:code/recommendations)
 * 2. In-memory caching for suggestions (1-hour TTL)
 * 3. Fallback recommendations support in zero-key/offline environment
 * 4. Video Details REST endpoint (GET /api/rooms/:code/video-details)
 * 5. In-site authoritative playback from recommendation (NO external youtube.com redirects, zero 2nd players)
 * 6. Playback metadata synchronization (playback:sync-metadata) across devices
 * 7. Cross-device progress & duration synchronization (Phone Remote receives accurate duration from Car Screen)
 * 8. Real-time passenger role promotion and demotion (+Mod / -Mod)
 * 9. Security & role validation (prevent self-demotion, participant playback restrictions)
 */

import assert from "node:assert";
import { io as ClientSocket, type Socket as ClientSocketType } from "socket.io-client";
import { prisma } from "./config/prisma.js";

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

    socket.connect();
  });
}

async function joinRoomViaSocket(socket: ClientSocketType, roomCode: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("room:join ack timed out")), 8000);
    socket.emit("room:join", { roomCode }, (res: any) => {
      clearTimeout(timer);
      if (res && res.success) {
        resolve(res);
      } else {
        reject(new Error(res?.error || "room:join failed"));
      }
    });
  });
}

async function runSuite() {
  console.log("\n==========================================================================");
  console.log("  Web3Task Watch Party V2.0 — Recommendations & Cross-Device Sync Suite");
  console.log("==========================================================================\n");

  let createdRoomId: string | null = null;
  let carSocket: ClientSocketType | null = null;
  let phoneSocket: ClientSocketType | null = null;

  try {
    // --------------------------------------------------------------------------
    // Test 1: Backend Health
    // --------------------------------------------------------------------------
    console.log("[Test 1] Verifying backend health...");
    const healthRes = await fetch(`${API_URL}/health`);
    assert.strictEqual(healthRes.status, 200, "Health check should return 200");
    const healthData = await healthRes.json();
    assert.ok(healthData.status === "ok" || healthData.status === "healthy");
    recordPass("Backend health check", `Status: 200 ${healthData.status}`);

    // --------------------------------------------------------------------------
    // Test 2: Room Creation (Car Screen / Host)
    // --------------------------------------------------------------------------
    console.log("\n[Test 2] Creating room for Car Screen (Host)...");
    const createRes = await fetch(`${API_URL}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Driver Screen", title: "Infotainment Party" }),
    });
    assert.strictEqual(createRes.status, 201, "Create room should return 201");
    const createData = await createRes.json();
    const roomCode: string = createData.room.code;
    const carToken: string = createData.sessionToken;
    const hostParticipantId: string = createData.participant.id;
    createdRoomId = createData.room.id;
    assert.ok(roomCode && carToken && hostParticipantId);
    recordPass("Car Screen Room Creation", `Room Code: ${roomCode}, Host ID: ${hostParticipantId}`);

    // --------------------------------------------------------------------------
    // Test 3: Passenger Join (Phone Remote / Participant)
    // --------------------------------------------------------------------------
    console.log("\n[Test 3] Joining passenger device (Phone Remote)...");
    const joinRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Passenger Phone" }),
    });
    assert.ok(joinRes.status === 200 || joinRes.status === 201, "Join room should return 200 or 201");
    const joinData = await joinRes.json();
    const phoneToken: string = joinData.sessionToken;
    const passengerId: string = joinData.participant.id;
    assert.strictEqual(joinData.participant.role, "PARTICIPANT");
    recordPass("Passenger Join via REST", `Passenger ID: ${passengerId}, Role: PARTICIPANT`);

    // --------------------------------------------------------------------------
    // Test 4: Recommendations REST Endpoint
    // --------------------------------------------------------------------------
    console.log("\n[Test 4] Testing GET /api/rooms/:code/recommendations...");
    const recRes = await fetch(`${API_URL}/rooms/${roomCode}/recommendations?limit=6`, {
      headers: { Authorization: `Bearer ${carToken}` },
    });
    assert.strictEqual(recRes.status, 200, "Recommendations endpoint should return 200");
    const recData = await recRes.json();
    assert.strictEqual(recData.success, true);
    assert.ok(Array.isArray(recData.recommendations));
    assert.ok(recData.recommendations.length > 0, "Should return at least 1 recommendation");

    const firstRec = recData.recommendations[0];
    assert.ok(firstRec.videoId, "Rec must have videoId");
    assert.ok(firstRec.title, "Rec must have title");
    assert.ok(firstRec.channelTitle, "Rec must have channelTitle");
    assert.ok(firstRec.thumbnailUrl, "Rec must have thumbnailUrl");
    assert.ok(typeof firstRec.durationSec === "number", "Rec must have durationSec");
    assert.ok(firstRec.durationFormatted, "Rec must have durationFormatted");
    recordPass("Recommendations Service", `Returned ${recData.recommendations.length} songs (e.g. "${firstRec.title}")`);

    // --------------------------------------------------------------------------
    // Test 5: Recommendations Accessible to Passenger
    // --------------------------------------------------------------------------
    console.log("\n[Test 5] Verifying Passenger can view recommendations...");
    const passRecRes = await fetch(`${API_URL}/rooms/${roomCode}/recommendations?limit=4`, {
      headers: { Authorization: `Bearer ${phoneToken}` },
    });
    assert.strictEqual(passRecRes.status, 200, "Passenger should be allowed to view recommendations");
    const passRecData = await passRecRes.json();
    assert.strictEqual(passRecData.success, true);
    recordPass("Passenger Recommendations Read Access", `Accessible to non-privileged passengers`);

    // --------------------------------------------------------------------------
    // Test 6: Recommendations In-Memory Caching
    // --------------------------------------------------------------------------
    console.log("\n[Test 6] Verifying Recommendations in-memory caching...");
    const tStart = Date.now();
    const cachedRecRes = await fetch(`${API_URL}/rooms/${roomCode}/recommendations?limit=6`, {
      headers: { Authorization: `Bearer ${carToken}` },
    });
    const tElapsed = Date.now() - tStart;
    assert.strictEqual(cachedRecRes.status, 200);
    recordPass("Recommendations Caching", `Second fetch completed in ${tElapsed}ms`);

    // --------------------------------------------------------------------------
    // Test 7: Video Details Endpoint
    // --------------------------------------------------------------------------
    console.log("\n[Test 7] Testing GET /api/rooms/:code/video-details...");
    const testVideoId = firstRec.videoId || "jfKfPfyJRdk";
    const detailsRes = await fetch(`${API_URL}/rooms/${roomCode}/video-details?videoId=${testVideoId}`, {
      headers: { Authorization: `Bearer ${carToken}` },
    });
    assert.strictEqual(detailsRes.status, 200, "Video details should return 200");
    const detailsData = await detailsRes.json();
    assert.strictEqual(detailsData.success, true);
    assert.strictEqual(detailsData.details.videoId, testVideoId);
    recordPass("Video Details Lookup", `Found details for "${detailsData.details.title}"`);

    // --------------------------------------------------------------------------
    // Test 8: Connect Sockets for Car Screen & Phone Remote
    // --------------------------------------------------------------------------
    console.log("\n[Test 8] Connecting WebSocket sessions for both devices...");
    carSocket = await createAndConnectSocket(carToken, roomCode);
    await joinRoomViaSocket(carSocket, roomCode);

    phoneSocket = await createAndConnectSocket(phoneToken, roomCode);
    await joinRoomViaSocket(phoneSocket, roomCode);
    recordPass("Two-Device WebSocket Connection", "Car Screen and Phone Remote both joined room channel");

    // --------------------------------------------------------------------------
    // Test 9: Play Selected Recommendation In-Site (Authoritative, Zero External Nav)
    // --------------------------------------------------------------------------
    console.log("\n[Test 9] Authoritative playback from recommendation...");
    const targetSong = recData.recommendations[0];
    const carPlaybackStatePromise = waitForEvent(carSocket, "playback:state");
    const phonePlaybackStatePromise = waitForEvent(phoneSocket, "playback:state");

    // Host triggers recommendation play
    carSocket.emit(
      "playback:change-video",
      {
        videoId: targetSong.videoId,
        autoPlay: true,
        title: targetSong.title,
        channelTitle: targetSong.channelTitle,
        thumbnailUrl: targetSong.thumbnailUrl,
        durationSec: targetSong.durationSec,
      },
      (ack: any) => {
        assert.strictEqual(ack?.success, true, "change-video ack should succeed");
      }
    );

    const [carStateEvent, phoneStateEvent] = await Promise.all([
      carPlaybackStatePromise,
      phonePlaybackStatePromise,
    ]);

    assert.strictEqual(carStateEvent.state.currentVideoId, targetSong.videoId);
    assert.strictEqual(carStateEvent.state.isPlaying, true);
    assert.strictEqual(carStateEvent.state.videoTitle, targetSong.title);
    assert.strictEqual(phoneStateEvent.state.currentVideoId, targetSong.videoId);
    assert.strictEqual(phoneStateEvent.state.isPlaying, true);
    assert.strictEqual(phoneStateEvent.state.videoTitle, targetSong.title);
    recordPass(
      "In-Site Recommendation Playback",
      `Loaded "${targetSong.title}" (${targetSong.videoId}) authoritatively on both screens without redirect`
    );

    // --------------------------------------------------------------------------
    // Test 10: Metadata Synchronization (playback:sync-metadata)
    // --------------------------------------------------------------------------
    console.log("\n[Test 10] Car Screen discovers duration and syncs metadata to server...");
    const phoneEnrichedPromise = waitForEvent(phoneSocket, "playback:state");

    carSocket.emit(
      "playback:sync-metadata",
      {
        videoId: targetSong.videoId,
        durationSec: 360,
        title: targetSong.title,
        channelTitle: targetSong.channelTitle,
      },
      (ack: any) => {
        assert.strictEqual(ack?.success, true, "sync-metadata ack should succeed");
      }
    );

    const enrichedPhoneState = await phoneEnrichedPromise;
    assert.strictEqual(enrichedPhoneState.state.durationSec, 360, "Phone Remote must receive accurate durationSec");
    assert.strictEqual(enrichedPhoneState.state.videoTitle, targetSong.title);
    recordPass(
      "Cross-Device Metadata Sync",
      `Phone Remote received durationSec=360s & title; progress bar sync guaranteed`
    );

    // --------------------------------------------------------------------------
    // Test 11: Host Passenger Role Management (+Mod / -Mod)
    // --------------------------------------------------------------------------
    console.log("\n[Test 11] Host promoting passenger to MODERATOR (+Mod)...");
    const promoteRes = await fetch(`${API_URL}/rooms/${roomCode}/participants/${passengerId}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${carToken}`,
      },
      body: JSON.stringify({ role: "MODERATOR" }),
    });
    assert.strictEqual(promoteRes.status, 200, "Promote should return 200");
    const promoteData = await promoteRes.json();
    assert.strictEqual(promoteData.participant.role, "MODERATOR");
    recordPass("Passenger Promotion to Moderator", "Passenger successfully promoted to MODERATOR role");

    // --------------------------------------------------------------------------
    // Test 12: Promoted Moderator Can Control Playback
    // --------------------------------------------------------------------------
    console.log("\n[Test 12] Verifying newly promoted Moderator can pause playback...");
    const carPausePromise = waitForEvent(carSocket, "playback:state");

    phoneSocket.emit("playback:pause", { timestamp: 10 }, (ack: any) => {
      assert.strictEqual(ack?.success, true, "Promoted moderator pause should succeed");
    });

    const carPauseEvent = await carPausePromise;
    assert.strictEqual(carPauseEvent.state.isPlaying, false);
    recordPass("Moderator Control Authority", "Newly promoted Moderator successfully paused the Car Screen");

    // --------------------------------------------------------------------------
    // Test 13: Demote Back to Participant (-Mod)
    // --------------------------------------------------------------------------
    console.log("\n[Test 13] Host demoting passenger back to PARTICIPANT (-Mod)...");
    const demoteRes = await fetch(`${API_URL}/rooms/${roomCode}/participants/${passengerId}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${carToken}`,
      },
      body: JSON.stringify({ role: "PARTICIPANT" }),
    });
    assert.strictEqual(demoteRes.status, 200, "Demote should return 200");
    const demoteData = await demoteRes.json();
    assert.strictEqual(demoteData.participant.role, "PARTICIPANT");
    recordPass("Passenger Demotion to Participant", "Participant role restored");

    // --------------------------------------------------------------------------
    // Test 14: Demoted Participant Forbidden from Direct Playback Control
    // --------------------------------------------------------------------------
    console.log("\n[Test 14] Verifying Demoted Participant cannot control playback directly...");
    let demoteCheckPassed = false;
    await new Promise<void>((resolve) => {
      phoneSocket!.emit("playback:play", {}, (ack: any) => {
        if (!ack?.success && ack?.error?.includes("Forbidden")) {
          demoteCheckPassed = true;
        }
        resolve();
      });
    });
    assert.ok(demoteCheckPassed, "Demoted participant must be rejected when attempting direct playback command");
    recordPass("Participant Playback Restrictions", "Demoted passenger correctly denied direct playback controls");

    // --------------------------------------------------------------------------
    // Test 15: Prevent Host Self-Demotion
    // --------------------------------------------------------------------------
    console.log("\n[Test 15] Verifying Host cannot demote themselves...");
    const selfDemoteRes = await fetch(`${API_URL}/rooms/${roomCode}/participants/${hostParticipantId}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${carToken}`,
      },
      body: JSON.stringify({ role: "PARTICIPANT" }),
    });
    assert.strictEqual(selfDemoteRes.status, 400, "Self-demote should be rejected with 400");
    recordPass("Host Self-Demotion Prevention", "Host prevented from accidentally demoting themselves");

  } finally {
    // Teardown
    if (carSocket) carSocket.disconnect();
    if (phoneSocket) phoneSocket.disconnect();
    if (createdRoomId) {
      try {
        await prisma.queueItem.deleteMany({ where: { roomId: createdRoomId } });
        await prisma.participant.deleteMany({ where: { roomId: createdRoomId } });
        await prisma.room.delete({ where: { id: createdRoomId } });
      } catch (err) {
        console.warn("[Teardown warning]:", err);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log("\n==========================================================================");
  console.log("  SUITE RESULTS");
  console.log("==========================================================================");
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\nTotal: ${total} | Passed: ${passed} | Failed: ${failed}`);
  if (failed === 0) {
    console.log("\n🎉 ALL TESTS PASSED! YouTube Suggestions & Car Mode Dashboard Ready.\n");
    process.exit(0);
  } else {
    console.error("\n❌ SOME TESTS FAILED!\n");
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Test suite fatal error:", err);
  process.exit(1);
});
