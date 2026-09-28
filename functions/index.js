"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { LOOKBACK_MS, analyze } = require("./analysis");

initializeApp();
const db = getFirestore();
const BATCH_LIMIT = 400;

async function commitInChunks(writes) {
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const [ref, data] of writes.slice(i, i + BATCH_LIMIT)) batch.set(ref, data);
    await batch.commit();
  }
}

async function loadProfiles(uids) {
  if (uids.length === 0) return {};
  const refs = uids.map(uid => db.collection("users").doc(uid));
  const snaps = await db.getAll(...refs);
  const profiles = {};
  for (const snap of snaps) {
    if (snap.exists) {
      const { username, timezone } = snap.data();
      profiles[snap.id] = { username, timezone };
    }
  }
  return profiles;
}

async function runAnalysis(now) {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const snap = await db.collectionGroup("tapsSent").where("timestamp", ">=", since).get();

  const taps = [];
  snap.forEach(doc => {
    const { toUid, timestamp } = doc.data();
    if (typeof toUid !== "string" || !timestamp) return;
    // The sender is the owner of the parent path, which the security rules tie to the authenticated user
    taps.push({ fromUid: doc.ref.parent.parent.id, toUid, time: timestamp.toDate() });
  });

  const uids = [...new Set(taps.flatMap(t => [t.fromUid, t.toUid]))];
  const profiles = await loadProfiles(uids);
  const { summaries, matches } = analyze(taps, profiles, now);

  const writes = [];
  for (const [uid, byDate] of Object.entries(summaries)) {
    for (const [date, summary] of Object.entries(byDate)) {
      writes.push([db.collection("users").doc(uid).collection("dailySummary").doc(date), summary]);
    }
  }
  for (const m of matches) {
    const pairId = [m.userA, m.userB].sort().join("__");
    const recordId = `${pairId}_${m.tapATime.getTime()}_${m.tapBTime.getTime()}`;
    writes.push([db.collection("research").doc("matches").collection("records").doc(recordId), {
      userA: m.userA, userB: m.userB, tapATime: m.tapATime, tapBTime: m.tapBTime, gapSeconds: m.gapSeconds
    }]);
  }
  await commitInChunks(writes);

  logger.info("Analysis complete", { taps: taps.length, matches: matches.length, users: uids.length });
}

// Hourly, so each user's day is finalized soon after their local midnight
exports.dailyAnalysis = onSchedule({ schedule: "every 60 minutes", timeZone: "UTC" }, () => runAnalysis(new Date()));
