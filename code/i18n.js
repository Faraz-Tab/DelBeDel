const i18n = {
  lang: "en",
  translations: {},
  rtlLanguages: ["fa", "ar"],

  async init() {
    this.lang = localStorage.getItem("lang") || "en";
    await this.load(this.lang);
    this.applyDir();
    this.applyAll();
    this.renderLangToggle();
  },

  async load(lang) {
    try {
      const res = await fetch(`lang/${lang}.json`);
      this.translations = await res.json();
      this.lang = lang;
    } catch {
      if (lang !== "en") await this.load("en");
    }
  },

  t(key, params) {
    let str = this.translations[key] || key;
    if (params) {
      Object.keys(params).forEach(k => {
        str = str.replace(`{${k}}`, params[k]);
      });
    }
    return str;
  },

  applyAll() {
    document.querySelectorAll("[data-i18n]").forEach(el => {
      const key = el.getAttribute("data-i18n");
      const attr = el.getAttribute("data-i18n-attr");
      if (attr) {
        el.setAttribute(attr, this.t(key));
      } else {
        el.textContent = this.t(key);
      }
    });
  },

  applyDir() {
    const isRtl = this.rtlLanguages.includes(this.lang);
    document.documentElement.dir = isRtl ? "rtl" : "ltr";
    document.documentElement.lang = this.lang;
    document.body.style.fontFamily = isRtl
      ? "'Vazirmatn', sans-serif"
      : "'Outfit', sans-serif";
  },

  renderLangToggle() {
    const btn = document.getElementById("lang-toggle");
    if (!btn) return;
    btn.textContent = this.t("nav.language");
    btn.onclick = () => this.toggle();
  },

  async toggle() {
    const available = ["en", "fa"];
    const idx = available.indexOf(this.lang);
    const next = available[(idx + 1) % available.length];
    await this.setLang(next);
  },

  async setLang(lang) {
    localStorage.setItem("lang", lang);
    await this.load(lang);
    this.applyDir();
    this.applyAll();
    this.renderLangToggle();
    document.dispatchEvent(new CustomEvent("langChanged", { detail: { lang } }));
  }
};
