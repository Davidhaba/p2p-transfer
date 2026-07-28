const { admin, db } = require('./_firebase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const room = req.query.room;
  const clientId = req.query.clientId;
  if (!room || !clientId) {
    return res.status(400).json({ error: 'Missing room or clientId' });
  }

  const roomId = room.toString().trim().toLowerCase();
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

  return res.status(200).json({ peers });
};
