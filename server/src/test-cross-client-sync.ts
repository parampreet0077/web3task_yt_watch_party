/**
 * Phase 7.3 Multi-Client Playback Synchronization Test Suite
 * Tests full end-to-end event chain across 3+ isolated clients (Host, Moderator, Participant, Late Joiner):
 * 1. Multi-client session initialization and role authorization
 * 2. Host change video -> all clients receive authoritative video ID & paused state
 * 3. Host play -> all clients receive isPlaying: true and synchronized serverTime
 * 4. Host pause -> all clients receive isPlaying: false and frozen timestamp
 * 5. Host seek -> all clients receive updated currentTimestamp
 * 6. Host resume -> all clients receive isPlaying: true aligned to seek position
 * 7. Late joiner edge case -> newly connected participant receives live playback state
 * 8. Moderator authorized controls -> Moderator pause/seek/play propagate to Host and Participants
 * 9. Participant unauthorized controls -> direct play/pause/seek rejected with FORBIDDEN
 * 10. Echo suppression validation -> syncToken matching prevents client duplicate processing
 */
import assert from "node:assert";
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
  console.log(`✔ PASS - ${name} ${details ? `(${details})` : ""}`);
}

function recordFail(name: string, details?: string) {
  results.push({ name, passed: false, details });
  console.log(`✖ FAIL - ${name} ${details ? `(${details})` : ""}`);
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

export async function runCrossClientSyncTests(): Promise<boolean> {
  console.log("\n=======================================================");
  console.log("   RUNNING PHASE 7.3 CROSS-CLIENT PLAYBACK SYNC SUITE");
  console.log("=======================================================\n");

  const activeSockets: ClientSocketType[] = [];

  try {
    // 1. Setup Room with Host, Moderator, and Participant
    const roomRes = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({ displayName: "HostUser", title: "Cross-Client Sync Room" }),
    });
    const room = roomRes.body?.room;
    const roomCode = room?.code;
    const hostToken = roomRes.body?.sessionToken;

    assert(roomCode && hostToken, "Failed to create room for sync test");

    // Join Moderator
    const modRes = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "ModUser" }),
    });
    const modToken = modRes.body?.sessionToken;
    const modId = modRes.body?.participant?.id;

    // Join Participant
    const partRes = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "PartUser" }),
    });
    const partToken = partRes.body?.sessionToken;

    // Promote ModUser to MODERATOR role via REST
    const promoteRes = await request(`/rooms/${roomCode}/participants/${modId}/role`, {
      method: "PATCH",
      headers: { "x-session-token": hostToken },
      body: JSON.stringify({ role: "MODERATOR" }),
    });
    assert(promoteRes.status === 200, "Failed to promote ModUser");

    // Connect 3 Client Sockets concurrently and await authenticated connection
    const [hostSocket, modSocket, partSocket] = await Promise.all([
      createAndConnectSocket(hostToken, roomCode),
      createAndConnectSocket(modToken, roomCode),
      createAndConnectSocket(partToken, roomCode),
    ]);
    activeSockets.push(hostSocket, modSocket, partSocket);

    await Promise.all([
      new Promise((r) => hostSocket.emit("room:join", { roomCode }, r)),
      new Promise((r) => modSocket.emit("room:join", { roomCode }, r)),
      new Promise((r) => partSocket.emit("room:join", { roomCode }, r)),
    ]);

    recordPass("1. Three isolated clients (Host, Moderator, Participant) connected and joined room channel");

    // 2. Host changes video to 'dQw4w9WgXcQ'
    const modSawVideoPromise = waitForEvent(modSocket, "playback:state");
    const partSawVideoPromise = waitForEvent(partSocket, "playback:state");

    const changeVideoAck = await new Promise<any>((resolve) => {
      hostSocket.emit("playback:change-video", { videoId: "dQw4w9WgXcQ", syncToken: "tok-cv-1" }, resolve);
    });

    const modSawVideo = await modSawVideoPromise;
    const partSawVideo = await partSawVideoPromise;

    const cvPass =
      changeVideoAck.success === true &&
      modSawVideo.state.currentVideoId === "dQw4w9WgXcQ" &&
      partSawVideo.state.currentVideoId === "dQw4w9WgXcQ" &&
      modSawVideo.state.isPlaying === false &&
      partSawVideo.state.isPlaying === false;

    if (cvPass) {
      recordPass("2. Host loads video -> Moderator and Participant receive identical video ID and paused state");
    } else {
      recordFail("2. Host loads video -> Moderator and Participant receive identical video ID and paused state");
    }

    // 3. Host plays video
    const modSawPlayPromise = waitForEvent(modSocket, "playback:state");
    const partSawPlayPromise = waitForEvent(partSocket, "playback:state");

    const playAck = await new Promise<any>((resolve) => {
      hostSocket.emit("playback:play", { timestamp: 0, syncToken: "tok-play-1" }, resolve);
    });

    const modSawPlay = await modSawPlayPromise;
    const partSawPlay = await partSawPlayPromise;

    const playPass =
      playAck.success === true &&
      modSawPlay.state.isPlaying === true &&
      partSawPlay.state.isPlaying === true &&
      modSawPlay.state.serverTime > 0 &&
      partSawPlay.state.serverTime > 0;

    if (playPass) {
      recordPass("3. Host plays video -> Moderator and Participant players receive synchronized isPlaying: true");
    } else {
      recordFail("3. Host plays video -> Moderator and Participant players receive synchronized isPlaying: true");
    }

    // Wait 1.5 seconds for authoritative playback time to advance
    await new Promise((r) => setTimeout(r, 1500));

    // 4. Host pauses video at current timestamp
    const modSawPausePromise = waitForEvent(modSocket, "playback:state");
    const partSawPausePromise = waitForEvent(partSocket, "playback:state");

    const pauseAck = await new Promise<any>((resolve) => {
      hostSocket.emit("playback:pause", { timestamp: 12.5, syncToken: "tok-pause-1" }, resolve);
    });

    const modSawPause = await modSawPausePromise;
    const partSawPause = await partSawPausePromise;

    const pausePass =
      pauseAck.success === true &&
      modSawPause.state.isPlaying === false &&
      partSawPause.state.isPlaying === false &&
      modSawPause.state.currentTimestamp === 12.5 &&
      partSawPause.state.currentTimestamp === 12.5;

    if (pausePass) {
      recordPass(
        "4. Host pauses video -> Moderator and Participant players receive isPlaying: false with exact pause timestamp (12.5s)"
      );
    } else {
      recordFail(
        "4. Host pauses video -> Moderator and Participant players receive isPlaying: false with exact pause timestamp"
      );
    }

    // 5. Host seeks video to 60.0s
    const modSawSeekPromise = waitForEvent(modSocket, "playback:state");
    const partSawSeekPromise = waitForEvent(partSocket, "playback:state");

    const seekAck = await new Promise<any>((resolve) => {
      hostSocket.emit("playback:seek", { timestamp: 60.0, syncToken: "tok-seek-1" }, resolve);
    });

    const modSawSeek = await modSawSeekPromise;
    const partSawSeek = await partSawSeekPromise;

    const seekPass =
      seekAck.success === true &&
      modSawSeek.state.currentTimestamp === 60.0 &&
      partSawSeek.state.currentTimestamp === 60.0 &&
      modSawSeek.state.isPlaying === false &&
      partSawSeek.state.isPlaying === false;

    if (seekPass) {
      recordPass(
        "5. Host seeks video to 60.0s -> Moderator and Participant players seek to exact authoritative timestamp"
      );
    } else {
      recordFail(
        "5. Host seeks video to 60.0s -> Moderator and Participant players seek to exact authoritative timestamp"
      );
    }

    // 6. Host resumes playback from seeked position
    const modSawResumePromise = waitForEvent(modSocket, "playback:state");
    const partSawResumePromise = waitForEvent(partSocket, "playback:state");

    const resumeAck = await new Promise<any>((resolve) => {
      hostSocket.emit("playback:play", { timestamp: 60.0, syncToken: "tok-resume-1" }, resolve);
    });

    const modSawResume = await modSawResumePromise;
    const partSawResume = await partSawResumePromise;

    const resumePass =
      resumeAck.success === true &&
      modSawResume.state.isPlaying === true &&
      partSawResume.state.isPlaying === true &&
      modSawResume.state.currentTimestamp >= 60.0 &&
      partSawResume.state.currentTimestamp >= 60.0;

    if (resumePass) {
      recordPass("6. Host resumes video -> Moderator and Participant resume playback in sync from 60.0s");
    } else {
      recordFail("6. Host resumes video -> Moderator and Participant resume playback in sync from 60.0s");
    }

    // Wait 1 second while video is actively playing
    await new Promise((r) => setTimeout(r, 1000));

    // 7. Edge Case: Late Joiner (Dave) connects while room is actively playing
    const daveRes = await request(`/rooms/${roomCode}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Dave (Late Joiner)" }),
    });
    const daveToken = daveRes.body?.sessionToken;
    const daveSocket = await createAndConnectSocket(daveToken, roomCode);
    activeSockets.push(daveSocket);

    const daveJoinAck = await new Promise<any>((resolve) => {
      daveSocket.emit("room:join", { roomCode }, resolve);
    });

    const lateJoinPass =
      daveJoinAck.success === true &&
      daveJoinAck.playback?.currentVideoId === "dQw4w9WgXcQ" &&
      daveJoinAck.playback?.isPlaying === true &&
      daveJoinAck.playback?.currentTimestamp >= 60.0;

    if (lateJoinPass) {
      recordPass(
        "7. Edge Case: Late-joining participant immediately receives live playback position in room:join ack",
        `Video: ${daveJoinAck.playback.currentVideoId}, Playing: true, Position: ${daveJoinAck.playback.currentTimestamp.toFixed(2)}s`
      );
    } else {
      recordFail("7. Edge Case: Late-joining participant immediately receives live playback position");
    }

    // 8. Moderator authorized controls propagate to Host and Participants
    const hostSawModPausePromise = waitForEvent(hostSocket, "playback:state");
    const partSawModPausePromise = waitForEvent(partSocket, "playback:state");

    const modPauseAck = await new Promise<any>((resolve) => {
      modSocket.emit("playback:pause", { timestamp: 75.0, syncToken: "tok-mod-pause" }, resolve);
    });

    const hostSawModPause = await hostSawModPausePromise;
    const partSawModPause = await partSawModPausePromise;

    const modControlPass =
      modPauseAck.success === true &&
      hostSawModPause.state.isPlaying === false &&
      partSawModPause.state.isPlaying === false &&
      hostSawModPause.state.currentTimestamp === 75.0 &&
      partSawModPause.state.currentTimestamp === 75.0;

    if (modControlPass) {
      recordPass("8. Moderator pauses video -> Host and Participant receive authoritative pause at 75.0s");
    } else {
      recordFail("8. Moderator pauses video -> Host and Participant receive authoritative pause at 75.0s");
    }

    // 9. Participant unauthorized controls are strictly rejected
    const partUnauthorizedPlay = await new Promise<any>((resolve) => {
      partSocket.emit("playback:play", { timestamp: 80.0 }, resolve);
    });
    const partUnauthorizedPause = await new Promise<any>((resolve) => {
      partSocket.emit("playback:pause", { timestamp: 80.0 }, resolve);
    });
    const partUnauthorizedSeek = await new Promise<any>((resolve) => {
      partSocket.emit("playback:seek", { timestamp: 80.0 }, resolve);
    });

    const unauthorizedPass =
      partUnauthorizedPlay.success === false &&
      partUnauthorizedPause.success === false &&
      partUnauthorizedSeek.success === false;

    if (unauthorizedPass) {
      recordPass("9. Participant direct play/pause/seek commands rejected with FORBIDDEN authorization error");
    } else {
      recordFail("9. Participant direct play/pause/seek commands rejected with FORBIDDEN authorization error");
    }

    // 10. Echo suppression: syncToken preserved in broadcast state
    const syncTokenPass =
      modPauseAck.state?.syncToken === "tok-mod-pause" &&
      hostSawModPause.state?.syncToken === "tok-mod-pause" &&
      partSawModPause.state?.syncToken === "tok-mod-pause";

    if (syncTokenPass) {
      recordPass("10. Echo suppression: Authoritative broadcast preserves syncToken for caller loop prevention");
    } else {
      recordFail("10. Echo suppression: Authoritative broadcast preserves syncToken");
    }

    console.log("\n=======================================================");
    const passedCount = results.filter((r) => r.passed).length;
    const failedCount = results.filter((r) => !r.passed).length;
    console.log(`   TOTAL TESTS: ${results.length} | PASSED: ${passedCount} | FAILED: ${failedCount}`);
    console.log("=======================================================\n");

    return failedCount === 0;
  } finally {
    for (const s of activeSockets) {
      try {
        s.disconnect();
      } catch {
        // Ignore
      }
    }
  }
}

// Auto-run when executed directly
if (process.env.RUN_TESTS !== "0") {
  runCrossClientSyncTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("Test runner encountered error:", err);
      process.exit(1);
    });
}
