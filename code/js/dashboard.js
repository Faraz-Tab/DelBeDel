const dash = {
  uid: null,
  username: null,
  connections: [],
  tapCooldowns: {},
  summaryData: null,
  COOLDOWN_MS: 3 * 60 * 1000,

  async init(user) {
    this.uid = user.uid;
    const userDoc = await db.collection("users").doc(user.uid).get();
    const data = userDoc.data() || {};
    this.username = data.username;

    document.getElementById("dash-greeting").textContent =
      i18n.t("dash.greeting", { name: user.displayName || "User" });

    this.initGuide();
    this.initSearch();
    await this.loadConnections();
    this.loadSummary();
  },

  // --- Guide ---
  initGuide() {
    const guide = document.getElementById("guide-card");
    if (localStorage.getItem("guideDismissed")) {
      guide.style.display = "none";
    } else {
      guide.style.display = "block";
    }
    document.getElementById("dismiss-guide").addEventListener("click", () => {
      guide.style.display = "none";
      localStorage.setItem("guideDismissed", "true");
    });
  },

  // --- Search & Add ---
  initSearch() {
    const form = document.getElementById("search-form");
    form.addEventListener("submit", e => {
      e.preventDefault();
      this.searchAndAdd();
    });
  },

  async searchAndAdd() {
    const input = document.getElementById("search-input");
    const msg = document.getElementById("search-msg");
    const btn = document.getElementById("search-btn");
    const query = input.value.toLowerCase().trim().replace(/^@/, "");
    msg.textContent = "";
    msg.className = "msg";

    if (!query) return;

    if (query === this.username) {
      msg.textContent = i18n.t("dash.search.selfAdd");
      msg.className = "msg error";
      return;
    }

    btn.disabled = true;
    btn.textContent = i18n.t("dash.search.searching");

    try {
      const usernameDoc = await db.collection("usernames").doc(query).get();
      if (!usernameDoc.exists) {
        msg.textContent = i18n.t("dash.search.notFound");
        msg.className = "msg error";
        btn.disabled = false;
        btn.textContent = i18n.t("dash.search.btn");
        return;
      }

      const targetUid = usernameDoc.data().uid;

      const existing = await db.collection("connections")
        .where("fromUid", "==", this.uid)
        .where("toUid", "==", targetUid)
        .get();

      if (!existing.empty) {
        msg.textContent = i18n.t("dash.search.alreadyAdded");
        msg.className = "msg error";
        btn.disabled = false;
        btn.textContent = i18n.t("dash.search.btn");
        return;
      }

      const targetDoc = await db.collection("users").doc(targetUid).get();
      const targetData = targetDoc.data();

      await db.collection("connections").add({
        fromUid: this.uid,
        toUid: targetUid,
        fromUsername: this.username,
        toUsername: targetData.username,
        toDisplayName: targetData.displayName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      msg.textContent = i18n.t("dash.search.added");
      msg.className = "msg success";
      input.value = "";
      await this.loadConnections();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg error";
    }

    btn.disabled = false;
    btn.textContent = i18n.t("dash.search.btn");
  },

  // --- Connections ---
  async loadConnections() {
    const snap = await db.collection("connections")
      .where("fromUid", "==", this.uid)
      .orderBy("createdAt", "desc")
      .get();

    this.connections = [];
    snap.forEach(doc => {
      this.connections.push({ id: doc.id, ...doc.data() });
    });

    this.renderConnections();
  },

  async renderConnections() {
    const container = document.getElementById("connections-list");
    const empty = document.getElementById("no-connections");

    if (this.connections.length === 0) {
      container.innerHTML = "";
      empty.style.display = "block";
      return;
    }

    empty.style.display = "none";

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let html = "";
    for (const conn of this.connections) {
      const tapCount = await this.getTodayTapCount(conn.toUid);
      const initials = this.getInitials(conn.toDisplayName || conn.toUsername);

      html += `
        <div class="conn-row" id="conn-${conn.id}">
          <div class="conn-avatar">${initials}</div>
          <div class="conn-info">
            <div class="conn-name">${conn.toDisplayName || conn.toUsername}</div>
            <div class="conn-username">@${conn.toUsername}</div>
          </div>
          <div class="conn-right">
            <span class="conn-sent" id="sent-${conn.id}"></span>
            <span class="conn-tap-count" id="count-${conn.id}"></span>
            <button class="heart-btn" id="tap-${conn.id}"
              onclick="dash.tap('${conn.id}', '${conn.toUid}', '${conn.toUsername}', '${(conn.toDisplayName || conn.toUsername).replace(/'/g, "\\'")}')">♥</button>
            <button class="remove-btn"
              onclick="dash.removeConnection('${conn.id}', '${(conn.toDisplayName || conn.toUsername).replace(/'/g, "\\'")}')">×</button>
          </div>
        </div>`;
    }

    container.innerHTML = html;

    for (const conn of this.connections) {
      const tapCount = await this.getTodayTapCount(conn.toUid);
      this.updateTapCountDisplay(conn.id, conn.toDisplayName || conn.toUsername, tapCount);
    }
  },

  updateTapCountDisplay(connId, name, count) {
    const el = document.getElementById(`count-${connId}`);
    if (!el) return;
    if (count > 0) {
      el.textContent = i18n.t("dash.connections.tappedToday", { name, count });
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  },

  async getTodayTapCount(toUid) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const snap = await db.collection("taps")
      .where("fromUid", "==", this.uid)
      .where("toUid", "==", toUid)
      .where("timestamp", ">=", todayStart)
      .get();

    return snap.size;
  },

  // --- Tapping ---
  async tap(connId, toUid, toUsername, toDisplayName) {
    const btn = document.getElementById(`tap-${connId}`);
    const sentEl = document.getElementById(`sent-${connId}`);

    const now = Date.now();
    const lastTap = this.tapCooldowns[connId] || 0;
    if (now - lastTap < this.COOLDOWN_MS) {
      sentEl.textContent = i18n.t("dash.connections.cooldown");
      sentEl.className = "conn-sent show cooldown";
      setTimeout(() => { sentEl.className = "conn-sent"; }, 1500);
      return;
    }

    btn.classList.remove("pulsed");
    void btn.offsetWidth;
    btn.classList.add("pulsed");

    try {
      await db.collection("taps").add({
        fromUid: this.uid,
        toUid: toUid,
        fromUsername: this.username,
        toUsername: toUsername,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });

      this.tapCooldowns[connId] = now;

      sentEl.textContent = i18n.t("tap.sent");
      sentEl.className = "conn-sent show";
      setTimeout(() => { sentEl.className = "conn-sent"; }, 1200);

      const tapCount = await this.getTodayTapCount(toUid);
      this.updateTapCountDisplay(connId, toDisplayName, tapCount);
    } catch (err) {
      sentEl.textContent = err.message;
      sentEl.className = "conn-sent show cooldown";
      setTimeout(() => { sentEl.className = "conn-sent"; }, 2000);
    }

    setTimeout(() => { btn.classList.remove("pulsed"); }, 600);
  },

  // --- Remove Connection ---
  async removeConnection(connId, name) {
    const confirmed = confirm(i18n.t("dash.connections.removeConfirm", { name }));
    if (!confirmed) return;

    try {
      await db.collection("connections").doc(connId).delete();
      await this.loadConnections();
    } catch (err) {
      console.error("Remove failed:", err);
    }
  },

  // --- Summary (11 PM gate) ---
  async loadSummary() {
    const container = document.getElementById("summary-section");
    const stored = localStorage.getItem("summaryData");
    const storedTime = localStorage.getItem("summaryTime");

    const now = new Date();
    const hour = now.getHours();

    // Check if we've passed 11 PM since last update
    const shouldUpdate = this.shouldUpdateSummary(storedTime, now);

    if (shouldUpdate && hour >= 23) {
      await this.fetchAndStoreSummary();
    } else if (stored) {
      this.summaryData = JSON.parse(stored);
    }

    this.renderSummary();
  },

  shouldUpdateSummary(storedTime, now) {
    if (!storedTime) return true;
    const last = new Date(storedTime);
    const lastDate = last.toDateString();
    const todayDate = now.toDateString();

    if (lastDate !== todayDate) return true;
    if (last.getHours() < 23 && now.getHours() >= 23) return true;
    return false;
  },

  async fetchAndStoreSummary() {
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const snap24 = await db.collection("taps")
      .where("toUid", "==", this.uid)
      .where("timestamp", ">=", h24)
      .get();

    const snap7d = await db.collection("taps")
      .where("toUid", "==", this.uid)
      .where("timestamp", ">=", d7)
      .get();

    const count24 = {};
    snap24.forEach(doc => {
      const d = doc.data();
      const key = d.fromUsername;
      count24[key] = (count24[key] || 0) + 1;
    });

    const count7d = {};
    snap7d.forEach(doc => {
      const d = doc.data();
      const key = d.fromUsername;
      count7d[key] = (count7d[key] || 0) + 1;
    });

    this.summaryData = { count24, count7d };
    localStorage.setItem("summaryData", JSON.stringify(this.summaryData));
    localStorage.setItem("summaryTime", now.toISOString());
  },

  renderSummary() {
    const section = document.getElementById("summary-section");

    if (!this.summaryData) {
      section.innerHTML = `
        <h3 data-i18n="dash.summary.title"></h3>
        <p class="summary-note" data-i18n="dash.summary.updatesAt"></p>
        <p class="empty-state" data-i18n="dash.summary.noTaps"></p>`;
      i18n.applyAll();
      return;
    }

    const { count24, count7d } = this.summaryData;
    const has24 = Object.keys(count24).length > 0;
    const has7d = Object.keys(count7d).length > 0;

    let html = `
      <h3 data-i18n="dash.summary.title"></h3>
      <p class="summary-note" data-i18n="dash.summary.updatesAt"></p>`;

    html += `<div class="summary-block">
      <h4 data-i18n="dash.summary.last24h"></h4>`;
    if (has24) {
      html += `<ul class="summary-list">`;
      for (const [name, count] of Object.entries(count24)) {
        html += `<li>${i18n.t("dash.summary.taps24h", { name: "@" + name, count })}</li>`;
      }
      html += `</ul>`;
    } else {
      html += `<p class="empty-state" data-i18n="dash.summary.noTaps"></p>`;
    }
    html += `</div>`;

    html += `<div class="summary-block">
      <h4 data-i18n="dash.summary.last7d"></h4>`;
    if (has7d) {
      html += `<ul class="summary-list">`;
      for (const [name, count] of Object.entries(count7d)) {
        html += `<li>${i18n.t("dash.summary.taps7d", { name: "@" + name, count })}</li>`;
      }
      html += `</ul>`;
    } else {
      html += `<p class="empty-state" data-i18n="dash.summary.noTaps"></p>`;
    }
    html += `</div>`;

    section.innerHTML = html;
    i18n.applyAll();
  },

  // --- Helpers ---
  getInitials(name) {
    return name.split(/[\s_]+/)
      .map(w => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
};

document.addEventListener("langChanged", () => {
  const user = auth.currentUser;
  if (user) {
    document.getElementById("dash-greeting").textContent =
      i18n.t("dash.greeting", { name: user.displayName || "User" });
    dash.renderConnections();
    dash.renderSummary();
  }
});
