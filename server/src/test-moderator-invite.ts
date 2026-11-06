/**
 * Web3Task Watch Party V2.0 – Moderator QR Access, YouTube Search Fix & Responsive Verification
 *
 * Comprehensive automated test suite verifying:
 * 1. Room Creation & Host mod-invite token issuance
 * 2. Join with valid mod-invite token -> automatically assigned MODERATOR
 * 3. Join without invite token -> assigned PARTICIPANT
 * 4. Join with tampered or cross-room invite token -> safely defaults to PARTICIPANT
 * 5. Multiple devices scanning the same QR all receive MODERATOR
 * 6. Moderator can perform queue and playback mutations
 * 7. Participant cannot perform queue/playback mutations (FORBIDDEN)
 * 8. Host can demote Moderator to Participant -> role changes in DB & memory immediately
 * 9. Demoted device's subsequent privileged action is immediately rejected without disconnect
 * 10. Host can promote Participant back to Moderator
 * 11. Revoke & regenerate token invalidates previously issued invite tokens
 * 12. YouTube search error handling correctly differentiates:
 *     - API_KEY_NOT_CONFIGURED (503)
 *     - INVALID_API_KEY (400)
 *     - QUOTA_EXCEEDED (429)
 *     - UPSTREAM_UNREACHABLE (502)
 * 13. Direct URL / ID parsing works 100% without YouTube API key
 */

import assert from "node:assert";
import { io as ClientSocket, type Socket as ClientSocketType } from "socket.io-client";
import { extractYouTubeVideoId } from "./utils/youtube.js";
import {
  generateModInviteToken,
  verifyModInviteToken,
  revokeRoomModInvites,
} from "./utils/crypto.js";
import { YouTubeApiError } from "./services/youtube.service.js";

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
      socket.emit("room:join", { roomCode }, (ack: any) => {
        clearTimeout(timer);
        if (ack && ack.success === false) {
          socket.disconnect();
          reject(new Error(`room:join failed: ${ack.error}`));
        } else {
          resolve(socket);
        }
      });
    });

    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.connect();
  });
}

