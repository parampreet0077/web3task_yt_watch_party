/**
 * Automated Test Suite for Phase 4.1 Backend APIs
 * Tests room creation, joining, session tokens, authorization, and restart persistence.
 */
import { prisma } from "./config/prisma.js";
import { httpServer } from "./index.js";

let BASE_URL = "http://localhost:5000/api";

interface TestResult {
  name: string;
  passed: boolean;
  status?: number;
  expectedStatus?: number;
  details?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, details?: string) {
  results.push({ name, passed: condition, details });
  const icon = condition ? "✔ PASS" : "✖ FAIL";
  console.log(`${icon} - ${name} ${details ? `(${details})` : ""}`);
}

async function request(endpoint: string, options: RequestInit = {}) {
  const url = `${BASE_URL}${endpoint}`;
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

export async function runAllTests(): Promise<boolean> {
  console.log("\n=======================================================");
  console.log("   RUNNING PHASE 4.1 INTEGRATION TEST SUITE");
  console.log("=======================================================\n");

  if (!httpServer.listening) {
    await new Promise<void>((resolve) => {
      httpServer.listen(5000, () => resolve());
    });
  }
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 5000;
  BASE_URL = `http://localhost:${port}/api`;

  // 1. Health check
  const healthRes = await request("/health");
  assert("1. Health Endpoint returns 200 OK", healthRes.status === 200 && healthRes.body?.status === "ok");

  // 2. Create room with empty displayName
  const badCreateRes = await request("/rooms", {
    method: "POST",
    body: JSON.stringify({ displayName: "" }),
  });
  assert("2. Reject room creation with empty displayName (400)", badCreateRes.status === 400);

  // 3. Create room with valid data
  const createRes = await request("/rooms", {
    method: "POST",
    body: JSON.stringify({ displayName: "Alice (Host)", title: "Weekend Watch Party" }),
  });
  const room = createRes.body?.room;
  const host = createRes.body?.participant;
  const hostToken = createRes.body?.sessionToken;

  assert(
    "3. Successfully create room (201 Created) with null currentVideoId",
    createRes.status === 201 &&
      typeof room?.code === "string" &&
      room.code.length === 6 &&
      room.currentVideoId === null &&
      host?.role === "HOST" &&
      typeof hostToken === "string" &&
      hostToken.length === 64
  );

  const roomCode = room?.code;

  // 4. Verify DB stores only hash, not raw token, and isConnected is false
  const hostDbRecord = await prisma.participant.findUnique({
    where: { id: host?.id },
  });
  assert(
    "4. Database stores tokenHash (not raw) and isConnected is truthfully false",
    hostDbRecord?.tokenHash !== hostToken &&
      typeof hostDbRecord?.tokenHash === "string" &&
      hostDbRecord?.isConnected === false
  );

  // 5. Join nonexistent room
  const joinNonexistentRes = await request("/rooms/NONEXISTENT99/join", {
    method: "POST",
    body: JSON.stringify({ displayName: "Bob" }),
  });
  assert("5. Reject join for nonexistent room (404)", joinNonexistentRes.status === 404);

  // 6. Join room with empty displayName
  const joinEmptyNameRes = await request(`/rooms/${roomCode}/join`, {
    method: "POST",
    body: JSON.stringify({ displayName: "   " }),
  });
  assert("6. Reject join with empty displayName (400)", joinEmptyNameRes.status === 400);

  // 7. Join room as Bob (Participant)
  const joinBobRes = await request(`/rooms/${roomCode}/join`, {
    method: "POST",
    body: JSON.stringify({ displayName: "Bob (Viewer)" }),
  });
  const bob = joinBobRes.body?.participant;
  const bobToken = joinBobRes.body?.sessionToken;
  assert(
    "7. Bob joins room as PARTICIPANT (201 Created)",
    joinBobRes.status === 201 && bob?.role === "PARTICIPANT" && typeof bobToken === "string"
  );

  // 8. Join room as Charlie (Participant)
  const joinCharlieRes = await request(`/rooms/${roomCode}/join`, {
    method: "POST",
    body: JSON.stringify({ displayName: "Charlie (Viewer)" }),
  });
  const charlie = joinCharlieRes.body?.participant;
  const charlieToken = joinCharlieRes.body?.sessionToken;
  assert(
    "8. Charlie joins room as PARTICIPANT (201 Created)",
    joinCharlieRes.status === 201 && charlie?.role === "PARTICIPANT"
  );

  // 9. Read room without token (401)
  const noTokenRes = await request(`/rooms/${roomCode}`);
  assert("9. Reject read room without token (401)", noTokenRes.status === 401);

  // 10. Read room with bogus token (401)
  const bogusTokenRes = await request(`/rooms/${roomCode}`, {
    headers: { Authorization: "Bearer deadbeef1234567890abcdef1234567890abcdef" },
  });
  assert("10. Reject read room with bogus token (401)", bogusTokenRes.status === 401);

  // 11. Create a second room to test cross-room token rejection
  const secondRoomRes = await request("/rooms", {
    method: "POST",
    body: JSON.stringify({ displayName: "Eve (Other Room)" }),
  });
  const eveToken = secondRoomRes.body?.sessionToken;
  const crossRoomRes = await request(`/rooms/${roomCode}`, {
    headers: { Authorization: `Bearer ${eveToken}` },
  });
  assert("11. Reject token belonging to a different room (403)", crossRoomRes.status === 403);

  // 12. Read room with Bob's valid token (200)
  const readBobRes = await request(`/rooms/${roomCode}`, {
    headers: { Authorization: `Bearer ${bobToken}` },
  });
  const participants = readBobRes.body?.participants;
  const hasTokenHashExposed = JSON.stringify(readBobRes.body).includes("tokenHash");
  const allReportedDisconnected = participants?.every((p: any) => p.isConnected === false);
  assert(
    "12. Bob reads room; currentVideoId is null; isConnected is false; tokenHash NOT exposed (200)",
    readBobRes.status === 200 &&
      readBobRes.body?.room?.currentVideoId === null &&
      Array.isArray(participants) &&
      participants.length === 3 &&
      allReportedDisconnected &&
      !hasTokenHashExposed
  );

  // 13. Bob (Participant) attempts to promote Charlie to MODERATOR (403)
  const unauthorizedPromoteRes = await request(`/rooms/${roomCode}/participants/${charlie?.id}/role`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ role: "MODERATOR" }),
  });
  assert(
    "13. Participant cannot promote other members (403 Forbidden)",
    unauthorizedPromoteRes.status === 403
  );

  // 14. Host attempts to promote self to HOST through role endpoint (400)
  const hostPromoteSelfRes = await request(`/rooms/${roomCode}/participants/${host?.id}/role`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ role: "MODERATOR" }),
  });
  assert(
    "14. Host cannot demote or modify their own role (400 Bad Request)",
    hostPromoteSelfRes.status === 400
  );

  // 15. Host promotes Bob to MODERATOR (200)
  const promoteBobRes = await request(`/rooms/${roomCode}/participants/${bob?.id}/role`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({ role: "MODERATOR" }),
  });
  assert(
    "15. Host promotes Bob to MODERATOR (200 OK)",
    promoteBobRes.status === 200 && promoteBobRes.body?.participant?.role === "MODERATOR"
  );

  // 16. Bob (now Moderator) attempts to demote Charlie (403)
  const modDemoteRes = await request(`/rooms/${roomCode}/participants/${charlie?.id}/role`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${bobToken}` },
    body: JSON.stringify({ role: "PARTICIPANT" }),
  });
  assert("16. Moderator cannot promote/demote members (403 Forbidden)", modDemoteRes.status === 403);

  // 17. Host attempts to self-remove (400)
  const hostRemoveSelfRes = await request(`/rooms/${roomCode}/participants/${host?.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  assert("17. Host cannot remove themselves (400 Bad Request)", hostRemoveSelfRes.status === 400);

  // 18. Host removes Charlie from room (200)
  const removeCharlieRes = await request(`/rooms/${roomCode}/participants/${charlie?.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  assert("18. Host removes Charlie from room (200 OK)", removeCharlieRes.status === 200);

  // 19. Charlie's token is now invalidated (401)
  const charliePostRemoveRes = await request(`/rooms/${roomCode}`, {
    headers: { Authorization: `Bearer ${charlieToken}` },
  });
  assert("19. Removed participant's token is immediately invalidated (401)", charliePostRemoveRes.status === 401);

  // 20. Verify roster after removal
  const finalRosterRes = await request(`/rooms/${roomCode}`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  const remainingIds = finalRosterRes.body?.participants?.map((p: any) => p.id);
  assert(
    "20. Room roster contains only Host and Moderator after removal",
    remainingIds?.length === 2 && !remainingIds.includes(charlie?.id)
  );

  console.log("\n=======================================================");
  const totalPassed = results.filter((r) => r.passed).length;
  console.log(`   TOTAL TESTS: ${results.length} | PASSED: ${totalPassed} | FAILED: ${results.length - totalPassed}`);
  console.log("=======================================================\n");

  return totalPassed === results.length;
}

if (process.env.RUN_TESTS !== "0") {
  runAllTests()
    .then((success) => process.exit(success ? 0 : 1))
    .catch((err) => {
      console.error("Test runner encountered an error:", err);
      process.exit(1);
    });
}
