/**
 * Integration Test Suite for Phase 6.1 — Host Lifecycle, Session Resilience & Reliability
 * Tests Host disconnect/reconnect, single/multi-tab resilience, ownership preservation,
 * authorized and unauthorized Host transfer (REST and Socket.IO), concurrent transfer concurrency control,
 * single-host invariant enforcement, and session revocation.
 */
import { io as ClientSocket, type Socket as ClientSocketType } from "socket.io-client";
import { httpServer } from "./index.js";
import { prisma } from "./config/prisma.js";

let actualPort = 5000;
let SERVER_URL = `http://localhost:${actualPort}`;
let API_URL = `${SERVER_URL}/api`;

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, details?: string) {
  results.push({ name, passed: condition, details });
  const icon = condition ? "✔ PASS" : "✖ FAIL";
  console.log(`${icon} - ${name} ${details ? `(${details})` : ""}`);
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
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return { status: res.status, body };
    } catch (err) {
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
  return { status: 500, body: null };
}

function createClientSocket(
  token?: string,
  roomCode?: string,
  extraOptions: Record<string, any> = {}
): ClientSocketType {
  return ClientSocket(SERVER_URL, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    auth: {
      token,
      roomCode,
    },
    ...extraOptions,
  });
}

function waitForEvent<T = any>(socket: ClientSocketType, event: string, timeoutMs = 10000): Promise<T> {
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

async function dbRetry<T>(fn: () => Promise<T>, retries = 4, delayMs = 1000): Promise<T> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (i < retries - 1 && (err?.code === "P1001" || err?.message?.includes("Can't reach database") || err?.code === "P1017")) {
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

export async function runHostLifecycleTests(): Promise<boolean> {
  console.log("\n=======================================================");
  console.log("   RUNNING PHASE 6.1 HOST LIFECYCLE & RELIABILITY TEST SUITE");
  console.log("=======================================================\n");

  if (!httpServer.listening) {
    await new Promise<void>((resolve) => {
      httpServer.listen(5099, () => {
        resolve();
      });
    });
    actualPort = 5099;
  } else {
    const addr = httpServer.address();
    if (addr && typeof addr === "object") {
      actualPort = addr.port;
    }
  }

  SERVER_URL = `http://localhost:${actualPort}`;
  API_URL = `${SERVER_URL}/api`;

  const activeSockets: ClientSocketType[] = [];
  function registerSocket(s: ClientSocketType) {
    activeSockets.push(s);
    return s;
  }

  try {
    // 1. Health Endpoint
    const health = await request("/health");
    assert("1. HTTP /api/health endpoint returns 200 OK", health.status === 200 && health.body?.status === "ok");

    // 2. Setup Room with Alice (HOST), Bob (PARTICIPANT), and Charlie (PARTICIPANT)
    const roomRes = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({ displayName: "Alice (Host)", title: "Lifecycle Test Room" }),
    });
    const room = roomRes.body?.room;
    const roomCode = room?.code;
    const aliceToken = roomRes.body?.sessionToken;
    const aliceId = roomRes.body?.participant?.id;

    assert(
      "2. Room created with Alice as initial HOST",
      roomRes.status === 201 && roomCode && aliceToken && roomRes.body?.participant?.role === "HOST"
    );

    const bobRes = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Bob (Participant)" }),
    });
    const bobToken = bobRes.body?.sessionToken;
    const bobId = bobRes.body?.participant?.id;

    const charlieRes = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Charlie (Participant)" }),
    });
    const charlieToken = charlieRes.body?.sessionToken;
    const charlieId = charlieRes.body?.participant?.id;

    assert("3. Bob and Charlie join room as PARTICIPANT", bobRes.status === 201 && charlieRes.status === 201);

    // 4. Host Connects via Socket
    const aliceSocket = registerSocket(createClientSocket(aliceToken, roomCode));
    await waitForEvent(aliceSocket, "health:ready");
    const aliceJoinAck = await new Promise<any>((resolve) => {
      aliceSocket.emit("room:join", { roomCode }, (ack: any) => resolve(ack));
    });
    assert("4. Alice (Host) connects and joins room channel", aliceJoinAck.success === true);

    const bobSocket = registerSocket(createClientSocket(bobToken, roomCode));
    await waitForEvent(bobSocket, "health:ready");
    bobSocket.emit("room:join", { roomCode });
    await waitForEvent(bobSocket, "room:joined");

    // 5. Host Disconnect & Ownership Preservation (Single-Tab)
    // When Alice disconnects, her DB status must be isConnected === false, BUT her role MUST REMAIN HOST!
    const bobSawAliceLeave = waitForEvent(bobSocket, "room:participant-left");
    aliceSocket.disconnect();
    await bobSawAliceLeave;

    const aliceRecordAfterDisconnect = await dbRetry(() =>
      prisma.participant.findUnique({
        where: { id: aliceId },
      })
    );
    assert(
      "5a. Host disconnect sets isConnected === false",
      aliceRecordAfterDisconnect?.isConnected === false
    );
    assert(
      "5b. Host disconnect strictly PRESERVES HOST ownership (no auto-promotion)",
      aliceRecordAfterDisconnect?.role === "HOST"
    );

    // Verify Bob is still PARTICIPANT (was not arbitrarily promoted)
    const bobRecordWhileHostOffline = await dbRetry(() =>
      prisma.participant.findUnique({
        where: { id: bobId },
      })
    );
    assert(
      "5c. Other room members remain PARTICIPANT while Host is disconnected",
      bobRecordWhileHostOffline?.role === "PARTICIPANT"
    );

    // 6. Host Reconnect & Authority Restoration
    const aliceSocket2 = registerSocket(createClientSocket(aliceToken, roomCode));
    await waitForEvent(aliceSocket2, "health:ready");
    const aliceRejoinAck = await new Promise<any>((resolve) => {
      aliceSocket2.emit("room:join", { roomCode }, (ack: any) => resolve(ack));
    });

    const aliceRecordAfterReconnect = await dbRetry(() =>
      prisma.participant.findUnique({
        where: { id: aliceId },
      })
    );
    assert(
      "6a. Host reconnect restores isConnected === true in database",
      aliceRejoinAck.success === true && aliceRecordAfterReconnect?.isConnected === true
    );
    assert(
      "6b. Reconnected Host retains full HOST role in database and roster",
      aliceRecordAfterReconnect?.role === "HOST" &&
        aliceRejoinAck.roster?.find((p: any) => p.id === aliceId)?.role === "HOST"
    );

    // 7. Host Multi-Tab Connection Tracking
    const aliceTab2 = registerSocket(createClientSocket(aliceToken, roomCode));
    await waitForEvent(aliceTab2, "health:ready");
    await new Promise<any>((resolve) => {
      aliceTab2.emit("room:join", { roomCode }, (ack: any) => resolve(ack));
    });

    // Disconnect Tab 1: Tab 2 is still connected, so DB isConnected must remain TRUE!
    aliceSocket2.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    const aliceMultiTabRecord = await dbRetry(() =>
      prisma.participant.findUnique({
        where: { id: aliceId },
      })
    );
    assert(
      "7a. Disconnecting Tab 1 preserves isConnected === true while Tab 2 remains active",
      aliceMultiTabRecord?.isConnected === true
    );

    // Disconnect Tab 2: Now all tabs are disconnected, so isConnected becomes FALSE!
    const bobSawAliceLeave2 = waitForEvent(bobSocket, "room:participant-left");
    aliceTab2.disconnect();
    await bobSawAliceLeave2;

    const aliceAllTabsClosedRecord = await dbRetry(() =>
      prisma.participant.findUnique({
        where: { id: aliceId },
      })
    );
    assert(
      "7b. Disconnecting last active tab transitions isConnected to false",
      aliceAllTabsClosedRecord?.isConnected === false
    );

    // Reconnect Alice for transfer tests
    const aliceActiveSocket = registerSocket(createClientSocket(aliceToken, roomCode));
    await waitForEvent(aliceActiveSocket, "health:ready");
    await new Promise<any>((resolve) => {
      aliceActiveSocket.emit("room:join", { roomCode }, (ack: any) => resolve(ack));
    });

    // 8. Unauthorized Host Transfer Rejections
    // 8a. Charlie (Participant) attempts to transfer host
    const unauthTransfer1 = await request(`/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: { Authorization: `Bearer ${charlieToken}` },
      body: JSON.stringify({ newHostParticipantId: charlieId }),
    });
    assert("8a. Regular Participant cannot transfer host (403 Forbidden)", unauthTransfer1.status === 403);

    // 8b. Promote Bob to Moderator, then Bob attempts to transfer host
    await request(`/rooms/${roomCode}/participants/${bobId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ role: "MODERATOR" }),
    });
    const unauthTransfer2 = await request(`/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ newHostParticipantId: bobId }),
    });
    assert("8b. Moderator cannot transfer host (403 Forbidden)", unauthTransfer2.status === 403);

    // 8c. Alice attempts to transfer host to herself
    const selfTransfer = await request(`/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ newHostParticipantId: aliceId }),
    });
    assert("8c. Host cannot transfer ownership to themselves (400 Bad Request)", selfTransfer.status === 400);

    // 8d. Alice attempts to transfer host to nonexistent participant
    const nonExistentTransfer = await request(`/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ newHostParticipantId: "00000000-0000-0000-0000-000000000000" }),
    });
    assert("8d. Host transfer to non-existent participant rejected (404 Not Found)", nonExistentTransfer.status === 404);

    // 9. Authorized Host Transfer via REST API
    // Alice transfers Host to Bob (Bob was MODERATOR, Alice becomes MODERATOR)
    const bobSawHostTransferredPromise = waitForEvent(bobSocket, "room:host-transferred");
    const bobSawRosterUpdatePromise = waitForEvent(bobSocket, "room:roster");

    const transferRes = await request(`/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ newHostParticipantId: bobId }),
    });

    const [bobSawHostTransferred, bobSawRosterUpdate] = await Promise.all([
      bobSawHostTransferredPromise,
      bobSawRosterUpdatePromise,
    ]);

    assert(
      "9a. Host successfully transfers ownership to Bob (200 OK)",
      transferRes.status === 200 &&
        transferRes.body?.formerHost?.role === "MODERATOR" &&
        transferRes.body?.newHost?.role === "HOST"
    );

    assert(
      "9b. Room members receive real-time room:host-transferred broadcast",
      bobSawHostTransferred.previousHostId === aliceId &&
        bobSawHostTransferred.newHostId === bobId &&
        bobSawHostTransferred.newHostDisplayName === "Bob (Participant)"
    );

    assert(
      "9c. Room members receive updated roster with Bob as HOST and Alice as MODERATOR",
      bobSawRosterUpdate.participants?.find((p: any) => p.id === bobId)?.role === "HOST" &&
        bobSawRosterUpdate.participants?.find((p: any) => p.id === aliceId)?.role === "MODERATOR"
    );

    // Database verification: Single-Host Invariant
    const allHostsInRoom = await dbRetry(() =>
      prisma.participant.findMany({
        where: { roomId: room.id, role: "HOST" },
      })
    );
    assert(
      "9d. Single-Host Invariant: Database confirms exactly ONE Host in room",
      allHostsInRoom.length === 1 && allHostsInRoom[0].id === bobId
    );

    // 10. Authority Enforcement on New Host vs Former Host
    // 10a. Bob (new Host) promotes Charlie to MODERATOR
    const bobPromotesCharlie = await request(`/rooms/${roomCode}/participants/${charlieId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${bobToken}` },
      body: JSON.stringify({ role: "MODERATOR" }),
    });
    assert("10a. New Host (Bob) possesses full host management authority (200 OK)", bobPromotesCharlie.status === 200);

    // 10b. Alice (former Host, now MODERATOR) cannot promote/demote members
    const aliceDemoteCharlie = await request(`/rooms/${roomCode}/participants/${charlieId}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ role: "PARTICIPANT" }),
    });
    assert("10b. Former Host (now Moderator) is forbidden from host actions (403 Forbidden)", aliceDemoteCharlie.status === 403);

    // 10c. Former Host (now Moderator) can still control playback
    const aliceSelectVideoAck = await new Promise<any>((resolve) => {
      aliceActiveSocket.emit(
        "playback:change-video",
        { videoId: "dQw4w9WgXcQ" },
        (ack: any) => resolve(ack)
      );
    });
    assert("10c. Former Host (Moderator) retains playback control authority", aliceSelectVideoAck.success === true);

    // 11. Host Transfer via Socket.IO
    // Bob transfers Host back to Alice via room:transfer-host socket event
    const aliceSawHostTransferredPromise = waitForEvent(aliceActiveSocket, "room:host-transferred");
    const socketTransferAck = await new Promise<any>((resolve) => {
      bobSocket.emit(
        "room:transfer-host",
        { targetParticipantId: aliceId },
        (ack: any) => resolve(ack)
      );
    });
    const aliceSawHostTransferred = await aliceSawHostTransferredPromise;

    assert(
      "11a. Host transfer via Socket.IO executes successfully (ack received)",
      socketTransferAck.success === true &&
        socketTransferAck.newHost?.role === "HOST" &&
        socketTransferAck.formerHost?.role === "MODERATOR"
    );

    assert(
      "11b. Socket.IO transfer emits room:host-transferred broadcast",
      aliceSawHostTransferred.newHostId === aliceId && aliceSawHostTransferred.previousHostId === bobId
    );

    // 12. Concurrency Control: Concurrent Host Transfer Attempts
    // Alice sends two simultaneous transfer requests targeting Bob
    const concurrent1Promise = request(`/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ newHostParticipantId: bobId }),
    });
    const concurrent2Promise = request(`/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ newHostParticipantId: bobId }),
    });

    const [c1, c2] = await Promise.all([concurrent1Promise, concurrent2Promise]);
    const successCount = (c1.status === 200 ? 1 : 0) + (c2.status === 200 ? 1 : 0);
    const failureCount = (c1.status !== 200 ? 1 : 0) + (c2.status !== 200 ? 1 : 0);

    assert(
      "12a. Concurrency Control: Exactly ONE concurrent transfer succeeds",
      successCount === 1 && failureCount === 1
    );

    const postConcurrentHosts = await dbRetry(() =>
      prisma.participant.findMany({
        where: { roomId: room.id, role: "HOST" },
      })
    );
    assert(
      "12b. Database verifies exactly ONE Host exists after concurrent transfer attempts",
      postConcurrentHosts.length === 1
    );

    // 13. Removed Participant Revocation & Reconnection Rejection
    // The current active host removes Charlie
    const currentHostRecord = postConcurrentHosts[0];
    const currentHostToken = currentHostRecord.id === bobId ? bobToken : aliceToken;

    const charlieSocket = registerSocket(createClientSocket(charlieToken, roomCode));
    await waitForEvent(charlieSocket, "health:ready");
    charlieSocket.emit("room:join", { roomCode });
    await waitForEvent(charlieSocket, "room:joined");

    const charlieSawKicked = waitForEvent(charlieSocket, "room:kicked");
    const removeCharlieRes = await request(`/rooms/${roomCode}/participants/${charlieId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${currentHostToken}` },
    });
    await charlieSawKicked;

    assert("13a. Host removes Charlie and Charlie receives room:kicked", removeCharlieRes.status === 200);

    // Attempting to reconnect with Charlie's revoked token fails
    const charlieReconnectSocket = registerSocket(createClientSocket(charlieToken, roomCode));
    const connectError = await new Promise<any>((resolve) => {
      charlieReconnectSocket.on("connect_error", (err) => resolve(err));
    });

    assert(
      "13b. Revoked session token permanently rejected on reconnect (connect_error)",
      connectError?.message?.includes("Invalid or expired session token")
    );

    // Attempting REST call with Charlie's revoked token returns 401
    const charlieRestRes = await request(`/rooms/${roomCode}`, {
      headers: { Authorization: `Bearer ${charlieToken}` },
    });
    assert("13c. Revoked session token rejected on REST endpoint (401 Unauthorized)", charlieRestRes.status === 401);

    // 14. Confidentiality Check
    // Verify room:roster and transfer responses leak ZERO tokens or token hashes
    assert(
      "14. Confidentiality: Zero session tokens or token hashes leaked in host transfer",
      !transferRes.body?.formerHost?.tokenHash &&
        !transferRes.body?.newHost?.tokenHash &&
        !transferRes.body?.sessionToken &&
        !bobSawRosterUpdate.participants?.some((p: any) => p.tokenHash || p.token)
    );

    // 15. Real-Time Role Request & Host Resolution Workflow
    // Dave joins the room as PARTICIPANT
    const daveJoinRes = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Dave" }),
    });
    const daveToken = daveJoinRes.body?.sessionToken;
    const daveId = daveJoinRes.body?.participant?.id;
    const daveSocket = registerSocket(createClientSocket(daveToken, roomCode));
    await waitForEvent(daveSocket, "health:ready");
    daveSocket.emit("room:join", { roomCode });
    await waitForEvent(daveSocket, "room:joined");

    const hostSocket = currentHostRecord.id === bobId ? bobSocket : aliceActiveSocket;
    const nonHostSocket = currentHostRecord.id === bobId ? aliceActiveSocket : bobSocket;

    // Dave emits role:request
    const hostSawRoleReqPromise = waitForEvent(hostSocket, "role:requested");
    const roleReqAck = await new Promise<any>((resolve) => {
      daveSocket.emit("role:request", { requestedRole: "MODERATOR" }, (ack: any) => resolve(ack));
    });
    const hostSawRoleReq = await hostSawRoleReqPromise;

    assert(
      "15a. Participant submits role:request for MODERATOR (ack returned & Host receives broadcast)",
      roleReqAck.success === true &&
        hostSawRoleReq.participant?.id === daveId &&
        hostSawRoleReq.requestedRole === "MODERATOR"
    );

    // Unauthorized resolution: non-host attempts to approve
    const unauthorizedResolveAck = await new Promise<any>((resolve) => {
      nonHostSocket.emit(
        "role:resolve-request",
        { requestId: roleReqAck.requestId, participantId: daveId, action: "APPROVE" },
        (ack: any) => resolve(ack)
      );
    });
    assert(
      "15b. Unauthorized role:resolve-request by non-host rejected (FORBIDDEN)",
      unauthorizedResolveAck.success === false
    );

    // Host approves Dave's request
    const daveSawResolvedPromise = waitForEvent(daveSocket, "role:request-resolved");
    const hostApproveAck = await new Promise<any>((resolve) => {
      hostSocket.emit(
        "role:resolve-request",
        { requestId: roleReqAck.requestId, participantId: daveId, action: "APPROVE" },
        (ack: any) => resolve(ack)
      );
    });
    const daveSawResolved = await daveSawResolvedPromise;

    assert(
      "15c. Host approves role request; ack confirms status APPROVED and emits role:request-resolved",
      hostApproveAck.success === true &&
        hostApproveAck.status === "APPROVED" &&
        daveSawResolved.status === "APPROVED" &&
        daveSawResolved.role === "MODERATOR"
    );

    const daveInDb = await dbRetry(() =>
      prisma.participant.findUnique({ where: { id: daveId } })
    );
    assert(
      "15d. Authoritative database reflects promoted role MODERATOR for participant",
      daveInDb?.role === "MODERATOR"
    );

    console.log("\n=======================================================");
    const totalPassed = results.filter((r) => r.passed).length;
    const totalFailed = results.filter((r) => !r.passed).length;
    console.log(`   TOTAL TESTS: ${results.length} | PASSED: ${totalPassed} | FAILED: ${totalFailed}`);
    console.log("=======================================================\n");

    return totalFailed === 0;
  } finally {
    for (const socket of activeSockets) {
      try {
        socket.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

// Auto-run if executed directly
if (process.env.RUN_TESTS !== "0") {
  runHostLifecycleTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Host lifecycle test runner encountered error:", err);
      process.exit(1);
    });
}
