// Security rules tests. Run with: npm run test:rules (starts the Firestore emulator)
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, Timestamp, updateDoc, writeBatch } from "firebase/firestore";

let env;

const ALICE = { uid: "alice", email: "alice@example.com", username: "alice_1" };
const BOB = { uid: "bob", email: "bob@example.com", username: "bob_2" };

const as = user => env.authenticatedContext(user.uid, { email: user.email }).firestore();
const anon = () => env.unauthenticatedContext().firestore();

function registerBatch(db, user, overrides = {}) {
  const batch = writeBatch(db);
  batch.set(doc(db, "users", user.uid), {
    displayName: "Display", username: user.username, email: user.email,
    timezone: "America/Toronto", createdAt: serverTimestamp(), ...overrides.user
  });
  batch.set(doc(db, "usernames", overrides.username ?? user.username), {
    uid: user.uid, displayName: "Display", ...overrides.usernameDoc
  });
  return batch;
}

async function seedUser(user) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", user.uid), {
      displayName: "Display", username: user.username, email: user.email, timezone: "UTC", createdAt: Timestamp.now()
    });
    await setDoc(doc(db, "usernames", user.username), { uid: user.uid, displayName: "Display" });
  });
}

function connectionData(from, to, overrides = {}) {
  return {
    fromUid: from.uid, toUid: to.uid, fromUsername: from.username, toUsername: to.username,
    toDisplayName: "Display", createdAt: serverTimestamp(), ...overrides
  };
}

function tapBatch(db, from, to, timestamp = serverTimestamp()) {
  const batch = writeBatch(db);
  batch.set(doc(db, "users", from.uid, "tapsSent", `t${Math.random()}`), { toUid: to.uid, timestamp });
  batch.set(doc(db, "users", from.uid, "tapCooldowns", to.uid), { last: serverTimestamp() });
  return batch;
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-delbedel",
    firestore: { rules: readFileSync("firestore.rules", "utf8") }
  });
});

beforeEach(() => env.clearFirestore());

after(() => env.cleanup());

describe("registration", () => {
  test("a user can register with their own uid and username", async () => {
    await assertSucceeds(registerBatch(as(ALICE), ALICE).commit());
  });

  test("a username cannot point at another user's uid", async () => {
    await assertFails(setDoc(doc(as(ALICE), "usernames", "fake_bob"), { uid: BOB.uid, displayName: "Bob" }));
  });

  test("a username cannot be claimed without the matching user document", async () => {
    await assertFails(setDoc(doc(as(ALICE), "usernames", "squatted"), { uid: ALICE.uid, displayName: "Alice" }));
  });

  test("a second username cannot be claimed after registration", async () => {
    await seedUser(ALICE);
    await assertFails(setDoc(doc(as(ALICE), "usernames", "second_name"), { uid: ALICE.uid, displayName: "Alice" }));
  });

  test("an existing username cannot be taken over", async () => {
    await seedUser(BOB);
    await assertFails(registerBatch(as(ALICE), { ...ALICE, username: BOB.username }).commit());
  });

  test("invalid usernames are rejected", async () => {
    const user = { ...ALICE, username: "<img src=x>" };
    await assertFails(registerBatch(as(ALICE), user).commit());
  });

  test("display names over 50 characters are rejected", async () => {
    const long = "x".repeat(51);
    await assertFails(registerBatch(as(ALICE), ALICE, { user: { displayName: long }, usernameDoc: { displayName: long } }).commit());
  });

  test("the stored email must match the signed-in account", async () => {
    await assertFails(registerBatch(as(ALICE), ALICE, { user: { email: "someone@else.com" } }).commit());
  });

  test("createdAt must be the server time", async () => {
    await assertFails(registerBatch(as(ALICE), ALICE, { user: { createdAt: Timestamp.fromDate(new Date(2020, 0, 1)) } }).commit());
  });

  test("extra fields are rejected", async () => {
    await assertFails(registerBatch(as(ALICE), ALICE, { user: { isAdmin: true } }).commit());
  });

  test("signed-out users cannot read usernames", async () => {
    await seedUser(ALICE);
    await assertFails(getDoc(doc(anon(), "usernames", ALICE.username)));
  });
});

describe("profile updates", () => {
  beforeEach(() => seedUser(ALICE));

  test("display name and timezone can be updated", async () => {
    await assertSucceeds(updateDoc(doc(as(ALICE), "users", ALICE.uid), { displayName: "New", timezone: "Asia/Tehran" }));
  });

  test("username cannot be changed", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "users", ALICE.uid), { username: "other_name" }));
  });

  test("invalid timezone strings are rejected", async () => {
    await assertFails(updateDoc(doc(as(ALICE), "users", ALICE.uid), { timezone: "<script>" }));
  });

  test("users cannot read each other's profiles", async () => {
    await seedUser(BOB);
    await assertFails(getDoc(doc(as(BOB), "users", ALICE.uid)));
  });
});

