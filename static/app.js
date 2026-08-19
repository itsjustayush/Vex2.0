(() => {
  "use strict";

  const firebaseConfig = window.VEX_FIREBASE_CONFIG || {};
  const storageKey = "vex:prototype:workspace";
  const defaultState = {
    theme: "dark",
    pageType: "ruled-single",
    muted: false,
    title: "A softer place to think",
    content: "# A softer place to think\n\nIdeas do not arrive in straight lines. Vex gives them room to wander, connect, and become something useful.\n\n**Try typing** with the keyboard below, or switch to a moodboard when words need a little more space.\n\n`Inline code` · $E = mc^2$",
    mood: [
      { id: "m1", type: "note", color: "yellow", x: 170, y: 110, title: "small sparks", text: "Collect the tiny things before they disappear." },
      { id: "m2", type: "note", color: "pink", x: 460, y: 250, title: "make it playful", text: "A good system should feel like an invitation, not a chore." },
      { id: "m3", type: "note", color: "blue", x: 820, y: 110, title: "next", text: "Turn the loose ideas into one tiny experiment." }
    ]
  };

  let state = loadState();
  let saveTimer = null;
  let toastTimer = null;
  let activeView = window.location.hash === "#app" ? "app" : "landing";
  let syncStatus = "local draft";
  let firebaseDb = null;
  let firebaseUser = null;

  function loadState() {
    try { return { ...defaultState, ...JSON.parse(localStorage.getItem(storageKey) || "{}")} } catch (_) { return { ...defaultState }; }
  }

  function persist() {
    clearTimeout(saveTimer);
    syncStatus = "saving";
    updateSyncLabels();
    saveTimer = setTimeout(() => {
      localStorage.setItem(storageKey, JSON.stringify(state));
      syncStatus = firebaseUser ? "synced" : "saved locally";
      updateSyncLabels();
      tryRemoteSync();
    }, 260);
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

  function updateSyncLabels() {
    document.querySelectorAll("[data-sync-label]").forEach(el => {
      el.textContent = syncStatus === "saving" ? "saving" : syncStatus;
      el.previousElementSibling?.classList.toggle("sync-saving", syncStatus === "saving");
    });
  }

  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    persist();
    showToast(`${theme[0].toUpperCase()}${theme.slice(1)} theme`);
    renderAll();
  }

  function playKeySound(key = "a") {
    if (state.muted) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 130 + ((key.charCodeAt(0) || 2) % 8) * 17;
      gain.gain.setValueAtTime(.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(.035, ctx.currentTime + .008);
      gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .08);
      osc.connect(gain).connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + .09);
    } catch (_) {}
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
        ${mode === "landing" ? `<button class="primary-btn" data-action="open-app">Open Vex ${icon("arrow")}</button>` : `<button class="ghost-btn" data-action="open-landing">Home</button>`}
      </div>
    </header>`;
  }

  function renderSidebar() {
    return `<aside class="sidebar"><div class="sidebar-inner">
      <button class="primary-btn new-page" data-action="new-page">${icon("plus")} New page</button>
      <div class="side-section"><p class="side-label">your space</p>
        <button class="side-item active" data-action="focus-editor"><span class="item-icon">${icon("note")}</span><span>Daily notes</span><small>⌘1</small></button>
        <button class="side-item" data-action="switch-moodboard"><span class="item-icon">${icon("board")}</span><span>Moodboard</span><small>⌘2</small></button>
        <button class="side-item" data-action="coming-soon"><span class="item-icon">${icon("folder")}</span><span>All pages</span><small>3</small></button>
      </div>
      <div class="side-section"><p class="side-label">page style</p>
        <button class="side-item" data-action="set-page-type" data-value="plain"><span class="item-icon">—</span><span>Plain page</span></button>
        <button class="side-item" data-action="set-page-type" data-value="dotted-light"><span class="item-icon">⠿</span><span>Dotted · light</span></button>
        <button class="side-item" data-action="set-page-type" data-value="dotted-dense"><span class="item-icon">⠿</span><span>Dotted · dense</span></button>
      </div>
      <div class="side-note"><strong>Synced by Firebase</strong> Your local draft is always available. Sign in can be re-enabled later for cross-device identity sync.</div>
    </div></aside>`;
  }

  const rows = [
    ["esc","1","2","3","4","5","6","7","8","9","0","-","=","⌫"],
    ["tab","Q","W","E","R","T","Y","U","I","O","P","[","]","\\"],
    ["caps","A","S","D","F","G","H","J","K","L",";","'","↵"],
    ["shift","Z","X","C","V","B","N","M",",",".","/","shift"],
    ["ctrl","alt","⌘","space","⌘","fn","←","↓","→"]
  ];
  function renderKeyboard() {
    return `<div class="keyboard-dock"><div class="keyboard-shell"><div class="keyboard-top"><span>vex / soft press</span><span>${state.muted ? "sound off" : "sound on"}</span></div>${rows.map(row => `<div class="key-row">${row.map(key => `<button class="key ${key === "space" ? "space" : ""} ${["tab","caps","shift","ctrl","alt","fn","⌫","↵"].includes(key) ? "wide-1" : ""}" data-key="${escapeHtml(key)}">${escapeHtml(key)}</button>`).join("")}</div>`).join("")}</div></div>`;
  }

  function renderFormatBar() {
    return `<div class="format-bar">
      <button data-format="bold" title="Bold">${icon("bold")}</button><button data-format="italic" title="Italic"><i>${icon("italic")}</i></button><button data-format="heading" title="Heading">H</button><button data-format="quote" title="Quote">❝</button><span class="divider"></span><button data-format="code" title="Inline code">${icon("code")}</button><button data-format="math" title="LaTeX">∑</button><span class="divider"></span><button data-action="preview-markdown" title="Preview markdown">Preview</button>
    </div>`;
  }

  function renderEditor() {
    return `<section class="editor-stage"><div class="editor-head"><input class="page-title" value="${escapeHtml(state.title)}" aria-label="Page title" /><div class="editor-tools"><button class="pill-btn" data-action="export-page">${icon("download")} <span>Export</span></button></div></div><div class="page-meta"><span>Today · just now</span><div class="page-switcher">${["ruled-single","ruled-double","plain","dotted-light","dotted-dense"].map(type => `<button class="${state.pageType === type ? "active" : ""}" data-action="set-page-type" data-value="${type}">${type.replace("ruled-", "ruled · ").replace("dotted-", "dotted · ")}</button>`).join("")}</div></div><div class="page-card ${pageClass()}"><div class="editor-content" contenteditable="true" spellcheck="true" data-placeholder="Start with a sentence, a question, or a tiny spark…">${formatPreview(state.content)}</div></div>${renderFormatBar()}</section>`;
  }

  function renderMoodboard() {
    return `<section class="editor-stage"><div class="editor-head"><input class="page-title" value="Moodboard" aria-label="Moodboard title" readonly /><div class="editor-tools"><label class="primary-btn">${icon("plus")} Add media<input type="file" accept="image/*,video/*" multiple hidden data-file-upload /></label><button class="pill-btn" data-action="add-note">${icon("note")} <span>Note</span></button></div></div><div class="page-meta"><span>Endless canvas · drag anything anywhere</span><div class="page-switcher"><button class="active">moodboard</button><button data-action="coming-soon">zoom 100%</button></div></div><div class="moodboard" data-moodboard><div class="mood-canvas">${state.mood.map(renderMoodItem).join("")}</div>${state.mood.length === 0 ? `<div class="mood-empty"><div><strong>Your canvas is wide open.</strong>Drop in an image, video, or note to begin.</div></div>` : ""}</div></section>`;
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
    document.getElementById("app").innerHTML = `<div class="landing"><div class="landing-shell">${renderTopbar("landing")}<main><section class="landing-hero"><span class="eyebrow"><b>✦</b> writing, notes & moodboards</span><h1>Make room for <em>good</em> thoughts.</h1><p class="landing-subtitle">A calm, colorful workspace for the thoughts that refuse to sit still. Write in full flow, pin the fragments, and let the connections appear.</p><div class="landing-cta"><button class="primary-btn" data-action="open-app">Start writing ${icon("arrow")}</button><button class="ghost-btn" data-action="scroll-demo">See the workspace <span>↓</span></button></div></section><section class="demo-wrap" id="demo"><div class="demo-frame"><div id="demo-host"></div></div></section><section class="landing-bento"><article class="feature-card"><div class="feature-icon">✺</div><h3>Thoughts, not folders.</h3><p>Start with a blank page, choose a texture, and make your own little corner of the internet.</p></article><article class="feature-card"><div class="feature-icon">⌘</div><h3>Markdown native.</h3><p>Formatting, LaTeX, shortcuts, and a gentle keyboard that makes writing feel tactile.</p></article><article class="feature-card"><div class="feature-icon">◌</div><h3>Endless moodboards.</h3><p>Drop in images, videos, notes, and references without fighting the canvas.</p></article><article class="feature-card"><div class="feature-icon">≈</div><h3>Three moods.</h3><p>Light, dark, and zen. The room changes when you do.</p></article><article class="feature-card"><div class="feature-icon">↗</div><h3>Offline first.</h3><p>Your latest draft lives on this device and is ready for Firebase sync when identity is enabled.</p></article></section></main><footer class="landing-footer"><span>© 2026 Vex. Think in full color.</span><span>Prototype · auth intentionally paused</span></footer></div></div>`;
    const demoHost = document.getElementById("demo-host");
    mountWorkspace(demoHost, { embedded: true });
    document.querySelectorAll("[data-action='scroll-demo']").forEach(btn => btn.addEventListener("click", () => document.getElementById("demo")?.scrollIntoView({ behavior: "smooth" })));
    wireGlobal();
  }

  function renderApp() {
    document.getElementById("app").innerHTML = `<div class="app-shell"><div>${renderTopbar("workspace")}</div><div class="workspace">${renderSidebar()}${state.moodboard ? renderMoodboard() : renderEditor()}</div>${renderKeyboard()}</div>`;
    document.documentElement.dataset.theme = state.theme;
    wireWorkspace(document.getElementById("app"));
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
    document.querySelectorAll("[data-action='toggle-sound']").forEach(btn => btn.addEventListener("click", () => { state.muted = !state.muted; persist(); renderAll(); showToast(state.muted ? "Sound muted" : "Sound on"); }));
    document.querySelectorAll("[data-action='cycle-theme']").forEach(btn => btn.addEventListener("click", () => setTheme(state.theme === "light" ? "dark" : state.theme === "dark" ? "zen" : "light")));
  }

  function wireWorkspace(root) {
    wireGlobal();
    root.querySelectorAll("[data-action='toggle-sidebar']").forEach(btn => btn.addEventListener("click", () => {
      const workspace = root.querySelector(".workspace");
      workspace?.classList.toggle("sidebar-hidden");
      root.querySelector(".app-shell")?.classList.toggle("sidebar-open");
    }));
    root.querySelectorAll("[data-action='focus-editor']").forEach(btn => btn.addEventListener("click", () => { state.moodboard = false; renderApp(); setTimeout(() => document.querySelector(".editor-content")?.focus(), 50); }));
    root.querySelectorAll("[data-action='switch-moodboard']").forEach(btn => btn.addEventListener("click", () => { state.moodboard = true; renderApp(); }));
    root.querySelectorAll("[data-action='new-page']").forEach(btn => btn.addEventListener("click", () => { state.moodboard = false; state.title = "Untitled page"; state.content = ""; persist(); renderApp(); setTimeout(() => document.querySelector(".page-title")?.focus(), 50); }));
    root.querySelectorAll("[data-action='set-page-type']").forEach(btn => btn.addEventListener("click", () => { state.pageType = btn.dataset.value; persist(); renderAll(); }));
    root.querySelectorAll("[data-action='toggle-sound']").forEach(btn => btn.addEventListener("click", () => { state.muted = !state.muted; persist(); renderAll(); showToast(state.muted ? "Sound muted" : "Sound on"); }));
    root.querySelectorAll("[data-action='cycle-theme']").forEach(btn => btn.addEventListener("click", () => setTheme(state.theme === "light" ? "dark" : state.theme === "dark" ? "zen" : "light")));
    root.querySelectorAll("[data-action='coming-soon']").forEach(btn => btn.addEventListener("click", () => showToast("More spaces are coming soon")));
    root.querySelectorAll("[data-action='add-note']").forEach(btn => btn.addEventListener("click", () => { state.mood.push({ id:"m" + Date.now(), type:"note", color:["yellow","pink","blue","green"][state.mood.length % 4], x:180 + state.mood.length * 48, y:160 + state.mood.length * 35, title:"new thought", text:"Double-click to make this yours." }); persist(); renderAll(); }));
    root.querySelectorAll("[data-action='export-page']").forEach(btn => btn.addEventListener("click", exportPage));
    root.querySelectorAll("[data-action='preview-markdown']").forEach(btn => btn.addEventListener("click", () => showToast("Markdown is rendered live as you type")));
    root.querySelectorAll(".page-title:not([readonly])").forEach(input => input.addEventListener("input", e => { state.title = e.target.value; persist(); }));
    const editor = root.querySelector(".editor-content");
    if (editor) {
      editor.addEventListener("input", () => { state.content = editorToMarkdown(editor); persist(); });
      editor.addEventListener("keydown", e => { if (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace") playKeySound(e.key); if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); applyFormat("bold"); } });
    }
    root.querySelectorAll("[data-format]").forEach(btn => btn.addEventListener("click", () => applyFormat(btn.dataset.format)));
    root.querySelectorAll(".key").forEach(key => key.addEventListener("click", () => handleVirtualKey(key)));
    root.querySelectorAll("[data-file-upload]").forEach(input => input.addEventListener("change", e => handleFiles(e.target.files)));
    root.querySelectorAll(".mood-note, .mood-image").forEach(item => enableDrag(item));
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
    state.content = editorToMarkdown(editor); persist(); playKeySound(kind); 
  }

  function handleVirtualKey(keyEl) {
    const key = keyEl.dataset.key;
    keyEl.classList.add("pressed"); setTimeout(() => keyEl.classList.remove("pressed"), 110);
    playKeySound(key);
    const editor = document.querySelector(".editor-content");
    if (!editor || ["tab","caps","shift","ctrl","alt","⌘","fn","←","↓","→"].includes(key)) return;
    editor.focus();
    if (key === "space") document.execCommand("insertText", false, " ");
    else if (key === "⌫") document.execCommand("delete", false);
    else if (key === "↵") document.execCommand("insertText", false, "\n");
    else document.execCommand("insertText", false, key.length === 1 ? key.toLowerCase() : key);
    state.content = editorToMarkdown(editor); persist();
  }

  function exportPage() {
    const blob = new Blob([`# ${state.title}\n\n${state.content}`], { type:"text/markdown" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href=url; a.download=(state.title || "vex-page").toLowerCase().replace(/\s+/g,"-") + ".md"; a.click(); URL.revokeObjectURL(url); showToast("Markdown page exported");
  }

  function handleFiles(files) {
    [...files].forEach(file => {
      if (!file.type.startsWith("image/")) { showToast("Image uploads are live; video preview comes next"); return; }
      const reader = new FileReader();
      reader.onload = e => { state.mood.push({ id:"m" + Date.now() + Math.random(), type:"image", src:e.target.result, name:file.name, x:220 + state.mood.length * 35, y:190 + state.mood.length * 26 }); persist(); renderApp(); };
      reader.readAsDataURL(file);
    });
  }

  function enableDrag(element) {
    let startX, startY, originX, originY;
    element.addEventListener("pointerdown", e => { if (e.target.closest("button")) return; element.setPointerCapture(e.pointerId); const item = state.mood.find(x => x.id === element.dataset.moodId); if (!item) return; startX=e.clientX;startY=e.clientY;originX=item.x;originY=item.y; element.addEventListener("pointermove", move); element.addEventListener("pointerup", up, { once:true }); });
    function move(e) { const item = state.mood.find(x => x.id === element.dataset.moodId); if (!item) return; item.x = originX + e.clientX - startX; item.y = originY + e.clientY - startY; element.style.left=item.x+"px"; element.style.top=item.y+"px"; }
    function up() { element.removeEventListener("pointermove", move); persist(); }
  }

  async function tryRemoteSync() {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      firebaseDb = firebase.firestore();
      firebaseUser = firebase.auth().currentUser;
      if (!firebaseUser) { syncStatus = "saved locally"; updateSyncLabels(); return; }
      await firebaseDb.collection("files").doc(`vex-prototype-${firebaseUser.uid}`).set({ id:`vex-prototype-${firebaseUser.uid}`, user_id:firebaseUser.uid, project_id:"vex-prototype", title:state.title, content:state.content, page_type:state.pageType, updated_at:new Date().toISOString() }, { merge:true });
      syncStatus = "synced"; updateSyncLabels();
    } catch (_) { syncStatus = "saved locally"; updateSyncLabels(); }
  }

  function initFirebase() {
    if (!firebaseConfig.apiKey || !window.firebase || !firebase.apps) return;
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      firebase.auth().onAuthStateChanged(user => { firebaseUser = user || null; if (user) tryRemoteSync(); });
    } catch (_) {}
  }

  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "1") { e.preventDefault(); state.moodboard=false; renderApp(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "2") { e.preventDefault(); state.moodboard=true; renderApp(); }
  });

  initFirebase();
  renderAll();
})();
