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

    this.loadCooldowns();
    this.initGuide();
    this.initSearch();
    await this.loadConnections();
    this.loadSummary();
  },

  // --- Tap cooldowns (persisted so a page reload can't bypass them) ---
  loadCooldowns() {
    try {
      this.tapCooldowns = JSON.parse(localStorage.getItem("tapCooldowns")) || {};
    } catch (err) {
      this.tapCooldowns = {};
    }
  },

  saveCooldowns() {
    localStorage.setItem("tapCooldowns", JSON.stringify(this.tapCooldowns));
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
    const input = document.getElementById("search-input");

    form.addEventListener("submit", e => {
      e.preventDefault();
      this.hideSearchResults();
      this.searchAndAdd();
    });

    input.addEventListener("input", () => {
      clearTimeout(this._searchDebounce);
      const prefix = input.value.toLowerCase().trim().replace(/^@/, "");
      if (!prefix) {
        this.hideSearchResults();
        return;
      }
      this._searchDebounce = setTimeout(() => this.liveSearch(prefix), 250);
    });

    document.addEventListener("click", e => {
      const results = document.getElementById("search-results");
      if (results && !results.contains(e.target) && e.target !== input) {
        this.hideSearchResults();
      }
      if (!e.target.closest(".conn-options")) {
        document.querySelectorAll(".options-menu.open").forEach(m => m.classList.remove("open"));
      }
    });
  },

  async liveSearch(prefix) {
    const results = document.getElementById("search-results");

    try {
      const snap = await db.collection("usernames")
        .orderBy(firebase.firestore.FieldPath.documentId())
        .startAt(prefix)
        .endAt(prefix + "")
        .limit(8)
        .get();

      const rows = [];
      snap.forEach(doc => {
        if (doc.id === this.username) return;
        const data = doc.data();
        const name = data.displayName || doc.id;
        rows.push({ username: doc.id, uid: data.uid, name });
      });

      if (rows.length === 0) {
        results.innerHTML = `<div class="search-result-empty">${i18n.t("dash.search.noMatches")}</div>`;
      } else {
        results.innerHTML = rows.map(r => `
          <div class="search-result-row">
            <span class="search-result-name">${r.name}</span>
            <span class="search-result-username">@${r.username}</span>
            <button type="button" class="btn btn-sm"
              onclick="dash.addConnection('${r.uid}', '${r.username}', '${r.name.replace(/'/g, "\\'")}')">
              ${i18n.t("dash.search.btn")}
            </button>
          </div>`).join("");
      }

      results.style.display = "block";
    } catch (err) {
      console.warn("Live search failed:", err);
    }
  },

  hideSearchResults() {
    const results = document.getElementById("search-results");
    if (results) results.style.display = "none";
  },

  async searchAndAdd() {
    const input = document.getElementById("search-input");
    const msg = document.getElementById("search-msg");
    const btn = document.getElementById("search-btn");
    const query = input.value.toLowerCase().trim().replace(/^@/, "");
    msg.textContent = "";
    msg.className = "msg";

    if (!query) return;

    btn.disabled = true;
    btn.textContent = i18n.t("dash.search.searching");

    try {
      const usernameDoc = await db.collection("usernames").doc(query).get();
      if (!usernameDoc.exists) {
        msg.textContent = i18n.t("dash.search.notFound");
        msg.className = "msg error";
      } else {
        const data = usernameDoc.data();
        await this.addConnection(data.uid, query, data.displayName || query);
      }
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg error";
    }

    btn.disabled = false;
    btn.textContent = i18n.t("dash.search.btn");
  },

  async addConnection(targetUid, targetUsername, targetDisplayName) {
    const msg = document.getElementById("search-msg");
    msg.textContent = "";
    msg.className = "msg";

    if (targetUsername === this.username) {
      msg.textContent = i18n.t("dash.search.selfAdd");
      msg.className = "msg error";
      return;
    }

    try {
      const existing = await db.collection("connections")
        .where("fromUid", "==", this.uid)
        .where("toUid", "==", targetUid)
        .get();

      if (!existing.empty) {
        msg.textContent = i18n.t("dash.search.alreadyAdded");
        msg.className = "msg error";
        return;
      }

      await db.collection("connections").add({
        fromUid: this.uid,
        toUid: targetUid,
        fromUsername: this.username,
        toUsername: targetUsername,
        toDisplayName: targetDisplayName,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      msg.textContent = i18n.t("dash.search.added");
      msg.className = "msg success";
      document.getElementById("search-input").value = "";
      this.hideSearchResults();
      await this.loadConnections();
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "msg error";
    }
  },

  toggleOptions(connId) {
    const menu = document.getElementById(`options-${connId}`);
    const isOpen = menu.classList.contains("open");
    document.querySelectorAll(".options-menu.open").forEach(m => m.classList.remove("open"));
    if (!isOpen) menu.classList.add("open");
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
            <div class="conn-options">
              <button class="options-btn" aria-label="${i18n.t("dash.connections.options")}"
                onclick="dash.toggleOptions('${conn.id}')">⋯</button>
              <div class="options-menu" id="options-${conn.id}">
                <button class="options-item"
                  onclick="dash.removeConnection('${conn.id}', '${(conn.toDisplayName || conn.toUsername).replace(/'/g, "\\'")}')">${i18n.t("dash.connections.remove")}</button>
              </div>
            </div>
          </div>
        </div>`;
    }

    container.innerHTML = html;

    for (const conn of this.connections) {
      try {
        const tapCount = await this.getTodayTapCount(conn.toUid);
        this.updateTapCountDisplay(conn.id, conn.toDisplayName || conn.toUsername, tapCount);
      } catch (err) {
        console.warn("Could not load tap count for", conn.toUsername, err);
      }
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

    const snap = await db.collection("users").doc(this.uid)
      .collection("tapsSent")
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
      const batch = db.batch();
      const sentRef = db.collection("users").doc(this.uid)
        .collection("tapsSent").doc();
      const receivedRef = db.collection("users").doc(toUid)
        .collection("tapsReceived").doc();

      batch.set(sentRef, {
        toUid: toUid,
        toUsername: toUsername,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });

      batch.set(receivedRef, {
        fromUid: this.uid,
        fromUsername: this.username,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });

      await batch.commit();

      this.tapCooldowns[connId] = now;
      this.saveCooldowns();

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

  // --- Summary ---
  async loadSummary() {
    try {
      const snap = await db.collection("users").doc(this.uid)
        .collection("dailySummary")
        .orderBy("date", "desc")
        .limit(1)
        .get();

      this.summaryData = snap.empty ? null : snap.docs[0].data();
    } catch (err) {
      console.warn("Could not load daily summary:", err);
      this.summaryData = null;
    }

    this.renderSummary();
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

    const { tappedBy, tapsSent, tapsReceived } = this.summaryData;
    const matches = this.summaryData.matches || [];
    const hasTaps = Object.keys(tappedBy).length > 0;

    let html = `
      <h3 data-i18n="dash.summary.title"></h3>
      <p class="summary-note" data-i18n="dash.summary.updatesAt"></p>`;

    html += `<div class="summary-block">
      <h4 data-i18n="dash.summary.today"></h4>`;
    if (hasTaps) {
      html += `<ul class="summary-list">`;
      for (const [name, count] of Object.entries(tappedBy)) {
        html += `<li>${i18n.t("dash.summary.tappedBy", { name: "@" + name, count })}</li>`;
      }
      html += `</ul>`;
    } else {
      html += `<p class="empty-state" data-i18n="dash.summary.noTaps"></p>`;
    }
    html += `</div>`;

    if (matches.length > 0) {
      html += `<div class="summary-block summary-match">
        <h4 data-i18n="dash.summary.matchTitle"></h4>
        <ul class="summary-list">`;
      for (const m of matches) {
        const time = m.matchedAt && m.matchedAt.toDate
          ? m.matchedAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "";
        html += `<li>${i18n.t("dash.summary.matchWith", {
          name: "@" + m.withUsername,
          time,
          gap: this.formatGap(m.gapSeconds)
        })}</li>`;
      }
      html += `</ul></div>`;
    }

    html += `<div class="summary-block summary-stats">
      <p>${i18n.t("dash.summary.statsSent", { count: tapsSent })}</p>
      <p>${i18n.t("dash.summary.statsReceived", { count: tapsReceived })}</p>
    </div>`;

    section.innerHTML = html;
    i18n.applyAll();
  },

  // --- Helpers ---
  formatGap(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  },

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
