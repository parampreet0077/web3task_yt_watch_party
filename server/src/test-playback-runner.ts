/**
 * Integration Test Suite for Phase 5.1 — Authoritative Playback Synchronization Backend
 * Tests:
 * 1. Playback state initialization (null video)
 * 2. Playback command permissions (Host/Mod only vs Participant rejection)
 * 3. Validation (YouTube IDs, timestamps, playback rates, pre-video commands)
 * 4. Authoritative synchronization, state progression, and echo token handling
 * 5. Participant Control Requests (creation, validation, listing, reject, approve & execute, double-resolution block)
 * 6. Room isolation for playback events
 * 7. Reconnect state recovery and credential confidentiality
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

export async function runPlaybackTests(): Promise<boolean> {
  console.log("\n=======================================================");
  console.log("   RUNNING PHASE 5.1 PLAYBACK SYNCHRONIZATION TEST SUITE");
  console.log("=======================================================\n");

  if (!httpServer.listening) {
    await new Promise<void>((resolve) => {
      httpServer.listen(5098, () => resolve());
    });
    actualPort = 5098;
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
    // 1. Setup Room 1 (Alice: Host) and Room 2 (Eve: Host)
    const room1Res = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({ displayName: "Alice (Host)", title: "Playback Room 1" }),
    });
    const room1 = room1Res.body?.room;
    const aliceToken = room1Res.body?.sessionToken;

    const room2Res = await request("/rooms", {
      method: "POST",
      body: JSON.stringify({ displayName: "Eve (Host)", title: "Playback Room 2" }),
    });
    const room2 = room2Res.body?.room;
    const eveToken = room2Res.body?.sessionToken;

    assert(
      "1. Room creation initializes with null currentVideoId, isPlaying === false, timestamp === 0.0",
      room1?.currentVideoId === null &&
        room1?.isPlaying === false &&
        room1?.currentTimestamp === 0.0 &&
        room1?.playbackRate === 1.0
    );

    // Alice connects via WebSocket and joins Room 1
    const aliceSocket = registerSocket(createClientSocket(aliceToken, room1.code));
    await waitForEvent(aliceSocket, "health:ready");

    const aliceJoinAck = await new Promise<any>((resolve) => {
      aliceSocket.emit("room:join", { roomCode: room1.code }, (ack: any) => resolve(ack));
    });
    assert(
      "1b. Alice joins room and receives initial null playback state in ack",
      aliceJoinAck.success === true &&
        aliceJoinAck.playback?.currentVideoId === null &&
        aliceJoinAck.playback?.isPlaying === false
    );

    // 2. Reject playback commands before a video is selected
    const earlyPlayAck = await new Promise<any>((resolve) => {
      aliceSocket.emit("playback:play", {}, (ack: any) => resolve(ack));
    });
    assert(
      "2a. Host cannot play without selected video (NO_VIDEO_SELECTED)",
      earlyPlayAck.success === false && earlyPlayAck.error?.includes("No video selected")
    );

    const earlySeekAck = await new Promise<any>((resolve) => {
      aliceSocket.emit("playback:seek", { timestamp: 30 }, (ack: any) => resolve(ack));
    });
    assert(
      "2b. Host cannot seek without selected video (NO_VIDEO_SELECTED)",
      earlySeekAck.success === false && earlySeekAck.error?.includes("No video selected")
    );

    const room1DbPreVideo = await prisma.room.findUnique({ where: { id: room1.id } });
    assert(
      "2c. Database state unchanged after rejected commands (currentVideoId remains null)",
      room1DbPreVideo?.currentVideoId === null && room1DbPreVideo?.isPlaying === false
    );

    // 3. Bob joins Room 1 as PARTICIPANT
    const bobRes = await request(`/rooms/${room1.code}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Bob (Viewer)" }),
    });
    const bob = bobRes.body?.participant;
    const bobToken = bobRes.body?.sessionToken;

    const bobSocket = registerSocket(createClientSocket(bobToken, room1.code));
    await waitForEvent(bobSocket, "health:ready");
    bobSocket.emit("room:join", { roomCode: room1.code });
    await waitForEvent(bobSocket, "room:joined");

    // 4. Participant cannot execute direct playback commands (Forbidden)
    const bobChangeVidAck = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:change-video", { videoId: "dQw4w9WgXcQ" }, (ack: any) => resolve(ack));
    });
    assert(
      "4a. Participant rejected from changing video (FORBIDDEN)",
      bobChangeVidAck.success === false && bobChangeVidAck.error?.includes("Forbidden")
    );

    const bobPlayAck = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:play", {}, (ack: any) => resolve(ack));
    });
    assert(
      "4b. Participant rejected from starting playback (FORBIDDEN)",
      bobPlayAck.success === false && bobPlayAck.error?.includes("Forbidden")
    );

    // 5. Input validation on YouTube video IDs
    const badVidAck1 = await new Promise<any>((resolve) => {
      aliceSocket.emit("playback:change-video", { videoId: "short" }, (ack: any) => resolve(ack));
    });
    const badVidAck2 = await new Promise<any>((resolve) => {
      aliceSocket.emit("playback:change-video", { videoId: "invalid_chars!$" }, (ack: any) => resolve(ack));
    });
    assert(
      "5. Malformed YouTube video IDs rejected (INVALID_VIDEO_ID)",
      badVidAck1.success === false && badVidAck2.success === false
    );

    // 6. Host changes video to valid YouTube ID
    const bobSawVideoChangePromise = waitForEvent(bobSocket, "playback:state");
    const validChangeAck = await new Promise<any>((resolve) => {
      aliceSocket.emit("playback:change-video", { videoId: "dQw4w9WgXcQ" }, (ack: any) => resolve(ack));
    });
    const bobSawVideoChange = await bobSawVideoChangePromise;

    assert(
      "6a. Host successfully changes video to 'dQw4w9WgXcQ' (ack returned)",
      validChangeAck.success === true &&
        validChangeAck.state?.currentVideoId === "dQw4w9WgXcQ" &&
        validChangeAck.state?.isPlaying === false &&
        validChangeAck.state?.currentTimestamp === 0
    );

    assert(
      "6b. Room participants receive playback:state broadcast with new video ID",
      bobSawVideoChange.state?.currentVideoId === "dQw4w9WgXcQ" &&
        bobSawVideoChange.state?.isPlaying === false
    );

    const room1DbAfterChange = await prisma.room.findUnique({ where: { id: room1.id } });
    assert(
      "6c. PostgreSQL persists authoritative currentVideoId === 'dQw4w9WgXcQ'",
      room1DbAfterChange?.currentVideoId === "dQw4w9WgXcQ"
    );

    // 7. Host starts playback
    const bobSawPlayPromise = waitForEvent(bobSocket, "playback:state");
    const playAck = await new Promise<any>((resolve) => {
      aliceSocket.emit("playback:play", { syncToken: "play-token-123" }, (ack: any) => resolve(ack));
    });
    const bobSawPlay = await bobSawPlayPromise;

    assert(
      "7a. Host starts playback; receives ack with isPlaying === true and syncToken",
      playAck.success === true &&
        playAck.state?.isPlaying === true &&
        playAck.state?.syncToken === "play-token-123"
    );

    assert(
      "7b. Room participants receive playback:state with isPlaying === true and serverTime",
      bobSawPlay.state?.isPlaying === true && typeof bobSawPlay.state?.serverTime === "number"
    );

    // 8. Authoritative playback position advances dynamically over time
    await new Promise((r) => setTimeout(r, 300));
    const bobCheckState = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:get-state", {}, (ack: any) => resolve(ack));
    });
    assert(
      "8. Current playback timestamp advances authoritatively while playing",
      bobCheckState.success === true &&
        bobCheckState.state?.isPlaying === true &&
        bobCheckState.state?.currentTimestamp > 0.15
    );

    // 9. Promote Bob to MODERATOR via REST API
    const promoteBobRes = await request(`/rooms/${room1.code}/participants/${bob.id}/role`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ role: "MODERATOR" }),
    });
    assert("9. Bob successfully promoted to MODERATOR (200 OK)", promoteBobRes.status === 200);

    // 10. Moderator pauses video
    const aliceSawPausePromise = waitForEvent(aliceSocket, "playback:state");
    const pauseAck = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:pause", {}, (ack: any) => resolve(ack));
    });
    const aliceSawPause = await aliceSawPausePromise;

    assert(
      "10a. Moderator pauses playback; ack confirms isPlaying === false",
      pauseAck.success === true && pauseAck.state?.isPlaying === false
    );
    assert(
      "10b. Room members receive pause broadcast; timestamp remains locked",
      aliceSawPause.state?.isPlaying === false && aliceSawPause.state?.currentTimestamp > 0.15
    );

    // 11. Moderator seeks video to timestamp 45.5
    const aliceSawSeekPromise = waitForEvent(aliceSocket, "playback:state");
    const seekAck = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:seek", { timestamp: 45.5 }, (ack: any) => resolve(ack));
    });
    const aliceSawSeek = await aliceSawSeekPromise;

    assert(
      "11. Moderator seeks to 45.5s; state broadcast confirms currentTimestamp === 45.5",
      seekAck.success === true &&
        seekAck.state?.currentTimestamp === 45.5 &&
        aliceSawSeek.state?.currentTimestamp === 45.5
    );

    // 12. Input validation for timestamps and playback rates
    const badSeekAck1 = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:seek", { timestamp: -5.0 }, (ack: any) => resolve(ack));
    });
    const badSeekAck2 = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:seek", { timestamp: Infinity }, (ack: any) => resolve(ack));
    });
    const badRateAck = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:set-rate", { playbackRate: 3.5 }, (ack: any) => resolve(ack));
    });
    assert(
      "12a. Negative timestamps, non-finite values, and unsupported rates rejected",
      badSeekAck1.success === false && badSeekAck2.success === false && badRateAck.success === false
    );

    // Valid rate change to 1.5
    const validRateAck = await new Promise<any>((resolve) => {
      bobSocket.emit("playback:set-rate", { playbackRate: 1.5 }, (ack: any) => resolve(ack));
    });
    assert(
      "12b. Valid playback rate 1.5 applied and persisted",
      validRateAck.success === true && validRateAck.state?.playbackRate === 1.5
    );

    // 13. Participant Control Request Workflow
    // Charlie joins as PARTICIPANT
    const charlieRes = await request(`/rooms/${room1.code}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Charlie (Participant)" }),
    });
    const charlie = charlieRes.body?.participant;
    const charlieToken = charlieRes.body?.sessionToken;

    const charlieSocket = registerSocket(createClientSocket(charlieToken, room1.code));
    await waitForEvent(charlieSocket, "health:ready");
    charlieSocket.emit("room:join", { roomCode: room1.code });
    await waitForEvent(charlieSocket, "room:joined");

    // Charlie submits SEEK control request
    const bobSawReqPromise = waitForEvent(bobSocket, "request:created");
    const createReqAck = await new Promise<any>((resolve) => {
      charlieSocket.emit(
        "request:create",
        { type: "SEEK", targetTimestamp: 120.0 },
        (ack: any) => resolve(ack)
      );
    });
    const bobSawReq = await bobSawReqPromise;

    const requestId = createReqAck.request?.id;
    assert(
      "13a. Charlie (Participant) submits SEEK control request (status: PENDING)",
      createReqAck.success === true &&
        typeof requestId === "string" &&
        createReqAck.request?.type === "SEEK" &&
        createReqAck.request?.targetTimestamp === 120 &&
        createReqAck.request?.status === "PENDING"
    );

    assert(
      "13b. Room members receive request:created broadcast with safe participant info",
      bobSawReq.request?.id === requestId &&
        bobSawReq.request?.participant?.displayName === "Charlie (Participant)" &&
        bobSawReq.request?.type === "SEEK"
    );

    // 14. Validation on control requests
    const badReqAck1 = await new Promise<any>((resolve) => {
      charlieSocket.emit("request:create", { type: "SEEK" }, (ack: any) => resolve(ack));
    });
    const badReqAck2 = await new Promise<any>((resolve) => {
      charlieSocket.emit(
        "request:create",
        { type: "CHANGE_VIDEO", targetVideoId: "invalid!" },
        (ack: any) => resolve(ack)
      );
    });
    assert(
      "14. Malformed control requests rejected (missing targetTimestamp or bad video ID)",
      badReqAck1.success === false && badReqAck2.success === false
    );

    // 15. Moderator lists pending requests
    const listReqAck = await new Promise<any>((resolve) => {
      bobSocket.emit("request:list", { status: "PENDING" }, (ack: any) => resolve(ack));
    });
    assert(
      "15. Moderator lists requests; finds Charlie's pending SEEK request",
      listReqAck.success === true &&
        Array.isArray(listReqAck.requests) &&
        listReqAck.requests.some((r: any) => r.id === requestId && r.status === "PENDING")
    );

    // 16. Participant cannot approve or reject requests
    const unauthApproveAck = await new Promise<any>((resolve) => {
      charlieSocket.emit("request:approve", { requestId }, (ack: any) => resolve(ack));
    });
    assert(
      "16. Participant cannot approve control requests (FORBIDDEN)",
      unauthApproveAck.success === false && unauthApproveAck.error?.includes("Forbidden")
    );

    // 17. Charlie submits a second request to test rejection
    const secondReqAck = await new Promise<any>((resolve) => {
      charlieSocket.emit("request:create", { type: "PLAY" }, (ack: any) => resolve(ack));
    });
    const secondReqId = secondReqAck.request?.id;

    const charlieSawRejectPromise = waitForEvent(charlieSocket, "request:resolved");
    const rejectAck = await new Promise<any>((resolve) => {
      bobSocket.emit("request:reject", { requestId: secondReqId }, (ack: any) => resolve(ack));
    });
    const charlieSawReject = await charlieSawRejectPromise;

    assert(
      "17. Moderator rejects request; room receives request:resolved with status 'REJECTED'",
      rejectAck.success === true &&
        rejectAck.request?.status === "REJECTED" &&
        charlieSawReject.request?.id === secondReqId &&
        charlieSawReject.request?.status === "REJECTED"
    );

    // 18. Moderator approves Charlie's SEEK request (120.0s) -> Authoritatively executed
    const charlieSawApprovePromise = waitForEvent(charlieSocket, "request:resolved");
    const charlieSawSeekFromApprovalPromise = waitForEvent(charlieSocket, "playback:state");

    const approveAck = await new Promise<any>((resolve) => {
      bobSocket.emit("request:approve", { requestId }, (ack: any) => resolve(ack));
    });

    const [charlieSawApprove, charlieSawSeekFromApproval] = await Promise.all([
      charlieSawApprovePromise,
      charlieSawSeekFromApprovalPromise,
    ]);

    assert(
      "18a. Moderator approves request; ack returns APPROVED status and updated playback state",
      approveAck.success === true &&
        approveAck.request?.status === "APPROVED" &&
        approveAck.state?.currentTimestamp === 120.0
    );

    assert(
      "18b. Room members receive request:resolved (APPROVED) and synchronized playback:state",
      charlieSawApprove.request?.id === requestId &&
        charlieSawApprove.request?.status === "APPROVED" &&
        charlieSawSeekFromApproval.state?.currentTimestamp === 120.0
    );

    const room1DbAfterApproval = await prisma.room.findUnique({ where: { id: room1.id } });
    assert(
      "18c. Database confirms room currentTimestamp is now 120.0s",
      room1DbAfterApproval?.currentTimestamp === 120.0
    );

    // 19. Double resolution prevention: cannot approve or reject an already-resolved request
    const doubleApproveAck = await new Promise<any>((resolve) => {
      aliceSocket.emit("request:approve", { requestId }, (ack: any) => resolve(ack));
    });
    assert(
      "19. Attempt to resolve already-resolved request is rejected (ALREADY_RESOLVED)",
      doubleApproveAck.success === false && doubleApproveAck.error?.includes("already been resolved")
    );

    // 20. Room Isolation: Eve in Room 2 does NOT receive Room 1 playback or request events
    const eveSocket = registerSocket(createClientSocket(eveToken, room2.code));
    await waitForEvent(eveSocket, "health:ready");
    eveSocket.emit("room:join", { roomCode: room2.code });
    await waitForEvent(eveSocket, "room:joined");

    let eveReceivedRoom1Event = false;
    const eveSpy = () => {
      eveReceivedRoom1Event = true;
    };
    eveSocket.on("playback:state", eveSpy);
    eveSocket.on("request:created", eveSpy);
    eveSocket.on("request:resolved", eveSpy);

    // Alice performs a seek in Room 1
    const bobSawSeekPromise = waitForEvent(bobSocket, "playback:state");
    aliceSocket.emit("playback:seek", { timestamp: 60.0 });
    await bobSawSeekPromise;

    // Charlie submits a request in Room 1
    const bobSawReqPromise2 = waitForEvent(bobSocket, "request:created");
    charlieSocket.emit("request:create", { type: "PAUSE" });
    await bobSawReqPromise2;

    await new Promise((r) => setTimeout(r, 200));
    eveSocket.off("playback:state", eveSpy);
    eveSocket.off("request:created", eveSpy);
    eveSocket.off("request:resolved", eveSpy);

    assert(
      "20. Strict room isolation: Eve in Room 2 receives ZERO playback or request events from Room 1",
      !eveReceivedRoom1Event
    );

    // 21. Reconnecting participant receives authoritative playback state in room:join ack
    const daveRes = await request(`/rooms/${room1.code}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Dave (Reconnecting)" }),
    });
    const dave = daveRes.body?.participant;
    const daveToken = daveRes.body?.sessionToken;

    const daveSocket = registerSocket(createClientSocket(daveToken, room1.code));
    await waitForEvent(daveSocket, "health:ready");

    const daveJoinAck = await new Promise<any>((resolve) => {
      daveSocket.emit("room:join", { roomCode: room1.code }, (ack: any) => resolve(ack));
    });

    assert(
      "21. Reconnecting/joining participant receives current playback state (video, timestamp, rate)",
      daveJoinAck.success === true &&
        daveJoinAck.playback?.currentVideoId === "dQw4w9WgXcQ" &&
        daveJoinAck.playback?.currentTimestamp === 60.0 &&
        daveJoinAck.playback?.playbackRate === 1.5
    );

    // 22. Confidentiality: verify no session tokens or hashes in any playback or request payloads
    const serializedPlaybackState = JSON.stringify(bobCheckState);
    const serializedControlReq = JSON.stringify(bobSawReq);
    const hasLeaks =
      serializedPlaybackState.includes("tokenHash") ||
      serializedPlaybackState.includes(aliceToken) ||
      serializedControlReq.includes("tokenHash") ||
      serializedControlReq.includes(charlieToken);

    assert(
      "22. Confidentiality: Zero tokens, token hashes, or credentials leaked in playback/request events",
      !hasLeaks
    );
  } finally {
    for (const s of activeSockets) {
      if (s.connected) s.disconnect();
    }
  }

  console.log("\n=======================================================");
  const totalPassed = results.filter((r) => r.passed).length;
  console.log(`   TOTAL TESTS: ${results.length} | PASSED: ${totalPassed} | FAILED: ${results.length - totalPassed}`);
  console.log("=======================================================\n");

  return totalPassed === results.length;
}

if (process.env.RUN_TESTS !== "0") {
  process.env.NODE_ENV = "test";
  runPlaybackTests()
    .then((success) => process.exit(success ? 0 : 1))
    .catch((err) => {
      console.error("Playback test runner encountered error:", err);
      process.exit(1);
    });
}
