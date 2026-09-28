let _registering = false;

function redirectIfLoggedIn() {
  auth.onAuthStateChanged(user => {
    if (user && !_registering) window.location.href = "dashboard.html";
  });
}

function redirectIfLoggedOut() {
  auth.onAuthStateChanged(user => {
    if (!user) window.location.href = "login.html";
  });
}

function updateNav() {
  auth.onAuthStateChanged(user => {
    const navAuth = document.getElementById("nav-auth");
    if (!navAuth) return;
    if (user) {
      navAuth.innerHTML = `
        <a href="dashboard.html" data-i18n="nav.dashboard"></a>
        <a href="profile.html" data-i18n="nav.profile"></a>
        <a href="#" onclick="logout()" data-i18n="nav.logout"></a>`;
    } else {
      navAuth.innerHTML = `
        <a href="login.html" data-i18n="nav.login"></a>
        <a href="register.html" data-i18n="nav.register"></a>`;
    }
    i18n.applyAll();
  });
}

function validateUsername(username) {
  return /^[a-z0-9_]{3,20}$/.test(username);
}

function validateDisplayName(name) {
  return name.length > 0 && name.length <= 50;
}

function currentTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function register(email, password, displayName, username) {
  username = username.toLowerCase().trim();

  if (!validateUsername(username)) {
    throw new Error(i18n.t("register.usernameInvalid"));
  }
  if (!validateDisplayName(displayName)) {
    throw new Error(i18n.t("register.displayNameInvalid"));
  }

  _registering = true;
  try {
    const credential = await auth.createUserWithEmailAndPassword(email, password);
    const user = credential.user;

    // Usernames are only readable once signed in, so availability is checked after sign-up
    const taken = (await db.collection("usernames").doc(username).get()).exists;
    if (taken) {
      await user.delete();
      throw new Error(i18n.t("register.usernameTaken"));
    }

    try {
      const batch = db.batch();
      batch.set(db.collection("users").doc(user.uid), {
        displayName,
        username,
        email: user.email,
        timezone: currentTimezone(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      batch.set(db.collection("usernames").doc(username), { uid: user.uid, displayName });
      await batch.commit();
    } catch (err) {
      // Don't leave an account without a profile if the username was claimed in the meantime
      await user.delete();
      throw err;
    }

    await user.updateProfile({ displayName });
  } finally {
    _registering = false;
  }

  window.location.href = "dashboard.html";
}

async function login(email, password) {
  await auth.signInWithEmailAndPassword(email, password);
  window.location.href = "dashboard.html";
}

async function resetPassword(email) {
  await auth.sendPasswordResetEmail(email);
}

function logout() {
  auth.signOut().then(() => window.location.href = "index.html");
}

document.addEventListener("DOMContentLoaded", async () => {
  await i18n.init();
  updateNav();
});