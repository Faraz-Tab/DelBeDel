"use strict";

const MATCH_WINDOW_MS = 10 * 60 * 1000;
// Covers "yesterday" and "today" in every timezone (UTC-12 to UTC+14) plus the match window
const LOOKBACK_MS = 49 * 60 * 60 * 1000;
const DEFAULT_TIMEZONE = "UTC";

function isValidTimezone(tz) {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localDateKey(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function timezoneOf(profiles, uid) {
  const tz = profiles[uid] && profiles[uid].timezone;
  return isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

function usernameOf(profiles, uid) {
  return (profiles[uid] && profiles[uid].username) || null;
}

/**
 * Pair each A->B tap with the closest unused B->A tap within the match window.
 * Taps: [{ fromUid, toUid, time: Date }]
 */
function findMatches(taps) {
  const byPair = new Map();
  for (const tap of taps) {
    const key = `${tap.fromUid}__${tap.toUid}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(tap);
  }

  const matches = [];
  const checked = new Set();
  for (const [key, tapsAB] of byPair) {
    const [uidA, uidB] = key.split("__");
    const pairId = [uidA, uidB].sort().join("__");
    if (checked.has(pairId)) continue;
    checked.add(pairId);

    const tapsBA = byPair.get(`${uidB}__${uidA}`);
    if (!tapsBA) continue;

    const sortedAB = [...tapsAB].sort((a, b) => a.time - b.time);
    const sortedBA = [...tapsBA].sort((a, b) => a.time - b.time);
    const used = new Set();

    for (const tapA of sortedAB) {
      let best = -1;
      let bestGap = Infinity;
      sortedBA.forEach((tapB, i) => {
        const gap = Math.abs(tapA.time - tapB.time);
        if (!used.has(i) && gap <= MATCH_WINDOW_MS && gap < bestGap) {
          best = i;
          bestGap = gap;
        }
      });
      if (best >= 0) {
        used.add(best);
        const tapB = sortedBA[best];
        matches.push({
          userA: uidA,
          userB: uidB,
          tapATime: tapA.time,
          tapBTime: tapB.time,
          matchedAt: tapA.time < tapB.time ? tapA.time : tapB.time,
          gapSeconds: Math.round(bestGap / 1000)
        });
      }
    }
  }
  return matches;
}

function emptySummary(date) {
  return {
    date, tapsSent: 0, tapsReceived: 0, matchedTaps: 0,
    unmatchedSent: 0, unmatchedReceived: 0, matchCount: 0, matches: [], tappedBy: {}
  };
}

/**
 * Build each user's summaries for their local "today" and "yesterday".
 * Usernames and timezones come from server-side profiles, never from client-written tap fields.
 * Returns { summaries: { uid: { dateKey: summary } }, matches }
 */
function analyze(taps, profiles, now) {
  const matches = findMatches(taps);
  const summaries = {};

  const datesFor = uid => {
    const tz = timezoneOf(profiles, uid);
    return new Set([localDateKey(now, tz), localDateKey(new Date(now - 24 * 60 * 60 * 1000), tz)]);
  };
  const summaryFor = (uid, time) => {
    const date = localDateKey(time, timezoneOf(profiles, uid));
    if (!datesFor(uid).has(date)) return null;
    summaries[uid] = summaries[uid] || {};
    summaries[uid][date] = summaries[uid][date] || emptySummary(date);
    return summaries[uid][date];
  };

  for (const tap of taps) {
    const sent = summaryFor(tap.fromUid, tap.time);
    if (sent) sent.tapsSent++;

    const received = summaryFor(tap.toUid, tap.time);
    if (received) {
      received.tapsReceived++;
      const sender = usernameOf(profiles, tap.fromUid);
      if (sender) received.tappedBy[sender] = (received.tappedBy[sender] || 0) + 1;
    }
  }

  for (const match of matches) {
    for (const [self, other] of [[match.userA, match.userB], [match.userB, match.userA]]) {
      const summary = summaryFor(self, match.matchedAt);
      if (!summary) continue;
      summary.matchedTaps++;
      summary.matches.push({
        withUid: other,
        withUsername: usernameOf(profiles, other),
        gapSeconds: match.gapSeconds,
        matchedAt: match.matchedAt
      });
    }
  }

  for (const byDate of Object.values(summaries)) {
    for (const s of Object.values(byDate)) {
      s.matches.sort((a, b) => a.matchedAt - b.matchedAt);
      s.matchCount = s.matches.length;
      s.unmatchedSent = Math.max(0, s.tapsSent - s.matchedTaps);
      s.unmatchedReceived = Math.max(0, s.tapsReceived - s.matchedTaps);
    }
  }

  return { summaries, matches };
}

module.exports = {
  MATCH_WINDOW_MS, LOOKBACK_MS, DEFAULT_TIMEZONE,
  isValidTimezone, localDateKey, findMatches, analyze
};
