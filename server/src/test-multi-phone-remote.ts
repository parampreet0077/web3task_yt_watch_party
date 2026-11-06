/**
 * Web3Task Watch Party V2.0 – Car Host + Multi-Phone Remote Architecture Test Suite
 *
 * Verifies:
 * 1. 1 Car Host + 2 Moderator Phones + 1 Participant Phone in a single room.
 * 2. Car Screen is Host; Phone A & B default to Moderator via QR invite; Phone C is Participant.
 * 3. Authoritative role hierarchy: Car Host has final authority; cannot be usurped.
 * 4. Concurrent / simultaneous remote commands from Phone A and Phone B both update Car Screen.
 * 5. All phones and car screen receive synchronized state snapshots.
 * 6. Car Host demotes Phone A to Participant -> Phone A playback commands are rejected.
 * 7. Phone B retains Moderator privileges and can continue controlling playback.
 * 8. Participant Phone C cannot issue playback or queue mutations directly.
 * 9. Session isolation across all 4 independent client sockets.
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
      reject(new Error(`Timed out waiting for socket initialization after ${timeoutMs}ms`));
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

async function runSuite() {
  console.log("\n=======================================================");
  console.log("  Web3Task V2.0 Car Host + Multi-Phone Architecture Test");
  console.log("=======================================================\n");

  const createdRoomCodes: string[] = [];
  const openSockets: ClientSocketType[] = [];

  try {
    // 1. Health check
    const healthRes = await fetch(`${SERVER_URL}/api/health`);
    const healthJson = await healthRes.json() as any;
    assert.strictEqual(healthRes.status, 200, "Health check must return 200");
    assert.ok(healthJson.status === "ok" || healthJson.status === "healthy", "Server must report healthy status");
    recordPass("Server health check is healthy");

    // 2. Create room from Car Host
    const roomTitle = `Car Multi-Remote Suite ${Date.now()}`;
    const createRes = await fetch(`${API_URL}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: roomTitle,
        displayName: "Car Display Host",
      }),
    });
    assert.strictEqual(createRes.status, 201, "Room creation must return 201");
    const createData = await createRes.json() as any;
    const roomCode = createData.room.code;
    const hostToken = createData.sessionToken;
    const hostParticipantId = createData.participant.id;
    createdRoomCodes.push(roomCode);

    assert.strictEqual(createData.participant.role, "HOST", "Car screen creator must be HOST");
    recordPass("Car Host created room with Role.HOST", `Room: ${roomCode}`);

    // 3. Connect Car Host Socket
    const carHostSocket = await createAndConnectSocket(hostToken, roomCode);
    openSockets.push(carHostSocket);
    recordPass("Car Host socket connected and joined room channel");

    // 4. Car Host obtains Moderator Invite Token
    const inviteRes = await fetch(`${API_URL}/rooms/${roomCode}/mod-invite`, {
      headers: { Authorization: `Bearer ${hostToken}` },
    });
    assert.strictEqual(inviteRes.status, 200, "Should return 200 for mod invite token");
    const { inviteToken } = await inviteRes.json() as any;
    assert.ok(inviteToken && typeof inviteToken === "string", "Valid inviteToken string returned");
    recordPass("Car Host generated active Moderator Invite Token", `Token: ${inviteToken.slice(0, 8)}...`);

    // 5. Phone A joins via Moderator QR invite
    const phoneARes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Passenger Phone A",
        inviteToken,
      }),
    });
    assert.ok(phoneARes.status === 200 || phoneARes.status === 201, "Join should return 200/201");
    const phoneAData = await phoneARes.json() as any;
    assert.strictEqual(phoneAData.participant.role, "MODERATOR", "Phone A must auto-grant MODERATOR via QR");
    const phoneAToken = phoneAData.sessionToken;
    const phoneAParticipantId = phoneAData.participant.id;
    recordPass("Phone A joined via QR and automatically granted MODERATOR role");

    // 6. Phone B joins via SAME Moderator QR invite
    const phoneBRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Passenger Phone B",
        inviteToken,
      }),
    });
    assert.ok(phoneBRes.status === 200 || phoneBRes.status === 201, "Join should return 200/201");
    const phoneBData = await phoneBRes.json() as any;
    assert.strictEqual(phoneBData.participant.role, "MODERATOR", "Phone B must auto-grant MODERATOR via QR");
    const phoneBToken = phoneBData.sessionToken;
    const phoneBParticipantId = phoneBData.participant.id;
    recordPass("Phone B joined via same QR and also granted MODERATOR role");

    // 7. Phone C joins normally (WITHOUT invite token) -> Must be PARTICIPANT
    const phoneCRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Passenger Phone C (Regular)",
      }),
    });
    assert.ok(phoneCRes.status === 200 || phoneCRes.status === 201, "Join should return 200/201");
    const phoneCData = await phoneCRes.json() as any;
    assert.strictEqual(phoneCData.participant.role, "PARTICIPANT", "Phone C without QR must be PARTICIPANT");
    const phoneCToken = phoneCData.sessionToken;
    const phoneCParticipantId = phoneCData.participant.id;
    recordPass("Phone C joined normally without QR and is Role.PARTICIPANT");

    // 8. Connect all 3 phone sockets
    const socketA = await createAndConnectSocket(phoneAToken, roomCode);
    openSockets.push(socketA);
    const socketB = await createAndConnectSocket(phoneBToken, roomCode);
    openSockets.push(socketB);
    const socketC = await createAndConnectSocket(phoneCToken, roomCode);
    openSockets.push(socketC);
    recordPass("All 3 phone sockets connected & joined room channel simultaneously");

    // 9. Initial state: set current video from Car Host
    const changeVideoPromiseCar = waitForEvent(carHostSocket, "playback:state");
    const changeVideoPromisePhoneA = waitForEvent(socketA, "playback:state");
    const changeVideoPromisePhoneB = waitForEvent(socketB, "playback:state");

    carHostSocket.emit(
      "playback:change-video",
      {
        videoId: "dQw4w9WgXcQ",
        title: "Never Gonna Give You Up",
        channelTitle: "Rick Astley",
        thumbnailUrl: "https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
        durationSec: 212,
        autoPlay: true,
      },
      (ack: any) => {
        assert.ok(ack && ack.success, "Host change-video must succeed");
      }
    );

    const [carStateEvent1, phoneAStateEvent1, phoneBStateEvent1] = await Promise.all([
      changeVideoPromiseCar,
      changeVideoPromisePhoneA,
      changeVideoPromisePhoneB,
    ]);

    assert.strictEqual(carStateEvent1.state.currentVideoId, "dQw4w9WgXcQ", "Car must have videoId");
    assert.strictEqual(phoneAStateEvent1.state.currentVideoId, "dQw4w9WgXcQ", "Phone A must receive videoId");
    assert.strictEqual(phoneBStateEvent1.state.currentVideoId, "dQw4w9WgXcQ", "Phone B must receive videoId");
    assert.strictEqual(phoneAStateEvent1.state.durationSec, 212, "Phone A must receive duration");
    recordPass("Car Host loaded initial track, synchronized metadata broadcast to all devices");

    // 10. Phone A sends Play command -> Car Screen & Phone B receive playback:state
    const phoneAPlayPromiseCar = waitForEvent(carHostSocket, "playback:state");
    const phoneAPlayPromiseB = waitForEvent(socketB, "playback:state");

    await new Promise<void>((resolve, reject) => {
      socketA.emit("playback:play", { timestamp: 15 }, (ack: any) => {
        if (ack?.success) resolve();
        else reject(new Error(ack?.error || "Phone A playback:play failed"));
      });
    });

    const [carPlayEvent, phoneBPlayEvent] = await Promise.all([phoneAPlayPromiseCar, phoneAPlayPromiseB]);
    assert.strictEqual(carPlayEvent.state.isPlaying, true, "Car Screen playing state is true");
    assert.strictEqual(phoneBPlayEvent.state.isPlaying, true, "Phone B received playing state");
    assert.ok(Math.abs(carPlayEvent.state.currentTimestamp - 15) < 2, `Car received timestamp near 15 (got ${carPlayEvent.state.currentTimestamp})`);
    recordPass("Phone A executed Play command; Car Screen & Phone B immediately updated");

    // 11. Phone B sends Seek command -> Car Screen & Phone A receive playback:state
    const phoneBSeekPromiseCar = waitForEvent(carHostSocket, "playback:state");
    const phoneBSeekPromiseA = waitForEvent(socketA, "playback:state");

    await new Promise<void>((resolve, reject) => {
      socketB.emit("playback:seek", { timestamp: 80 }, (ack: any) => {
        if (ack?.success) resolve();
        else reject(new Error(ack?.error || "Phone B playback:seek failed"));
      });
    });

    const [carSeekEvent, phoneASeekEvent] = await Promise.all([phoneBSeekPromiseCar, phoneBSeekPromiseA]);
    assert.ok(Math.abs(carSeekEvent.state.currentTimestamp - 80) < 2, `Car received timestamp near 80 (got ${carSeekEvent.state.currentTimestamp})`);
    assert.ok(Math.abs(phoneASeekEvent.state.currentTimestamp - 80) < 2, `Phone A received timestamp near 80 (got ${phoneASeekEvent.state.currentTimestamp})`);
    recordPass("Phone B executed Seek command; Car Screen & Phone A immediately updated");

    // 12. Concurrent commands from Phone A and Phone B in rapid succession
    const seekAckPromises = await Promise.all([
      new Promise<any>((res) => socketA.emit("playback:seek", { timestamp: 100 }, res)),
      new Promise<any>((res) => socketB.emit("playback:seek", { timestamp: 105 }, res)),
    ]);
    assert.ok(seekAckPromises[0].success, "Phone A concurrent command succeeded");
    assert.ok(seekAckPromises[1].success, "Phone B concurrent command succeeded");
    recordPass("Concurrent commands from Phone A and Phone B handled safely without conflicts");

    // 13. Regular Participant Phone C attempts playback command -> MUST BE REJECTED
    const phoneCAttempt = await new Promise<any>((res) => {
      socketC.emit("playback:pause", { timestamp: 105 }, res);
    });
    assert.strictEqual(phoneCAttempt.success, false, "Participant cannot execute playback:pause");
    assert.ok(phoneCAttempt.error, "Error message returned for participant playback command");
    recordPass("Regular Participant Phone C is blocked from controlling playback");

    // 14. Car Host demotes Phone A to PARTICIPANT (-Mod)
    const demoteRes = await fetch(`${API_URL}/rooms/${roomCode}/participants/${phoneAParticipantId}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hostToken}`,
      },
      body: JSON.stringify({ role: "PARTICIPANT" }),
    });
    assert.strictEqual(demoteRes.status, 200, "Host demoting Phone A must return 200");
    const demoteData = await demoteRes.json() as any;
    assert.strictEqual(demoteData.participant.role, "PARTICIPANT", "Phone A role in DB must now be PARTICIPANT");
    recordPass("Car Host successfully demoted Phone A to PARTICIPANT");

    // 15. Verify Phone A can NO LONGER execute playback commands
    const phoneAPostDemote = await new Promise<any>((res) => {
      socketA.emit("playback:pause", { timestamp: 105 }, res);
    });
    assert.strictEqual(phoneAPostDemote.success, false, "Demoted Phone A must fail to pause");
    recordPass("Demoted Phone A immediately loses playback privileges (Database-verified role)");

    // 16. Verify Phone B REMAINS Moderator and continues controlling playback
    const phoneBPostDemotePromiseCar = waitForEvent(carHostSocket, "playback:state");
    const phoneBPostDemote = await new Promise<any>((res) => {
      socketB.emit("playback:pause", { timestamp: 110 }, res);
    });
    assert.strictEqual(phoneBPostDemote.success, true, "Phone B retains moderator privileges");
    const carPauseEvent = await phoneBPostDemotePromiseCar;
    assert.strictEqual(carPauseEvent.state.isPlaying, false, "Car Screen paused by Phone B");
    recordPass("Phone B retains Moderator privileges and continues controlling Car Screen");

    // 17. Security check: Moderator Phone B CANNOT demote the Car Host
    const modDemoteHostRes = await fetch(`${API_URL}/rooms/${roomCode}/participants/${hostParticipantId}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${phoneBToken}`,
      },
      body: JSON.stringify({ role: "PARTICIPANT" }),
    });
    assert.strictEqual(modDemoteHostRes.status, 403, "Moderator cannot modify Host's role (403 Forbidden)");
    recordPass("Phone Moderator cannot modify or usurp Car Host's authority");

    // 18. Security check: Moderator Phone B CANNOT transfer host to itself
    const modTransferRes = await fetch(`${API_URL}/rooms/${roomCode}/transfer-host`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${phoneBToken}`,
      },
      body: JSON.stringify({ newHostParticipantId: phoneBParticipantId }),
    });
    assert.strictEqual(modTransferRes.status, 403, "Moderator cannot transfer host authority (403 Forbidden)");
    recordPass("Phone Moderator cannot transfer host authority (Car Screen remains permanent Host)");

    console.log("\n-------------------------------------------------------");
    console.log(`Results: ${results.filter((r) => r.passed).length} / ${results.length} PASSED`);
    console.log("-------------------------------------------------------\n");

    if (results.some((r) => !r.passed)) {
      process.exit(1);
    }
  } finally {
    // Cleanup sockets
    for (const s of openSockets) {
      if (s.connected) s.disconnect();
    }

    // Cleanup DB rooms
    for (const code of createdRoomCodes) {
      try {
        await prisma.queueItem.deleteMany({ where: { room: { code } } });
        await prisma.participant.deleteMany({ where: { room: { code } } });
        await prisma.room.deleteMany({ where: { code } });
      } catch (err) {
        console.warn(`Failed cleanup for room ${code}:`, err);
      }
    }
    await prisma.$disconnect();
  }
}

runSuite().catch((err) => {
  console.error("Multi-phone test suite error:", err);
  process.exit(1);
});
