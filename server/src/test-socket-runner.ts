/**
 * Integration Test Suite for Phase 4.2 — Secure Socket.IO Room Membership
 * Tests authentication, connection states, multi-socket tracking,
 * room isolation, broadcasts, disconnects, and REST eviction.
 */
import { io as ClientSocket, type Socket as ClientSocketType } from "socket.io-client";
import { httpServer, app } from "./index.js";
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
  return { status: res.status, body };
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

export async function runSocketTests(): Promise<boolean> {
  console.log("\n=======================================================");
  console.log("   RUNNING PHASE 4.2 SOCKET.IO INTEGRATION TEST SUITE");
  console.log("=======================================================\n");

  // Determine port and start server if not already listening
  if (!httpServer.listening) {
    await new Promise<void>((resolve) => {
      httpServer.listen(5099, () => {
        resolve();
      });
    });
    actualPort = 5099;
  } else {
    const addr = httpServer.address();
    actualPort = typeof addr === "object" && addr ? addr.port : 5000;
  }
  SERVER_URL = `http://localhost:${actualPort}`;
  API_URL = `${SERVER_URL}/api`;
  console.log(`[Test Runner] Connected to backend on port ${actualPort}`);

  const activeSockets: ClientSocketType[] = [];

  const registerSocket = (s: ClientSocketType) => {
    activeSockets.push(s);
    return s;
  };

  try {
    // 1. Health check verification
    const healthRes = await request("/health");
    assert(
      "1. HTTP /api/health endpoint returns 200 OK",
      healthRes.status === 200 && healthRes.body?.status === "ok"
    );

    // 2. Setup Rooms via REST API
    const room1Res = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({ displayName: "Alice (Host)", title: "Room 1" }),
    });
    const room1 = room1Res.body?.room;
    const alice = room1Res.body?.participant;
    const aliceToken = room1Res.body?.sessionToken;

    assert(
      "2. Create Room 1: returns code and token; DB isConnected is initially false",
      room1Res.status === 201 && typeof aliceToken === "string" && typeof room1?.code === "string"
    );

    const aliceDbInitial = await prisma.participant.findUnique({ where: { id: alice.id } });
    assert(
      "2b. Alice initial DB status isConnected === false before socket connection",
      aliceDbInitial?.isConnected === false
    );

    const room2Res = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({ displayName: "Eve (Host)", title: "Room 2" }),
    });
    const room2 = room2Res.body?.room;
    const eveToken = room2Res.body?.sessionToken;

    // Bob joins Room 1 via REST
    const bobRes = await request(`/rooms/${room1.code}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Bob (Viewer)" }),
    });
    const bob = bobRes.body?.participant;
    const bobToken = bobRes.body?.sessionToken;

    const bobDbInitial = await prisma.participant.findUnique({ where: { id: bob.id } });
    assert(
      "2c. Bob initial DB status isConnected === false before socket connection",
      bobDbInitial?.isConnected === false
    );

    // 3. Unauthorized socket connection rejection (no token)
    const unauthorizedSocket = registerSocket(createClientSocket(undefined, room1.code));
    const unauthorizedError = await new Promise<string>((resolve) => {
      unauthorizedSocket.on("connect_error", (err) => resolve(err.message));
      unauthorizedSocket.on("connect", () => resolve("UNEXPECTED_CONNECT"));
    });
    assert(
      "3. Unauthenticated socket connection is rejected (connect_error)",
      unauthorizedError.includes("Session token is required") || unauthorizedError.includes("token")
    );
    unauthorizedSocket.disconnect();

    // 4. Bogus token connection rejection
    const bogusSocket = registerSocket(
      createClientSocket("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", room1.code)
    );
    const bogusError = await new Promise<string>((resolve) => {
      bogusSocket.on("connect_error", (err) => resolve(err.message));
      bogusSocket.on("connect", () => resolve("UNEXPECTED_CONNECT"));
    });
    assert(
      "4. Bogus session token connection is rejected (connect_error)",
      bogusError.includes("Invalid or expired") || bogusError.includes("Unauthorized")
    );
    bogusSocket.disconnect();

    // 5. Cross-room handshake mismatch rejection
    const crossRoomSocket = registerSocket(createClientSocket(eveToken, room1.code));
    const crossRoomError = await new Promise<string>((resolve) => {
      crossRoomSocket.on("connect_error", (err) => resolve(err.message));
      crossRoomSocket.on("connect", () => resolve("UNEXPECTED_CONNECT"));
    });
    assert(
      "5. Token belonging to Room 2 attempting connection to Room 1 is rejected (Forbidden)",
      crossRoomError.includes("does not belong to the targeted room")
    );
    crossRoomSocket.disconnect();

    // 6. Authorized Host socket connection
    const aliceSocket = registerSocket(createClientSocket(aliceToken, room1.code));
    const aliceHealthReady = await waitForEvent(aliceSocket, "health:ready");
    assert(
      "6. Alice (Host) connects successfully with token and receives health:ready",
      aliceHealthReady.status === "connected" &&
        aliceHealthReady.participantId === alice.id &&
        aliceHealthReady.roomCode === room1.code
    );

    // 7. Prevent client from joining arbitrary unauthorized room
    const badJoinPromise = new Promise<{ success: boolean; error?: string }>((resolve) => {
      aliceSocket.emit("room:join", { roomCode: room2.code }, (ack: any) => resolve(ack));
    });
    const badJoinAck = await badJoinPromise;
    assert(
      "7. Enforce server-side room membership: reject join for unauthorized room code",
      badJoinAck.success === false && Boolean(badJoinAck.error?.includes("Forbidden"))
    );

    // 8. Join authorized room and verify DB isConnected persistence
    const aliceJoinAck = await new Promise<{ success: boolean; roster?: any[] }>((resolve) => {
      aliceSocket.emit("room:join", { roomCode: room1.code }, (ack: any) => resolve(ack));
    });
    assert(
      "8a. Alice successfully joins authorized room channel (room:join ack)",
      aliceJoinAck.success === true && Array.isArray(aliceJoinAck.roster)
    );

    const aliceDbConnected = await prisma.participant.findUnique({ where: { id: alice.id } });
    assert(
      "8b. Alice DB record updated to isConnected === true based on live socket",
      aliceDbConnected?.isConnected === true
    );

    // 9. Bob joins Room 1: Alice receives join notification; Bob receives roster
    const bobSocket = registerSocket(createClientSocket(bobToken, room1.code));
    await waitForEvent(bobSocket, "health:ready");

    const aliceJoinNotificationPromise = waitForEvent(aliceSocket, "room:participant-joined");
    const bobRosterPromise = waitForEvent(bobSocket, "room:roster");

    bobSocket.emit("room:join", { roomCode: room1.code });

    const [aliceReceivedJoin, bobReceivedRoster] = await Promise.all([
      aliceJoinNotificationPromise,
      bobRosterPromise,
    ]);

    assert(
      "9a. Alice receives room:participant-joined broadcast when Bob connects",
      aliceReceivedJoin?.participant?.id === bob.id &&
        aliceReceivedJoin?.participant?.displayName === "Bob (Viewer)" &&
        aliceReceivedJoin?.participant?.isConnected === true
    );

    assert(
      "9b. Room members receive updated room:roster with safe participant data",
      Array.isArray(bobReceivedRoster?.participants) &&
        bobReceivedRoster.participants.length === 2 &&
        bobReceivedRoster.participants.some((p: any) => p.id === alice.id && p.isConnected === true) &&
        bobReceivedRoster.participants.some((p: any) => p.id === bob.id && p.isConnected === true)
    );

    const bobDbConnected = await prisma.participant.findUnique({ where: { id: bob.id } });
    assert(
      "9c. Bob DB record updated to isConnected === true",
      bobDbConnected?.isConnected === true
    );

    // 10. Multi-tab handling for single participant (Bob opens Tab 2)
    const bobSocketTab2 = registerSocket(createClientSocket(bobToken, room1.code));
    await waitForEvent(bobSocketTab2, "health:ready");

    let aliceReceivedExtraJoin = false;
    const extraJoinListener = (data: any) => {
      if (data?.participant?.id === bob.id) {
        aliceReceivedExtraJoin = true;
      }
    };
    aliceSocket.on("room:participant-joined", extraJoinListener);

    bobSocketTab2.emit("room:join", { roomCode: room1.code });
    await waitForEvent(bobSocketTab2, "room:joined");

    // Wait 200ms to verify Alice was NOT sent duplicate participant-joined broadcast
    await new Promise((r) => setTimeout(r, 200));
    aliceSocket.off("room:participant-joined", extraJoinListener);

    assert(
      "10a. Second tab for existing participant does NOT emit redundant room:participant-joined",
      !aliceReceivedExtraJoin
    );

    // Disconnect Tab 1 for Bob: Bob must NOT be marked disconnected because Tab 2 is active
    let aliceReceivedPrematureLeave = false;
    const prematureLeaveListener = (data: any) => {
      if (data?.participantId === bob.id) {
        aliceReceivedPrematureLeave = true;
      }
    };
    aliceSocket.on("room:participant-left", prematureLeaveListener);

    bobSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    aliceSocket.off("room:participant-left", prematureLeaveListener);

    const bobDbAfterTab1Close = await prisma.participant.findUnique({ where: { id: bob.id } });
    assert(
      "10b. Disconnecting Tab 1 does NOT mark participant disconnected while Tab 2 remains active",
      bobDbAfterTab1Close?.isConnected === true && !aliceReceivedPrematureLeave
    );

    // Disconnect Tab 2 for Bob (last active socket)
    const aliceLeaveNotificationPromise = waitForEvent(aliceSocket, "room:participant-left");
    bobSocketTab2.disconnect();

    const aliceReceivedLeave = await aliceLeaveNotificationPromise;
    assert(
      "10c. Disconnecting last active socket emits room:participant-left to room members",
      aliceReceivedLeave?.participantId === bob.id &&
        aliceReceivedLeave?.displayName === "Bob (Viewer)"
    );

    const bobDbAfterTab2Close = await prisma.participant.findUnique({ where: { id: bob.id } });
    assert(
      "10d. Database reflects isConnected === false when all sockets for participant disconnect",
      bobDbAfterTab2Close?.isConnected === false
    );

    // 11. Reconnect handling: Bob reconnects
    const bobReconnectSocket = registerSocket(createClientSocket(bobToken, room1.code));
    await waitForEvent(bobReconnectSocket, "health:ready");

    const aliceRejoinPromise = waitForEvent(aliceSocket, "room:participant-joined");
    bobReconnectSocket.emit("room:join", { roomCode: room1.code });
    const bobRejoined = await aliceRejoinPromise;

    const bobDbReconnected = await prisma.participant.findUnique({ where: { id: bob.id } });
    assert(
      "11. Reconnecting participant restores isConnected === true and notifies room",
      bobRejoined?.participant?.id === bob.id && bobDbReconnected?.isConnected === true
    );

    // 12. Graceful room:leave event
    const aliceLeaveViaEventPromise = waitForEvent(aliceSocket, "room:participant-left");
    bobReconnectSocket.emit("room:leave");
    const leaveResult = await aliceLeaveViaEventPromise;

    const bobDbAfterLeave = await prisma.participant.findUnique({ where: { id: bob.id } });
    assert(
      "12. Graceful room:leave event notifies room and sets DB isConnected === false",
      leaveResult?.participantId === bob.id && bobDbAfterLeave?.isConnected === false
    );

    // 13. Room Isolation: Eve in Room 2 does not receive Room 1 events
    const eveSocket = registerSocket(createClientSocket(eveToken, room2.code));
    await waitForEvent(eveSocket, "health:ready");
    const eveJoinedPromise = waitForEvent(eveSocket, "room:joined");
    eveSocket.emit("room:join", { roomCode: room2.code });
    await eveJoinedPromise;

    let eveReceivedRoom1Event = false;
    const eveSpy = () => {
      eveReceivedRoom1Event = true;
    };
    eveSocket.on("room:participant-joined", eveSpy);
    eveSocket.on("room:participant-left", eveSpy);

    // Bob re-joins Room 1
    const bobRejoinedPromise = waitForEvent(bobReconnectSocket, "room:joined");
    bobReconnectSocket.emit("room:join", { roomCode: room1.code });
    await bobRejoinedPromise;

    await new Promise((r) => setTimeout(r, 300));
    eveSocket.off("room:participant-joined", eveSpy);
    eveSocket.off("room:participant-left", eveSpy);

    assert(
      "13. Strict room isolation: Eve in Room 2 receives ZERO events from Room 1",
      !eveReceivedRoom1Event
    );

    // 14. Eviction of participant removed through REST API with active Socket.IO connection
    // Charlie joins Room 1 via REST and opens a live socket
    const charlieRes = await request(`/rooms/${room1.code}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Charlie (To Be Kicked)" }),
    });
    const charlie = charlieRes.body?.participant;
    const charlieToken = charlieRes.body?.sessionToken;

    const charlieSocket = registerSocket(createClientSocket(charlieToken, room1.code));
    await waitForEvent(charlieSocket, "health:ready");
    charlieSocket.emit("room:join", { roomCode: room1.code });
    await waitForEvent(charlieSocket, "room:joined");

    const charlieKickPromise = waitForEvent(charlieSocket, "room:kicked");
    const charlieDisconnectPromise = waitForEvent(charlieSocket, "disconnect");
    const aliceSawCharlieLeavePromise = waitForEvent(aliceSocket, "room:participant-left");

    // Host removes Charlie via REST API
    const removeRes = await request(`/rooms/${room1.code}/participants/${charlie.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aliceToken}` },
    });

    const [kickEvent, disconnectReason, sawLeave] = await Promise.all([
      charlieKickPromise,
      charlieDisconnectPromise,
      aliceSawCharlieLeavePromise,
    ]);

    assert(
      "14a. Participant removed via REST receives room:kicked and is forcefully disconnected",
      removeRes.status === 200 &&
        typeof kickEvent?.reason === "string" &&
        sawLeave?.participantId === charlie.id
    );

    // Verify Charlie cannot reconnect with old session token
    const charlieReconSocket = registerSocket(createClientSocket(charlieToken, room1.code));
    const charlieReconErr = await new Promise<string>((resolve) => {
      charlieReconSocket.on("connect_error", (err) => resolve(err.message));
      charlieReconSocket.on("connect", () => resolve("UNEXPECTED_CONNECT"));
    });
    assert(
      "14b. Removed participant's session token is permanently rejected on subsequent reconnect attempts",
      charlieReconErr.includes("Invalid or expired") || charlieReconErr.includes("Unauthorized")
    );
    charlieReconSocket.disconnect();

    // 15. Security verification: Ensure NO token or tokenHash is exposed in payloads
    const testRoster = await request(`/rooms/${room1.code}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const serializedRoster = JSON.stringify(testRoster.body);
    const serializedJoin = JSON.stringify(aliceReceivedJoin);
    const serializedLeave = JSON.stringify(aliceReceivedLeave);

    const hasExposedSecrets =
      serializedRoster.includes("tokenHash") ||
      serializedRoster.includes(aliceToken) ||
      serializedJoin.includes("tokenHash") ||
      serializedJoin.includes(aliceToken) ||
      serializedLeave.includes("tokenHash");

    assert(
      "15. Confidentiality: No session tokens, token hashes, or credentials exposed in events or responses",
      !hasExposedSecrets
    );
  } finally {
    // Teardown all client sockets
    for (const socket of activeSockets) {
      if (socket.connected) {
        socket.disconnect();
      }
    }

    // Close test HTTP server
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  }

  console.log("\n=======================================================");
  const totalPassed = results.filter((r) => r.passed).length;
  console.log(`   TOTAL TESTS: ${results.length} | PASSED: ${totalPassed} | FAILED: ${results.length - totalPassed}`);
  console.log("=======================================================\n");

  return totalPassed === results.length;
}

if (process.env.RUN_TESTS !== "0") {
  process.env.NODE_ENV = "test";
  runSocketTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Test execution failed:", err);
      process.exit(1);
    });
}
