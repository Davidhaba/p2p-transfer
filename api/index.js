const { admin, db } = require('./_firebase');

const parseRoute = (req) => {
  const url = req.url || '';
  const parsed = new URL(url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsed.pathname;

  if (pathname.startsWith('/')) {
    pathname = pathname.substring(1);
  }

  return pathname || 'ping';
};

const jsonResponse = (res, status, body) => {
  res.status(status).json(body);
};

const requireMethod = (req, res, method) => {
  if (req.method !== method) {
    res.setHeader('Allow', method);
    jsonResponse(res, 405, { error: 'Method not allowed' });
    return false;
  }
  return true;
};

const normalizeRoomId = (room) => room.toString().trim().toLowerCase();

const fetchAndDeleteSignals = async (roomId, clientId) => {
  const signalsRef = db.collection('rooms').doc(roomId).collection('signals');
  const querySnapshot = await signalsRef
    .where('to', '==', clientId)
    .orderBy('createdAt', 'asc')
    .limit(50)
    .get();

  const signals = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const batch = db.batch();
  querySnapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  return signals;
};

const getRoomPeers = async (roomId, clientId) => {
  const membersRef = db.collection('rooms').doc(roomId).collection('members');
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 30000);
  const memberSnapshot = await membersRef.get();

  return memberSnapshot.docs
    .filter((doc) => doc.id !== clientId)
    .map((doc) => doc.data())
    .filter((peer) => peer.lastSeen && peer.lastSeen.toMillis() >= cutoff.toMillis())
    .map((peer) => ({
      deviceId: peer.clientId,
      deviceName: peer.clientName,
    }));
};

const crypto = require('crypto');

const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');

const handleJoinRoom = async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const { room, clientId, clientName, password } = req.body || {};
  if (!room || !clientId || !clientName) {
    return jsonResponse(res, 400, { error: 'Missing room, clientId, or clientName' });
  }

  const roomId = normalizeRoomId(room);
  const membersRef = db.collection('rooms').doc(roomId).collection('members');
  const now = admin.firestore.Timestamp.now();
  const roomRef = db.collection('rooms').doc(roomId);
  const roomSnap = await roomRef.get();

  if (!roomSnap.exists) {
    if (password === undefined) {
      return jsonResponse(res, 200, { status: 'create_password' });
    }
    try {
      if (password === '') {
        await roomRef.set({ updatedAt: now }, { merge: true });
      } else {
        await roomRef.set({ passwordHash: hashPassword(password), updatedAt: now }, { merge: true });
      }
    } catch (err) {
      console.error('Failed to create room with password:', err);
      return jsonResponse(res, 500, { error: 'Failed to create room' });
    }
  } else {
    const roomData = roomSnap.data() || {};
    const storedHash = roomData.passwordHash;
    const roomProtected = storedHash !== undefined && storedHash !== null;
    const passwordSent = password !== undefined && password !== null;

    if (roomProtected) {
      if (!passwordSent) {
        return jsonResponse(res, 200, { status: 'require_password' });
      }
      const providedHash = hashPassword(password);
      if (providedHash !== storedHash) {
        return jsonResponse(res, 200, { status: 'wrong_password' });
      }
    }
  }

  try {
    await roomRef.set({ updatedAt: now }, { merge: true });
    await membersRef.doc(clientId).set({
      clientId,
      clientName,
      joinedAt: now,
      lastSeen: now,
    });

    const peers = await getRoomPeers(roomId, clientId);
    const signals = await fetchAndDeleteSignals(roomId, clientId);

    try {
      const memberSnapshot = await membersRef.get();
      const signalsRef = db.collection('rooms').doc(roomId).collection('signals');
      const batch = db.batch();
      memberSnapshot.docs
        .filter((doc) => doc.id !== clientId)
        .forEach((doc) => {
          const other = doc.data();
          const sigDoc = signalsRef.doc();
          batch.set(sigDoc, {
            from: clientId,
            to: other.clientId,
            signal: {
              type: 'peer_joined',
              deviceId: clientId,
              deviceName: clientName,
            },
            createdAt: now,
          });
        });
      await batch.commit();
    } catch (err) {
      console.error('Failed to write peer_joined signals:', err);
    }

    return jsonResponse(res, 200, { status: 'joined', room: roomId, peers, signals });
  } catch (err) {
    console.error('Failed to join room:', err);
    return jsonResponse(res, 500, { error: 'Failed to join room' });
  }
};

const handleGetPeers = async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;

  const room = req.query.room;
  const clientId = req.query.clientId;
  if (!room || !clientId) {
    return jsonResponse(res, 400, { error: 'Missing room or clientId' });
  }

  const roomId = normalizeRoomId(room);
  try {
    const membersRef = db.collection('rooms').doc(roomId).collection('members');
    const now = admin.firestore.Timestamp.now();
    await membersRef.doc(clientId).set({ lastSeen: now }, { merge: true });
  } catch (err) {
    console.error('Failed to update lastSeen in get-peers:', err);
  }
  const membersRef = db.collection('rooms').doc(roomId).collection('members');
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 30000);
  const memberSnapshot = await membersRef.get();

  const peers = memberSnapshot.docs
    .filter((doc) => doc.id !== clientId)
    .map((doc) => doc.data())
    .filter((peer) => peer.lastSeen && peer.lastSeen.toMillis() >= cutoff.toMillis())
    .map((peer) => ({
      deviceId: peer.clientId,
      deviceName: peer.clientName,
    }));

  return jsonResponse(res, 200, { peers });
};

