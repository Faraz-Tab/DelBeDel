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

async function checkUsernameAvailable(username) {
  const doc = await db.collection("usernames").doc(username).get();
  return !doc.exists;
}

async function register(email, password, displayName, username) {
  username = username.toLowerCase().trim();

  if (!validateUsername(username)) {
    throw new Error(i18n.t("register.usernameInvalid"));
  }

  const available = await checkUsernameAvailable(username);
  if (!available) {
    throw new Error(i18n.t("register.usernameTaken"));
  }

  _registering = true;
  try {
    const credential = await auth.createUserWithEmailAndPassword(email, password);
    const user = credential.user;

    await user.updateProfile({ displayName });

    const batch = db.batch();
    batch.set(db.collection("users").doc(user.uid), {
      displayName,
      username,
      email,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    batch.set(db.collection("usernames").doc(username), { uid: user.uid });
    await batch.commit();
  } finally {
    _registering = false;
  }

  window.location.href = "dashboard.html";
}

async function login(email, password) {
  await auth.signInWithEmailAndPassword(email, password);
  window.location.href = "dashboard.html";
}

function logout() {
  auth.signOut().then(() => window.location.href = "index.html");
}

document.addEventListener("DOMContentLoaded", async () => {
  await i18n.init();
  updateNav();
});