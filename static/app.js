(() => {
  "use strict";

  const firebaseConfig = window.VEX_FIREBASE_CONFIG || {};
  const supabaseConfig = window.VEX_SUPABASE_CONFIG || {};
  const storageKey = "vex:prototype:workspace";
  const shareRouteId = (() => {
    const hashMatch = String(window.location.hash || "").match(/^#app((?:n|b)_[A-Za-z0-9_-]{12,})$/);
    if (hashMatch) return decodeURIComponent(hashMatch[1]);
    const parts = window.location.pathname.split("/").filter(Boolean);
    const candidate = parts.length === 1 ? decodeURIComponent(parts[0]) : "";
    return /^(?:n|b)_[A-Za-z0-9_-]{12,}$/.test(candidate) ? candidate : "";
  })();
  const hasAppHash = /^#app(?:$|(?:n|b)_[A-Za-z0-9_-]{12,}$)/.test(String(window.location.hash || ""));
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
  const dirtyVersions = { page:0, board:0, settings:0, typing:0 };
  let saveInFlight = false;
  let saveQueued = false;
  let savePromise = null;
  let syncRetryDelay = 1000;
  let activeView = hasAppHash || shareRouteId ? "app" : "landing";
  let workspaceTab = "write";
  let selectedMoodId = "";
  let mobileInputTarget = "body";
  let typingSession = { exerciseId: "home-row", visibleLength: 0, ready: false, value: "", errors: 0, startedAt: 0, finished: false };
  let typingAnimationTimer = null;
  let syncStatus = "guest · not saved";
  let lastSyncError = "";
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

  function makeEntityId(kind) {
    const prefix = kind === "board" ? "b_" : kind === "note" ? "n_" : "m_";
    const random = window.crypto?.randomUUID ? window.crypto.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    return `${prefix}${random}`;
  }

  function legacyEntityId(kind, ownerId, rawId) {
    const prefix = kind === "board" ? "b_" : "n_";
    const source = `${ownerId || "vex"}:${rawId || "legacy"}`;
    let encoded = "";
    try { encoded = btoa(unescape(encodeURIComponent(source))).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_"); } catch (_) { encoded = source.replace(/[^A-Za-z0-9_-]/g, "_"); }
    return `${prefix}legacy_${encoded}`;
  }

  function normalizePage(page = {}, ownerId = "vex") {
    const rawId = String(page.id || "");
    const id = rawId === "daily-notes" || /^n_[A-Za-z0-9_-]{12,}$/.test(rawId) ? rawId : legacyEntityId("note", ownerId, rawId || page.title || "page");
    const existingShare = String(page.share_id || page.metadata?.share_id || "");
    const share_id = /^n_[A-Za-z0-9_-]{12,}$/.test(existingShare) ? existingShare : id;
    return { ...page, id, entity_type:"note", share_id, ...(id !== rawId ? { legacy_id:rawId } : {}) };
  }

  function normalizeBoard(board = {}, ownerId = "vex") {
    const rawId = String(board.id || "");
    const id = rawId === "moodboard" || /^b_[A-Za-z0-9_-]{12,}$/.test(rawId) ? rawId : legacyEntityId("board", ownerId, rawId || board.title || "board");
    const existingShare = String(board.share_id || board.metadata?.share_id || "");
    const share_id = /^b_[A-Za-z0-9_-]{12,}$/.test(existingShare) ? existingShare : id;
    return { ...board, id, entity_type:"moodboard", share_id, ...(id !== rawId ? { legacy_id:rawId } : {}) };
  }

  function dedupeEntities(records = []) {
    const byId = new Map();
    records.forEach(record => { if (record?.id && !byId.has(record.id)) byId.set(record.id, record); });
    return [...byId.values()];
  }

  function ensureWorkspaceHistory(target = state) {
    const ownerId = target.owner_id || "vex";
    target.pages = dedupeEntities((Array.isArray(target.pages) && target.pages.length ? target.pages : [{ id:target.pageId || "daily-notes", title:target.title, content:target.content, page_type:target.pageType, updated_at:"" }]).map(page => normalizePage(page, ownerId)));
    target.boards = dedupeEntities((Array.isArray(target.boards) && target.boards.length ? target.boards : [{ id:"moodboard", title:"Moodboard", item_count:target.mood?.length || 0, updated_at:"" }]).map(board => normalizeBoard(board, ownerId)));
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

  async function supabaseRequest(method, payload = null) {
    if (!supabaseConfig.enabled || !firebaseUser) return null;
    let token = await firebaseUser.getIdToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let response;
      try { response = await fetch("/api/sync/state", { method, headers:{ "Content-Type":"application/json", Authorization:`Bearer ${token}` }, body:payload ? JSON.stringify(payload) : undefined, signal:controller.signal }); }
      finally { clearTimeout(timeout); }
      if (response.status === 401 && attempt === 0) { token = await firebaseUser.getIdToken(true); continue; }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || `Supabase bridge failed (${response.status}).`);
      return data;
    }
    throw new Error("Firebase session token could not be refreshed");
  }

  async function supabaseDirectRequest(method, table, query = "", payload = null, prefer = "return=minimal") {
    if (!supabaseConfig.enabled || !supabaseConfig.url || !supabaseConfig.publishableKey || !firebaseUser) return null;
    let token = await firebaseUser.getIdToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let response;
      try { response = await fetch(`${supabaseConfig.url}/rest/v1/${table}${query}`, { method, headers:{ apikey:supabaseConfig.publishableKey, Authorization:`Bearer ${token}`, "Content-Type":"application/json", Prefer:prefer }, body:payload == null ? undefined : JSON.stringify(payload), signal:controller.signal }); }
      finally { clearTimeout(timeout); }
      if (response.status === 401 && attempt === 0) { token = await firebaseUser.getIdToken(true); continue; }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error_description || `Supabase REST ${table} failed (${response.status}).`);
      return data;
    }
    throw new Error(`Supabase REST ${table} rejected the refreshed Firebase token`);
  }

  function supabaseUserFilter(uid, extra = "") {
    return `?user_id=eq.${encodeURIComponent(uid)}${extra ? `&${extra}` : ""}`;
  }

  async function hydrateSupabaseDirect() {
    const uid = firebaseUser.uid;
    const [pages, boards, items, settingsRows, typingRows] = await Promise.all([
      supabaseDirectRequest("GET", "vex_pages", `${supabaseUserFilter(uid, "select=*&order=updated_at.desc&limit=100")}`),
      supabaseDirectRequest("GET", "vex_boards", `${supabaseUserFilter(uid, "select=*&order=updated_at.desc&limit=50")}`),
      supabaseDirectRequest("GET", "vex_board_items", `${supabaseUserFilter(uid, "select=*&limit=5000")}`),
      supabaseDirectRequest("GET", "vex_settings", `${supabaseUserFilter(uid, "select=preferences&limit=1")}`),
      supabaseDirectRequest("GET", "vex_typing_stats", `${supabaseUserFilter(uid, "select=stats&limit=1")}`)
    ]);
    return { enabled:true, pages:pages || [], boards:boards || [], items:items || [], settings:settingsRows?.[0]?.preferences || {}, typing:typingRows?.[0]?.stats || {} };
  }

  async function syncSupabaseDirect(payload) {
    const uid = firebaseUser.uid;
    const calls = [];
    if (payload.pages) calls.push(supabaseDirectRequest("POST", "vex_pages", "?on_conflict=user_id,id", payload.pages, "resolution=merge-duplicates,return=minimal"));
    if (payload.settings) calls.push(supabaseDirectRequest("POST", "vex_settings", "?on_conflict=user_id", { user_id:uid, preferences:payload.settings, updated_at:new Date().toISOString() }, "resolution=merge-duplicates,return=minimal"));
    if (payload.typing) calls.push(supabaseDirectRequest("POST", "vex_typing_stats", "?on_conflict=user_id", { user_id:uid, stats:payload.typing, updated_at:new Date().toISOString() }, "resolution=merge-duplicates,return=minimal"));
    await Promise.all(calls);
    if (payload.boards) {
      await supabaseDirectRequest("POST", "vex_boards", "?on_conflict=user_id,id", payload.boards.map(board => ({ ...board, user_id:uid, item_count:(payload.board_items?.[board.id] || []).length })), "resolution=merge-duplicates,return=minimal");
      await Promise.all(payload.boards.map(async board => {
        await supabaseDirectRequest("DELETE", "vex_board_items", `?user_id=eq.${encodeURIComponent(uid)}&board_id=eq.${encodeURIComponent(board.id)}`);
        const items = payload.board_items?.[board.id] || [];
        if (items.length) await supabaseDirectRequest("POST", "vex_board_items", "?on_conflict=user_id,board_id,id", items.map(item => ({ id:String(item.id), user_id:uid, board_id:board.id, item_type:item.type || "note", payload:item, updated_at:new Date().toISOString() })), "resolution=merge-duplicates,return=minimal");
      }));
    }
    return { ok:true, enabled:true };
  }

  async function readSupabaseState() {
    let firstError = null;
    const transports = supabaseConfig.serverBridge ? [() => supabaseRequest("GET"), () => hydrateSupabaseDirect()] : [() => hydrateSupabaseDirect(), () => supabaseRequest("GET")];
    for (const transport of transports) {
      try { return await transport(); } catch (error) { firstError = firstError || error; console.warn("Vex Supabase read transport failed:", error); }
    }
    throw new Error(firstError?.message || "Supabase read failed");
  }

  async function writeSupabaseState(payload) {
    let firstError = null;
    const transports = supabaseConfig.serverBridge ? [() => supabaseRequest("PUT", payload), () => syncSupabaseDirect(payload)] : [() => syncSupabaseDirect(payload), () => supabaseRequest("PUT", payload)];
    for (const transport of transports) {
      try { return await transport(); } catch (error) { firstError = firstError || error; console.warn("Vex Supabase write transport failed:", error); }
    }
    throw new Error(firstError?.message || "Supabase write failed");
  }

  function supabasePageRow(page) {
    return { id:String(page.id), user_id:firebaseUser.uid, title:String(page.title || "Untitled page"), content:String(page.content || ""), page_type:String(page.page_type || "ruled-single"), updated_at:page.updated_at || new Date().toISOString(), metadata:{ ...(page.metadata || {}), schema_version:1, entity_type:"note", share_id:page.share_id || page.id, legacy_id:page.legacy_id || null } };
  }

  function supabaseBoardRow(board, itemCount = 0) {
    return { id:String(board.id), user_id:firebaseUser.uid, title:String(board.title || "Moodboard"), item_count:itemCount, updated_at:board.updated_at || new Date().toISOString(), metadata:{ ...(board.metadata || {}), schema_version:1, entity_type:"moodboard", share_id:board.share_id || board.id, legacy_id:board.legacy_id || null } };
  }

  async function stateSyncPayload(scopes = new Set(["page", "board", "settings", "typing"])) {
    ensureWorkspaceHistory();
    const payload = {};
    if (scopes.has("page")) {
      rememberCurrentPage();
      payload.pages = state.pages.slice(0, 100).map(supabasePageRow);
    }
    if (scopes.has("board")) {
      rememberCurrentBoard();
      const boardItems = {};
      for (const board of state.boards) boardItems[board.id] = await Promise.all((state.boardItems[board.id] || []).slice(0, 500).map(item => prepareMoodItemForSync(item, firebaseUser.uid)));
      payload.boards = state.boards.slice(0, 50).map(board => supabaseBoardRow(board, boardItems[board.id]?.length || 0));
      payload.board_items = boardItems;
    }
    if (scopes.has("settings")) payload.settings = { theme:state.theme, muted:state.muted, active_page_id:state.pageId, active_board_id:state.activeBoardId };
    if (scopes.has("typing")) payload.typing = state.typingStats;
    return payload;
  }

  function persist(scope = "all") {
    ensureWorkspaceHistory();
    if (scope === "page") rememberCurrentPage();
    if (scope === "board") rememberCurrentBoard();
    const changedScopes = scope === "all" ? ["page", "board", "settings", "typing"] : [scope];
    changedScopes.forEach(name => { dirtyScopes.add(name); dirtyVersions[name] += 1; });
    clearTimeout(saveTimer);
    if (!firebaseUser) {
      syncStatus = "guest · not saved";
      updateSyncLabels();
      return;
    }
    syncStatus = "saving";
    updateSyncLabels();
    saveTimer = setTimeout(() => { runRemoteSync(); }, scope === "page" ? 120 : 220);
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
    try {
      clearTimeout(saveTimer);
      if (firebaseUser && userHydrated && hydratedUserId === firebaseUser.uid && dirtyScopes.size) {
        const flushed = await flushRemoteSync();
        if (!flushed) { syncStatus = "saved locally · retrying"; updateSyncLabels(); showToast("Still saving — please try signing out again in a moment"); return; }
      }
      hydrationRequestId += 1;
      if (authReady()) await firebase.auth().signOut();
      firebaseUser = null; userHydrated=false; hydratedUserId=""; hydratingUserId=""; dirtyScopes.clear(); selectedMoodId="";
      renderAll(); showToast("Signed out");
    } catch (error) { showToast(authErrorMessage(error)); }
  }

  function updateSyncLabels() {
    document.querySelectorAll("[data-sync-label]").forEach(el => {
      el.textContent = syncStatus === "saving" ? "saving" : syncStatus;
      el.title = lastSyncError || "";
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
    }).catch(() => { soundLoadPromise = null; return false; });
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
    const numericId = typeof input === "object" && input.keyCode ? String(input.keyCode) : (/^\d+$/.test(String(code)) ? String(code) : codeToLegacyId(code));
    loadSoundPack().then(loaded => {
      if (!loaded || !soundBuffer || !soundContext || !soundConfig) { fallbackKeySound(numericId); return; }
      try {
        if (soundContext.state === "suspended") soundContext.resume().catch(() => {});
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
  function isTouchLayout() { return window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth <= 820; }

  function updateTypingValue(nextValue, input) {
    const exercise = currentTypingExercise();
    typingSession.value = nextValue.slice(0, exercise.text.length);
    if (!typingSession.startedAt && typingSession.value.length) typingSession.startedAt = Date.now();
    typingSession.errors = [...typingSession.value].reduce((total, character, index) => total + (character !== exercise.text[index] ? 1 : 0), 0);
    if (input) input.value = typingSession.value;
    const prompt = document.querySelector("[data-typing-prompt]");
    if (prompt) prompt.innerHTML = typingPromptMarkup(exercise.text, typingSession.value, exercise.text.length);
    const progress = document.querySelector(".typing-progress span");
    if (progress) progress.style.width = `${typingProgress()}%`;
    const progressLabel = document.querySelector(".typing-actions span:last-child");
    if (progressLabel) progressLabel.textContent = `${typingProgress()}%`;
    if (typingSession.value.length >= exercise.text.length) finishTypingExercise();
  }

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
    return `<section class="editor-stage typing-stage"><div class="editor-head"><div><span class="eyebrow"><b>✦</b> enhance typing</span><h2 class="typing-heading">Practice the rhythm, not the rush.</h2></div><div class="editor-tools"><button class="pill-btn" data-action="reset-typing">↻ <span>New exercise</span></button></div></div><div class="typing-layout"><div class="typing-card"><div class="typing-card-top"><span>vex / typewriter</span><span>${escapeHtml(exercise.level)}</span></div><div class="typing-prompt" data-typing-prompt>${typingPromptMarkup(exercise.text, typingSession.value, typingSession.visibleLength || exercise.text.length)}</div><input class="typing-input ${isTouchLayout() ? "mobile-typing-input" : ""}" data-typing-input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="none" ${isTouchLayout() ? "readonly" : ""} placeholder="${isTouchLayout() ? "Use the Vex keyboard below…" : "Type the sentence above…"}" aria-label="Typing exercise input" ${typingSession.ready ? "" : "disabled"} value="${escapeHtml(typingSession.value)}" /><div class="typing-progress"><span style="width:${typingProgress()}%"></span></div><div class="typing-actions"><span>${typingSession.ready ? "Your turn." : "Setting the page…"}</span><span>${typingProgress()}%</span></div></div><aside class="typing-stats"><p class="side-label">your rhythm</p><div class="stat-grid"><div><strong>${stats.bestWpm || 0}</strong><span>best wpm</span></div><div><strong>${stats.bestAccuracy || 0}%</strong><span>best accuracy</span></div><div><strong>${stats.completed || 0}</strong><span>completed</span></div><div><strong>${stats.streak || 0}</strong><span>streak</span></div></div><p class="typing-note">${firebaseUser ? "Your progress is private to this account and syncs across devices." : "Try it freely. Sign in when you want Vex to remember your progress."}</p>${!firebaseUser ? `<button class="side-signin" data-action="open-auth">Sign in to save progress ↗</button>` : ""}</aside></div><div class="typing-exercises"><p class="side-label">choose a feeling</p>${typingExercises.map(item => `<button class="exercise-chip ${item.id === exercise.id ? "active" : ""}" data-action="select-exercise" data-exercise-id="${item.id}"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(item.level)}</small></button>`).join("")}</div></section>`;
  }

  function pageClass() { return state.pageType; }

  function renderTopbar(mode = "workspace") {
    return `<header class="topbar">
      <div class="top-left">
        <div class="brand"><span class="brand-mark">vx</span><span>Vex</span></div>
        ${mode === "workspace" ? `<button class="icon-btn" data-action="toggle-sidebar" aria-label="Toggle sidebar">${icon("menu")}</button><div class="crumb"><span>workspace</span><span>/</span><strong>${state.title || "untitled"}</strong></div>` : `<div class="crumb"><strong>an open canvas for your thoughts</strong></div>`}
      </div>
      <div class="top-actions">
        <button class="status status-action" data-action="retry-sync" title="${escapeHtml(lastSyncError || "Retry sync")}"><span class="status-dot"></span><span data-sync-label>${syncStatus}</span></button>
        <button class="icon-btn sound-toggle" data-action="toggle-sound" aria-label="${state.muted ? "Turn sound on" : "Mute keyboard sounds"}" aria-pressed="${state.muted ? "true" : "false"}">${state.muted ? icon("soundOff") : icon("sound")}</button>
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
    const touchMode = isTouchLayout();
    return `<section class="editor-stage"><div class="editor-head"><input class="page-title" value="${escapeHtml(state.title)}" aria-label="Page title" ${touchMode ? "readonly inputmode=none" : ""} /><div class="editor-tools"><button class="pill-btn" data-action="share-note" title="Share note">↗ <span>Share</span></button><button class="pill-btn" data-action="export-page" title="Export note">${icon("download")} <span>Export</span></button></div></div><div class="page-meta"><span>${touchMode ? "Use the Vex keyboard below" : "Today · just now"}</span><div class="page-switcher">${["ruled-single","ruled-double","plain","dotted-light","dotted-dense"].map(type => `<button class="${state.pageType === type ? "active" : ""}" data-action="set-page-type" data-value="${type}">${type.replace("ruled-", "ruled · ").replace("dotted-", "dotted · ")}</button>`).join("")}</div></div><div class="page-card ${pageClass()}"><div class="editor-content ${touchMode ? "mobile-editor-content" : ""}" contenteditable="${touchMode ? "false" : "true"}" inputmode="none" spellcheck="false" data-placeholder="Start with a sentence, a question, or a tiny spark…">${formatPreview(state.content)}</div></div>${renderFormatBar()}</section>`;
  }

  function renderMoodboard() {
    ensureWorkspaceHistory();
    const board = state.boards.find(item => item.id === state.activeBoardId) || state.boards[0];
    const zoomPercent = Math.round(state.boardZoom * 100);
        return `<section class="editor-stage moodboard-stage"><div class="editor-head"><input class="page-title" value="${escapeHtml(board.title)}" aria-label="Moodboard title" readonly /><div class="editor-tools"><button class="pill-btn" data-action="share-board">↗ <span>Share</span></button><button class="pill-btn" data-action="new-board">${icon("plus")} <span>New board</span></button>
<label class="primary-btn">${icon("plus")} Add media<input type="file" accept="image/*,video/*" multiple hidden data-file-upload /></label><button class="pill-btn" data-action="add-note">${icon("note")} <span>Note</span></button></div></div><div class="page-meta"><span>Endless canvas · drag to pan · scroll to zoom</span><div class="page-switcher">${state.boards.map(item => `<button class="${item.id === state.activeBoardId ? "active" : ""}" data-action="select-board" data-board-id="${item.id}">${escapeHtml(item.title)}</button>`).join("")}<button data-action="zoom-board" data-zoom="out">−</button><button class="active" data-zoom-label>${zoomPercent}%</button><button data-action="zoom-board" data-zoom="in">+</button><button data-action="zoom-board" data-zoom="reset">reset</button></div></div><div class="moodboard" data-moodboard><div class="mood-canvas" style="transform:translate(${state.boardPan.x}px,${state.boardPan.y}px) scale(${state.boardZoom})">${state.mood.map(renderMoodItem).join("")}</div>${state.mood.length === 0 ? `<div class="mood-empty"><div><strong>Your canvas is wide open.</strong>Drop in an image, video, or note to begin.</div></div>` : ""}</div>${renderMoodInspector()}</section>`;
  }
  function renderMoodInspector() {
    const item = state.mood.find(piece => piece.id === selectedMoodId);
    if (!item) return `<aside class="mood-inspector mood-inspector-empty"><div class="inspector-orbit">✦</div><strong>Select a piece</strong><p>Choose a note or image on the canvas to edit its details.</p></aside>`;
    const isNote = item.type === "note";
    const colors = ["yellow", "pink", "blue", "green"];
    return `<aside class="mood-inspector"><div class="inspector-head"><div><p class="side-label">selected piece</p><strong>${isNote ? "Note" : "Media"}</strong></div><button class="icon-btn" data-action="clear-mood-selection" aria-label="Close inspector">×</button></div><div class="inspector-preview ${item.color || "yellow"}">${isNote ? `<strong>${escapeHtml(item.title || "new thought")}</strong><span>${escapeHtml(item.text || "")}</span>` : `<span>${escapeHtml(item.name || "Uploaded media")}</span>`}</div>${isNote ? `<label class="inspector-label">Title<input data-mood-field="title" value="${escapeHtml(item.title || "")}" /></label><label class="inspector-label">Text<textarea data-mood-field="text" rows="5">${escapeHtml(item.text || "")}</textarea></label><div class="inspector-control"><span>Color</span><div class="color-options">${colors.map(color => `<button class="color-dot ${color} ${item.color === color ? "active" : ""}" data-mood-color="${color}" aria-label="${color} color"></button>`).join("")}</div></div><label class="inspector-label">Font<select data-mood-field="fontFamily"><option value="Space Grotesk" ${item.fontFamily === "Space Grotesk" ? "selected" : ""}>Space Grotesk</option><option value="IBM Plex Mono" ${item.fontFamily === "IBM Plex Mono" ? "selected" : ""}>IBM Plex Mono</option><option value="Georgia" ${item.fontFamily === "Georgia" ? "selected" : ""}>Georgia</option></select></label><label class="inspector-label">Size<select data-mood-field="fontSize"><option value="13" ${Number(item.fontSize || 13) === 13 ? "selected" : ""}>Small</option><option value="16" ${Number(item.fontSize || 13) === 16 ? "selected" : ""}>Medium</option><option value="20" ${Number(item.fontSize || 13) === 20 ? "selected" : ""}>Large</option><option value="26" ${Number(item.fontSize || 13) === 26 ? "selected" : ""}>XL</option></select></label><div class="inspector-control"><span>Style</span><div class="style-options"><button class="${item.fontWeight === 700 ? "active" : ""}" data-mood-style="bold">B</button><button class="${item.fontStyle === "italic" ? "active" : ""}" data-mood-style="italic"><i>I</i></button><button class="${item.textAlign === "center" ? "active" : ""}" data-mood-style="center">Center</button></div></div>` : `<label class="inspector-label">Caption<input data-mood-field="name" value="${escapeHtml(item.name || "")}" /></label>`}<button class="danger-btn" data-action="delete-mood-item">Delete piece</button></aside>`;
  }

  function renderMoodItem(item) {
    const selected = selectedMoodId === item.id ? "selected" : "";
    const style = `left:${item.x}px;top:${item.y}px;font-size:${item.fontSize || 13}px;font-family:${item.fontFamily || "Space Grotesk"};font-weight:${item.fontWeight || 500};font-style:${item.fontStyle || "normal"};text-align:${item.textAlign || "left"};`;
    if (item.type === "note") return `<article class="mood-note ${item.color || "yellow"} ${selected}" data-mood-id="${item.id}" data-action="select-mood-item" tabindex="0" style="${style}"><h4>${escapeHtml(item.title || "new thought")}</h4><p>${escapeHtml(item.text || "")}</p></article>`;
    return `<article class="mood-image ${selected}" data-mood-id="${item.id}" data-action="select-mood-item" tabindex="0" style="left:${item.x}px;top:${item.y}px"><img src="${item.src}" alt="${escapeHtml(item.name || "uploaded image")}" /><small>${escapeHtml(item.name || "moodboard media")}</small></article>`;
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
    root.querySelectorAll("[data-action='new-page']").forEach(btn => btn.addEventListener("click", () => { workspaceTab = "write"; state.moodboard = false; const page = normalizePage({ id:makeEntityId("note"), title:"Untitled page", content:"", page_type:"ruled-single", updated_at:new Date().toISOString() }, firebaseUser?.uid); state.pages.unshift(page); state.pageId = page.id; state.title = page.title; state.content = page.content; state.pageType = page.page_type; persist("page"); renderApp(); setTimeout(() => document.querySelector(".page-title")?.focus(), 50); }));
    root.querySelectorAll("[data-action='set-page-type']").forEach(btn => btn.addEventListener("click", () => { state.pageType = btn.dataset.value; persist("page"); renderAll(); }));
    root.querySelectorAll("[data-action='toggle-sound']").forEach(btn => btn.addEventListener("click", () => { state.muted = !state.muted; persist("settings"); renderAll(); showToast(state.muted ? "Sound muted" : "Sound on"); }));
    root.querySelectorAll("[data-action='cycle-theme']").forEach(btn => btn.addEventListener("click", () => setTheme(state.theme === "light" ? "dark" : state.theme === "dark" ? "zen" : "light")));
    root.querySelectorAll("[data-action='open-auth']").forEach(btn => btn.addEventListener("click", () => showAuthModal()));
    root.querySelectorAll("[data-action='sign-out']").forEach(btn => btn.addEventListener("click", signOut));
    root.querySelectorAll("[data-action='retry-sync']").forEach(btn => btn.addEventListener("click", () => { if (firebaseUser) { syncStatus = "saving"; updateSyncLabels(); runRemoteSync(); } else showAuthModal(); }));
    root.querySelectorAll("[data-action='coming-soon']").forEach(btn => btn.addEventListener("click", () => showToast("More spaces are coming soon")));
    root.querySelectorAll("[data-action='open-pages']").forEach(btn => btn.addEventListener("click", showPagesModal));
    root.querySelectorAll("[data-action='new-board']").forEach(btn => btn.addEventListener("click", () => { ensureWorkspaceHistory(); const board = normalizeBoard({ id:makeEntityId("board"), title:"New moodboard", item_count:0, updated_at:new Date().toISOString() }, firebaseUser?.uid); state.boards.unshift(board); state.boardItems[board.id]=[]; setActiveBoard(board.id); state.moodboard=true; workspaceTab="write"; persist("board"); renderApp(); showToast("New moodboard created"); }));
    root.querySelectorAll("[data-action='select-board']").forEach(btn => btn.addEventListener("click", () => { setActiveBoard(btn.dataset.boardId); state.moodboard=true; persist("settings"); renderApp(); }));
    root.querySelectorAll("[data-action='zoom-board']").forEach(btn => btn.addEventListener("click", () => { const action=btn.dataset.zoom; if (action === "in") state.boardZoom=Math.min(2.5, state.boardZoom + .1); if (action === "out") state.boardZoom=Math.max(.45, state.boardZoom - .1); if (action === "reset") { state.boardZoom=1; state.boardPan={x:0,y:0}; } renderApp(); }));
    root.querySelectorAll("[data-action='add-note']").forEach(btn => btn.addEventListener("click", () => {     const note = { id:makeEntityId("mood-piece"), type:"note", color:["yellow","pink","blue","green"][state.mood.length % 4], x:180 + state.mood.length * 48, y:160 + state.mood.length * 35, title:"new thought", text:"Double-click to make this yours.", fontSize:13, fontFamily:"Space Grotesk", fontWeight:500, fontStyle:"normal", textAlign:"left" };
 state.mood.push(note); selectedMoodId=note.id; persist("board"); renderAll(); }));
    root.querySelectorAll("[data-action='select-mood-item']").forEach(item => item.addEventListener("click", event => { event.stopPropagation(); selectedMoodId=item.dataset.moodId; renderApp(); }));
    root.querySelectorAll("[data-action='clear-mood-selection']").forEach(btn => btn.addEventListener("click", () => { selectedMoodId=""; renderApp(); }));
    root.querySelectorAll("[data-action='delete-mood-item']").forEach(btn => btn.addEventListener("click", () => { state.mood = state.mood.filter(item => item.id !== selectedMoodId); state.boardItems[state.activeBoardId] = state.mood; selectedMoodId=""; persist("board"); renderApp(); showToast("Piece deleted"); }));
    root.querySelectorAll("[data-mood-field]").forEach(field => field.addEventListener("input", event => { const item=state.mood.find(piece => piece.id === selectedMoodId); if (!item) return; const key=field.dataset.moodField; item[key] = key === "fontSize" ? Number(field.value) : field.value; persist("board"); const preview=document.querySelector(".mood-inspector .inspector-preview"); if (preview && item.type === "note") preview.innerHTML=`<strong>${escapeHtml(item.title || "new thought")}</strong><span>${escapeHtml(item.text || "")}</span>`; const canvasItem=document.querySelector(`[data-mood-id="${selectedMoodId}"]`); if (canvasItem) { if (key === "title") canvasItem.querySelector("h4").textContent=item.title; if (key === "text") canvasItem.querySelector("p").textContent=item.text; if (key === "name") canvasItem.querySelector("small").textContent=item.name; if (key === "fontSize") canvasItem.style.fontSize=item.fontSize+"px"; if (key === "fontFamily") canvasItem.style.fontFamily=item.fontFamily; } }));
    root.querySelectorAll("[data-mood-color]").forEach(btn => btn.addEventListener("click", () => { const item=state.mood.find(piece => piece.id === selectedMoodId); if (!item) return; item.color=btn.dataset.moodColor; persist("board"); renderApp(); }));
    root.querySelectorAll("[data-mood-style]").forEach(btn => btn.addEventListener("click", () => { const item=state.mood.find(piece => piece.id === selectedMoodId); if (!item) return; const style=btn.dataset.moodStyle; if (style === "bold") item.fontWeight=item.fontWeight === 700 ? 500 : 700; if (style === "italic") item.fontStyle=item.fontStyle === "italic" ? "normal" : "italic"; if (style === "center") item.textAlign=item.textAlign === "center" ? "left" : "center"; persist("board"); renderApp(); }));
    root.querySelectorAll("[data-action='share-note']").forEach(btn => btn.addEventListener("click", shareNote));
    root.querySelectorAll("[data-action='share-board']").forEach(btn => btn.addEventListener("click", shareBoard));
    root.querySelectorAll("[data-action='export-page']").forEach(btn => btn.addEventListener("click", showExportMenu));
    root.querySelectorAll("[data-action='preview-markdown']").forEach(btn => btn.addEventListener("click", () => showToast("Markdown is rendered live as you type")));
    root.querySelectorAll(".page-title:not([readonly])").forEach(input => input.addEventListener("input", e => { state.title = e.target.value; persist("page"); }));
    const typingInput = root.querySelector("[data-typing-input]");
    if (typingInput) {
      typingInput.addEventListener("input", e => updateTypingValue(e.target.value, e.target));
    }
    const editor = root.querySelector(".editor-content");
    const pageTitle = root.querySelector(".page-title");
    if (isTouchLayout()) {
      pageTitle?.addEventListener("pointerdown", event => { event.preventDefault(); mobileInputTarget="title"; pageTitle.classList.add("mobile-input-active"); });
      editor?.addEventListener("pointerdown", event => { event.preventDefault(); mobileInputTarget="body"; editor.classList.add("mobile-input-active"); });
    }
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
    const typingInput = document.querySelector("[data-typing-input]");
    if (typingInput && workspaceTab === "typing" && typingSession.ready && !typingSession.finished) {
      let nextValue = typingSession.value;
      if (key === "space") nextValue += " ";
      else if (key === "⌫") nextValue = nextValue.slice(0, -1);
      else if (key === "↵") nextValue += "\n";
      else if (!(["tab","caps","shift","ctrl","alt","⌘","fn","←","↓","→"].includes(key))) nextValue += key.length === 1 ? key.toLowerCase() : key;
      if (nextValue !== typingSession.value) updateTypingValue(nextValue, typingInput);
      return;
    }
    const ignoredKeys = ["tab","caps","shift","ctrl","alt","⌘","fn","←","↓","→"];
    if (isTouchLayout() && workspaceTab === "write") {
      if (ignoredKeys.includes(key)) return;
      const valueTarget = mobileInputTarget === "title" ? "title" : "body";
      const currentValue = valueTarget === "title" ? state.title : state.content;
      let nextValue = currentValue;
      if (key === "⌫") nextValue = currentValue.slice(0, -1);
      else if (key === "space") nextValue += " ";
      else if (key === "↵") nextValue += valueTarget === "body" ? "\n" : "";
      else if (key.length === 1) nextValue += key.toLowerCase();
      if (nextValue === currentValue) return;
      if (valueTarget === "title") {
        state.title = nextValue;
        const titleInput = document.querySelector(".page-title");
        if (titleInput) titleInput.value = state.title;
      } else {
        state.content = nextValue;
        const editor = document.querySelector(".editor-content");
        if (editor) editor.innerHTML = formatPreview(state.content);
      }
      persist("page");
      return;
    }
    const editor = document.querySelector(".editor-content");
    if (!editor || ignoredKeys.includes(key)) return;
    editor.focus();
    if (key === "space") document.execCommand("insertText", false, " ");
    else if (key === "⌫") document.execCommand("delete", false);
    else if (key === "↵") document.execCommand("insertText", false, "\n");
    else document.execCommand("insertText", false, key.length === 1 ? key.toLowerCase() : key);
    state.content = editorToMarkdown(editor); persist("page");
  }

  function shareUrl(id) {
    const origin = String(window.VEX_SITE_URL || window.location.origin).replace(/\/$/, "");
    return `${origin}/#app${encodeURIComponent(id)}`;
  }

  function currentPage() {
    ensureWorkspaceHistory();
    return state.pages.find(page => page.id === state.pageId) || state.pages[0];
  }

  function currentBoard() {
    ensureWorkspaceHistory();
    return state.boards.find(board => board.id === state.activeBoardId) || state.boards[0];
  }

  async function shareEntity(entity, kind) {
    if (!entity?.id) return;
    const url = shareUrl(entity.share_id || entity.id);
    const text = kind === "board" ? `${entity.title || "Vex moodboard"} · Vex moodboard` : noteText();
    try {
      await navigator.clipboard?.writeText(url);
      if (navigator.share) await navigator.share({ title:entity.title || (kind === "board" ? "Vex moodboard" : "Vex note"), text, url });
      showToast("Share link copied");
    } catch (_) { showToast("Share link: " + url); }
  }

  function shareNote() { return shareEntity(currentPage(), "note"); }
  function shareBoard() { return shareEntity(currentBoard(), "board"); }

  function resolveShareRoute() {
    if (!shareRouteId || !firebaseUser || !userHydrated) return false;
    const page = state.pages.find(item => item.share_id === shareRouteId || item.id === shareRouteId);
    if (page) {
      state.pageId = page.id; state.title = page.title || "Untitled page"; state.content = page.content || ""; state.pageType = page.page_type || "ruled-single"; state.moodboard = false; workspaceTab = "write"; renderApp(); showToast("Shared note opened"); return true;
    }
    const board = state.boards.find(item => item.share_id === shareRouteId || item.id === shareRouteId);
    if (board) { setActiveBoard(board.id); state.moodboard = true; workspaceTab = "write"; renderApp(); showToast("Shared moodboard opened"); return true; }
    showToast("This shared Vex item is unavailable in your account");
    return false;
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
  let hydratedUserId = "";
  let hydrationRequestId = 0;
  let remoteBoardItemIds = {};

  function userRoot(uid) { return firebaseDb.collection("users").doc(uid); }
  function userPage(uid) { return userRoot(uid).collection("pages").doc("daily-notes"); }
  function userBoard(uid) { return userRoot(uid).collection("boards").doc("moodboard"); }
  function userTyping(uid) { return userRoot(uid).collection("typing").doc("stats"); }

  function vexFirestoreDatabaseId() { return firebaseConfig.firestoreDatabaseId || "(default)"; }
  function vexFirestoreDocumentName(path) {
    return `projects/${firebaseConfig.projectId}/databases/${vexFirestoreDatabaseId()}/documents/${path}`;
  }
  function vexFirestoreUrl(path = "") {
    const encodedPath = path.split("/").filter(Boolean).map(segment => encodeURIComponent(String(segment))).join("/");
    return `https://firestore.googleapis.com/v1/${vexFirestoreDocumentName(encodedPath)}`;
  }
  function vexFirestoreBatchUrl() {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/${encodeURIComponent(vexFirestoreDatabaseId())}/documents:batchWrite`;
  }
  function firestoreValue(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    if (typeof value === "string") return { stringValue: value };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
    if (value instanceof Date) return { timestampValue: value.toISOString() };
    if (typeof value === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, firestoreValue(item)])) } };
    return { stringValue: String(value) };
  }
  function firestoreFields(data) { return Object.fromEntries(Object.entries(data || {}).filter(([, value]) => value !== undefined).map(([key, value]) => [key, firestoreValue(value)])); }
  function readFirestoreValue(value) {
    if (!value) return null;
    if (Object.prototype.hasOwnProperty.call(value, "nullValue")) return null;
    if (Object.prototype.hasOwnProperty.call(value, "stringValue")) return value.stringValue;
    if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) return value.booleanValue;
    if (Object.prototype.hasOwnProperty.call(value, "integerValue")) return Number(value.integerValue);
    if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) return value.doubleValue;
    if (Object.prototype.hasOwnProperty.call(value, "timestampValue")) return value.timestampValue;
    if (Object.prototype.hasOwnProperty.call(value, "bytesValue")) return value.bytesValue;
    if (Object.prototype.hasOwnProperty.call(value, "referenceValue")) return value.referenceValue;
    if (Object.prototype.hasOwnProperty.call(value, "arrayValue")) return (value.arrayValue.values || []).map(readFirestoreValue);
    if (Object.prototype.hasOwnProperty.call(value, "mapValue")) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, readFirestoreValue(item)]));
    return null;
  }
  function firestoreDocumentToObject(document) {
    const name = document?.name || "";
    const id = decodeURIComponent(name.split("/").pop() || "");
    return { id, ...Object.fromEntries(Object.entries(document?.fields || {}).map(([key, value]) => [key, readFirestoreValue(value)])) };
  }
  async function firestoreRestRequest(url, options = {}) {
    if (!firebaseUser) throw new Error("Vex sync requires an authenticated Firebase user.");
    let token = await firebaseUser.getIdToken();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization:`Bearer ${token}`, "Content-Type":"application/json" } });
      if (response.status === 401 && attempt === 0) { token = await firebaseUser.getIdToken(true); continue; }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `Firestore sync failed (${response.status}).`);
      return payload;
    }
    throw new Error("Firebase session token could not be refreshed");
  }
  async function firestoreRestList(path, pageSize = 100) {
    const payload = await firestoreRestRequest(`${vexFirestoreUrl(path)}?pageSize=${pageSize}`);
    return (payload.documents || []).map(firestoreDocumentToObject);
  }
  async function firestoreRestGet(path) {
    try { return firestoreDocumentToObject(await firestoreRestRequest(vexFirestoreUrl(path))); }
    catch (error) { if (String(error.message || "").includes("(404)") || /not found/i.test(error.message || "")) return null; throw error; }
  }
  async function firestoreRestBatchWrite(writes) {
    for (let offset = 0; offset < writes.length; offset += 450) {
      const chunk = writes.slice(offset, offset + 450).map(write => write.delete ? { delete:vexFirestoreDocumentName(write.delete) } : { update: { name:vexFirestoreDocumentName(write.path), fields:firestoreFields(write.data) } });
      const payload = await firestoreRestRequest(vexFirestoreBatchUrl(), { method:"POST", body:JSON.stringify({ writes:chunk }) });
      const failed = (payload.status || []).find(status => status.code);
      if (failed) throw new Error(failed.message || `Firestore batch write failed (${failed.code}).`);
    }
  }
  async function readCompatDefaultUserData(uid) {
    const [pagesSnap, settingsSnap, boardsSnap, typingSnap] = await Promise.all([
      userRoot(uid).collection("pages").limit(100).get(),
      userRoot(uid).collection("settings").doc("preferences").get(),
      userRoot(uid).collection("boards").limit(50).get(),
      userTyping(uid).get()
    ]);
    const boardDocs = boardsSnap.docs.map(doc => ({ id:doc.id, ...doc.data() }));
    const itemResults = await Promise.all(boardDocs.map(board => userRoot(uid).collection("boards").doc(board.id).collection("items").limit(500).get()));
    return {
      pageDocs:pagesSnap.docs.map(doc => ({ id:doc.id, ...doc.data() })),
      settingsDoc:settingsSnap.exists ? settingsSnap.data() : null,
      boardDocs,
      itemResults:itemResults.map(snapshot => snapshot.docs.map(doc => ({ id:doc.id, ...doc.data() }))),
      typingDoc:typingSnap.exists ? typingSnap.data() : null
    };
  }

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

  async function hydrateSupabaseUserData(user, requestId, requestUserId) {
    const data = await readSupabaseState();
    if (!data?.enabled || requestId !== hydrationRequestId || !firebaseUser || firebaseUser.uid !== requestUserId) return false;
    const pages = Array.isArray(data.pages) ? data.pages.map(page => normalizePage(page, requestUserId)) : [];
    const rawBoards = Array.isArray(data.boards) ? data.boards : [];
    const boards = rawBoards.map(board => normalizeBoard(board, requestUserId));
    const boardIdMap = new Map(rawBoards.map((board, index) => [String(board.id), boards[index].id]));
    const rows = Array.isArray(data.items) ? data.items : [];
    const settings = data.settings && typeof data.settings === "object" ? data.settings : {};
    state.pages = pages.length ? pages : cloneState(defaultState).pages;
    state.boards = boards.length ? boards : cloneState(defaultState).boards;
    state.boardItems = {};
    remoteBoardItemIds = {};
    state.boards.forEach(board => { state.boardItems[board.id] = []; remoteBoardItemIds[board.id] = []; });
    rows.forEach(row => {
      const item = row.payload && typeof row.payload === "object" ? { ...row.payload, id:row.id, type:row.item_type || row.payload.type || "note" } : { id:row.id, type:row.item_type || "note" };
      const boardId = boardIdMap.get(String(row.board_id)) || row.board_id;
      state.boardItems[boardId] = state.boardItems[boardId] || [];
      state.boardItems[boardId].push(item);
      remoteBoardItemIds[boardId] = remoteBoardItemIds[boardId] || [];
      remoteBoardItemIds[boardId].push(row.id);
    });
    const activePage = state.pages.find(page => page.id === settings.active_page_id) || state.pages[0];
    state.pageId = activePage?.id || "daily-notes";
    state.title = activePage?.title || "Untitled page";
    state.content = activePage?.content || "";
    state.pageType = activePage?.page_type || "ruled-single";
    state.theme = settings.theme || state.theme;
    if (typeof settings.muted === "boolean") state.muted = settings.muted;
    state.typingStats = { ...defaultState.typingStats, ...(data.typing || {}) };
    state.activeBoardId = settings.active_board_id && state.boards.some(board => board.id === settings.active_board_id) ? settings.active_board_id : state.boards[0]?.id || "moodboard";
    ensureWorkspaceHistory();
    setActiveBoard(state.activeBoardId);
    state.moodboard = false;
    workspaceTab = "write";
    userHydrated = true;
    hydratedUserId = requestUserId;
    dirtyScopes.clear();
    syncStatus = "synced";
    document.documentElement.dataset.theme = state.theme;
    updateFavicon(state.theme);
    renderAll();
    if (shareRouteId) setTimeout(resolveShareRoute, 0);
    const emptyAccount = !pages.length && !boards.length && !rows.length && !Object.keys(settings).length && !Object.keys(data.typing || {}).length;
    if (emptyAccount && supabaseConfig.serverBridge) {
      ["page", "board", "settings", "typing"].forEach(scope => dirtyScopes.add(scope));
      syncStatus = "saving";
      updateSyncLabels();
      setTimeout(runRemoteSync, 0);
      return true;
    }
    return !emptyAccount;
  }

  function clearSyncedScopes(scopes, versions) {
    scopes.forEach(scope => { if (dirtyVersions[scope] === versions.get(scope)) dirtyScopes.delete(scope); });
  }

  async function trySupabaseSync(scopes, versions) {
    if (!supabaseConfig.enabled || !firebaseUser || !userHydrated || hydratedUserId !== firebaseUser.uid || hydratingUserId !== firebaseUser.uid) return false;
    await writeSupabaseState(await stateSyncPayload(scopes));
    clearSyncedScopes(scopes, versions);
    syncStatus = dirtyScopes.size ? "saving" : "synced";
    updateSyncLabels();
    return true;
  }

  async function hydrateUserData(user) {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps || !user) return;
    const requestId = ++hydrationRequestId;
    const requestUserId = user.uid;
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      firebaseDb = firebase.firestore();
      hydratingUserId = requestUserId;
      if (supabaseConfig.enabled) {
        try {
          if (await hydrateSupabaseUserData(user, requestId, requestUserId)) return;
        } catch (supabaseError) {
          lastSyncError = supabaseError?.message || "Supabase hydration failed";
          console.error("Vex Supabase hydration failed", supabaseError);
          if (supabaseConfig.serverBridge) { syncStatus = "offline · retrying"; updateSyncLabels(); return; }
        }
        if (supabaseConfig.serverBridge) { syncStatus = "offline · retrying"; updateSyncLabels(); return; }
      }
      hydratedUserId = "";
      userHydrated = false;
      syncStatus = "loading your space";
      updateSyncLabels();
      let pageDocs = [], settingsDoc = null, boardDocs = [], typingDoc = null, fallbackItems = [];
      let namedReadError = null;
      let recoveredDefaultData = false;
      try {
        [pageDocs, settingsDoc, boardDocs, typingDoc] = await Promise.all([
          firestoreRestList(`users/${requestUserId}/pages`, 100),
          firestoreRestGet(`users/${requestUserId}/settings/preferences`),
          firestoreRestList(`users/${requestUserId}/boards`, 50),
          firestoreRestGet(`users/${requestUserId}/typing/stats`)
        ]);
      } catch (error) {
        namedReadError = error;
      }
      if (namedReadError || (!pageDocs.length && !boardDocs.length && !settingsDoc && !typingDoc)) {
        try {
          const fallback = await readCompatDefaultUserData(requestUserId);
          if (fallback.pageDocs.length || fallback.boardDocs.length || fallback.settingsDoc || fallback.typingDoc) {
            pageDocs = fallback.pageDocs;
            settingsDoc = fallback.settingsDoc;
            boardDocs = fallback.boardDocs;
            fallbackItems = fallback.itemResults;
            typingDoc = fallback.typingDoc;
            recoveredDefaultData = true;
            console.warn("Vex recovered user data from the legacy default Firestore database.");
          } else if (namedReadError) {
            throw namedReadError;
          }
        } catch (fallbackError) {
          if (namedReadError) throw namedReadError;
          console.warn("Vex default Firestore recovery skipped:", fallbackError);
        }
      }
      let legacyPages = [];
      try {
        const legacyFiles = await firestoreRestList("files", 100);
        legacyPages = legacyFiles.filter(data => data.user_id === requestUserId).map(data => ({ id:`legacy-${data.id}`, title:data.title || data.name || "Recovered note", content:data.content || data.text || "", page_type:data.page_type || "ruled-single", updated_at:data.updated_at || data.updatedAt || data.created_at || "", legacy_file_id:data.id }));
      } catch (legacyError) {
        console.warn("Vex legacy file migration skipped:", legacyError);
      }
      if (requestId !== hydrationRequestId || !firebaseUser || firebaseUser.uid !== requestUserId) return;
      const pageById = new Map([...pageDocs, ...legacyPages].map(page => [page.id, page]));
      const allPages = [...pageById.values()].map(page => normalizePage(page, requestUserId)).sort((a,b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
      const rawSortedBoards = boardDocs.sort((a,b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
      const sortedBoards = rawSortedBoards.map(board => normalizeBoard(board, requestUserId));
      const itemResults = fallbackItems.length ? fallbackItems : await Promise.all(rawSortedBoards.map(board => firestoreRestList(`users/${requestUserId}/boards/${board.id}/items`, 500)));
      if (requestId !== hydrationRequestId || !firebaseUser || firebaseUser.uid !== requestUserId) return;
      state.pages = allPages.length ? allPages : [{ id:"daily-notes", title:"A softer place to think", content:"", page_type:"ruled-single", updated_at:"" }];
      if (legacyPages.length || recoveredDefaultData) dirtyScopes.add("page");
      state.boards = sortedBoards.length ? sortedBoards : state.boards;
      state.boardItems = {};
      remoteBoardItemIds = {};
      sortedBoards.forEach((board, index) => { state.boardItems[board.id] = itemResults[index]; remoteBoardItemIds[board.id] = itemResults[index].map(item => item.id); });
      const latestPage = state.pages[0];
      if (latestPage) {
        state.pageId = latestPage.id;
        state.title = latestPage.title || "Untitled page";
        state.content = latestPage.content || "";
        state.pageType = latestPage.page_type || "ruled-single";
      }
      if (settingsDoc) {
        const settings = settingsDoc;
        if (settings.theme) state.theme = settings.theme;
        if (typeof settings.muted === "boolean") state.muted = settings.muted;
      }
      ensureWorkspaceHistory();
      const firstBoard = state.boards[0];
      if (firstBoard) setActiveBoard(firstBoard.id);
      state.moodboard = false;
      workspaceTab = "write";
      if (typingDoc) state.typingStats = { ...defaultState.typingStats, ...typingDoc };
      userHydrated = true;
      hydratedUserId = requestUserId;
      dirtyScopes.clear();
      syncStatus = "synced";
      document.documentElement.dataset.theme = state.theme;
      updateFavicon(state.theme);
      renderAll();
      if (shareRouteId) setTimeout(resolveShareRoute, 0);
      if (recoveredDefaultData) ["page", "board", "settings", "typing"].forEach(scope => dirtyScopes.add(scope));
      if (!pageDocs.length && !sortedBoards.length && !settingsDoc && !typingDoc && !legacyPages.length && !recoveredDefaultData) ["page", "board", "settings", "typing"].forEach(scope => dirtyScopes.add(scope));
      if (recoveredDefaultData || legacyPages.length || (!pageDocs.length && !sortedBoards.length && !settingsDoc && !typingDoc)) await tryRemoteSync();
    } catch (error) {
      if (requestId !== hydrationRequestId || !firebaseUser || firebaseUser.uid !== requestUserId) return;
      userHydrated = false;
      hydratedUserId = "";
      lastSyncError = error?.message || "Workspace hydration failed";
      syncStatus = "offline · retrying";
      console.error("Vex hydration failed", error);
      updateSyncLabels();
    }
  }

  function runRemoteSync() {
    if (saveInFlight) { saveQueued = true; return savePromise || Promise.resolve(); }
    saveInFlight = true;
    saveQueued = false;
    savePromise = tryRemoteSync().finally(() => {
      saveInFlight = false;
      savePromise = null;
      if (saveQueued || dirtyScopes.size) {
        const shouldRunImmediately = saveQueued;
        saveQueued = false;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(runRemoteSync, shouldRunImmediately ? 140 : syncRetryDelay);
      }
    });
    return savePromise;
  }

  async function flushRemoteSync(maxAttempts = 3) {
    clearTimeout(saveTimer);
    for (let attempt = 0; attempt < maxAttempts && dirtyScopes.size; attempt += 1) {
      if (saveInFlight) await (savePromise || Promise.resolve());
      else await runRemoteSync();
      if (dirtyScopes.size && !saveInFlight) await new Promise(resolve => setTimeout(resolve, Math.min(250, syncRetryDelay)));
    }
    return dirtyScopes.size === 0;
  }

  async function tryRemoteSync() {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps || !firebaseUser || !userHydrated || hydratedUserId !== firebaseUser.uid || hydratingUserId !== firebaseUser.uid) return;
    const scopes = new Set(dirtyScopes);
    if (!scopes.size) return;
    const versions = new Map([...scopes].map(scope => [scope, dirtyVersions[scope]]));
    if (supabaseConfig.serverBridge) {
      try {
        if (await trySupabaseSync(scopes, versions)) { syncRetryDelay = 1000; return; }
      } catch (serverSupabaseError) {
        lastSyncError = serverSupabaseError?.message || "Server Supabase sync failed";
        console.error("Vex server Supabase sync failed", serverSupabaseError);
      }
      syncRetryDelay = Math.min(15000, Math.round(syncRetryDelay * 1.7));
      syncStatus = "saved locally · retrying";
      updateSyncLabels();
      return;
    }
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      firebaseDb = firebase.firestore();
      firebaseStorage = window.firebase.storage ? firebase.storage() : null;
      const uid = firebaseUser.uid;
      const now = new Date().toISOString();
      const writes = [{ path:`users/${uid}`, data:{ uid, email:firebaseUser.email || null, display_name:firebaseUser.displayName || null, photo_url:firebaseUser.photoURL || null, last_seen_at:now, schema_version:1 } }];
      if (scopes.has("page")) {
        rememberCurrentPage();
        state.pages.slice(0, 100).forEach(page => writes.push({ path:`users/${uid}/pages/${page.id}`, data:{ ...page, schema_version:1 } }));
      }
      if (scopes.has("settings")) writes.push({ path:`users/${uid}/settings/preferences`, data:{ theme:state.theme, muted:state.muted, active_page_id:state.pageId, active_board_id:state.activeBoardId, updated_at:now, schema_version:1 } });
      if (scopes.has("typing")) writes.push({ path:`users/${uid}/typing/stats`, data:{ ...state.typingStats, updated_at:now, schema_version:1 } });
      if (scopes.has("board")) {
        rememberCurrentBoard();
        for (const board of state.boards.slice(0, 50)) {
          const items = state.boardItems[board.id] || [];
          writes.push({ path:`users/${uid}/boards/${board.id}`, data:{ ...board, board_id:board.id, item_count:items.length, updated_at:board.id === state.activeBoardId ? now : (board.updated_at || now), schema_version:1 } });
          const syncedItems = await Promise.all(items.slice(0, 500).map(item => prepareMoodItemForSync(item, uid)));
          syncedItems.forEach(item => writes.push({ path:`users/${uid}/boards/${board.id}/items/${item.id}`, data:{ ...item, updated_at:now, schema_version:1 } }));
          const currentIds = new Set(items.map(item => String(item.id)));
          (remoteBoardItemIds[board.id] || []).filter(itemId => !currentIds.has(String(itemId))).forEach(itemId => writes.push({ delete:`users/${uid}/boards/${board.id}/items/${itemId}` }));
          remoteBoardItemIds[board.id] = items.map(item => item.id);
        }
      }
      await firestoreRestBatchWrite(writes);
      clearSyncedScopes(scopes, versions);
      syncRetryDelay = 1000;
      lastSyncError = "";
      syncStatus = dirtyScopes.size ? "saving" : "synced"; updateSyncLabels();
    } catch (firebaseError) {
      lastSyncError = firebaseError?.message || "Firestore sync failed";
      console.error("Vex Firestore sync failed; trying Supabase fallback", firebaseError);
      if (supabaseConfig.enabled) {
        try {
          if (await trySupabaseSync(scopes, versions)) { syncRetryDelay = 1000; return; }
        } catch (supabaseError) {
          lastSyncError = `${lastSyncError}; ${supabaseError?.message || "Supabase sync failed"}`;
          console.error("Vex Supabase fallback sync failed", supabaseError);
        }
      }
      syncRetryDelay = Math.min(15000, Math.round(syncRetryDelay * 1.7));
      syncStatus = "saved locally · retrying";
      updateSyncLabels();
    }
  }

  function initFirebase() {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      const auth = firebase.auth();
      auth.getRedirectResult().catch(error => { if (error?.code !== "auth/no-auth-event") showAuthModal(authErrorMessage(error)); });
      auth.onAuthStateChanged(user => {
        const previousUid = firebaseUser?.uid || lastAuthenticatedUid;
        hydrationRequestId += 1;
        firebaseUser = user || null;
        userHydrated = false;
        hydratedUserId = "";
        hydratingUserId = user?.uid || "";
        dirtyScopes.clear();
        selectedMoodId = "";
        state = cloneState(defaultState);
        ensureWorkspaceHistory();
        if (user) {
          lastAuthenticatedUid = user.uid;
          syncStatus = previousUid && previousUid !== user.uid ? "loading your space" : "loading your space";
          document.documentElement.dataset.theme = state.theme;
          renderAll();
          hydrateUserData(user);
        } else {
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
