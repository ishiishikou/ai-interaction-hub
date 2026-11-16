"use strict";
const $ = (id) => document.getElementById(id);
const timeline = $("timeline");
const picker = $("sessions");
const md = window.markdownit({
  html: false, linkify: true, breaks: true, typographer: true,
  highlight: (str, lang) => {
    if (!window.hljs || !lang || !window.hljs.getLanguage(lang)) return "";
    try { return window.hljs.highlight(str, {language: lang, ignoreIllegals: true}).value; }
    catch { return ""; }
  }
});
if (window.katex && window.texmath) {
  md.use(window.texmath, {engine: window.katex, delimiters: "dollars",
    katexOptions: {throwOnError: false, trust: false, strict: "warn"}});
}
const state = {sessionId: null, signature: "", fetching: false, needsRefresh: false};
const roles = {user:"あなた",chatgpt:"ChatGPT",codex:"Codex"};
const icons = {chatgpt:"✦",codex:">_"};

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function prettyTime(iso) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("ja-JP", {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : iso;
}
async function fetchJSON(url) {
  const r = await fetch(url,{cache:"no-store"});
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent; button.textContent = "コピーしました";
    setTimeout(() => button.textContent = original, 1300);
  } catch { button.textContent = "コピー失敗"; }
}
function makeMessage(event) {
  const item = node("article","message " + event.author + (event.kind==="raw_log"?" raw_log":""));
  item.dataset.seq = event.seq;
  if (event.author !== "user") item.append(node("div","avatar", icons[event.author] || "?"));
  const body = node("div","message-content");
  const meta = node("div","meta");
  meta.append(node("span","name",roles[event.author] || event.author));
  const t = node("time",null,prettyTime(event.created_at));
  t.dateTime = event.created_at; meta.append(t);
  if (event.kind !== "message") meta.append(node("span","kind",({
    delegation:"Codexへの依頼",result:"返却結果",raw_log:"生ログ",status:"状態"
  })[event.kind] || event.kind));
  body.append(meta);
  if (event.kind !== "raw_log") {
    const content = node("div","markdown");
    if (event.content_format === "markdown") content.innerHTML = md.render(event.content);
    else if (event.content_format === "json") {
      try { content.append(node("pre",null,JSON.stringify(JSON.parse(event.content),null,2))); }
      catch { content.append(node("pre",null,event.content)); }
    } else content.append(node("pre",null,event.content));
    body.append(content);
  }
  const actions = node("div","actions");
  const copy = node("button","mini-btn","全文コピー");
  copy.type = "button"; copy.addEventListener("click",()=>copyText(event.content,copy));
  actions.append(copy);
  if (event.rich) {
    const richButton = node("button","mini-btn","構造データをコピー");
    richButton.type="button";
    richButton.addEventListener("click",()=>copyText(JSON.stringify(event.rich,null,2),richButton));
    actions.append(richButton);
  }
  body.append(actions);
  const raw = node("details","raw");
  const label = event.kind === "raw_log" ? "ログ全文を表示" : "元テキスト全文を表示（Markdown未変換）";
  raw.append(node("summary",null,label));
  raw.append(node("pre",null,event.content));
  body.append(raw);
  item.append(body);
  return item;
}
async function loadSessions() {
  const data = await fetchJSON("/api/sessions");
  const chosen = state.sessionId;
  picker.replaceChildren();
  for (const s of data.sessions || []) {
    const option = node("option",null,s.title + " (" + s.message_count + ")");
    option.value = s.id; picker.append(option);
  }
  if (!data.sessions?.length) {
    picker.append(node("option",null,"まだ記録がありません"));
    state.sessionId=null; timeline.replaceChildren(node("div","empty","チャットからAIRに記録すると、ここに表示されます。"));
    return;
  }
  state.sessionId = data.sessions.some(x=>x.id===chosen)?chosen:data.sessions[0].id;
  picker.value=state.sessionId;
}
async function loadTimeline() {
  if (!state.sessionId) return;
  if (state.fetching) { state.needsRefresh = true; return; }
  const targetSession = state.sessionId;
  state.fetching=true;
  try {
    let after=0, entries=[], page;
    do {
      const data = await fetchJSON("/api/sessions/"+encodeURIComponent(targetSession)+"/events?after="+after+"&limit=500");
      page=data.events || []; entries.push(...page);
      if(page.length) after=page[page.length-1].seq;
      if(entries.length>10000) throw new Error("一度に表示できる記録件数を超えました");
    } while(page.length===500);
    if (targetSession !== state.sessionId) return;
    const signature=targetSession+":"+entries.length+":"+after;
    if(state.signature!==signature) {
      state.signature=signature;
      const atBottom=timeline.scrollHeight<=window.innerHeight+window.scrollY+150;
      timeline.replaceChildren(...entries.map(makeMessage));
      if(!entries.length) timeline.append(node("div","empty","このセッションにはまだ記録がありません。"));
      $("count").textContent=String(entries.length);
      if(atBottom && entries.length) window.scrollTo({top:document.body.scrollHeight,behavior:"instant"});
    }
    $("updated").textContent="更新 "+new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
  } catch(error) {
    if (targetSession === state.sessionId) {
      state.signature = "";
      timeline.replaceChildren(node("div","empty","読み込み失敗: "+error.message));
    }
  } finally {
    state.fetching=false;
    if (state.needsRefresh) { state.needsRefresh=false; loadTimeline(); }
  }
}
async function refresh() {
  if(state.fetching) return;
  try { await loadSessions(); await loadTimeline(); }
  catch(e) { state.signature=""; timeline.replaceChildren(node("div","empty","接続できません: "+e.message)); }
}
picker.addEventListener("change",()=>{state.sessionId=picker.value;state.signature="";loadTimeline();});
$("reload").addEventListener("click",refresh);
refresh();
setInterval(refresh,4500);
