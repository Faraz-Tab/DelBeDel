const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const MATCH_WINDOW_MS = 10 * 60 * 1000;

exports.dailyAnalysis = onSchedule("0 */6 * * *", async (event) => {
  const now = new Date();
  const dateKey = now.toISOString().split("T")[0];

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  const sentSnap = await db.collectionGroup("tapsSent")
    .where("timestamp", ">=", dayStart)
    .get();

  const allTaps = [];
  sentSnap.forEach(doc => {
    const data = doc.data();
    const senderUid = doc.ref.parent.parent.id;
    allTaps.push({
      fromUid: senderUid,
      toUid: data.toUid,
      toUsername: data.toUsername,
      timestamp: data.timestamp.toDate()
    });
  });

  const receivedSnap = await db.collectionGroup("tapsReceived")
    .where("timestamp", ">=", dayStart)
    .get();

  const receivedByUser = {};
  receivedSnap.forEach(doc => {
    const data = doc.data();
    const receiverUid = doc.ref.parent.parent.id;
    if (!receivedByUser[receiverUid]) receivedByUser[receiverUid] = [];
    receivedByUser[receiverUid].push({
      fromUid: data.fromUid,
      fromUsername: data.fromUsername,
      timestamp: data.timestamp.toDate()
    });
  });

  const pairMap = {};
  for (const tap of allTaps) {
    const key = `${tap.fromUid}__${tap.toUid}`;
    if (!pairMap[key]) pairMap[key] = [];
    pairMap[key].push(tap);
  }

  const matches = [];
  const userStats = {};

  const ensureUser = (uid) => {
    if (!userStats[uid]) {
      userStats[uid] = {
        tapsSent: 0,
        tapsReceived: 0,
        matchedTaps: 0,
        unmatchedSent: 0,
        unmatchedReceived: 0,
        matches: []
      };
    }
  };

  for (const tap of allTaps) {
    ensureUser(tap.fromUid);
    ensureUser(tap.toUid);
    userStats[tap.fromUid].tapsSent++;
    userStats[tap.toUid].tapsReceived++;
  }

  const checkedPairs = new Set();
  for (const keyAB of Object.keys(pairMap)) {
    const [uidA, uidB] = keyAB.split("__");
    const pairId = [uidA, uidB].sort().join("__");

    if (checkedPairs.has(pairId)) continue;
    checkedPairs.add(pairId);

    const keyBA = `${uidB}__${uidA}`;
    const tapsAB = pairMap[keyAB] || [];
    const tapsBA = pairMap[keyBA] || [];

    if (tapsAB.length === 0 || tapsBA.length === 0) continue;

    const usedB = new Set();
    const sortedAB = [...tapsAB].sort((a, b) => a.timestamp - b.timestamp);
    const sortedBA = [...tapsBA].sort((a, b) => a.timestamp - b.timestamp);

    for (const tapA of sortedAB) {
      let bestMatch = null;
      let bestGap = Infinity;

      for (let i = 0; i < sortedBA.length; i++) {
        if (usedB.has(i)) continue;
        const gap = Math.abs(tapA.timestamp - sortedBA[i].timestamp);
        if (gap <= MATCH_WINDOW_MS && gap < bestGap) {
          bestMatch = i;
          bestGap = gap;
        }
      }

      if (bestMatch !== null) {
        usedB.add(bestMatch);
        matches.push({
          userA: uidA,
          userB: uidB,
          userAUsername: sortedBA[bestMatch].toUsername,
          userBUsername: tapA.toUsername,
          tapA_time: tapA.timestamp,
          tapB_time: sortedBA[bestMatch].timestamp,
          gapSeconds: Math.round(bestGap / 1000)
        });
      }
    }
  }

  for (const match of matches) {
    ensureUser(match.userA);
    ensureUser(match.userB);
    userStats[match.userA].matchedTaps++;
    userStats[match.userB].matchedTaps++;
    const matchedAt = match.tapA_time < match.tapB_time ? match.tapA_time : match.tapB_time;
    userStats[match.userA].matches.push({
      withUid: match.userB,
      withUsername: match.userBUsername,
      gapSeconds: match.gapSeconds,
      matchedAt
    });
    userStats[match.userB].matches.push({
      withUid: match.userA,
      withUsername: match.userAUsername,
      gapSeconds: match.gapSeconds,
      matchedAt
    });
  }

  for (const uid of Object.keys(userStats)) {
    const s = userStats[uid];
    s.unmatchedSent = Math.max(0, s.tapsSent - s.matchedTaps);
    s.unmatchedReceived = Math.max(0, s.tapsReceived - s.matchedTaps);
    s.matches.sort((a, b) => a.matchedAt - b.matchedAt);
  }

  const connSnap = await db.collection("connections").get();
  const connTypes = {};
  connSnap.forEach(doc => {
    const d = doc.data();
    const pairId = [d.fromUid, d.toUid].sort().join("__");
    if (d.relationshipType) {
      connTypes[pairId] = d.relationshipType;
    }
  });

  const totalTaps = allTaps.length;
  const totalMatches = matches.length;

  const summaryRef = db.collection("research").doc("daily")
    .collection(dateKey).doc("summary");

  const summaryBatch = db.batch();
  summaryBatch.set(summaryRef, {
    date: dateKey,
    totalTaps,
    totalMatches,
    totalUnmatched: totalTaps - (totalMatches * 2),
    matchRate: totalTaps > 0 ? (totalMatches * 2) / totalTaps : 0,
    windowMinutes: MATCH_WINDOW_MS / 60000,
    activeUsers: Object.keys(userStats).length,
    createdAt: FieldValue.serverTimestamp()
  });
  await summaryBatch.commit();

  const userIds = Object.keys(userStats);
  for (let i = 0; i < userIds.length; i += 400) {
    const chunk = userIds.slice(i, i + 400);
    const batch = db.batch();

    for (const uid of chunk) {
      const ref = db.collection("research").doc("daily")
        .collection(dateKey).doc("users")
        .collection("reports").doc(uid);
      batch.set(ref, userStats[uid]);
    }

    await batch.commit();
  }

  for (let i = 0; i < matches.length; i += 400) {
    const chunk = matches.slice(i, i + 400);
    const batch = db.batch();

    for (const match of chunk) {
      const pairId = [match.userA, match.userB].sort().join("__");
      const recordId = `${pairId}_${match.tapA_time.getTime()}_${match.tapB_time.getTime()}`;
      const ref = db.collection("research").doc("daily")
        .collection(dateKey).doc("matches")
        .collection("records").doc(recordId);
      batch.set(ref, {
        userA: match.userA,
        userB: match.userB,
        tapA_time: match.tapA_time,
        tapB_time: match.tapB_time,
        gapSeconds: match.gapSeconds,
        relationshipType: connTypes[pairId] || null
      });
    }

    await batch.commit();
  }

  for (let i = 0; i < userIds.length; i += 400) {
    const chunk = userIds.slice(i, i + 400);
    const batch = db.batch();

    for (const uid of chunk) {
      const ref = db.collection("users").doc(uid)
        .collection("dailySummary").doc(dateKey);
      const s = userStats[uid];

      const receivedList = receivedByUser[uid] || [];
      const tappedBy = {};
      for (const r of receivedList) {
        tappedBy[r.fromUsername] = (tappedBy[r.fromUsername] || 0) + 1;
      }

      batch.set(ref, {
        date: dateKey,
        tapsSent: s.tapsSent,
        tapsReceived: s.tapsReceived,
        matchedTaps: s.matchedTaps,
        unmatchedSent: s.unmatchedSent,
        unmatchedReceived: s.unmatchedReceived,
        matchCount: s.matches.length,
        matches: s.matches,
        tappedBy
      });
    }

    await batch.commit();
  }

  console.log(`Daily analysis complete: ${dateKey} — ${totalTaps} taps, ${totalMatches} matches, ${userIds.length} users`);
});