const handleRoomState = async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;

  const room = req.query.room;
  const clientId = req.query.clientId;
  if (!room || !clientId) {
    return jsonResponse(res, 400, { error: 'Missing room or clientId' });
  }

  const roomId = normalizeRoomId(room);
  try {
    const membersRef = db.collection('rooms').doc(roomId).collection('members');
    const now = admin.firestore.Timestamp.now();
    await membersRef.doc(clientId).set({ lastSeen: now }, { merge: true });
  } catch (err) {
    console.error('Failed to update lastSeen in room-state:', err);
  }
  const peers = await getRoomPeers(roomId, clientId);
  const signals = await fetchAndDeleteSignals(roomId, clientId);
  return jsonResponse(res, 200, { peers, signals });
};

const handleSendSignal = async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const { room, from, to, signal } = req.body || {};
  if (!room || !from || !to || !signal) {
    return jsonResponse(res, 400, { error: 'Missing room, from, to, or signal' });
  }

  const roomId = normalizeRoomId(room);
  const signalsRef = db.collection('rooms').doc(roomId).collection('signals');
  const now = admin.firestore.Timestamp.now();

  await signalsRef.add({
    from,
    to,
    signal,
    createdAt: now,
  });

  return jsonResponse(res, 200, { ok: true });
};

const handlePollSignals = async (req, res) => {
  if (!requireMethod(req, res, 'GET')) return;

  const room = req.query.room;
  const clientId = req.query.clientId;
  if (!room || !clientId) {
    return jsonResponse(res, 400, { error: 'Missing room or clientId' });
  }

  const roomId = normalizeRoomId(room);
  try {
    const membersRef = db.collection('rooms').doc(roomId).collection('members');
    const now = admin.firestore.Timestamp.now();
    await membersRef.doc(clientId).set({ lastSeen: now }, { merge: true });
  } catch (err) {
    console.error('Failed to update lastSeen in poll-signals:', err);
  }
  const signalsRef = db.collection('rooms').doc(roomId).collection('signals');
  try {
    const querySnapshot = await signalsRef
      .where('to', '==', clientId)
      .orderBy('createdAt', 'asc')
      .limit(50)
      .get();

    const signals = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const batch = db.batch();
    querySnapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    return jsonResponse(res, 200, { signals });
  } catch (error) {
    console.error('API error while polling signals:', error);
    return jsonResponse(res, 200, { signals: [], warning: 'firestore_query_requires_index_or_failed', details: String(error) });
  }
};

const handleLeaveRoom = async (req, res) => {
  if (!requireMethod(req, res, 'POST')) return;

  const { room, clientId } = req.body || {};
  if (!room || !clientId) {
    return jsonResponse(res, 400, { error: 'Missing room or clientId' });
  }

  const roomId = normalizeRoomId(room);
  const memberRef = db.collection('rooms').doc(roomId).collection('members').doc(clientId);
  try {
    const membersRef = db.collection('rooms').doc(roomId).collection('members');
    const membersSnapshot = await membersRef.get();
    const signalsRef = db.collection('rooms').doc(roomId).collection('signals');
    const now = admin.firestore.Timestamp.now();

    const batch = db.batch();
    membersSnapshot.docs
      .filter((doc) => doc.id !== clientId)
      .forEach((doc) => {
        const other = doc.data();
        const sigDoc = signalsRef.doc();
        batch.set(sigDoc, {
          from: clientId,
          to: other.clientId,
          signal: {
            type: 'peer_left',
            deviceId: clientId,
          },
          createdAt: now,
        });
      });

    await memberRef.delete();
    await batch.commit();
  } catch (err) {
    // If something fails, still attempt to delete the member and log the error.
    console.error('Error while notifying peers on leave:', err);
    try {
      await memberRef.delete();
    } catch (e) {
      console.error('Failed to delete member after notification error:', e);
    }
  }

  return jsonResponse(res, 200, { ok: true });
};

const handlePing = async (req, res) => {
  return jsonResponse(res, 200, { status: 'ok' });
};

module.exports = async (req, res) => {
  try {
    const route = parseRoute(req);

    switch (route) {
      case 'join-room':
        return await handleJoinRoom(req, res);
      case 'get-peers':
        return await handleGetPeers(req, res);
      case 'room-state':
        return await handleRoomState(req, res);
      case 'send-signal':
        return await handleSendSignal(req, res);
      case 'poll-signals':
        return await handlePollSignals(req, res);
      case 'leave-room':
        return await handleLeaveRoom(req, res);
      case 'ping':
        return await handlePing(req, res);
      default:
        return jsonResponse(res, 404, { error: 'Not found' });
    }
  } catch (error) {
    console.error('API error:', error);
    return jsonResponse(res, 500, { error: 'Internal server error' });
  }
};
