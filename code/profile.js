document.addEventListener("DOMContentLoaded", () => {
  redirectIfLoggedOut();

  auth.onAuthStateChanged(async user => {
    if (!user) return;

    document.getElementById("profile-email").textContent = user.email;
    document.getElementById("profile-uid").textContent = user.uid;

    const doc = await db.collection("users").doc(user.uid).get();
    const data = doc.data() || {};
    document.getElementById("display-name").value = data.displayName || "";
    document.getElementById("profile-username").textContent = "@" + (data.username || "—");

    if (data.createdAt) {
      document.getElementById("profile-joined").textContent =
        data.createdAt.toDate().toLocaleDateString();
    }
  });

  document.getElementById("profile-form").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    const msg = document.getElementById("profile-msg");
    const newName = document.getElementById("display-name").value.trim();
    if (!newName) return;

    btn.disabled = true;
    btn.textContent = i18n.t("profile.saving");
    try {
      const user = auth.currentUser;
      await user.updateProfile({ displayName: newName });
      await db.collection("users").doc(user.uid).update({ displayName: newName });
      msg.textContent = i18n.t("profile.updated");
      msg.className = "msg success";
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg error";
    }
    btn.disabled = false;
    btn.textContent = i18n.t("profile.save");
  });
});
