"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze, findMatches, localDateKey, isValidTimezone } = require("../analysis");

const at = iso => new Date(iso);
const tap = (fromUid, toUid, iso) => ({ fromUid, toUid, time: at(iso) });
const profiles = {
  alice: { username: "alice", timezone: "America/Toronto" },
  bob: { username: "bob", timezone: "Asia/Tehran" }
};

test("taps in opposite directions within 10 minutes match", () => {
  const matches = findMatches([tap("alice", "bob", "2026-09-28T14:00:00Z"), tap("bob", "alice", "2026-09-28T14:09:00Z")]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].gapSeconds, 540);
});

test("taps more than 10 minutes apart do not match", () => {
  const matches = findMatches([tap("alice", "bob", "2026-09-28T14:00:00Z"), tap("bob", "alice", "2026-09-28T14:10:01Z")]);
  assert.equal(matches.length, 0);
});

test("taps in the same direction never match", () => {
  const matches = findMatches([tap("alice", "bob", "2026-09-28T14:00:00Z"), tap("alice", "bob", "2026-09-28T14:01:00Z")]);
  assert.equal(matches.length, 0);
});

test("each tap is used in at most one match, pairing closest first", () => {
  const matches = findMatches([
    tap("alice", "bob", "2026-09-28T14:00:00Z"),
    tap("alice", "bob", "2026-09-28T14:04:00Z"),
    tap("bob", "alice", "2026-09-28T14:05:00Z")
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].gapSeconds, 300);
});

test("local dates follow each user's timezone", () => {
  // 03:30 UTC is 23:30 the previous day in Toronto and 07:00 the same day in Tehran
  const time = at("2026-09-28T03:30:00Z");
  assert.equal(localDateKey(time, "America/Toronto"), "2026-09-27");
  assert.equal(localDateKey(time, "Asia/Tehran"), "2026-09-28");
});

test("a tap is counted on each user's own local date", () => {
  const { summaries } = analyze([tap("alice", "bob", "2026-09-28T03:30:00Z")], profiles, at("2026-09-28T12:00:00Z"));
  assert.equal(summaries.alice["2026-09-27"].tapsSent, 1);
  assert.equal(summaries.bob["2026-09-28"].tapsReceived, 1);
  assert.deepEqual(summaries.bob["2026-09-28"].tappedBy, { alice: 1 });
});

test("late-evening taps are included (previously missed after the last run of the day)", () => {
  // 23:50 Toronto time on Sept 27, analysed the next morning
  const { summaries } = analyze([tap("alice", "bob", "2026-09-28T03:50:00Z")], profiles, at("2026-09-28T13:00:00Z"));
  assert.equal(summaries.alice["2026-09-27"].tapsSent, 1);
});

test("taps older than the user's local yesterday are not rewritten", () => {
  const { summaries } = analyze([tap("alice", "bob", "2026-09-25T15:00:00Z")], profiles, at("2026-09-28T12:00:00Z"));
  assert.equal(summaries.alice, undefined);
});

test("matches appear in both users' summaries with server-side usernames", () => {
  const taps = [tap("alice", "bob", "2026-09-28T14:00:00Z"), tap("bob", "alice", "2026-09-28T14:02:00Z")];
  const { summaries } = analyze(taps, profiles, at("2026-09-28T15:00:00Z"));
  const a = summaries.alice["2026-09-28"];
  const b = summaries.bob["2026-09-28"];
  assert.equal(a.matchCount, 1);
  assert.equal(a.matches[0].withUsername, "bob");
  assert.equal(b.matches[0].withUsername, "alice");
  assert.equal(a.unmatchedSent, 0);
});

test("unknown senders are counted but not named, and invalid timezones fall back to UTC", () => {
  const withBadTz = { bob: { username: "bob", timezone: "Not/AZone" } };
  const { summaries } = analyze([tap("ghost", "bob", "2026-09-28T14:00:00Z")], withBadTz, at("2026-09-28T15:00:00Z"));
  assert.equal(isValidTimezone("Not/AZone"), false);
  assert.equal(summaries.bob["2026-09-28"].tapsReceived, 1);
  assert.deepEqual(summaries.bob["2026-09-28"].tappedBy, {});
});
