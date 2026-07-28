const { admin, db } = require('./_firebase');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { room, clientId } = req.body;
  if (!room || !clientId) {
    return res.status(400).json({ error: 'Missing room or clientId' });
  }

  const roomId = room.toString().trim().toLowerCase();
  const memberRef = db.collection('rooms').doc(roomId).collection('members').doc(clientId);
  await memberRef.delete();

  return res.status(200).json({ ok: true });
};
