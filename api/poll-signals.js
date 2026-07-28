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
  const signalsRef = db.collection('rooms').doc(roomId).collection('signals');
  const querySnapshot = await signalsRef
    .where('to', '==', clientId)
    .orderBy('createdAt', 'asc')
    .limit(50)
    .get();

  const signals = querySnapshot.docs.map((doc) => {
    return {
      id: doc.id,
      ...doc.data(),
    };
  });

  const batch = db.batch();
  querySnapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  return res.status(200).json({ signals });
};
