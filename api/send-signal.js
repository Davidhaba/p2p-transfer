const { admin, db } = require('./_firebase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { room, from, to, signal } = req.body;
  if (!room || !from || !to || !signal) {
    return res.status(400).json({ error: 'Missing room, from, to, or signal' });
  }

  const roomId = room.toString().trim().toLowerCase();
  const signalsRef = db.collection('rooms').doc(roomId).collection('signals');
  const now = admin.firestore.Timestamp.now();

  await signalsRef.add({
    from,
    to,
    signal,
    createdAt: now,
  });

  return res.status(200).json({ ok: true });
};
