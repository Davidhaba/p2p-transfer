const { admin, db } = require('./_firebase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { room, clientId, clientName } = req.body;
  if (!room || !clientId || !clientName) {
    return res.status(400).json({ error: 'Missing room, clientId, or clientName' });
  }

  const roomId = room.toString().trim().toLowerCase();
  const membersRef = db.collection('rooms').doc(roomId).collection('members');
  const now = admin.firestore.Timestamp.now();

  await db.collection('rooms').doc(roomId).set({ updatedAt: now }, { merge: true });
  await membersRef.doc(clientId).set({
    clientId,
    clientName,
    joinedAt: now,
    lastSeen: now,
  });

  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 30000);
  const peerSnapshot = await membersRef.get();
  const peers = peerSnapshot.docs
    .filter((doc) => doc.id !== clientId)
    .map((doc) => doc.data())
    .filter((peer) => peer.lastSeen && peer.lastSeen.toMillis() >= cutoff.toMillis())
    .map((peer) => ({
      deviceId: peer.clientId,
      deviceName: peer.clientName,
    }));

  return res.status(200).json({ room: roomId, peers });
};