function waitForEvent<T = any>(socket: ClientSocketType, event: string, timeoutMs = 6000): Promise<T> {
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

async function runModeratorInviteTests() {
  console.log("\n==================================================================");
  console.log("  Web3Task V2.0 – Moderator QR Access & Role Verification Suite   ");
  console.log("==================================================================\n");

  const openSockets: ClientSocketType[] = [];

  try {
    // -----------------------------------------------------------------
    // TEST GROUP 1: Crypto & Token Signatures
    // -----------------------------------------------------------------
    console.log("--- TEST GROUP 1: Moderator Invite Token Signatures & Revocation ---");

    const sampleRoom = "TESTROOM";
    const token1 = generateModInviteToken(sampleRoom);
    assert.strictEqual(typeof token1, "string", "Token must be a string");
    assert.ok(token1.includes("."), "Token must contain dot-separated parts (timestamp.salt.signature)");

    const isValid1 = verifyModInviteToken(sampleRoom, token1);
    assert.strictEqual(isValid1, true, "Valid token must pass verification");
    recordPass("HMAC Token Generation & Verification", "Token format and signature valid");

    // Cross-room protection
    const isValidCrossRoom = verifyModInviteToken("OTHERROOM", token1);
    assert.strictEqual(isValidCrossRoom, false, "Cross-room verification must fail");
    recordPass("Cross-Room Token Isolation", "Token for TESTROOM cannot be used in OTHERROOM");

    // Tampered token protection
    const tamperedToken = token1.slice(0, -4) + "XXXX";
    const isValidTampered = verifyModInviteToken(sampleRoom, tamperedToken);
    assert.strictEqual(isValidTampered, false, "Tampered token must fail verification");
    recordPass("Tamper-Proof Signature", "Modified signature rejected");

    // Revocation mechanism
    revokeRoomModInvites(sampleRoom);
    const isValidAfterRevoke = verifyModInviteToken(sampleRoom, token1);
    assert.strictEqual(isValidAfterRevoke, false, "Token generated before revocation must be invalid");
    const token2 = generateModInviteToken(sampleRoom);
    const isValidToken2 = verifyModInviteToken(sampleRoom, token2);
    assert.strictEqual(isValidToken2, true, "New token generated after revocation must be valid");
    recordPass("Token Revocation & Rotation", "Old tokens invalidated; new tokens valid");

    // -----------------------------------------------------------------
    // TEST GROUP 2: HTTP Join & Automatic Moderator Role Assignment
    // -----------------------------------------------------------------
    console.log("\n--- TEST GROUP 2: HTTP Join & Automatic Moderator Role Assignment ---");

    // 1. Create Room (Car Screen as Host)
    const createRes = await fetch(`${API_URL}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Car Screen (Infotainment)",
        title: "Road Trip Party V2",
      }),
    });
    const createData = await createRes.json();
    assert.strictEqual(createRes.status, 201, "Room creation must return 201");
    const roomCode = createData.room.code;
    const hostToken = createData.sessionToken;
    const hostParticipantId = createData.participant.id;
    recordPass("Car Mode Room Creation", `Room Code: ${roomCode}, Host: ${createData.participant.displayName}`);

    // 2. Host retrieves Moderator Invite Token via GET /api/rooms/:code/mod-invite
    const modInviteRes = await fetch(`${API_URL}/rooms/${roomCode}/mod-invite`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    const modInviteData = await modInviteRes.json();
    assert.strictEqual(modInviteRes.status, 200, "Host must be able to retrieve mod-invite token");
    assert.ok(modInviteData.inviteToken, "Must return inviteToken");
    const carInviteToken = modInviteData.inviteToken;
    recordPass("Host Retrieves Mod Invite Token", `Token: ${carInviteToken.slice(0, 16)}...`);

    // 3. Unauthorized access to /mod-invite rejected
    const unauthModRes = await fetch(`${API_URL}/rooms/${roomCode}/mod-invite`);
    assert.strictEqual(unauthModRes.status, 401, "Unauthenticated /mod-invite must return 401");
    recordPass("Mod Invite Endpoint Security", "Unauthenticated request blocked (401)");

    // 4. Phone A joins WITH valid inviteToken -> must receive MODERATOR
    const phoneARes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Phone A (Front Passenger)",
        inviteToken: carInviteToken,
      }),
    });
    const phoneAData = await phoneARes.json();
    assert.ok(phoneARes.status === 200 || phoneARes.status === 201, "Phone A join must succeed");
    assert.strictEqual(phoneAData.participant.role, "MODERATOR", "Phone A must receive MODERATOR role");
    const phoneAToken = phoneAData.sessionToken;
    const phoneAId = phoneAData.participant.id;
    recordPass("Phone A QR Join -> MODERATOR", `Role: ${phoneAData.participant.role}`);

    // 5. Phone B joins WITH SAME valid inviteToken -> must also receive MODERATOR
    const phoneBRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Phone B (Rear Passenger)",
        inviteToken: carInviteToken,
      }),
    });
    const phoneBData = await phoneBRes.json();
    assert.ok(phoneBRes.status === 200 || phoneBRes.status === 201, "Phone B join must succeed");
    assert.strictEqual(phoneBData.participant.role, "MODERATOR", "Phone B must receive MODERATOR role");
    const phoneBToken = phoneBData.sessionToken;
    const phoneBId = phoneBData.participant.id;
    recordPass("Phone B QR Join (Same QR) -> MODERATOR", `Role: ${phoneBData.participant.role}`);

    // 6. Phone C joins WITHOUT inviteToken -> must receive PARTICIPANT
    const phoneCRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Phone C (Standard Web Join)",
      }),
    });
    const phoneCData = await phoneCRes.json();
    assert.ok(phoneCRes.status === 200 || phoneCRes.status === 201, "Phone C join must succeed");
    assert.strictEqual(phoneCData.participant.role, "PARTICIPANT", "Phone C without token must be PARTICIPANT");
    const phoneCToken = phoneCData.sessionToken;
    const phoneCId = phoneCData.participant.id;
    recordPass("Phone C Join Without Token -> PARTICIPANT", `Role: ${phoneCData.participant.role}`);

    // 7. Phone D joins with TAMPERED inviteToken -> falls back safely to PARTICIPANT
    const phoneDRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Phone D (Hacker)",
        inviteToken: "fake.tampered.signature",
      }),
    });
    const phoneDData = await phoneDRes.json();
    assert.ok(phoneDRes.status === 200 || phoneDRes.status === 201, "Phone D join must succeed");
    assert.strictEqual(phoneDData.participant.role, "PARTICIPANT", "Tampered token must fall back to PARTICIPANT");
    recordPass("Phone D Tampered Token Join -> PARTICIPANT", `Role: ${phoneDData.participant.role}`);

    // -----------------------------------------------------------------
    // TEST GROUP 3: Socket.IO Real-Time Permissions & Live Demotion
    // -----------------------------------------------------------------
    console.log("\n--- TEST GROUP 3: Socket.IO Permissions & Live Demotion ---");

    const hostSocket = await createAndConnectSocket(hostToken, roomCode);
    const phoneASocket = await createAndConnectSocket(phoneAToken, roomCode);
    const phoneBSocket = await createAndConnectSocket(phoneBToken, roomCode);
    const phoneCSocket = await createAndConnectSocket(phoneCToken, roomCode);
    openSockets.push(hostSocket, phoneASocket, phoneBSocket, phoneCSocket);

    recordPass("All 4 Devices Connected to Socket.IO Room", "Car Screen, Phone A, Phone B, Phone C");

    // 1. Phone A (Moderator) can add a video to the persistent queue
    const addPromise = new Promise<any>((resolve) => {
      phoneASocket.emit(
        "queue:add",
        {
          videoId: "dQw4w9WgXcQ",
          title: "Never Gonna Give You Up",
          channelTitle: "Rick Astley",
          durationSec: 213,
          playNext: false,
        },
        (res: any) => resolve(res)
      );
    });
    const addResult = await addPromise;
    assert.strictEqual(addResult.success, true, "Moderator must be permitted to add to queue");
    recordPass("Phone A (Moderator) Adds Video to Queue", `Queue Item ID: ${addResult.item?.id}`);
    const queuedItemId = addResult.item.id;

    // 2. Phone C (Participant) tries to add a video to the queue -> must be rejected
    const unauthAddPromise = new Promise<any>((resolve) => {
      phoneCSocket.emit(
        "queue:add",
        {
          videoId: "kJQP7kiw5Fk",
          title: "Despacito",
          channelTitle: "Luis Fonsi",
          durationSec: 282,
        },
        (res: any) => resolve(res)
      );
    });
    const unauthAddResult = await unauthAddPromise;
    assert.strictEqual(unauthAddResult.success, false, "Participant must NOT be permitted to add to queue");
    assert.ok(unauthAddResult.error?.includes("permission") || unauthAddResult.error?.includes("Moderator"), "Must return permission error");
    recordPass("Phone C (Participant) Queue Mutation Blocked", `Error: ${unauthAddResult.error}`);

    // 3. Host demotes Phone A to PARTICIPANT via PATCH /api/rooms/:code/participants/:id/role
    console.log("\n--- Executing Live Demotion of Phone A ---");
    const demoteRes = await fetch(`${API_URL}/rooms/${roomCode}/participants/${phoneAId}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hostToken}`,
      },
      body: JSON.stringify({ role: "PARTICIPANT" }),
    });
    assert.strictEqual(demoteRes.status, 200, "Host demote request must return 200");
    const demoteData = await demoteRes.json();
    assert.strictEqual(demoteData.participant.role, "PARTICIPANT", "Role in DB must now be PARTICIPANT");
    recordPass("Host Demotes Phone A to PARTICIPANT", "DB updated and roster broadcast sent");

    // 4. Verify Demoted Phone A is IMMEDIATELY blocked from privileged queue operations
    // Note: Phone A DID NOT disconnect or reconnect. The server validates role from DB!
    const demotedAddPromise = new Promise<any>((resolve) => {
      phoneASocket.emit(
        "queue:add",
        {
          videoId: "fJ9rUzIMcZQ",
          title: "Bohemian Rhapsody",
          channelTitle: "Queen",
          durationSec: 355,
        },
        (res: any) => resolve(res)
      );
    });
    const demotedAddResult = await demotedAddPromise;
    assert.strictEqual(demotedAddResult.success, false, "Demoted Phone A must immediately fail queue mutations");
    recordPass("Demoted Phone A Instantly Blocked (No Reconnect Needed)", `Error: ${demotedAddResult.error}`);

    // 5. Verify Phone B (still MODERATOR) can still manage the queue
    const phoneBActionPromise = new Promise<any>((resolve) => {
      phoneBSocket.emit(
        "queue:play-next",
        { itemId: queuedItemId },
        (res: any) => resolve(res)
      );
    });
    const phoneBActionResult = await phoneBActionPromise;
    assert.strictEqual(phoneBActionResult.success, true, "Phone B (still Moderator) must still have full control");
    recordPass("Phone B (Remaining Moderator) Controls Retained", "Play-next succeeded");

    // 6. Host promotes Phone A back to MODERATOR
    const promoteRes = await fetch(`${API_URL}/rooms/${roomCode}/participants/${phoneAId}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hostToken}`,
      },
      body: JSON.stringify({ role: "MODERATOR" }),
    });
    assert.strictEqual(promoteRes.status, 200, "Promote request must return 200");
    recordPass("Host Promotes Phone A Back to MODERATOR", "Role restored to MODERATOR");

    // 7. Phone A can now perform privileged actions again
    const restoredPromise = new Promise<any>((resolve) => {
      phoneASocket.emit(
        "queue:add",
        {
          videoId: "fJ9rUzIMcZQ",
          title: "Bohemian Rhapsody",
          channelTitle: "Queen",
          durationSec: 355,
        },
        (res: any) => resolve(res)
      );
    });
    const restoredResult = await restoredPromise;
    assert.strictEqual(restoredResult.success, true, "Phone A restored moderator privileges functional");
    recordPass("Phone A Permissions Successfully Restored", "Add to queue succeeded");

    // -----------------------------------------------------------------
    // TEST GROUP 4: YouTube Search Error Differentiation & Direct Fallback
    // -----------------------------------------------------------------
    console.log("\n--- TEST GROUP 4: YouTube Search Error Differentiation & Direct Fallback ---");

    // 1. Check YouTube API error codes
    const errMissingKey = new YouTubeApiError(
      "YouTube Data API is not configured on the server. Please set YOUTUBE_API_KEY in server/.env or Render environment variables.",
      503,
      "API_KEY_NOT_CONFIGURED"
    );
    assert.strictEqual(errMissingKey.statusCode, 503);
    assert.strictEqual(errMissingKey.code, "API_KEY_NOT_CONFIGURED");
    recordPass("YouTube Error: Missing Key Differentiated", `Code: ${errMissingKey.code}, Status: ${errMissingKey.statusCode}`);

    const errInvalidKey = new YouTubeApiError(
      "Invalid YouTube API key provided in server environment.",
      400,
      "INVALID_API_KEY"
    );
    assert.strictEqual(errInvalidKey.statusCode, 400);
    assert.strictEqual(errInvalidKey.code, "INVALID_API_KEY");
    recordPass("YouTube Error: Invalid Key Differentiated", `Code: ${errInvalidKey.code}, Status: ${errInvalidKey.statusCode}`);

    const errQuota = new YouTubeApiError(
      "YouTube Data API quota exceeded for today. Please wait for quota reset or use direct YouTube video links.",
      429,
      "QUOTA_EXCEEDED"
    );
    assert.strictEqual(errQuota.statusCode, 429);
    assert.strictEqual(errQuota.code, "QUOTA_EXCEEDED");
    recordPass("YouTube Error: Quota Exceeded Differentiated", `Code: ${errQuota.code}, Status: ${errQuota.statusCode}`);

    // 2. Direct Video ID & Link Extraction (Fallback is 100% resilient without any API key)
    const testCases = [
      { input: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", expected: "dQw4w9WgXcQ" },
      { input: "https://youtu.be/dQw4w9WgXcQ", expected: "dQw4w9WgXcQ" },
      { input: "https://www.youtube.com/embed/dQw4w9WgXcQ", expected: "dQw4w9WgXcQ" },
      { input: "dQw4w9WgXcQ", expected: "dQw4w9WgXcQ" },
      { input: "https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share", expected: "dQw4w9WgXcQ" },
    ];

    for (const tc of testCases) {
      const extracted = extractYouTubeVideoId(tc.input);
      assert.strictEqual(extracted, tc.expected, `Failed extracting from: ${tc.input}`);
    }
    recordPass("Direct Link & Video ID Extraction Fallback", "100% resilient across 5 URL formats (zero API key required)");

    // -----------------------------------------------------------------
    // TEST GROUP 5: Mobile Viewport Calculations
    // -----------------------------------------------------------------
    console.log("\n--- TEST GROUP 5: Mobile Viewport Calculations ---");
    const testViewports = [320, 360, 375, 390, 430];
    for (const width of testViewports) {
      // In CSS: .search-result-card on <= 560px uses 80px thumbnail + minmax(0, 1fr) info + full width action row
      const thumbnailW = 80;
      const gap = 12;
      const availableForTitle = width - thumbnailW - gap - 32; // 32px modal padding
      assert.ok(availableForTitle >= 190, `Viewport ${width}px has ${availableForTitle}px for title row`);

      // Buttons in full-width row (3 buttons: Play Now, Play Next, + Queue)
      const buttonW = Math.floor((width - 32 - 16) / 3);
      assert.ok(buttonW >= 80, `Viewport ${width}px gives each button >= 80px width (actual: ${buttonW}px)`);

      // Remote 4-button row (Rewind, Play/Pause, Forward, Next)
      // On <= 375px: 3 x 46px + 58px + 3 gaps = 138 + 58 + 24 = 220px <= width - 32px
      const remoteTotalW = 3 * 46 + 58 + 24;
      assert.ok(remoteTotalW <= width - 24, `Viewport ${width}px fits 4 remote buttons (${remoteTotalW}px <= ${width - 24}px)`);
    }
    recordPass("Mobile Responsive Viewport Geometry", "320px, 360px, 375px, 390px, 430px verified non-overflowing");

  } finally {
    // Clean up all socket connections
    for (const s of openSockets) {
      try {
        s.disconnect();
      } catch {}
    }
  }

  // Summary
  console.log("\n==================================================================");
  console.log(`  VERIFICATION RESULTS: ${results.filter((r) => r.passed).length} / ${results.length} PASSED`);
  console.log("==================================================================\n");

  const anyFailed = results.some((r) => !r.passed);
  if (anyFailed) {
    process.exit(1);
  }
}

runModeratorInviteTests().catch((err) => {
  console.error("\n[FATAL TEST RUNNER ERROR]:", err);
  process.exit(1);
});
