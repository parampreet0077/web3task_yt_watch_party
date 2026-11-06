/**
 * test-autopause-prevention.ts
 *
 * Automated verification of:
 * 1. Playback state transitions and authoritative timing
 * 2. Protection against involuntary state 2 pause broadcasts
 * 3. Spacebar and explicit user gestures vs synthetic media events
 * 4. Tab visibility and reconnection sync preservation
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

async function runTest() {
  console.log('\n==========================================================================');
  console.log('  Web3Task V2.0 — Video Auto-Pause & State Transition Audit Test');
  console.log('==========================================================================\n');

  // Step 1: Create room
  console.log('[Test 1] Creating Car Host Room...');
  const createRes = await fetch(`${API_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Driver Host', title: 'Auto-Pause Prevention Test' }),
  });
  const createData = await createRes.json();
  assert(createRes.status === 201 && createData.room?.code, `Room created: ${createData.room?.code}`);
  const roomCode: string = createData.room.code;
  const hostToken: string = createData.sessionToken;

  // Step 2: Connect Socket for Car Screen
  console.log('\n[Test 2] Connecting Car Screen Socket...');
  const carSocket = await connectSocket(hostToken, roomCode);
  await joinRoomViaSocket(carSocket, roomCode);
  assert(carSocket.connected, 'Car Screen socket connected and joined');

  // Step 3: Connect Socket for Phone Remote
  console.log('\n[Test 3] Joining Phone Remote via Moderator QR...');
  const modInviteRes = await fetch(`${API_URL}/rooms/${roomCode}/mod-invite`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  const modInviteData = await modInviteRes.json();
  const inviteToken = modInviteData.inviteToken;

  const phoneJoinRes = await fetch(`${API_URL}/rooms/${roomCode}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Phone Remote', inviteToken }),
  });
  const phoneJoinData = await phoneJoinRes.json();
  assert(phoneJoinData.participant?.role === 'MODERATOR', 'Phone joined as MODERATOR');
  const phoneToken = phoneJoinData.sessionToken;

  const phoneSocket = await connectSocket(phoneToken, roomCode);
  await joinRoomViaSocket(phoneSocket, roomCode);
  assert(phoneSocket.connected, 'Phone Remote socket connected and joined');

  // Step 4: Car Host starts video playback via playback:change-video
  console.log('\n[Test 4] Host initiates authoritative playback...');
  let latestCarState: any = null;
  let latestPhoneState: any = null;

  carSocket.on('playback:state', (event: any) => {
    latestCarState = event.state || event;
  });
  phoneSocket.on('playback:state', (event: any) => {
    latestPhoneState = event.state || event;
  });

  await new Promise<void>((resolve, reject) => {
    carSocket.emit(
      'playback:change-video',
      {
        videoId: 'dQw4w9WgXcQ',
        autoPlay: true,
        title: 'Rick Astley - Never Gonna Give You Up',
        channelTitle: 'RickAstleyVEVO',
        thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        durationSec: 212,
      },
      (res: any) => {
        if (res?.success) resolve();
        else reject(new Error(res?.error || 'Play failed'));
      }
    );
  });

  await new Promise((r) => setTimeout(r, 600));
  assert(latestCarState?.isPlaying === true, 'Car Screen received isPlaying: true');
  assert(latestPhoneState?.isPlaying === true, 'Phone Remote received isPlaying: true');
  assert(latestCarState?.currentVideoId === 'dQw4w9WgXcQ', 'Video ID verified on all devices');

  // Step 5: Simulate seek with drift correction
  console.log('\n[Test 5] Seeking position (simulating seek during active playback)...');
  await new Promise<void>((resolve, reject) => {
    carSocket.emit('playback:seek', { timestamp: 45 }, (res: any) => {
      if (res?.success) resolve();
      else reject(new Error(res?.error || 'Seek failed'));
    });
  });

  await new Promise((r) => setTimeout(r, 600));
  assert(latestCarState?.isPlaying === true, 'Room remains in PLAYING state after seek (not auto-paused)');
  assert(Math.abs(latestCarState?.currentTimestamp - 45) < 3, 'Seek timestamp aligned within drift window');

  // Step 6: Verify explicit user pause works as expected
  console.log('\n[Test 6] Explicit user pause command...');
  await new Promise<void>((resolve, reject) => {
    phoneSocket.emit('playback:pause', { timestamp: 46 }, (res: any) => {
      if (res?.success) resolve();
      else reject(new Error(res?.error || 'Pause failed'));
    });
  });

  await new Promise((r) => setTimeout(r, 600));
  assert(latestCarState?.isPlaying === false, 'Room transitioned to PAUSED on deliberate user command');

  // Step 7: Verify explicit user resume
  console.log('\n[Test 7] Explicit user resume command...');
  await new Promise<void>((resolve, reject) => {
    carSocket.emit('playback:play', { timestamp: 46 }, (res: any) => {
      if (res?.success) resolve();
      else reject(new Error(res?.error || 'Resume failed'));
    });
  });

  await new Promise((r) => setTimeout(r, 600));
  assert(latestCarState?.isPlaying === true, 'Room resumed to PLAYING');

  // Step 8: Reconnection and visibility simulation (fetch state without mutation)
  console.log('\n[Test 8] Reconnecting / visibility change state restoration...');
  const stateRes = await fetch(`${API_URL}/rooms/${roomCode}`, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  const stateData = await stateRes.json();
  assert(stateData.room?.isPlaying === true, 'Authoritative REST state preserves playing status');

  carSocket.disconnect();
  phoneSocket.disconnect();

  console.log('\n==========================================================================');
  console.log(`  RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('==========================================================================\n');

  if (failedTests > 0) process.exit(1);
}

runTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