describe("connections", () => {
  beforeEach(async () => {
    await seedUser(ALICE);
    await seedUser(BOB);
  });

  test("a valid connection can be created", async () => {
    await assertSucceeds(setDoc(doc(as(ALICE), "connections", "alice_bob"), connectionData(ALICE, BOB)));
  });

  test("the connection ID must be fromUid_toUid", async () => {
    await assertFails(setDoc(doc(as(ALICE), "connections", "random_id"), connectionData(ALICE, BOB)));
  });

  test("users cannot connect to themselves", async () => {
    await assertFails(setDoc(doc(as(ALICE), "connections", "alice_alice"), connectionData(ALICE, ALICE)));
  });

  test("the target username must belong to the target uid", async () => {
    await assertFails(setDoc(doc(as(ALICE), "connections", "alice_bob"), connectionData(ALICE, BOB, { toUsername: ALICE.username })));
  });

  test("the sender username must be the sender's own", async () => {
    await assertFails(setDoc(doc(as(ALICE), "connections", "alice_bob"), connectionData(ALICE, BOB, { fromUsername: BOB.username })));
  });

  test("checking your own not-yet-existing connection is allowed", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "connections", "alice_bob")));
  });

  test("the target can read, a third party cannot, and only the creator can delete", async () => {
    await setDoc(doc(as(ALICE), "connections", "alice_bob"), connectionData(ALICE, BOB));
    const carol = { uid: "carol", email: "carol@example.com", username: "carol_3" };
    await assertSucceeds(getDoc(doc(as(BOB), "connections", "alice_bob")));
    await assertFails(getDoc(doc(as(carol), "connections", "alice_bob")));
    await assertFails(deleteDoc(doc(as(BOB), "connections", "alice_bob")));
    await assertSucceeds(deleteDoc(doc(as(ALICE), "connections", "alice_bob")));
  });
});

describe("taps", () => {
  beforeEach(async () => {
    await seedUser(ALICE);
    await seedUser(BOB);
    await setDoc(doc(as(ALICE), "connections", "alice_bob"), connectionData(ALICE, BOB));
  });

  test("a tap to a connection succeeds", async () => {
    await assertSucceeds(tapBatch(as(ALICE), ALICE, BOB).commit());
  });

  test("a second tap within 3 minutes is rejected", async () => {
    await tapBatch(as(ALICE), ALICE, BOB).commit();
    await assertFails(tapBatch(as(ALICE), ALICE, BOB).commit());
  });

  test("a tap without the cooldown update is rejected", async () => {
    const db = as(ALICE);
    await assertFails(setDoc(doc(db, "users", ALICE.uid, "tapsSent", "t1"), { toUid: BOB.uid, timestamp: serverTimestamp() }));
  });

  test("backdated taps are rejected", async () => {
    await assertFails(tapBatch(as(ALICE), ALICE, BOB, Timestamp.fromDate(new Date(2020, 0, 1))).commit());
  });

  test("taps to non-connections are rejected", async () => {
    await assertFails(tapBatch(as(BOB), BOB, ALICE).commit());
  });

  test("taps cannot be written into another user's collection", async () => {
    const db = as(BOB);
    const batch = writeBatch(db);
    batch.set(doc(db, "users", ALICE.uid, "tapsSent", "t1"), { toUid: BOB.uid, timestamp: serverTimestamp() });
    await assertFails(batch.commit());
  });

  test("the old tapsReceived collection is closed", async () => {
    await assertFails(setDoc(doc(as(BOB), "users", ALICE.uid, "tapsReceived", "t1"), {
      fromUid: BOB.uid, fromUsername: "<img src=x>", timestamp: serverTimestamp()
    }));
  });
});

describe("server-written data", () => {
  beforeEach(async () => {
    await seedUser(ALICE);
    await seedUser(BOB);
    await env.withSecurityRulesDisabled(ctx =>
      setDoc(doc(ctx.firestore(), "users", ALICE.uid, "dailySummary", "2026-09-28"), { tapsSent: 1 }));
  });

  test("the owner can read their summary but not write it", async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), "users", ALICE.uid, "dailySummary", "2026-09-28")));
    await assertFails(setDoc(doc(as(ALICE), "users", ALICE.uid, "dailySummary", "2026-09-28"), { tapsSent: 99 }));
  });

  test("other users cannot read someone's summary", async () => {
    await assertFails(getDoc(doc(as(BOB), "users", ALICE.uid, "dailySummary", "2026-09-28")));
  });

  test("research data is not accessible to clients", async () => {
    await assertFails(getDoc(doc(as(ALICE), "research", "matches")));
    await assertFails(setDoc(doc(as(ALICE), "research", "matches"), { x: 1 }));
  });
});
