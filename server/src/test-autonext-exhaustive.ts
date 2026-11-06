/**
 * test-autonext-exhaustive.ts
 *
 * Exhaustive Verification Suite for Auto-Next Lifecycle:
 * 1. Single ENDED event advances queue.
 * 2. Duplicate ENDED event ignored safely (ALREADY_ADVANCED).
 * 3. Delayed ENDED event for an old video ignored safely.
 * 4. Queue with one upcoming item advances cleanly.
 * 5. Queue with multiple upcoming items advances in order and renormalizes positions.
 * 6. Empty queue transitions to paused and marks previous PLAYED.
 * 7. Simultaneous ENDED events from multiple clients handled by concurrency lock without double-advance.
 */

import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';

const API_BASE = 'http://localhost:5000';
const API_URL = `${API_BASE}/api`;
let passedTests = 0;
let failedTests = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ FAIL - ${msg}`);
    failedTests++;
    throw new Error(`Assertion failed: ${msg}`);
  } else {
    console.log(`  ✔ PASS - ${msg}`);
    passedTests++;
  }
}

function connectSocket(token: string, roomCode: string): Promise<ClientSocketType> {
  return new Promise((resolve, reject) => {
    const socket = ClientSocket(API_BASE, {
      transports: ['websocket'],
      autoConnect: false,
      auth: { token, roomCode },
    });

    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Timed out waiting for health:ready'));
    }, 8000);

    socket.once('health:ready', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.connect();
  });
}

function joinRoomViaSocket(socket: ClientSocketType, roomCode: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('room:join ack timed out')), 8000);
    socket.emit('room:join', { roomCode }, (res: any) => {
      clearTimeout(timer);
      if (res && res.success) {
        resolve(res);
      } else {
        reject(new Error(res?.error || 'room:join failed'));
      }
    });
  });
}

function waitForEvent<T = any>(
  socket: ClientSocketType,
  event: string,
  timeoutMs = 20000,
  filter?: (data: T) => boolean
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: T) => {
      if (!filter || filter(data)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(data);
      }
    };

    socket.on(event, handler);
  });
}

async function runTests() {
  console.log('\n==========================================================================');
  console.log('  Web3Task V2.0 — Auto-Next Exhaustive Lifecycle & Concurrency Suite');
  console.log('==========================================================================\n');

  const VID_1 = 'dQw4w9WgXcQ'; // Rick Astley
  const VID_2 = 'kXYiU_JCYtU'; // Linkin Park
  const VID_3 = 'fJ9rUzIMcZQ'; // Queen
  const VID_4 = 'M7lc1UVf-VE'; // YouTube API
  const VID_5 = '9bZkp7q19f0'; // Psy

  // Step 1: Create room
  console.log('[Setup] Creating test room...');
  const createRes = await fetch(`${API_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Car Screen Host', title: 'Auto-Next Test Lab' }),
  });
  const createData = await createRes.json();
  const roomCode: string = createData.room.code;
  const hostToken: string = createData.sessionToken;

  const carSocket = await connectSocket(hostToken, roomCode);
  await joinRoomViaSocket(carSocket, roomCode);
  assert(carSocket.connected, 'Car Screen Host connected and joined room');

  // Step 2: Add Phone Remote
  const joinPhoneRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Passenger Remote' }),
  });
  const phoneData = await joinPhoneRes.json();
  const phoneToken = phoneData.sessionToken;
  const phoneSocket = await connectSocket(phoneToken, roomCode);
  await joinRoomViaSocket(phoneSocket, roomCode);
  assert(phoneSocket.connected, 'Phone Remote connected and joined room');

  // --------------------------------------------------------------------------
  // TEST 1 & 4: Queue with One Upcoming Item & Single ENDED event
  // --------------------------------------------------------------------------
  console.log('\n[Test 1] Setting initial video and adding single upcoming item to queue...');
  await new Promise<void>((resolve, reject) => {
    carSocket.emit(
      'playback:change-video',
      {
        videoId: VID_1,
        autoPlay: true,
        title: 'Track 1 - Initial Song',
        channelTitle: 'Artist One',
        thumbnailUrl: `https://img.youtube.com/vi/${VID_1}/hqdefault.jpg`,
        durationSec: 180,
      },
      (ack: any) => {
        if (ack?.success) resolve();
        else reject(new Error(ack?.error || 'change-video failed'));
      }
    );
  });

  // Add Item 2 to queue
  await new Promise<void>((resolve, reject) => {
    carSocket.emit(
      'queue:add',
      {
        videoId: VID_2,
        title: 'Track 2 - Second Song',
        channelTitle: 'Artist Two',
        thumbnailUrl: `https://img.youtube.com/vi/${VID_2}/hqdefault.jpg`,
        durationSec: 210,
      },
      (ack: any) => {
        if (ack?.success) resolve();
        else reject(new Error(ack?.error || 'queue:add failed'));
      }
    );
  });

  console.log('[Test 1.1] Emitting single ENDED event for Track 1...');
  const statePromiseCar = waitForEvent(carSocket, 'playback:state', 20000, (d) => d.state?.currentVideoId === VID_2);
  const statePromisePhone = waitForEvent(phoneSocket, 'playback:state', 20000, (d) => d.state?.currentVideoId === VID_2);

  const endAck1 = await new Promise<any>((resolve) => {
    carSocket.emit('playback:ended', { videoId: VID_1 }, resolve);
  });

  assert(endAck1?.success === true, 'Ended acknowledgment succeeded');
  assert(endAck1?.advanced === true, 'Queue advanced to next item');

  const [stateEventCar, stateEventPhone] = await Promise.all([statePromiseCar, statePromisePhone]);
  assert(stateEventCar.state.currentVideoId === VID_2, `Car Screen received ${VID_2}`);
  assert(stateEventPhone.state.currentVideoId === VID_2, `Phone Remote received ${VID_2}`);
  assert(stateEventCar.state.isPlaying === true, 'New track automatically starts in PLAYING state');
  console.log(`  [Info] Track 2 start timestamp: ${stateEventCar.state.currentTimestamp}s`);
  assert(
    typeof stateEventCar.state.currentTimestamp === 'number' && stateEventCar.state.currentTimestamp < 10.0,
    'New track resets near 0.0s'
  );

  // --------------------------------------------------------------------------
  // TEST 2: Duplicate ENDED Event for same track
  // --------------------------------------------------------------------------
  console.log('\n[Test 2] Duplicate ENDED event for already advanced Track 1...');
  const dupAck = await new Promise<any>((resolve) => {
    carSocket.emit('playback:ended', { videoId: VID_1 }, resolve);
  });
  assert(dupAck?.success === true, 'Duplicate ended event handled gracefully');
  assert(dupAck?.advanced === false, 'Duplicate ended event did NOT advance a second time');
  assert(dupAck?.reason === 'ALREADY_ADVANCED', 'Duplicate returned ALREADY_ADVANCED reason');

  // --------------------------------------------------------------------------
  // TEST 3: Delayed ENDED Event for old video
  // --------------------------------------------------------------------------
  console.log('\n[Test 3] Delayed ENDED event for an ancient video ID...');
  const delayedAck = await new Promise<any>((resolve) => {
    phoneSocket.emit('playback:ended', { videoId: 'AAAAAAAAAAA' }, resolve);
  });
  assert(delayedAck?.success === true, 'Delayed old ended event handled gracefully');
  assert(delayedAck?.advanced === false, 'Delayed old video did NOT advance current queue');
  assert(delayedAck?.reason === 'ALREADY_ADVANCED', 'Delayed returned ALREADY_ADVANCED');

  // --------------------------------------------------------------------------
  // TEST 5: Queue with Multiple Upcoming Items & Renormalization
  // --------------------------------------------------------------------------
  console.log('\n[Test 5] Adding multiple items (Track 3, Track 4, Track 5) to queue...');
  await new Promise<void>((resolve) => {
    carSocket.emit('queue:add', { videoId: VID_3, title: 'Track 3', durationSec: 150 }, () => resolve());
  });
  await new Promise<void>((resolve) => {
    carSocket.emit('queue:add', { videoId: VID_4, title: 'Track 4', durationSec: 160 }, () => resolve());
  });
  await new Promise<void>((resolve) => {
    carSocket.emit('queue:add', { videoId: VID_5, title: 'Track 5', durationSec: 170 }, () => resolve());
  });

  // Track 2 ends -> should advance to Track 3, while Track 4 and 5 remain queued with positions 1 and 2
  console.log('[Test 5.1] Track 2 ends -> advances to Track 3...');
  const nextAck = await new Promise<any>((resolve) => {
    carSocket.emit('playback:ended', { videoId: VID_2 }, resolve);
  });
  assert(nextAck?.advanced === true, 'Advanced to Track 3');
  assert(nextAck?.state?.currentVideoId === VID_3, `Current video is now Track 3 (${VID_3})`);

  // Check remaining queue
  const queueRes = await fetch(`${API_URL}/rooms/${roomCode}/queue`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  const queueData = await queueRes.json();
  const queuedItems = queueData.queue.filter((i: any) => i.status === 'QUEUED');
  assert(queuedItems.length === 2, 'Two items remain queued');
  assert(queuedItems[0].videoId === VID_4 && queuedItems[0].position === 1, `Track 4 (${VID_4}) is position 1`);
  assert(queuedItems[1].videoId === VID_5 && queuedItems[1].position === 2, `Track 5 (${VID_5}) is position 2`);

  // --------------------------------------------------------------------------
  // TEST 7: Simultaneous ENDED events from multiple clients (Concurrency Lock)
  // --------------------------------------------------------------------------
  console.log('\n[Test 7] Firing simultaneous ENDED events for Track 3 from Car and Phone...');
  const [raceAck1, raceAck2] = await Promise.all([
    new Promise<any>((resolve) => carSocket.emit('playback:ended', { videoId: VID_3 }, resolve)),
    new Promise<any>((resolve) => phoneSocket.emit('playback:ended', { videoId: VID_3 }, resolve)),
  ]);

  const advancedCount = (raceAck1?.advanced ? 1 : 0) + (raceAck2?.advanced ? 1 : 0);
  assert(advancedCount === 1, `Exactly ONE event advanced the queue (Count: ${advancedCount})`);
  assert(
    raceAck1?.reason === 'ALREADY_ADVANCED' || raceAck2?.reason === 'ALREADY_ADVANCED',
    'Losing concurrent event cleanly returned ALREADY_ADVANCED'
  );

  // Now current video is Track 4. Advance past Track 4 to Track 5.
  console.log('\n[Test 7.1] Advancing past Track 4 to Track 5...');
  await new Promise<any>((resolve) => carSocket.emit('playback:ended', { videoId: VID_4 }, resolve));

  // --------------------------------------------------------------------------
  // TEST 6: Empty Queue Behavior
  // --------------------------------------------------------------------------
  console.log('\n[Test 6] Track 5 ends with empty upcoming queue...');
  const emptyAck = await new Promise<any>((resolve) => {
    carSocket.emit('playback:ended', { videoId: VID_5 }, resolve);
  });
  assert(emptyAck?.success === true, 'Empty queue ended handled successfully');
  assert(emptyAck?.advanced === false, 'Advanced is false when queue empty');
  assert(emptyAck?.emptyQueue === true, 'emptyQueue is true');
  assert(emptyAck?.state?.isPlaying === false, 'Room playback paused when queue empty');

  // Verify active queue is empty and item is marked PLAYED in database
  const finalQueueRes = await fetch(`${API_URL}/rooms/${roomCode}/queue`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  const finalQueueData = await finalQueueRes.json();
  assert(finalQueueData.queue.length === 0, 'Active queue is empty');

  const { prisma } = await import('./config/prisma.js');
  const track5InDb = await prisma.queueItem.findFirst({
    where: { videoId: VID_5 },
    orderBy: { createdAt: 'desc' },
  });
  assert(track5InDb?.status === 'PLAYED', 'Track 5 marked as PLAYED in database');
  assert(Boolean(track5InDb?.playedAt), 'Track 5 has valid playedAt timestamp');

  carSocket.disconnect();
  phoneSocket.disconnect();

  console.log('\n==========================================================================');
  console.log(`  RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('==========================================================================\n');

  if (failedTests > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
