(() => {
  "use strict";

  const firebaseConfig = window.VEX_FIREBASE_CONFIG || {};
  const storageKey = "vex:prototype:workspace";
  const defaultState = {
    theme: "dark",
    pageType: "ruled-single",
    pageId: "daily-notes",
    muted: false,
    title: "A softer place to think",
    content: "# A softer place to think\n\nIdeas do not arrive in straight lines. Vex gives them room to wander, connect, and become something useful.\n\n**Try typing** with the keyboard below, or switch to a moodboard when words need a little more space.\n\n`Inline code` · $E = mc^2$",
    typingStats: { completed: 0, bestWpm: 0, bestAccuracy: 0, lastWpm: 0, lastAccuracy: 0, streak: 0 },
    pages: [{ id:"daily-notes", title:"A softer place to think", content:"# A softer place to think\n\nIdeas do not arrive in straight lines. Vex gives them room to wander, connect, and become something useful.\n\n**Try typing** with the keyboard below, or switch to a moodboard when words need a little more space.\n\n`Inline code` · $E = mc^2$", page_type:"ruled-single", updated_at:"" }],
    boards: [{ id:"moodboard", title:"Moodboard", item_count:3, updated_at:"" }],
    activeBoardId: "moodboard",
    mood: [
      { id: "m1", type: "note", color: "yellow", x: 170, y: 110, title: "small sparks", text: "Collect the tiny things before they disappear." },
      { id: "m2", type: "note", color: "pink", x: 460, y: 250, title: "make it playful", text: "A good system should feel like an invitation, not a chore." },
      { id: "m3", type: "note", color: "blue", x: 820, y: 110, title: "next", text: "Turn the loose ideas into one tiny experiment." }
    ],
    boardItems: {},
    boardZoom: 1,
    boardPan: { x: 0, y: 0 },
  };
  defaultState.boardItems.moodboard = defaultState.mood;

  let state = loadState();
  let saveTimer = null;
  let toastTimer = null;
  const dirtyScopes = new Set(["page", "board", "settings", "typing"]);
  let activeView = window.location.hash === "#app" ? "app" : "landing";
  let workspaceTab = "write";
  let typingSession = { exerciseId: "home-row", visibleLength: 0, ready: false, value: "", errors: 0, startedAt: 0, finished: false };
  let typingAnimationTimer = null;
  let syncStatus = "guest · not saved";
  let firebaseDb = null;
  let firebaseStorage = null;
  let firebaseUser = null;
  let lastAuthenticatedUid = "";
  let soundContext = null;
  let soundBuffer = null;
  let soundConfig = null;
  let soundLoadPromise = null;
  const pressedCodes = new Set();

  function cloneState(source = defaultState) {
    return JSON.parse(JSON.stringify(source));
  }

  function ensureWorkspaceHistory(target = state) {
    target.pages = Array.isArray(target.pages) && target.pages.length ? target.pages : [{ id:target.pageId || "daily-notes", title:target.title, content:target.content, page_type:target.pageType, updated_at:"" }];
    target.boards = Array.isArray(target.boards) && target.boards.length ? target.boards : [{ id:"moodboard", title:"Moodboard", item_count:target.mood?.length || 0, updated_at:"" }];
    target.activeBoardId = target.activeBoardId || target.boards[0].id;
    target.boardItems = target.boardItems && typeof target.boardItems === "object" ? target.boardItems : {};
    if (!target.boardItems[target.activeBoardId]) target.boardItems[target.activeBoardId] = Array.isArray(target.mood) ? target.mood : [];
    target.mood = target.boardItems[target.activeBoardId];
    target.boardZoom = Number(target.boardZoom) || 1;
    target.boardPan = target.boardPan && typeof target.boardPan === "object" ? target.boardPan : { x:0, y:0 };
  }

  function setActiveBoard(boardId) {
    ensureWorkspaceHistory();
    if (!state.boards.some(board => board.id === boardId)) return;
    state.activeBoardId = boardId;
    if (!state.boardItems[boardId]) state.boardItems[boardId] = [];
    state.mood = state.boardItems[boardId];
    state.boardZoom = 1;
    state.boardPan = { x:0, y:0 };
  }

  function loadState() {
    // Guest sessions intentionally never hydrate from localStorage.
    // Any legacy local draft is removed so unauthenticated data cannot persist.
    try { localStorage.removeItem(storageKey); } catch (_) {}
    const guestState = cloneState(defaultState);
    ensureWorkspaceHistory(guestState);
    return guestState;
  }

  function rememberCurrentPage() {
    ensureWorkspaceHistory();
    const page = { id:state.pageId || "daily-notes", title:state.title || "Untitled page", content:state.content || "", page_type:state.pageType, updated_at:new Date().toISOString() };
    state.pageId = page.id;
    const index = state.pages.findIndex(item => item.id === page.id);
    if (index >= 0) state.pages[index] = { ...state.pages[index], ...page };
    else state.pages.unshift(page);
  }

  function rememberCurrentBoard() {
    ensureWorkspaceHistory();
    const board = state.boards.find(item => item.id === state.activeBoardId);
    if (board) { board.item_count = state.mood.length; board.updated_at = new Date().toISOString(); }
    state.boardItems[state.activeBoardId] = state.mood;
  }

  function persist(scope = "all") {
    ensureWorkspaceHistory();
    if (scope === "page") rememberCurrentPage();
    if (scope === "board") rememberCurrentBoard();
    if (scope === "all") ["page", "board", "settings", "typing"].forEach(name => dirtyScopes.add(name));
    else dirtyScopes.add(scope);
    clearTimeout(saveTimer);
    if (!firebaseUser) {
      syncStatus = "guest · not saved";
      updateSyncLabels();
      return;
    }
    syncStatus = "saving";
    updateSyncLabels();
    saveTimer = setTimeout(() => { tryRemoteSync(); }, 260);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[ch]));
  }

  function icon(name) {
    const icons = { menu:"☰", search:"⌕", plus:"+", folder:"▦", note:"✦", board:"▧", settings:"⚙", sound:"◖", soundOff:"◗", arrow:"↗", download:"↓", close:"×", bold:"B", italic:"I", code:"<>" };
    return icons[name] || name;
  }

  function showToast(message) {
    let toast = document.querySelector(".toast");
    if (!toast) { toast = document.createElement("div"); toast.className = "toast"; document.body.appendChild(toast); }
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function authErrorMessage(error) {
    const code = error?.code || "";
    if (code === "auth/unauthorized-domain") return `This domain is not authorized in Firebase. Add ${window.location.hostname} in Firebase Console → Authentication → Settings → Authorized domains.`;
    if (code === "auth/operation-not-allowed") return "Enable Google and Email link sign-in in Firebase Console → Authentication → Sign-in method.";
    if (code === "auth/popup-blocked") return "The popup was blocked. Try again or use the redirect option.";
    if (code === "auth/invalid-email") return "Enter a valid email address.";
    return error?.message || "Authentication could not be completed. Please try again.";
  }

  function showAuthModal(message = "") {
    const existing = document.querySelector(".auth-modal-backdrop");
    if (existing) {
      const messageEl = existing.querySelector("[data-auth-message]");
      if (messageEl) { messageEl.textContent = message; messageEl.classList.toggle("visible", Boolean(message)); }
      return;
    }
    const modal = document.createElement("div");
    modal.className = "auth-modal-backdrop";
    modal.innerHTML = `<div class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title"><button class="auth-close" data-auth-action="close" aria-label="Close">×</button><span class="eyebrow"><b>✦</b> your space, synced</span><h2 id="auth-title">Keep your thoughts close.</h2><p class="auth-subtitle">Sign in to unlock Firebase sync across devices. No password needed for email sign-in.</p><button class="google-auth-btn" data-auth-action="google"><span class="google-g">G</span> Continue with Google</button><div class="auth-divider"><span>or use email</span></div><form data-auth-form><label for="auth-email">Email address</label><input id="auth-email" type="email" autocomplete="email" placeholder="you@example.com" required /><button class="primary-btn auth-email-btn" type="submit">Send verification code</button></form><p class="auth-hint">Vex sends a branded six-digit code from its secure email service. Verify it to sign in or create your account.</p><p class="auth-message" data-auth-message>${escapeHtml(message)}</p></div>`;
    document.body.appendChild(modal);
    const emailInput = modal.querySelector("#auth-email");
    const messageEl = modal.querySelector("[data-auth-message]");
    if (message) messageEl.classList.add("visible");
    modal.addEventListener("click", e => { if (e.target === modal) closeAuthModal(); });
    modal.querySelector("[data-auth-action='close']").addEventListener("click", closeAuthModal);
    modal.querySelector("[data-auth-action='google']").addEventListener("click", () => signInWithGoogle());
    modal.querySelector("[data-auth-form]").addEventListener("submit", e => { e.preventDefault(); sendEmailOtp(emailInput.value.trim()); });
    emailInput.focus();
  }

  function showOtpScreen(email, message = "") {
    const modal = document.querySelector(".auth-modal-backdrop") || document.createElement("div");
    modal.className = "auth-modal-backdrop";
    modal.innerHTML = `<div class="auth-modal otp-modal" role="dialog" aria-modal="true" aria-labelledby="otp-title"><button class="auth-close" data-auth-action="close" aria-label="Close">×</button><div class="otp-window"><span class="otp-orbit" aria-hidden="true">◌</span><span class="otp-path">vex / auth / 01</span></div><span class="eyebrow"><b>✦</b> code sent from Vex</span><h2 id="otp-title">Check your inbox.</h2><p class="auth-subtitle">We sent a six-digit verification code to <strong class="otp-email">${escapeHtml(email)}</strong>.</p><form data-otp-form><label for="auth-otp-value">ONE-TIME CODE</label><input id="auth-otp-value" class="otp-entry" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-label="Six digit verification code" required /><p class="otp-caption">The code expires in 10 minutes. If you did not request it, you can ignore this email.</p><button class="primary-btn auth-email-btn" type="submit">Verify code</button></form><div class="otp-actions"><button class="text-btn" data-otp-action="back">Use a different email</button><button class="text-btn" data-otp-action="resend">Resend code</button></div><p class="auth-message ${message ? "visible" : ""}" data-auth-message>${escapeHtml(message)}</p></div>`;
    if (!modal.parentNode) document.body.appendChild(modal);
    const input = modal.querySelector("#auth-otp-value");
    const messageEl = modal.querySelector("[data-auth-message]");
    modal.addEventListener("click", e => { if (e.target === modal) closeAuthModal(); });
    modal.querySelector("[data-auth-action='close']").addEventListener("click", closeAuthModal);
    modal.querySelector("[data-otp-action='back']").addEventListener("click", () => { closeAuthModal(); showAuthModal(); });
    modal.querySelector("[data-otp-action='resend']").addEventListener("click", () => sendEmailOtp(email, true));
    modal.querySelector("[data-otp-form]").addEventListener("submit", e => { e.preventDefault(); verifyEmailOtp(email, input.value.replace(/\D/g, ""), messageEl); });
    input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 6); });
    input.focus();
  }

  function closeAuthModal() { document.querySelector(".auth-modal-backdrop")?.remove(); }

  function authReady() {
    return Boolean(firebaseConfig.apiKey && window.firebase && firebase.apps);
  }

  async function signInWithGoogle(useRedirect = false) {
    if (!authReady()) { showAuthModal("Firebase configuration is missing."); return; }
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      const auth = firebase.auth();
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope("email");
      provider.addScope("profile");
      if (useRedirect) return auth.signInWithRedirect(provider);
      await auth.signInWithPopup(provider);
      closeAuthModal();
      showToast("Signed in with Google");
    } catch (error) {
      if (error?.code === "auth/popup-blocked" || error?.code === "auth/popup-closed-by-user" || error?.code === "auth/network-request-failed") {
        try { await firebase.auth().signInWithRedirect(new firebase.auth.GoogleAuthProvider()); return; } catch (redirectError) { showAuthModal(authErrorMessage(redirectError)); return; }
      }
      showAuthModal(authErrorMessage(error));
    }
  }

  async function sendEmailOtp(email, keepOtpScreen = false) {
    if (!email) { showAuthModal("Enter your email address first."); return; }
    try {
      const response = await fetch("/api/auth/request-otp", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ email }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "We could not send the Vex code.");
      localStorage.setItem("vex:pending-otp-email", email);
      showOtpScreen(email, keepOtpScreen ? "A fresh Vex code is on its way." : "Your Vex verification code is on its way.");
    } catch (error) { showAuthModal(error.message || "We could not send the Vex code."); }
  }

  async function verifyEmailOtp(email, code, messageEl) {
    if (!/^\d{6}$/.test(code)) { messageEl.textContent = "Enter all six digits from the Vex email."; messageEl.classList.add("visible"); return; }
    messageEl.textContent = "Verifying your Vex code…";
    messageEl.classList.add("visible");
    try {
      const response = await fetch("/api/auth/verify-otp", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ email, code }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "That code could not be verified.");
      if (!authReady()) throw new Error("Firebase client configuration is missing.");
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      await firebase.auth().signInWithCustomToken(data.custom_token);
      localStorage.removeItem("vex:pending-otp-email");
      closeAuthModal();
      showToast("Email verified — welcome to Vex");
    } catch (error) { messageEl.textContent = error.message || "That code could not be verified."; messageEl.classList.add("visible"); }
  }

  async function sendEmailLink(email, keepOtpScreen = false) {
    if (!email) { showAuthModal("Enter your email address first."); return; }
    if (!authReady()) { showAuthModal("Firebase configuration is missing."); return; }
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      const actionCodeSettings = { url: `${window.location.origin}${window.location.pathname}`, handleCodeInApp: true };
      await firebase.auth().sendSignInLinkToEmail(email, actionCodeSettings);
      localStorage.setItem("vex:pending-email", email);
      if (keepOtpScreen) showOtpScreen(email, "A fresh confirmation email is on its way.");
      else showOtpScreen(email, "Check your inbox for the Vex confirmation link.");
    } catch (error) { showAuthModal(authErrorMessage(error)); }
  }

  async function finishEmailLinkSignIn() {
    if (!authReady() || !firebase.auth().isSignInWithEmailLink(window.location.href)) return;
    const email = localStorage.getItem("vex:pending-email") || window.prompt("Confirm your email address to finish signing in:");
    if (!email) return;
    try {
      await firebase.auth().signInWithEmailLink(email, window.location.href);
      localStorage.removeItem("vex:pending-email");
      window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      showToast("Email confirmed — welcome to Vex");
    } catch (error) { showAuthModal(authErrorMessage(error)); }
  }

  async function signOut() {
    try { if (authReady()) await firebase.auth().signOut(); firebaseUser = null; renderAll(); showToast("Signed out"); } catch (error) { showToast(authErrorMessage(error)); }
  }

  function updateSyncLabels() {
    document.querySelectorAll("[data-sync-label]").forEach(el => {
      el.textContent = syncStatus === "saving" ? "saving" : syncStatus;
      el.previousElementSibling?.classList.toggle("sync-saving", syncStatus === "saving");
    });
  }

  function updateFavicon(theme = state.theme) {
    const favicon = document.getElementById("vex-favicon");
    if (!favicon) return;
    const palettes = {
      light: { bg:"#f6f1e9", shadow:"#f26b4f", keycap:"#252426", stroke:"#1c1b1e", text:"#f7f4ec" },
      dark: { bg:"#0e0e10", shadow:"#78ddcf", keycap:"#f7f4ec", stroke:"#e8e3d8", text:"#222126" },
      zen: { bg:"#e8efe8", shadow:"#79a989", keycap:"#1f372d", stroke:"#173027", text:"#e7efe8" }
    };
    const palette = palettes[theme] || palettes.dark;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${palette.bg}"/><rect x="13" y="16" width="38" height="38" rx="13" fill="${palette.shadow}" transform="rotate(-7 32 35)"/><rect x="10" y="9" width="42" height="42" rx="13" fill="${palette.keycap}" stroke="${palette.stroke}" stroke-width="1.5" transform="rotate(-7 31 30)"/><text x="31" y="35" fill="${palette.text}" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="800" text-anchor="middle" transform="rotate(-7 31 30)">vx</text></svg>`;
    favicon.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const themeColors = { light:"#f6f1e9", dark:"#0e0e10", zen:"#e8efe8" };
    document.querySelector("meta[name='theme-color']")?.setAttribute("content", themeColors[theme] || themeColors.dark);
  }

  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    updateFavicon(theme);
    persist("settings");
    showToast(`${theme[0].toUpperCase()}${theme.slice(1)} theme`);
    renderAll();
  }

  function codeToLegacyId(code) {
    if (!code) return "";
    if (/^Key[A-Z]$/.test(code)) return String(code.charCodeAt(3));
    if (/^Digit[0-9]$/.test(code)) return String(code.charCodeAt(5));
    const ids = { Backquote:"192", Minus:"189", Equal:"187", BracketLeft:"219", BracketRight:"221", Backslash:"220", Semicolon:"186", Quote:"222", Comma:"188", Period:"190", Slash:"191", Space:"32", Tab:"9", CapsLock:"20", Enter:"13", Backspace:"8", ShiftLeft:"16", ShiftRight:"16", ControlLeft:"17", ControlRight:"17", AltLeft:"18", AltRight:"18", MetaLeft:"91", MetaRight:"92", Escape:"27", ArrowLeft:"37", ArrowUp:"38", ArrowRight:"39", ArrowDown:"40" };
    return ids[code] || "";
  }

  async function loadSoundPack() {
    if (soundLoadPromise) return soundLoadPromise;
    soundLoadPromise = Promise.all([
      fetch("/static/sound-config.json").then(response => response.json()),
      fetch("/static/sound.ogg").then(response => response.arrayBuffer())
    ]).then(async ([config, bytes]) => {
      soundConfig = config;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        soundContext = soundContext || new AudioContext();
        soundBuffer = await soundContext.decodeAudioData(bytes);
      }
      return true;
    }).catch(() => false);
    return soundLoadPromise;
  }

  function fallbackKeySound(numericId = "65") {
    try {
      const audio = new Audio("/static/sound.ogg");
      const definition = soundConfig?.defines?.[numericId] || soundConfig?.defines?.["65"];
      audio.volume = .22;
      if (definition) audio.currentTime = definition[0] / 1000;
      const stop = () => { audio.pause(); };
      audio.addEventListener("ended", stop, { once: true });
      audio.play().then(() => setTimeout(stop, (definition?.[1] || 170))).catch(() => {});
    } catch (_) {}
  }

  function playKeySound(input = "KeyA") {
    if (state.muted) return;
    const code = typeof input === "string" ? input : input.code;
    const numericId = typeof input === "object" && input.keyCode ? String(input.keyCode) : codeToLegacyId(code);
    loadSoundPack().then(loaded => {
      if (!loaded || !soundBuffer || !soundContext || !soundConfig) { fallbackKeySound(numericId); return; }
      try {
        if (soundContext.state === "suspended") soundContext.resume();
        const definition = soundConfig.defines[numericId] || soundConfig.defines["65"];
        const source = soundContext.createBufferSource();
        const gain = soundContext.createGain();
        source.buffer = soundBuffer;
        gain.gain.value = .72;
        source.connect(gain).connect(soundContext.destination);
        const offset = definition[0] / 1000;
        const duration = definition[1] / 1000;
        source.start(0, offset, duration);
      } catch (_) { fallbackKeySound(numericId); }
    });
  }

  function formatPreview(markdown) {
    let html = escapeHtml(markdown);
    html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>")
      .replace(/^## (.*)$/gm, "<h2>$1</h2>")
      .replace(/^# (.*)$/gm, "<h1>$1</h1>")
      .replace(/^> (.*)$/gm, "<blockquote>$1</blockquote>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\$([^$\n]+)\$/g, '<span class="math-inline">$1</span>')
      .replace(/^[-*] (.*)$/gm, "<span class=\"list-line\">• $1</span>")
      .replace(/\n{2,}/g, "</p><p>")
      .replace(/\n/g, "<br>");
    return `<p>${html}</p>`;
  }

  function editorToMarkdown(editor) {
    const scratch = document.createElement("div");
    scratch.innerHTML = editor.innerHTML.replace(/<br\s*\/?>(?!\n)/gi, "\n");
    scratch.querySelectorAll("h1").forEach(node => node.replaceWith(document.createTextNode(`# ${node.textContent}\n\n`)));
    scratch.querySelectorAll("h2").forEach(node => node.replaceWith(document.createTextNode(`## ${node.textContent}\n\n`)));
    scratch.querySelectorAll("h3").forEach(node => node.replaceWith(document.createTextNode(`### ${node.textContent}\n\n`)));
    scratch.querySelectorAll("strong, b").forEach(node => node.replaceWith(document.createTextNode(`**${node.textContent}**`)));
    scratch.querySelectorAll("em, i").forEach(node => node.replaceWith(document.createTextNode(`*${node.textContent}*`)));
    scratch.querySelectorAll("code").forEach(node => node.replaceWith(document.createTextNode(`\`${node.textContent}\``)));
    scratch.querySelectorAll("blockquote").forEach(node => node.replaceWith(document.createTextNode(`> ${node.textContent}\n\n`)));
    scratch.querySelectorAll("p").forEach(node => node.appendChild(document.createTextNode("\n\n")));
    return scratch.textContent.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  const typingExercises = [
    { id:"home-row", level:"warm up", title:"Home row drift", text:"asdf jkl; asdf jkl; keep your hands light and let the rhythm settle." },
    { id:"soft-focus", level:"focus", title:"Soft focus", text:"Small steps become a practice when you return to them with care." },
    { id:"clear-thoughts", level:"flow", title:"Clear thoughts", text:"Write the next true sentence before you decide whether it is good." },
    { id:"tiny-sprint", level:"sprint", title:"Tiny sprint", text:"A little momentum is enough to make the blank page feel friendly." }
  ];

  function currentTypingExercise() { return typingExercises.find(exercise => exercise.id === typingSession.exerciseId) || typingExercises[0]; }

  function resetTypingSession(exerciseId = typingSession.exerciseId) {
    clearInterval(typingAnimationTimer);
    typingSession = { exerciseId, visibleLength: 0, ready: false, value: "", errors: 0, startedAt: 0, finished: false };
    const exercise = currentTypingExercise();
    typingAnimationTimer = setInterval(() => {
      typingSession.visibleLength = Math.min(exercise.text.length, typingSession.visibleLength + 2);
      if (typingSession.visibleLength >= exercise.text.length) {
        clearInterval(typingAnimationTimer);
        typingSession.ready = true;
        const input = document.querySelector("[data-typing-input]");
        if (input) { input.disabled = false; setTimeout(() => input.focus(), 80); }
      }
      const prompt = document.querySelector("[data-typing-prompt]");
      if (prompt) prompt.innerHTML = typingPromptMarkup(exercise.text, typingSession.value, typingSession.visibleLength);
    }, 26);
  }

  function typingPromptMarkup(text, value = "", visibleLength = text.length) {
    const visible = text.slice(0, visibleLength);
    return [...visible].map((character, index) => {
      const typed = value[index];
      const className = typed == null ? "" : typed === character ? "typed-correct" : "typed-error";
      return `<span class="typing-char ${className}">${character === " " ? "·" : escapeHtml(character)}</span>`;
    }).join("");
  }

  function typingProgress() {
    const exercise = currentTypingExercise();
    return Math.min(100, Math.round((typingSession.value.length / exercise.text.length) * 100));
  }

  function finishTypingExercise() {
    if (typingSession.finished) return;
    const exercise = currentTypingExercise();
    const elapsedMinutes = Math.max((Date.now() - typingSession.startedAt) / 60000, 1 / 60);
    const correct = [...exercise.text].reduce((total, character, index) => total + (typingSession.value[index] === character ? 1 : 0), 0);
    const accuracy = Math.round((correct / exercise.text.length) * 100);
    const wpm = Math.max(1, Math.round((exercise.text.length / 5) / elapsedMinutes));
    state.typingStats = { ...(state.typingStats || defaultState.typingStats), completed:(state.typingStats?.completed || 0) + 1, bestWpm:Math.max(state.typingStats?.bestWpm || 0, wpm), bestAccuracy:Math.max(state.typingStats?.bestAccuracy || 0, accuracy), lastWpm:wpm, lastAccuracy:accuracy, streak:(state.typingStats?.streak || 0) + 1 };
    typingSession.finished = true;
    typingSession.ready = true;
    persist("typing");
    const input = document.querySelector("[data-typing-input]");
    if (input) input.disabled = true;
    showToast(`${wpm} WPM · ${accuracy}% accuracy`);
    setTimeout(() => { if (workspaceTab === "typing") renderApp(); }, 550);
  }

  function renderTyping() {
    const exercise = currentTypingExercise();
    const stats = state.typingStats || defaultState.typingStats;
    return `<section class="editor-stage typing-stage"><div class="editor-head"><div><span class="eyebrow"><b>✦</b> enhance typing</span><h2 class="typing-heading">Practice the rhythm, not the rush.</h2></div><div class="editor-tools"><button class="pill-btn" data-action="reset-typing">↻ <span>New exercise</span></button></div></div><div class="typing-layout"><div class="typing-card"><div class="typing-card-top"><span>vex / typewriter</span><span>${escapeHtml(exercise.level)}</span></div><div class="typing-prompt" data-typing-prompt>${typingPromptMarkup(exercise.text, typingSession.value, typingSession.visibleLength || exercise.text.length)}</div><input class="typing-input" data-typing-input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type the sentence above…" aria-label="Typing exercise input" ${typingSession.ready ? "" : "disabled"} value="${escapeHtml(typingSession.value)}" /><div class="typing-progress"><span style="width:${typingProgress()}%"></span></div><div class="typing-actions"><span>${typingSession.ready ? "Your turn." : "Setting the page…"}</span><span>${typingProgress()}%</span></div></div><aside class="typing-stats"><p class="side-label">your rhythm</p><div class="stat-grid"><div><strong>${stats.bestWpm || 0}</strong><span>best wpm</span></div><div><strong>${stats.bestAccuracy || 0}%</strong><span>best accuracy</span></div><div><strong>${stats.completed || 0}</strong><span>completed</span></div><div><strong>${stats.streak || 0}</strong><span>streak</span></div></div><p class="typing-note">${firebaseUser ? "Your progress is private to this account and syncs across devices." : "Try it freely. Sign in when you want Vex to remember your progress."}</p>${!firebaseUser ? `<button class="side-signin" data-action="open-auth">Sign in to save progress ↗</button>` : ""}</aside></div><div class="typing-exercises"><p class="side-label">choose a feeling</p>${typingExercises.map(item => `<button class="exercise-chip ${item.id === exercise.id ? "active" : ""}" data-action="select-exercise" data-exercise-id="${item.id}"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(item.level)}</small></button>`).join("")}</div></section>`;
  }

  function pageClass() { return state.pageType; }

  function renderTopbar(mode = "workspace") {
    return `<header class="topbar">
      <div class="top-left">
        <div class="brand"><span class="brand-mark">vx</span><span>Vex</span></div>
        ${mode === "workspace" ? `<button class="icon-btn" data-action="toggle-sidebar" aria-label="Toggle sidebar">${icon("menu")}</button><div class="crumb"><span>workspace</span><span>/</span><strong>${state.title || "untitled"}</strong></div>` : `<div class="crumb"><strong>an open canvas for your thoughts</strong></div>`}
      </div>
      <div class="top-actions">
        <div class="status"><span class="status-dot"></span><span data-sync-label>${syncStatus}</span></div>
        <button class="icon-btn" data-action="toggle-sound" aria-label="Toggle sound">${state.muted ? icon("soundOff") : icon("sound")}</button>
        <button class="pill-btn" data-action="cycle-theme"><span class="theme-swatch"></span><span>${state.theme}</span></button>
        ${firebaseUser ? `<button class="pill-btn" data-action="sign-out">${escapeHtml(firebaseUser.displayName || firebaseUser.email || "Account")} · sign out</button>` : `<button class="ghost-btn" data-action="open-auth">Sign in</button>`}
        ${mode === "landing" ? `<button class="primary-btn" data-action="open-app">Open Vex ${icon("arrow")}</button>` : `<button class="ghost-btn" data-action="open-landing">Home</button>`}
      </div>
    </header>`;
  }

  function renderSidebar() {
    return `<aside class="sidebar"><div class="sidebar-inner">
      <button class="primary-btn new-page" data-action="new-page">${icon("plus")} New page</button>
      <div class="side-section"><p class="side-label">your space</p>
        <button class="side-item ${workspaceTab === "write" && !state.moodboard ? "active" : ""}" data-action="focus-editor"><span class="item-icon">${icon("note")}</span><span>Daily notes</span><small>⌘1</small></button>
        <button class="side-item ${state.moodboard ? "active" : ""}" data-action="switch-moodboard"><span class="item-icon">${icon("board")}</span><span>Moodboard</span><small>⌘2</small></button>
        <button class="side-item ${workspaceTab === "typing" ? "active" : ""}" data-action="switch-typing"><span class="item-icon">⌁</span><span>Enhance typing</span><small>⌘3</small></button>
        <button class="side-item" data-action="open-pages"><span class="item-icon">${icon("folder")}</span><span>All pages</span><small>${(state.pages?.length || 0) + (state.boards?.length || 0)}</small></button>
      </div>
      <div class="side-section"><p class="side-label">page style</p>
        <button class="side-item" data-action="set-page-type" data-value="plain"><span class="item-icon">—</span><span>Plain page</span></button>
        <button class="side-item" data-action="set-page-type" data-value="dotted-light"><span class="item-icon">⠿</span><span>Dotted · light</span></button>
        <button class="side-item" data-action="set-page-type" data-value="dotted-dense"><span class="item-icon">⠿</span><span>Dotted · dense</span></button>
      </div>
      <div class="side-note ${firebaseUser ? "side-note-auth" : "side-note-guest"}"><strong>Built with love ♥ by <a href="https://github.com/itsjustayush" target="_blank" rel="noreferrer">Ayush</a></strong>${firebaseUser ? `Your private space is synced for ${escapeHtml(firebaseUser.email || "your account")}.` : "Write and explore freely. Sign in or sign up before leaving to save your pages and sync them across devices."}${!firebaseUser ? `<button class="side-signin" data-action="open-auth">Sign in to save ↗</button>` : ""}</div>
    </div></aside>`;
  }

  const rows = [
    ["esc","1","2","3","4","5","6","7","8","9","0","-","=","⌫"],
    ["tab","Q","W","E","R","T","Y","U","I","O","P","[","]","\\"],
    ["caps","A","S","D","F","G","H","J","K","L",";","'","↵"],
    ["shift","Z","X","C","V","B","N","M",",",".","/","shift"],
    ["ctrl","alt","⌘","space","⌘","fn","←","↓","→"]
  ];

  function keyCodeFor(key, rowIndex, keyIndex) {
    const codeMap = { esc:"Escape", "⌫":"Backspace", tab:"Tab", caps:"CapsLock", "↵":"Enter", "\\":"Backslash", "[":"BracketLeft", "]":"BracketRight", ";":"Semicolon", "'":"Quote", ",":"Comma", ".":"Period", "/":"Slash", "-":"Minus", "=":"Equal", space:"Space", fn:"Fn", "←":"ArrowLeft", "↓":"ArrowDown", "→":"ArrowRight", alt:"AltLeft", ctrl:"ControlLeft" };
    if (key === "shift") return keyIndex === 0 ? "ShiftLeft" : "ShiftRight";
    if (key === "⌘") return keyIndex === 2 ? "MetaLeft" : "MetaRight";
    if (/^[A-Z]$/.test(key)) return `Key${key}`;
    if (/^\\d$/.test(key)) return `Digit${key}`;
    return codeMap[key] || "";
  }

  function renderKeyboard() {
    return `<div class="keyboard-dock"><div class="keyboard-shell"><div class="keyboard-top"><span>vex / soft press</span><span>${state.muted ? "sound off" : "sound on"}</span></div>${rows.map((row, rowIndex) => `<div class="key-row">${row.map((key, keyIndex) => `<button class="key ${key === "space" ? "space" : ""} ${["tab","caps","shift","ctrl","alt","fn","⌫","↵"].includes(key) ? "wide-1" : ""}" data-key="${escapeHtml(key)}" data-code="${keyCodeFor(key, rowIndex, keyIndex)}">${escapeHtml(key)}</button>`).join("")}</div>`).join("")}</div></div>`;
  }

  function renderFormatBar() {
    return `<div class="format-bar">
      <button data-format="bold" title="Bold">${icon("bold")}</button><button data-format="italic" title="Italic"><i>${icon("italic")}</i></button><button data-format="heading" title="Heading">H</button><button data-format="quote" title="Quote">❝</button><span class="divider"></span><button data-format="code" title="Inline code">${icon("code")}</button><button data-format="math" title="LaTeX">∑</button><span class="divider"></span><button data-action="preview-markdown" title="Preview markdown">Preview</button>
    </div>`;
  }

  function renderEditor() {
    return `<section class="editor-stage"><div class="editor-head"><input class="page-title" value="${escapeHtml(state.title)}" aria-label="Page title" /><div class="editor-tools"><button class="pill-btn" data-action="share-note" title="Share note">↗ <span>Share</span></button><button class="pill-btn" data-action="export-page" title="Export note">${icon("download")} <span>Export</span></button></div></div><div class="page-meta"><span>Today · just now</span><div class="page-switcher">${["ruled-single","ruled-double","plain","dotted-light","dotted-dense"].map(type => `<button class="${state.pageType === type ? "active" : ""}" data-action="set-page-type" data-value="${type}">${type.replace("ruled-", "ruled · ").replace("dotted-", "dotted · ")}</button>`).join("")}</div></div><div class="page-card ${pageClass()}"><div class="editor-content" contenteditable="true" spellcheck="true" data-placeholder="Start with a sentence, a question, or a tiny spark…">${formatPreview(state.content)}</div></div>${renderFormatBar()}</section>`;
  }

  function renderMoodboard() {
    ensureWorkspaceHistory();
    const board = state.boards.find(item => item.id === state.activeBoardId) || state.boards[0];
    const zoomPercent = Math.round(state.boardZoom * 100);
    return `<section class="editor-stage"><div class="editor-head"><input class="page-title" value="${escapeHtml(board.title)}" aria-label="Moodboard title" readonly /><div class="editor-tools"><button class="pill-btn" data-action="new-board">${icon("plus")} <span>New board</span></button><label class="primary-btn">${icon("plus")} Add media<input type="file" accept="image/*,video/*" multiple hidden data-file-upload /></label><button class="pill-btn" data-action="add-note">${icon("note")} <span>Note</span></button></div></div><div class="page-meta"><span>Endless canvas · drag to pan · scroll to zoom</span><div class="page-switcher">${state.boards.map(item => `<button class="${item.id === state.activeBoardId ? "active" : ""}" data-action="select-board" data-board-id="${item.id}">${escapeHtml(item.title)}</button>`).join("")}<button data-action="zoom-board" data-zoom="out">−</button><button class="active">${zoomPercent}%</button><button data-action="zoom-board" data-zoom="in">+</button><button data-action="zoom-board" data-zoom="reset">reset</button></div></div><div class="moodboard" data-moodboard><div class="mood-canvas" style="transform:translate(${state.boardPan.x}px,${state.boardPan.y}px) scale(${state.boardZoom})">${state.mood.map(renderMoodItem).join("")}</div>${state.mood.length === 0 ? `<div class="mood-empty"><div><strong>Your canvas is wide open.</strong>Drop in an image, video, or note to begin.</div></div>` : ""}</div></section>`;
  }
  function renderMoodItem(item) {
    if (item.type === "note") return `<article class="mood-note ${item.color}" data-mood-id="${item.id}" style="left:${item.x}px;top:${item.y}px"><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.text)}</p></article>`;
    return `<article class="mood-image" data-mood-id="${item.id}" style="left:${item.x}px;top:${item.y}px"><img src="${item.src}" alt="${escapeHtml(item.name || "uploaded image")}" /><small>${escapeHtml(item.name || "moodboard media")}</small></article>`;
  }

  function mountWorkspace(host, { embedded = false } = {}) {
    host.innerHTML = `<div class="app-shell ${embedded ? "embedded-app" : ""}" data-theme-root><div class="workspace ${embedded ? "" : ""}">${renderSidebar()}${state.moodboard ? renderMoodboard() : renderEditor()}</div>${renderKeyboard()}</div>`;
    document.documentElement.dataset.theme = state.theme;
    wireWorkspace(host);
  }

  function renderLanding() {
    document.getElementById("app").innerHTML = `<div class="landing"><div class="landing-shell">${renderTopbar("landing")}<main><section class="landing-hero"><span class="eyebrow"><b>✦</b> writing, notes & moodboards</span><h1>Make room for <em>good</em> thoughts.</h1><p class="landing-subtitle">A calm, colorful workspace for the thoughts that refuse to sit still. Write in full flow, pin the fragments, and let the connections appear.</p><div class="landing-cta"><button class="primary-btn" data-action="open-app">Start writing ${icon("arrow")}</button><button class="ghost-btn" data-action="scroll-demo">See the workspace <span>↓</span></button></div></section><section class="demo-wrap" id="demo"><div class="demo-frame"><div id="demo-host"></div></div></section><section class="landing-bento"><article class="feature-card"><div class="feature-icon">✺</div><h3>Thoughts, not folders.</h3><p>Start with a blank page, choose a texture, and make your own little corner of the internet.</p></article><article class="feature-card"><div class="feature-icon">⌘</div><h3>Markdown native.</h3><p>Formatting, LaTeX, shortcuts, and a gentle keyboard that makes writing feel tactile.</p></article><article class="feature-card"><div class="feature-icon">◌</div><h3>Endless moodboards.</h3><p>Drop in images, videos, notes, and references without fighting the canvas.</p></article><article class="feature-card"><div class="feature-icon">≈</div><h3>Three moods.</h3><p>Light, dark, and zen. The room changes when you do.</p></article><article class="feature-card"><div class="feature-icon">↗</div><h3>Write freely.</h3><p>Explore as a guest in memory, then sign in when you are ready to save and sync your space.</p></article></section></main><footer class="landing-footer"><span>© 2026 Vex. Think in full color.</span><span class="creator-credit">Created by <a href="https://github.com/itsjustayush" target="_blank" rel="noreferrer">Ayush Bhattacharya</a> · <a href="mailto:info.cometlabs@gmail.com">info.cometlabs@gmail.com</a></span><span class="inspiration-credit">Inspired by <a href="https://keythm.aayushbharti.in/" target="_blank" rel="noreferrer">keythm.aayushbharti.in</a></span><a class="github-badge" href="https://github.com/itsjustayush/Vex2.0" target="_blank" rel="noreferrer" aria-label="View Vex on GitHub"><span aria-hidden="true">◉</span> Vex on GitHub ↗</a></footer></div></div>`;
    const demoHost = document.getElementById("demo-host");
    mountWorkspace(demoHost, { embedded: true });
    document.querySelectorAll("[data-action='scroll-demo']").forEach(btn => btn.addEventListener("click", () => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth" })));
    wireGlobal();
  }

  function renderApp() {
    const mainView = workspaceTab === "typing" ? renderTyping() : state.moodboard ? renderMoodboard() : renderEditor();
    document.getElementById("app").innerHTML = `<div class="app-shell"><div>${renderTopbar("workspace")}</div><div class="workspace">${renderSidebar()}${mainView}</div>${renderKeyboard()}</div>`;
    document.documentElement.dataset.theme = state.theme;
    wireWorkspace(document.getElementById("app"));
    if (workspaceTab === "typing" && !typingSession.ready) resetTypingSession(typingSession.exerciseId);
  }

  function showPagesModal() {
    ensureWorkspaceHistory();
    document.querySelector(".history-backdrop")?.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "history-backdrop";
    const pageRows = state.pages.slice().sort((a,b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).map(page => `<button class="history-row" data-history-page="${page.id}"><span class="history-icon">${icon("note")}</span><span><strong>${escapeHtml(page.title || "Untitled page")}</strong><small>${escapeHtml((page.content || "").replace(/[#*`\n]/g, " ").slice(0, 88) || "Empty page")}</small></span><time>${page.updated_at ? new Date(page.updated_at).toLocaleDateString() : "starter"}</time></button>`).join("");
    const boardRows = state.boards.slice().sort((a,b) => String(b.updated_at || "").localeCompare(String(a.updated_at || ""))).map(board => `<button class="history-row" data-history-board="${board.id}"><span class="history-icon board-icon">${icon("board")}</span><span><strong>${escapeHtml(board.title || "Untitled board")}</strong><small>${board.item_count || 0} pieces on the canvas</small></span><time>${board.updated_at ? new Date(board.updated_at).toLocaleDateString() : "starter"}</time></button>`).join("");
    backdrop.innerHTML = `<div class="history-modal"><button class="auth-close" data-action="close-history" aria-label="Close history">×</button><span class="eyebrow"><b>✦</b> your archive</span><h2>Past activity</h2><p class="history-subtitle">Your notes and moodboards, kept private to this account.</p><p class="side-label">notes</p><div class="history-list">${pageRows || `<div class="history-empty">No saved notes yet.</div>`}</div><p class="side-label">moodboards</p><div class="history-list">${boardRows || `<div class="history-empty">No saved moodboards yet.</div>`}</div></div>`;
    document.body.appendChild(backdrop);
    backdrop.addEventListener("click", event => { if (event.target === backdrop || event.target.closest("[data-action='close-history']")) backdrop.remove(); });
    backdrop.querySelectorAll("[data-history-page]").forEach(button => button.addEventListener("click", () => { const page = state.pages.find(item => item.id === button.dataset.historyPage); if (!page) return; state.pageId=page.id; state.title=page.title || "Untitled page"; state.content=page.content || ""; state.pageType=page.page_type || "ruled-single"; state.moodboard=false; workspaceTab="write"; backdrop.remove(); renderApp(); }));
    backdrop.querySelectorAll("[data-history-board]").forEach(button => button.addEventListener("click", () => { setActiveBoard(button.dataset.historyBoard); state.moodboard=true; workspaceTab="write"; backdrop.remove(); renderApp(); }));
  }

  function renderAll() { activeView === "landing" ? renderLanding() : renderApp(); }

  function openView(view) {
    activeView = view;
    window.location.hash = view === "app" ? "app" : "";
    renderAll();
  }

  function wireGlobal() {
    document.querySelectorAll("[data-action='open-app']").forEach(btn => btn.addEventListener("click", () => openView("app")));
    document.querySelectorAll("[data-action='open-landing']").forEach(btn => btn.addEventListener("click", () => openView("landing")));
    document.querySelectorAll("[data-action='toggle-sound']").forEach(btn => btn.addEventListener("click", () => { state.muted = !state.muted; persist("settings"); renderAll(); showToast(state.muted ? "Sound muted" : "Sound on"); }));
    document.querySelectorAll("[data-action='cycle-theme']").forEach(btn => btn.addEventListener("click", () => setTheme(state.theme === "light" ? "dark" : state.theme === "dark" ? "zen" : "light")));
    document.querySelectorAll("[data-action='open-auth']").forEach(btn => btn.addEventListener("click", () => showAuthModal()));
    document.querySelectorAll("[data-action='sign-out']").forEach(btn => btn.addEventListener("click", signOut));
  }

  function wireWorkspace(root) {
    wireGlobal();
    root.querySelectorAll("[data-action='toggle-sidebar']").forEach(btn => btn.addEventListener("click", () => {
      const workspace = root.querySelector(".workspace");
      workspace?.classList.toggle("sidebar-hidden");
      root.querySelector(".app-shell")?.classList.toggle("sidebar-open");
    }));
    root.querySelectorAll("[data-action='focus-editor']").forEach(btn => btn.addEventListener("click", () => { workspaceTab = "write"; state.moodboard = false; renderApp(); setTimeout(() => document.querySelector(".editor-content")?.focus(), 50); }));
    root.querySelectorAll("[data-action='switch-moodboard']").forEach(btn => btn.addEventListener("click", () => { workspaceTab = "write"; state.moodboard = true; renderApp(); }));
    root.querySelectorAll("[data-action='switch-typing']").forEach(btn => btn.addEventListener("click", () => { workspaceTab = "typing"; state.moodboard = false; resetTypingSession("home-row"); renderApp(); }));
    root.querySelectorAll("[data-action='reset-typing']").forEach(btn => btn.addEventListener("click", () => { resetTypingSession(typingSession.exerciseId); renderApp(); }));
    root.querySelectorAll("[data-action='select-exercise']").forEach(btn => btn.addEventListener("click", () => { typingSession.exerciseId = btn.dataset.exerciseId; resetTypingSession(btn.dataset.exerciseId); renderApp(); }));
    root.querySelectorAll("[data-action='new-page']").forEach(btn => btn.addEventListener("click", () => { workspaceTab = "write"; state.moodboard = false; state.pageId = "page-" + Date.now(); state.title = "Untitled page"; state.content = ""; state.pageType = "ruled-single"; persist("page"); renderApp(); setTimeout(() => document.querySelector(".page-title")?.focus(), 50); }));
    root.querySelectorAll("[data-action='set-page-type']").forEach(btn => btn.addEventListener("click", () => { state.pageType = btn.dataset.value; persist("page"); renderAll(); }));
    root.querySelectorAll("[data-action='toggle-sound']").forEach(btn => btn.addEventListener("click", () => { state.muted = !state.muted; persist("settings"); renderAll(); showToast(state.muted ? "Sound muted" : "Sound on"); }));
    root.querySelectorAll("[data-action='cycle-theme']").forEach(btn => btn.addEventListener("click", () => setTheme(state.theme === "light" ? "dark" : state.theme === "dark" ? "zen" : "light")));
    root.querySelectorAll("[data-action='open-auth']").forEach(btn => btn.addEventListener("click", () => showAuthModal()));
    root.querySelectorAll("[data-action='sign-out']").forEach(btn => btn.addEventListener("click", signOut));
    root.querySelectorAll("[data-action='coming-soon']").forEach(btn => btn.addEventListener("click", () => showToast("More spaces are coming soon")));
    root.querySelectorAll("[data-action='open-pages']").forEach(btn => btn.addEventListener("click", showPagesModal));
    root.querySelectorAll("[data-action='new-board']").forEach(btn => btn.addEventListener("click", () => { ensureWorkspaceHistory(); const board = { id:"board-" + Date.now(), title:"New moodboard", item_count:0, updated_at:new Date().toISOString() }; state.boards.unshift(board); state.boardItems[board.id]=[]; setActiveBoard(board.id); state.moodboard=true; workspaceTab="write"; persist("board"); renderApp(); showToast("New moodboard created"); }));
    root.querySelectorAll("[data-action='select-board']").forEach(btn => btn.addEventListener("click", () => { setActiveBoard(btn.dataset.boardId); state.moodboard=true; renderApp(); }));
    root.querySelectorAll("[data-action='zoom-board']").forEach(btn => btn.addEventListener("click", () => { const action=btn.dataset.zoom; if (action === "in") state.boardZoom=Math.min(2.5, state.boardZoom + .1); if (action === "out") state.boardZoom=Math.max(.45, state.boardZoom - .1); if (action === "reset") { state.boardZoom=1; state.boardPan={x:0,y:0}; } renderApp(); }));
    root.querySelectorAll("[data-action='add-note']").forEach(btn => btn.addEventListener("click", () => { state.mood.push({ id:"m" + Date.now(), type:"note", color:["yellow","pink","blue","green"][state.mood.length % 4], x:180 + state.mood.length * 48, y:160 + state.mood.length * 35, title:"new thought", text:"Double-click to make this yours." }); persist("board"); renderAll(); }));
    root.querySelectorAll("[data-action='share-note']").forEach(btn => btn.addEventListener("click", shareNote));
    root.querySelectorAll("[data-action='export-page']").forEach(btn => btn.addEventListener("click", showExportMenu));
    root.querySelectorAll("[data-action='preview-markdown']").forEach(btn => btn.addEventListener("click", () => showToast("Markdown is rendered live as you type")));
    root.querySelectorAll(".page-title:not([readonly])").forEach(input => input.addEventListener("input", e => { state.title = e.target.value; persist("page"); }));
    const typingInput = root.querySelector("[data-typing-input]");
    if (typingInput) {
      typingInput.addEventListener("input", e => {
        const exercise = currentTypingExercise();
        typingSession.value = e.target.value.slice(0, exercise.text.length);
        if (!typingSession.startedAt && typingSession.value.length) typingSession.startedAt = Date.now();
        typingSession.errors = [...typingSession.value].reduce((total, character, index) => total + (character !== exercise.text[index] ? 1 : 0), 0);
        e.target.value = typingSession.value;
        const prompt = root.querySelector("[data-typing-prompt]");
        if (prompt) prompt.innerHTML = typingPromptMarkup(exercise.text, typingSession.value, exercise.text.length);
        const progress = root.querySelector(".typing-progress span");
        if (progress) progress.style.width = `${typingProgress()}%`;
        const progressLabel = root.querySelector(".typing-actions span:last-child");
        if (progressLabel) progressLabel.textContent = `${typingProgress()}%`;
        if (typingSession.value.length >= exercise.text.length) finishTypingExercise();
      });
    }
    const editor = root.querySelector(".editor-content");
    if (editor) {
      editor.addEventListener("input", () => { state.content = editorToMarkdown(editor); persist("page"); });
      editor.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); applyFormat("bold"); } });
    }
    root.querySelectorAll("[data-format]").forEach(btn => btn.addEventListener("click", () => applyFormat(btn.dataset.format)));
    root.querySelectorAll(".key").forEach(key => key.addEventListener("click", () => handleVirtualKey(key)));
    root.querySelectorAll("[data-file-upload]").forEach(input => input.addEventListener("change", e => handleFiles(e.target.files)));
    root.querySelectorAll(".mood-note, .mood-image").forEach(item => enableDrag(item));
    const moodboard = root.querySelector("[data-moodboard]");
    if (moodboard) enableCanvasPan(moodboard);
    updateSyncLabels();
  }

  function applyFormat(kind) {
    const editor = document.querySelector(".editor-content");
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    const text = selection && selection.toString() ? selection.toString() : "your thought";
    const wraps = { bold:["**","**"], italic:["*","*"], heading:["### ",""], quote:["> ",""], code:["`","`"], math:["$","$"] };
    const [before, after] = wraps[kind] || ["",""];
    document.execCommand("insertText", false, before + text + after);
    state.content = editorToMarkdown(editor); persist("page"); playKeySound(kind);
  }

  function setPhysicalKey(code, pressed) {
    if (!code) return;
    document.querySelectorAll(`.key[data-code="${code}"]`).forEach(key => key.classList.toggle("pressed", pressed));
  }

  function handleVirtualKey(keyEl) {
    const key = keyEl.dataset.key;
    const code = keyEl.dataset.code;
    keyEl.classList.add("pressed"); setTimeout(() => keyEl.classList.remove("pressed"), 110);
    playKeySound(code);
    const editor = document.querySelector(".editor-content");
    if (!editor || ["tab","caps","shift","ctrl","alt","⌘","fn","←","↓","→"].includes(key)) return;
    editor.focus();
    if (key === "space") document.execCommand("insertText", false, " ");
    else if (key === "⌫") document.execCommand("delete", false);
    else if (key === "↵") document.execCommand("insertText", false, "\n");
    else document.execCommand("insertText", false, key.length === 1 ? key.toLowerCase() : key);
    state.content = editorToMarkdown(editor); persist("page");
  }

  function noteText() {
    return `# ${state.title || "Untitled page"}\n\n${state.content || ""}`.trim() + "\n";
  }

  function fileStem() {
    return (state.title || "vex-page").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "vex-page";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function exportMarkdown() {
    downloadBlob(new Blob([noteText()], { type:"text/markdown;charset=utf-8" }), `${fileStem()}.md`);
    showToast("Markdown downloaded");
  }

  function exportText() {
    downloadBlob(new Blob([noteText()], { type:"text/plain;charset=utf-8" }), `${fileStem()}.txt`);
    showToast("Text file downloaded");
  }

  function exportPdf() {
    const popup = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
    if (!popup) { showToast("Allow pop-ups to save a PDF"); return; }
    const printable = escapeHtml(noteText()).replace(/\n/g, "<br>");
    popup.document.write(`<!doctype html><html><head><title>${escapeHtml(state.title || "Vex note")}</title><style>body{font-family:Georgia,serif;max-width:760px;margin:64px auto;padding:0 32px;color:#25221e;line-height:1.75}h1{font-family:Arial,sans-serif;line-height:1.1;border-bottom:1px solid #ddd;padding-bottom:16px}@media print{body{margin:24px auto}}</style></head><body><h1>${escapeHtml(state.title || "Untitled page")}</h1><div>${printable.replace(/^# [^<]*<br>/, "")}</div><script>window.onload=()=>{window.print();};<\/script></body></html>`);
    popup.document.close();
    showToast("Print dialog opened — choose Save as PDF");
  }

  async function shareNote() {
    const shareData = { title: state.title || "Vex note", text: noteText(), url: window.location.href };
    try {
      if (navigator.share) { await navigator.share(shareData); showToast("Note shared"); return; }
      await navigator.clipboard.writeText(noteText());
      showToast("Note copied to clipboard");
    } catch (_) { showToast("Sharing was cancelled"); }
  }

  async function openGoogleDocs() {
    try { await navigator.clipboard.writeText(noteText()); } catch (_) {}
    window.open("https://docs.new", "_blank", "noopener,noreferrer");
    showToast("Copied — paste your note into Google Docs");
  }

  function showExportMenu() {
    const existing = document.querySelector(".export-menu");
    if (existing) { existing.remove(); return; }
    const anchor = document.querySelector("[data-action='export-page']");
    if (!anchor) return;
    const menu = document.createElement("div");
    menu.className = "export-menu";
    menu.innerHTML = `<button data-export="markdown">Download Markdown <span>.md</span></button><button data-export="text">Download text <span>.txt</span></button><button data-export="pdf">Print / save PDF <span>.pdf</span></button><button data-export="docs">Open Google Docs <span>paste</span></button>`;
    anchor.parentElement.appendChild(menu);
    menu.querySelector("[data-export='markdown']").addEventListener("click", () => { menu.remove(); exportMarkdown(); });
    menu.querySelector("[data-export='text']").addEventListener("click", () => { menu.remove(); exportText(); });
    menu.querySelector("[data-export='pdf']").addEventListener("click", () => { menu.remove(); exportPdf(); });
    menu.querySelector("[data-export='docs']").addEventListener("click", () => { menu.remove(); openGoogleDocs(); });
    setTimeout(() => document.addEventListener("click", e => { if (!menu.contains(e.target) && e.target !== anchor) menu.remove(); }, { once:true }), 0);
  }

  function handleFiles(files) {
    [...files].forEach(file => {
      if (!file.type.startsWith("image/")) { showToast("Image uploads are live; video preview comes next"); return; }
      const reader = new FileReader();
      reader.onload = e => { state.mood.push({ id:"m" + Date.now() + Math.random(), type:"image", src:e.target.result, name:file.name, x:220 + state.mood.length * 35, y:190 + state.mood.length * 26 }); persist("board"); renderApp(); };
      reader.readAsDataURL(file);
    });
  }

  function enableDrag(element) {
    let startX, startY, originX, originY;
    element.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; e.stopPropagation(); element.setPointerCapture(e.pointerId); const item = state.mood.find(x => x.id === element.dataset.moodId); if (!item) return; startX=e.clientX;startY=e.clientY;originX=item.x;originY=item.y; element.addEventListener("pointermove", move); element.addEventListener("pointerup", up, { once:true }); });
    function move(e) { const item = state.mood.find(x => x.id === element.dataset.moodId); if (!item) return; item.x = originX + (e.clientX - startX) / state.boardZoom; item.y = originY + (e.clientY - startY) / state.boardZoom; element.style.left=item.x+"px"; element.style.top=item.y+"px"; }
    function up() { element.removeEventListener("pointermove", move); persist("board"); }
  }

  function enableCanvasPan(moodboard) {
    let startX = 0, startY = 0, originX = 0, originY = 0, panning = false;
    moodboard.addEventListener("wheel", event => {
      event.preventDefault();
      const direction = event.deltaY > 0 ? -.08 : .08;
      state.boardZoom = Math.min(2.5, Math.max(.45, state.boardZoom + direction));
      const canvas = moodboard.querySelector(".mood-canvas");
      if (canvas) canvas.style.transform = `translate(${state.boardPan.x}px,${state.boardPan.y}px) scale(${state.boardZoom})`;
      const zoomLabel = moodboard.closest(".editor-stage")?.querySelector("[data-zoom-label]");
      if (zoomLabel) zoomLabel.textContent = `${Math.round(state.boardZoom * 100)}%`;
    }, { passive:false });
    moodboard.addEventListener("pointerdown", event => {
      if (event.target.closest(".mood-note, .mood-image, button, input, label")) return;
      panning = true; startX=event.clientX; startY=event.clientY; originX=state.boardPan.x; originY=state.boardPan.y; moodboard.setPointerCapture(event.pointerId);
    });
    moodboard.addEventListener("pointermove", event => {
      if (!panning) return;
      state.boardPan.x = originX + event.clientX - startX;
      state.boardPan.y = originY + event.clientY - startY;
      const canvas = moodboard.querySelector(".mood-canvas");
      if (canvas) canvas.style.transform = `translate(${state.boardPan.x}px,${state.boardPan.y}px) scale(${state.boardZoom})`;
    });
    moodboard.addEventListener("pointerup", () => { if (panning) { panning=false; persist("board"); } });
    moodboard.addEventListener("pointercancel", () => { panning=false; });
  }

  let userHydrated = false;
  let hydratingUserId = "";

  function userRoot(uid) { return firebaseDb.collection("users").doc(uid); }
  function userPage(uid) { return userRoot(uid).collection("pages").doc("daily-notes"); }
  function userBoard(uid) { return userRoot(uid).collection("boards").doc("moodboard"); }
  function userTyping(uid) { return userRoot(uid).collection("typing").doc("stats"); }

  function serializableMoodItem(item) {
    const safe = { ...item };
    if (safe.type === "image" && typeof safe.src === "string" && safe.src.startsWith("data:")) delete safe.src;
    return safe;
  }

  async function prepareMoodItemForSync(item, uid) {
    const safe = serializableMoodItem(item);
    if (item.type !== "image" || !item.src?.startsWith("data:") || !window.firebase?.storage) return safe;
    try {
      firebaseStorage = firebaseStorage || firebase.storage();
      const blob = await fetch(item.src).then(response => response.blob());
      const filename = `${String(item.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${(item.name || "image").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const ref = firebaseStorage.ref().child(`users/${uid}/moodboard/${filename}`);
      const snapshot = await ref.put(blob, { contentType: blob.type || "application/octet-stream" });
      safe.src = await snapshot.ref.getDownloadURL();
      safe.storage_path = ref.fullPath;
    } catch (_) {}
    return safe;
  }

  async function hydrateUserData(user) {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps || !user) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      firebaseDb = firebase.firestore();
      hydratingUserId = user.uid;
      userHydrated = false;
      syncStatus = "loading your space";
      updateSyncLabels();
      const [pagesSnap, settingsSnap, boardsSnap, typingSnap] = await Promise.all([
        userRoot(user.uid).collection("pages").limit(100).get(),
        userRoot(user.uid).collection("settings").doc("preferences").get(),
        userRoot(user.uid).collection("boards").limit(50).get(),
        userTyping(user.uid).get()
      ]);
      const pageDocs = pagesSnap.docs.map(doc => ({ id:doc.id, ...doc.data() })).sort((a,b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
      const boardDocs = boardsSnap.docs.map(doc => ({ id:doc.id, ...doc.data() })).sort((a,b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
      const itemResults = await Promise.all(boardDocs.map(board => userRoot(user.uid).collection("boards").doc(board.id).collection("items").limit(500).get()));
      state.pages = pageDocs.length ? pageDocs : state.pages;
      state.boards = boardDocs.length ? boardDocs : state.boards;
      state.boardItems = {};
      boardDocs.forEach((board, index) => { state.boardItems[board.id] = itemResults[index].docs.map(doc => ({ id:doc.id, ...doc.data() })); });
      const latestPage = state.pages[0];
      if (latestPage) {
        state.pageId = latestPage.id;
        state.title = latestPage.title || "Untitled page";
        state.content = latestPage.content || "";
        state.pageType = latestPage.page_type || "ruled-single";
      }
      if (settingsSnap.exists) {
        const settings = settingsSnap.data();
        if (settings.theme) state.theme = settings.theme;
        if (typeof settings.muted === "boolean") state.muted = settings.muted;
      }
      ensureWorkspaceHistory();
      const firstBoard = state.boards[0];
      if (firstBoard) setActiveBoard(firstBoard.id);
      state.moodboard = false;
      workspaceTab = "write";
      if (typingSnap.exists) state.typingStats = { ...defaultState.typingStats, ...typingSnap.data() };
      userHydrated = true;
      syncStatus = "synced";
      document.documentElement.dataset.theme = state.theme;
      updateFavicon(state.theme);
      renderAll();
      if (!pagesSnap.size && !boardsSnap.size && !settingsSnap.exists && !typingSnap.exists) await tryRemoteSync();
    } catch (_) {
      userHydrated = true;
      syncStatus = "signed in · retrying sync";
      updateSyncLabels();
    }
  }

  async function tryRemoteSync() {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps || !firebaseUser || !userHydrated || hydratingUserId !== firebaseUser.uid) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      firebaseDb = firebase.firestore();
      firebaseStorage = window.firebase.storage ? firebase.storage() : null;
      const uid = firebaseUser.uid;
      const now = new Date().toISOString();
      const scopes = new Set(dirtyScopes);
      if (!scopes.size) return;
      const batch = firebaseDb.batch();
      batch.set(userRoot(uid), { uid, email:firebaseUser.email || null, display_name:firebaseUser.displayName || null, photo_url:firebaseUser.photoURL || null, last_seen_at:now, schema_version:1 }, { merge:true });
      if (scopes.has("page")) {
        rememberCurrentPage();
        state.pages.slice(0, 100).forEach(page => batch.set(userRoot(uid).collection("pages").doc(String(page.id)), { ...page, schema_version:1 }, { merge:true }));
      }
      if (scopes.has("settings")) batch.set(userRoot(uid).collection("settings").doc("preferences"), { theme:state.theme, muted:state.muted, active_page_id:state.pageId, active_board_id:state.activeBoardId, updated_at:now, schema_version:1 }, { merge:true });
      if (scopes.has("typing")) batch.set(userTyping(uid), { ...state.typingStats, updated_at:now, schema_version:1 }, { merge:true });
      if (scopes.has("board")) {
        rememberCurrentBoard();
        for (const board of state.boards.slice(0, 50)) {
          const items = state.boardItems[board.id] || [];
          const boardRef = userRoot(uid).collection("boards").doc(String(board.id));
          batch.set(boardRef, { ...board, board_id:board.id, item_count:items.length, updated_at:board.id === state.activeBoardId ? now : (board.updated_at || now), schema_version:1 }, { merge:true });
          const syncedItems = await Promise.all(items.slice(0, 500).map(item => prepareMoodItemForSync(item, uid)));
          syncedItems.forEach(item => batch.set(boardRef.collection("items").doc(String(item.id)), { ...item, updated_at:now, schema_version:1 }, { merge:true }));
        }
      }
      await batch.commit();
      scopes.forEach(scope => dirtyScopes.delete(scope));
      syncStatus = "synced"; updateSyncLabels();
    } catch (_) { syncStatus = "sync paused · retrying"; updateSyncLabels(); }
  }

  function initFirebase() {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      const auth = firebase.auth();
      auth.getRedirectResult().catch(error => { if (error?.code !== "auth/no-auth-event") showAuthModal(authErrorMessage(error)); });
      auth.onAuthStateChanged(user => {
        const previousUid = firebaseUser?.uid || lastAuthenticatedUid;
        firebaseUser = user || null;
        if (user) {
          if (previousUid && previousUid !== user.uid) {
            state = cloneState(defaultState);
            document.documentElement.dataset.theme = state.theme;
          }
          lastAuthenticatedUid = user.uid;
          renderAll();
          hydrateUserData(user);
        } else {
          userHydrated = false;
          hydratingUserId = "";
          state = cloneState(defaultState);
          workspaceTab = "write";
          clearInterval(typingAnimationTimer);
          typingSession = { exerciseId:"home-row", visibleLength:0, ready:false, value:"", errors:0, startedAt:0, finished:false };
          syncStatus = "guest · not saved";
          if (activeView) renderAll();
        }
      });
      finishEmailLinkSignIn();
    } catch (_) {}
  }

  document.addEventListener("keydown", e => {
    if (e.isComposing || !e.code) return;
    setPhysicalKey(e.code, true);
    if (!pressedCodes.has(e.code)) {
      pressedCodes.add(e.code);
      if (!e.repeat) playKeySound(e);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "1") { e.preventDefault(); workspaceTab="write"; state.moodboard=false; renderApp(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "2") { e.preventDefault(); workspaceTab="write"; state.moodboard=true; renderApp(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "3") { e.preventDefault(); workspaceTab="typing"; state.moodboard=false; resetTypingSession("home-row"); renderApp(); }
  });

  document.addEventListener("keyup", e => {
    if (!e.code) return;
    pressedCodes.delete(e.code);
    setPhysicalKey(e.code, false);
  });

  window.addEventListener("blur", () => {
    pressedCodes.clear();
    document.querySelectorAll(".key.pressed").forEach(key => key.classList.remove("pressed"));
  });

  document.documentElement.dataset.theme = state.theme;
  updateFavicon(state.theme);
  initFirebase();
  renderAll();
})();
