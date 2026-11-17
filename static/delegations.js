"use strict";
(() => {
  const el = (id) => document.getElementById(id);
  const viewState = {session: "", cursor: null, listToken: 0, listBusy: false, detailToken: 0, scroll: 0, count: 0};
  const mk = (tag, cls, value) => {
    const item = document.createElement(tag);
    if (cls) item.className = cls;
    if (value !== undefined) item.textContent = value;
    return item;
  };
  const destination = delegationRecipient;
  function isRequestsRoute() { return location.hash !== "#history"; }
  function updateTabs(showRequests) {
    el("requests-pane").hidden = !showRequests;
    el("history-pane").hidden = showRequests;
    for (const [id, active] of [["requests-tab", showRequests], ["history-tab", !showRequests]]) {
      const tab = el(id);
      tab.classList.toggle("is-active", active);
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (!showRequests) window.dispatchEvent(new Event("ai-view-history"));
  }
  function renderCard(record) {
    const button = mk("button", "request-card");
    button.type = "button";
    button.dataset.seq = String(record.seq);
    button.setAttribute("aria-label", destination(record) + "への依頼原文を表示: " + record.session_title);
    const top = mk("div", "request-card-top");
    top.append(mk("strong", "request-target", destination(record)));
    top.append(mk("time", "request-time", prettyTime(record.created_at)));
    button.append(top);
    button.append(mk("div", "request-session-name", record.session_title));
    button.append(mk("p", "request-preview", record.excerpt.trim() || "（本文が空の依頼）"));
    const bottom = mk("div", "request-card-foot");
    bottom.append(mk("span", "request-count-text", record.characters.toLocaleString("ja-JP") + "文字 · 記録済み"));
    bottom.append(mk("span", "request-action", "依頼原文を開く →"));
    button.append(bottom);
    button.addEventListener("click", () => {
      viewState.scroll = window.scrollY;
      location.hash = "request/" + record.seq;
    });
    return button;
  }
  async function loadSessions() {
    try {
      const result = await fetchJSON("/api/sessions");
      const filter = el("request-session");
      const old = filter.value;
      filter.replaceChildren(new Option("すべての登録チャット", ""));
      for (const session of result.sessions || []) {
        filter.append(new Option(session.title, session.id));
      }
      filter.value = [...filter.options].some(x => x.value === old) ? old : "";
      viewState.session = filter.value;
    } catch {
      // The list endpoint can still be used if the session index is temporarily unavailable.
    }
  }
  async function loadList(append = false) {
    if (viewState.listBusy && append) return;
    const token = append ? viewState.listToken : ++viewState.listToken;
    viewState.listBusy = true;
    const list = el("request-list");
    const more = el("request-more");
    const targetCount = append ? 40 : Math.max(40, viewState.count);
    // Preserve the same visible card when a refresh inserts new entries above it.
    const topCard = !append && !el("request-list-view").hidden ?
      [...list.querySelectorAll(".request-card")].find(card => card.getBoundingClientRect().bottom > 130) : null;
    const anchor = topCard && {seq: topCard.dataset.seq, top: topCard.getBoundingClientRect().top};
    if (!append && viewState.count === 0) {
      list.replaceChildren(mk("p", "request-hint", "依頼の記録を読み込んでいます…"));
    }
    more.disabled = true;
    try {
      const entries = [];
      let cursor = append ? viewState.cursor : null;
      do {
        const params = new URLSearchParams({limit: String(Math.min(100, targetCount - entries.length))});
        if (viewState.session) params.set("session", viewState.session);
        if (cursor) params.set("before", String(cursor));
        const response = await fetchJSON("/api/delegations?" + params);
        if (token !== viewState.listToken) return;
        entries.push(...(response.delegations || []));
        cursor = response.next_before;
      } while (cursor && entries.length < targetCount);
      if (!append) {
        list.replaceChildren();
        viewState.count = 0;
      }
      const cards = entries.map(renderCard);
      list.append(...cards);
      viewState.count += cards.length;
      viewState.cursor = cursor;
      more.hidden = !cursor;
      el("request-count").textContent = viewState.count ? viewState.count + "件表示" : "";
      if (!viewState.count) {
        list.replaceChildren(mk("p", "request-hint", "登録された依頼はまだありません。依頼原文が記録されたタスクだけが表示されます。"));
      }
      if (anchor && !append && !el("request-list-view").hidden) {
        const retained = [...list.querySelectorAll(".request-card")].find(card => card.dataset.seq === anchor.seq);
        if (retained) window.scrollBy(0, retained.getBoundingClientRect().top - anchor.top);
      }
      el("updated").textContent = "取得 " + new Date().toLocaleTimeString("ja-JP", {hour:"2-digit",minute:"2-digit"});
    } catch (error) {
      if (token === viewState.listToken) {
        if (viewState.count === 0) list.replaceChildren();
        const note = mk("p", "request-hint request-error", "依頼を取得できません: " + error.message);
        list.append(note);
        if (!viewState.count) more.hidden = true;
      }
    } finally {
      if (token === viewState.listToken) {
        viewState.listBusy = false;
        more.disabled = false;
      }
    }
  }
  function addProperty(container, key, value) {
    const row = mk("div", "detail-property");
    row.append(mk("dt", null, key));
    row.append(mk("dd", null, String(value)));
    container.append(row);
  }
  function relatedLabel(entry, idx, length) {
    const labels = {retry:"再試行",followup:"追記",revision:"修正",initial:"初回依頼"};
    const name = labels[entry.revision_type];
    if (name) return name + (idx === length - 1 && idx !== 0 ? "（最新）" : "");
    if (idx === 0) return "最古の記録";
    if (idx === length - 1) return "最新の記録";
    return "依頼 " + (idx + 1);
  }
  function buildDetail(result) {
    const record = result.delegation;
    const wrapper = mk("article", "request-detail-card");
    const heading = mk("div", "detail-heading");
    heading.append(mk("span", "detail-eyebrow", "AIへの依頼原文"));
    heading.append(mk("h1", null, destination(record) + "への依頼"));
    heading.append(mk("p", "detail-session", record.session_title));
    wrapper.append(heading);
    const properties = mk("dl", "detail-properties");
    addProperty(properties, "記録日時", prettyTime(record.created_at));
    addProperty(properties, "記録元", record.source);
    addProperty(properties, "識別子", "#" + record.seq);
    wrapper.append(properties);
    const caution = mk("p", "request-caution", "これは保存された依頼文です。相手AIへの到達・処理完了を証明するものではありません。");
    wrapper.append(caution);
    if (result.related && result.related.length > 1) {
      const selector = mk("div", "detail-versions");
      selector.append(mk("h2", null, "同じタスクの依頼履歴"));
      const choices = mk("div", "version-buttons");
      result.related.forEach((entry, i) => {
        const option = mk("button", "version-button" + (entry.seq === record.seq ? " selected" : ""), relatedLabel(entry, i, result.related.length));
        option.type = "button";
        option.disabled = entry.seq === record.seq;
        option.addEventListener("click", () => { location.hash = "request/" + entry.seq; });
        choices.append(option);
      });
      selector.append(choices);
      wrapper.append(selector);
    }
    const toolbar = mk("div", "request-detail-toolbar");
    toolbar.append(mk("h2", null, "依頼全文"));
    const toggle = mk("div", "format-toggle");
    const plain = mk("button", "format-button selected", "原文");
    const formatted = mk("button", "format-button", "整形");
    plain.type = formatted.type = "button";
    toggle.append(plain, formatted);
    toolbar.append(toggle);
    wrapper.append(toolbar);
    const raw = mk("pre", "request-full-text", record.content);
    const rich = mk("div", "markdown request-rich");
    let rendered = false;
    if (record.content_format !== "markdown") formatted.disabled = true;
    rich.hidden = true;
    plain.addEventListener("click", () => {
      raw.hidden = false; rich.hidden = true;
      plain.classList.add("selected"); formatted.classList.remove("selected");
    });
    formatted.addEventListener("click", () => {
      if (!rendered) {
        rich.innerHTML = md.render(record.content);
        rendered = true;
      }
      raw.hidden = true; rich.hidden = false;
      formatted.classList.add("selected"); plain.classList.remove("selected");
    });
    wrapper.append(raw, rich);
    const copy = mk("button", "request-copy", "原文を全文コピー");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(record.content, copy));
    wrapper.append(copy);
    wrapper.append(mk("p", "request-bottom-note", "原文は改変せずに表示・コピーします。整形表示でもコピーするのは保存された原文です。"));
    return wrapper;
  }
  async function openDetail(seq) {
    const token = ++viewState.detailToken;
    const destinationElement = el("request-detail");
    destinationElement.replaceChildren(mk("p", "request-hint", "依頼原文を取得しています…"));
    try {
      const result = await fetchJSON("/api/delegations/" + seq);
      if (token !== viewState.detailToken || location.hash !== "#request/" + seq) return;
      destinationElement.replaceChildren(buildDetail(result));
    } catch (error) {
      if (token !== viewState.detailToken) return;
      destinationElement.replaceChildren(mk("p", "request-hint request-error", "原文を表示できません: " + error.message));
    }
  }
  function route() {
    const isHistory = location.hash === "#history";
    updateTabs(!isHistory);
    const detailMatch = !isHistory && /^#request\/([1-9]\d*)$/.exec(location.hash);
    el("request-list-view").hidden = Boolean(detailMatch);
    el("request-detail-view").hidden = !detailMatch;
    if (detailMatch) {
      window.scrollTo({top: 0, behavior: "instant"});
      openDetail(Number(detailMatch[1]));
    } else if (!isHistory) {
      ++viewState.detailToken;
      requestAnimationFrame(() => window.scrollTo({top: viewState.scroll, behavior: "instant"}));
    }
  }
  el("requests-tab").addEventListener("click", () => { location.hash = "requests"; });
  el("history-tab").addEventListener("click", () => { location.hash = "history"; });
  el("request-back").addEventListener("click", () => { location.hash = "requests"; });
  el("request-session").addEventListener("change", e => {
    viewState.session = e.target.value;
    viewState.cursor = null;
    viewState.count = 0;
    viewState.scroll = 0;
    el("request-list").replaceChildren();
    window.scrollTo({top: 0, behavior: "instant"});
    loadList();
  });
  el("request-more").addEventListener("click", () => loadList(true));
  el("reload").addEventListener("click", () => {
    if (!isRequestsRoute()) return;
    if (location.hash.startsWith("#request/")) {
      const seq = Number(location.hash.slice(9));
      if (Number.isSafeInteger(seq) && seq > 0) openDetail(seq);
    } else loadList();
  });
  window.addEventListener("hashchange", route);
  // Direct links must work even if the session index or the list API is slow.
  route();
  loadSessions().then(() => loadList());
  window.setInterval(() => {
    if (document.hidden || !isRequestsRoute() || location.hash.startsWith("#request/")) return;
    if (window.scrollY > 120 || viewState.listBusy) return;
    loadList(false);
  }, 15000);
})();
