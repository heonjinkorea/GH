/* GH 산업단지 업무편람 도우미 — 서버/AI 없이 브라우저에서 동작하는 검색형 챗봇 */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let M = null;            // manual.json
const SEC = new Map();   // id → section (+ part, chapter 참조)
const CH = new Map();    // id → chapter
let ORDER = [];          // 전체 절 순서
let INDEX = null;

/* 업무 단계(라이프사이클)로 보는 Part */
const STAGE_PARTS = [2, 3, 4, 5, 6, 7, 8];

/* 질문에서 지워도 되는 말 */
const STOP = new Set(("어떻게 어떤 어디 언제 무엇 뭐 뭘 뭔가 무슨 왜 누가 누구 해야 하나요 하나 하는 하면 할까 할까요 해요 합니까 " +
  "인가요 있나요 있어 있는 되나요 되는 됩니다 알려줘 알려주세요 알려 주세요 궁금 궁금해 질문 그리고 그러면 그럼 " +
  "이제 지금 다음 다음에 이후 이후에 그다음 끝나면 끝났 끝났는데 완료 완료되면 마치면 다했 했는데 됐는데 " +
  "들어왔 들어왔는데 들어왔어 왔는데 받았는데 요청 업무 일 것 수 등 및 관련 대해 대한 내가 제가 우리 저희 좀 " +
  "필요 필요한 방법 처리 진행 해야하나요 해야하는지 해야돼 해야해").split(/\s+/));

/* 조사·어미 떼기 */
const SUFFIX = ["으로부터", "에서는", "에게서", "이라고", "하려면", "하려고", "했는데", "됐는데", "왔는데", "하는데", "해야", "하면",
  "으로", "에서", "에게", "까지", "부터", "처럼", "이랑", "하고", "이나", "이면", "인데", "할때", "하는", "되는", "되면", "했어", "해요",
  "은", "는", "이", "가", "을", "를", "에", "의", "로", "와", "과", "도", "만", "랑", "요"];

/* 줄임말·동의어 */
const SYN = {
  "환평": "환경영향평가", "교평": "교통영향평가", "재해평가": "재해영향평가", "주민공람": "주민의견청취 공람",
  "공청회": "주민의견청취 공청회", "인허가": "인·허가 승인", "분양": "처분 공급 입주", "수용": "재결 수용 토지보상",
  "보상금": "보상금 지급 공탁", "감정평가": "보상평가 감정평가", "준공검사": "준공 준공인가", "착공신고": "착공계",
  "토지보상": "보상", "산단": "산업단지", "산단계획": "산업단지계획", "심의위원회": "심의 위원회", "타당성조사": "타당성",
  "투심": "내부투자심의회", "도의회": "지방의회 의결", "시의회": "지방의회 의결", "ve": "설계VE 경제성", "입찰": "발주 계약",
  "하자": "하자 보증 하자관리", "조성원가": "조성원가 원가", "분양가": "공급가격 조성원가", "업무흐름": "업무흐름도",
};

/* 질문 의도 */
const NEXT_RE = /(다음|이후|그다음|끝나면|끝났|끝내면|완료되면|완료했|마치면|마쳤|다\s?했|후에|뒤에|그러고)/;
const DOC_RE = /(서류|구비|제출|첨부|양식|서식)/;
const WHO_RE = /(누가|누구|담당|부서|기관|협의처)/;
const WHEN_RE = /(언제|기간|며칠|일\s?이내|기한|소요|일정)/;

/* ---------------------------------------------------------------- 텍스트 처리 */
function norm(s) { return s.toLowerCase().replace(/[^0-9a-z가-힣]+/g, " ").trim(); }
function stripSuffix(w) {
  for (const s of SUFFIX) if (w.length > s.length + 1 && w.endsWith(s)) return w.slice(0, -s.length);
  return w;
}
function grams(w) {
  const out = [];
  if (/^[가-힣]+$/.test(w)) {
    if (w.length === 1) return out;
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
  } else if (w.length >= 2) out.push(w);
  return out;
}
function tokenize(s) { return norm(s).split(" ").flatMap(grams); }

function queryTerms(q) {
  let words = norm(q).split(" ").filter(Boolean).map(stripSuffix).filter((w) => w.length > 0 && !STOP.has(w));
  const extra = [];
  for (const w of words) for (const k in SYN) if (w.includes(k)) extra.push(...SYN[k].split(" "));
  words = [...new Set([...words, ...extra.map(norm)])].filter((w) => w && !STOP.has(w));
  return words;
}

/* ---------------------------------------------------------------- 검색 색인 (BM25, 2글자 단위) */
function buildIndex() {
  const docs = [];
  for (const s of ORDER) {
    const title = `${s.title} ${s.ch.title}`;
    docs.push({ s, tf: count(tokenize(s.text)), ttf: count(tokenize(title)), len: 0 });
  }
  const df = new Map();
  let total = 0;
  for (const d of docs) {
    d.len = [...d.tf.values()].reduce((a, b) => a + b, 0) || 1;
    total += d.len;
    for (const t of new Set([...d.tf.keys(), ...d.ttf.keys()])) df.set(t, (df.get(t) || 0) + 1);
  }
  return { docs, df, avg: total / docs.length, N: docs.length };
}
function count(arr) { const m = new Map(); for (const t of arr) m.set(t, (m.get(t) || 0) + 1); return m; }

function search(q, limit = 8, preferStage = false) {
  const words = queryTerms(q);
  const toks = [...new Set(words.flatMap(grams))];
  if (!toks.length) return { words, hits: [] };
  const { docs, df, avg, N } = INDEX;
  const k1 = 1.2, b = 0.75;
  const hits = [];
  for (const d of docs) {
    let sc = 0, matched = 0;
    for (const t of toks) {
      const n = df.get(t) || 0;
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const f = d.tf.get(t) || 0;
      const tt = d.ttf.get(t) || 0;
      if (f || tt) matched++;
      if (f) sc += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg));
      if (tt) sc += idf * 2.2;
    }
    if (!sc) continue;
    // 질문 단어가 통째로 들어있으면 가산점
    const hay = (d.s.title + " " + d.s.ch.title).replace(/\s/g, "");
    const st = d.s.title.replace(/\s|\(.*\)/g, "");
    for (const w of words) {
      if (w.length < 2) continue;
      if (hay.includes(w)) sc += 4;
      if (st.includes(w)) sc += 8 * w.length / st.length;   // 제목이 질문과 딱 맞을수록 우대
    }
    sc *= 0.5 + matched / toks.length;           // 많은 단어가 맞을수록 우대
    if (d.s.part.num === 0) sc *= 0.6;            // 편람 소개는 낮춤
    if (d.s.title === "업무흐름도") sc *= 0.85;
    if (preferStage) sc *= STAGE_PARTS.includes(d.s.part.num) ? 1.3 : 0.6;   // "다음엔?" 질문은 실무 단계 우선
    hits.push({ s: d.s, score: sc });
  }
  hits.sort((a, b) => b.score - a.score);
  return { words, hits: hits.slice(0, limit) };
}

/* 본문 블록 중 질문과 가장 맞는 부분 뽑기 */
function bestBlocks(s, words, n = 3) {
  const box = document.createElement("div");
  box.innerHTML = s.html;
  const blocks = [...box.children];
  const toks = new Set(words.flatMap(grams));
  const scored = blocks.map((el, i) => {
    const t = el.textContent;
    let sc = 0;
    for (const g of tokenize(t)) if (toks.has(g)) sc++;
    for (const w of words) if (w.length >= 2 && t.replace(/\s/g, "").includes(w)) sc += 3;
    if (el.tagName === "DIV" && el.classList.contains("tw")) sc *= 0.7;
    return { el, i, sc: sc / Math.sqrt(1 + t.length / 120) };
  }).filter((x) => x.el.textContent.trim());
  let pick = scored.filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, n);
  if (!pick.length) pick = scored.slice(0, n);
  pick.sort((a, b) => a.i - b.i);
  return pick.map((x) => highlight(x.el.outerHTML, words)).join("");
}

function highlight(html, words) {
  const ws = words.filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);
  if (!ws.length) return html;
  const re = new RegExp("(" + ws.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g");
  return html.replace(/>([^<]+)</g, (m, t) => ">" + t.replace(re, "<mark>$1</mark>") + "<");
}

/* ---------------------------------------------------------------- 업무 순서 */
function isMeta(s) { return /^(업무흐름도|체크리스트|개요)$/.test(s.title) || /check-?list/i.test(s.title); }
function nextInChapter(s) {
  const arr = s.ch.sections;
  for (let i = arr.indexOf(s) + 1; i < arr.length; i++) if (!isMeta(arr[i])) return arr[i];
  return null;
}
function nextChapter(ch) {
  const part = ch.part;
  let i = part.chapters.indexOf(ch) + 1;
  for (; i < part.chapters.length; i++) {
    const c = part.chapters[i];
    if (!/이해$|체크리스트/.test(c.title)) return c;
  }
  // 다음 Part(단계)의 첫 실무 장
  const pi = M.parts.indexOf(part);
  const np = M.parts[pi + 1];
  if (np && STAGE_PARTS.includes(np.num)) return np.chapters.find((c) => !/이해$/.test(c.title)) || np.chapters[0];
  return null;
}
function firstWork(ch) { return ch.sections.find((x) => !isMeta(x)) || ch.sections[0]; }
function flowOf(ch) { return ch.sections.find((x) => x.title.includes("업무흐름도")); }
function checklistOf(part) {
  const c = part.chapters.find((c) => c.title.includes("체크리스트"));
  return c ? c.sections[0] : null;
}
function laws(s) {
  const m = s.text.match(/「[^」]{2,40}」(\s*제\s*\d+조(의\d+)?(\s*제\s*\d+항)?)?/g) || [];
  return [...new Set(m.map((x) => x.replace(/\s+/g, " ")))].slice(0, 6);
}
function summary(s, n = 90) {
  const t = s.text.replace(/\s+/g, " ").replace(/ \/ /g, " · ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function T(s) {
  if (s.title !== "개요") return s.title;
  return /체크리스트/.test(s.ch.title) ? `${s.part.title} 체크리스트` : `${s.ch.title} (개요)`;
}
function path(s) { return `Part ${s.part.num}. ${s.part.title} › ${s.ch.num}. ${s.ch.title}`; }

/* ---------------------------------------------------------------- 챗봇 답변 */
function answer(q) {
  const wantNext = NEXT_RE.test(q);
  const { words, hits } = search(q, 6, wantNext);
  if (!hits.length) {
    return `<div class="bot"><p class="nohit">편람에서 "<b>${esc(q)}</b>"와 맞는 내용을 찾지 못했어요.</p>
      <p>이렇게 해 보세요.</p><ul><li>업무 이름으로 짧게 물어보세요. 예: <i>보상계획 공고</i>, <i>준공인가</i>, <i>입주계약</i></li>
      <li><a href="#/flow">🧭 업무 흐름</a>에서 지금 단계를 골라 보세요.</li></ul></div>`;
  }
  const top = hits[0].s;
  let h = `<div class="bot">`;

  // 단계 표시
  h += `<div class="crumb">${esc(path(top))}</div>`;
  if (STAGE_PARTS.includes(top.part.num)) {
    h += `<div class="stage">${STAGE_PARTS.map((n) => {
      const p = M.parts.find((x) => x.num === n);
      return `<span class="${n === top.part.num ? "on" : ""}">${esc(p.title)}</span>`;
    }).join("<b style='color:#aab'>›</b>")}</div>`;
  }

  const nxt = nextInChapter(top);
  const nch = nextChapter(top.ch);

  if (wantNext) {
    h += `<h3>✅ 현재 업무: ${esc(top.num)} ${esc(T(top))}</h3>`;
    h += `<h5>👉 그다음에 할 일</h5><div class="next">`;
    if (nxt) h += card("같은 업무 안의 다음 절차", nxt);
    if (nch) h += card("다음 업무 단계", firstWork(nch), nch.title);
    if (!nxt && !nch) h += `<div class="card"><div class="t">이 장의 마지막 절차예요.</div><div class="d">아래 체크리스트로 빠진 것이 없는지 확인하세요.</div></div>`;
    h += `</div>`;
    const target = nxt || (nch && firstWork(nch));
    if (target) {
      h += `<h5>📌 ${esc(T(target))} — 주요 내용</h5><div class="excerpt content">${bestBlocks(target, words.length ? words : [target.title], 3)}</div>`;
    }
    h += `<h5>📖 지금 단계(${esc(T(top))}) 관련 내용</h5><div class="excerpt content">${bestBlocks(top, words, 2)}</div>`;
  } else {
    h += `<h3>📖 ${esc(top.num)} ${esc(T(top))}</h3>`;
    let tip = "";
    if (DOC_RE.test(q)) tip = "구비서류·양식은 본문의 표와 원문 페이지에서 함께 확인하세요.";
    else if (WHO_RE.test(q)) tip = "협의기관·부서는 Part 9 「관계기관 및 주요부서 등 역할관리」도 참고하세요.";
    else if (WHEN_RE.test(q)) tip = "기간·일정은 Part 9 「사업일정 관리」에 단계별로 정리돼 있어요.";
    if (tip) h += `<p class="crumb">💡 ${tip}</p>`;
    h += `<div class="excerpt content">${bestBlocks(top, words, 3)}</div>`;
  }

  h += `<div class="btns"><a class="btn pri" href="#/s/${top.id}">전체 내용 보기</a>
        <button class="btn" data-page="${top.page}">📄 원문 ${top.page}쪽</button>`;
  const fl = flowOf(top.ch);
  if (fl && fl !== top) h += `<a class="btn" href="#/s/${fl.id}">🔀 이 업무 흐름도</a>`;
  const ck = checklistOf(top.part);
  if (ck) h += `<a class="btn" href="#/s/${ck.id}">☑ ${esc(top.part.title)} 체크리스트</a>`;
  h += `</div>`;

  // 흐름도 바로 보여주기
  if (fl && fl !== top && !wantNext) {
    h += `<div class="flowbox content"><b>🔀 ${esc(top.ch.title)} 업무흐름도</b>${fl.html}</div>`;
  }

  if (!wantNext && (nxt || nch)) {
    h += `<h5>👉 이 업무 다음에는</h5><div class="next">`;
    if (nxt) h += card("다음 절차", nxt);
    if (nch) h += card("다음 업무 단계", firstWork(nch), nch.title);
    h += `</div>`;
  }

  const lw = laws(top);
  if (lw.length) h += `<h5>⚖ 관련 법령</h5><div class="law">${lw.map(esc).join(" · ")}</div>`;

  const others = hits.slice(1, 5).filter((x) => x.score > hits[0].score * 0.25);
  if (others.length) {
    h += `<h5>🔎 함께 볼 만한 내용</h5><ul class="others">${others.map((x) =>
      `<li><a href="#/s/${x.s.id}">${esc(x.s.num)} ${esc(T(x.s))}</a> <small>${esc(x.s.part.title)} › ${esc(x.s.ch.title)} · ${x.s.page}쪽</small></li>`).join("")}</ul>`;
  }
  h += `</div>`;
  return h;
}

function card(k, s, chTitle) {
  return `<a class="card" href="#/s/${s.id}"><div class="k">${esc(k)}</div>
    <div class="t">${esc(chTitle ? chTitle + " › " : "")}${esc(T(s))}</div><div class="d">${esc(summary(s, 70))}</div></a>`;
}

/* ---------------------------------------------------------------- 화면 */
const CHIPS = [
  "신규 사업 후보지는 어떻게 검토하나요?",
  "입지수요조사 방법",
  "타당성검토 끝나면 다음엔 뭐 해?",
  "주민의견청취 공고 기간",
  "보상계획 공고 및 열람",
  "수용재결 신청 절차",
  "착공계 검토할 때 확인할 것",
  "준공인가 신청",
  "조성원가 산정 방법",
  "입주계약 체결 절차",
  "환경영향평가 협의내용 이행",
  "구조고도화사업이란?",
];
let chatLog = [];

function viewChat() {
  setTab("chat");
  $("#main").innerHTML = `<div class="chat">
    <div class="hero"><h1>무엇이든 물어보세요</h1>
      <p>업무편람에서 관련 내용을 찾아 보여주고, <b>그다음에 할 일</b>까지 알려드려요.</p></div>
    <form class="ask" id="askForm"><input id="q" autocomplete="off" placeholder="예) 보상계획 공고는 어떻게 하나요? / 산업단지계획 승인 났는데 다음엔?">
      <button>질문</button></form>
    <div class="chips">${CHIPS.map((c) => `<button class="chip">${esc(c)}</button>`).join("")}</div>
    <div class="msgs" id="msgs">${chatLog.join("")}</div></div>`;
  $("#askForm").onsubmit = (e) => { e.preventDefault(); ask($("#q").value); };
  $("#main").querySelectorAll(".chip").forEach((b) => (b.onclick = () => ask(b.textContent)));
  $("#q").focus();
}

function ask(q) {
  q = q.trim();
  if (!q) return;
  const html = `<div class="me">${esc(q)}</div>` + answer(q);
  chatLog.push(html);
  const box = $("#msgs");
  const wrap = document.createElement("div");
  wrap.style.display = "contents";
  wrap.innerHTML = html;
  box.appendChild(wrap);
  $("#q").value = "";
  wrap.firstElementChild.scrollIntoView({ behavior: "smooth", block: "start" });
}

function viewSection(id) {
  const s = SEC.get(id);
  if (!s) return viewChat();
  setTab("read");
  const i = ORDER.indexOf(s);
  const prev = ORDER[i - 1], next = ORDER[i + 1];
  const fl = flowOf(s.ch);
  const ck = checklistOf(s.part);
  $("#main").innerHTML = `<article class="doc">
    <div class="crumb">${esc(path(s))}</div>
    <h1>${esc(s.num)} ${esc(T(s))}</h1>
    <div class="tools">
      <button class="btn" data-page="${s.page}">📄 원문 ${s.page}쪽 보기</button>
      ${fl && fl !== s ? `<a class="btn" href="#/s/${fl.id}">🔀 업무흐름도</a>` : ""}
      ${ck && ck !== s ? `<a class="btn" href="#/s/${ck.id}">☑ 체크리스트</a>` : ""}
      <a class="btn" href="#/q/${encodeURIComponent(s.ch.title + " " + s.title + " 다음에 할 일")}">👉 다음에 할 일</a>
    </div>
    <div class="content">${s.html || "<p class='crumb'>본문 없음 — 원문 페이지를 확인하세요.</p>"}</div>
    <div class="docnav">
      ${prev ? `<a class="card" href="#/s/${prev.id}"><div class="k">◀ 이전</div><div class="t">${esc(prev.num)} ${esc(T(prev))}</div></a>` : "<span></span>"}
      ${next ? `<a class="card" href="#/s/${next.id}" style="text-align:right"><div class="k">다음 ▶</div><div class="t">${esc(next.num)} ${esc(T(next))}</div></a>` : ""}
    </div></article>`;
  window.scrollTo(0, 0);
  markToc(id);
}

function viewFlow() {
  setTab("flow");
  const stage = M.parts.filter((p) => STAGE_PARTS.includes(p.num));
  const rest = M.parts.filter((p) => !STAGE_PARTS.includes(p.num) && p.chapters.length);
  $("#main").innerHTML = `<div class="flow">
    <h1>🧭 산업단지 개발사업 업무 흐름</h1>
    <p>기획부터 재생까지 단계별로 무엇을 하는지 한눈에 보고, 해당 업무를 눌러 상세 내용을 확인하세요.</p>
    <div class="lane">${stage.map((p, i) => `<div class="stagecard"><span class="no">${i + 1}</span>
      <h2>${esc(p.title)}<small>${esc(p.subtitle)}</small></h2><ol>${p.chapters.map((c) =>
        `<li><a href="#/s/${firstWork(c).id}">${esc(c.title)}</a>${flowOf(c) ? ` <a href="#/s/${flowOf(c).id}" title="업무흐름도">🔀</a>` : ""}</li>`).join("")}</ol></div>`).join("")}
    </div>
    <div class="extra lane">${rest.map((p) => `<div class="stagecard"><h2>${esc(p.title)}<small>${esc(p.subtitle || "")}</small></h2><ol>${p.chapters.map((c) =>
      `<li><a href="#/s/${c.sections[0].id}">${esc(c.title)}</a></li>`).join("")}</ol></div>`).join("")}
    </div></div>`;
}

function buildToc() {
  $("#toc").innerHTML = M.parts.filter((p) => p.chapters.length).map((p) => `<details data-part="${p.id}">
    <summary>${p.num ? `Part ${p.num}. ` : ""}${esc(p.title)}<small>${esc(p.subtitle || "")}</small></summary>
    ${p.chapters.map((c) => `<a class="ch" href="#/s/${c.sections[0].id}">${esc(c.num)}. ${esc(c.title)}</a>
      ${c.sections.length > 1 ? c.sections.map((s) => `<a class="sec" data-id="${s.id}" href="#/s/${s.id}">${esc(s.num)} ${esc(T(s))}</a>`).join("") : ""}`).join("")}
  </details>`).join("");
  $("#toc").addEventListener("click", (e) => { if (e.target.closest("a")) $("#toc").classList.remove("open"); });
}
function markToc(id) {
  document.querySelectorAll("#toc a.on").forEach((a) => a.classList.remove("on"));
  const a = document.querySelector(`#toc a[data-id="${id}"]`) || document.querySelector(`#toc a.ch[href="#/s/${id}"]`);
  if (a) { a.classList.add("on"); a.closest("details").open = true; a.scrollIntoView({ block: "nearest" }); }
}
function setTab(t) { document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === t)); }

/* 원문 페이지 뷰어 */
let vPage = 1;
function openPage(n) {
  vPage = Math.min(Math.max(1, n), M.meta.pages || 1);
  $("#vImg").src = `pages/p${String(vPage).padStart(3, "0")}.webp`;
  $("#vPage").textContent = `${vPage} / ${M.meta.pages}쪽`;
  $("#viewer").hidden = false;
  $(".viewer-body").scrollTop = 0;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (b) openPage(+b.dataset.page);
  const v = e.target.closest("[data-v]");
  if (v) {
    if (v.dataset.v === "prev") openPage(vPage - 1);
    if (v.dataset.v === "next") openPage(vPage + 1);
    if (v.dataset.v === "close") $("#viewer").hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if ($("#viewer").hidden) return;
  if (e.key === "Escape") $("#viewer").hidden = true;
  if (e.key === "ArrowLeft") openPage(vPage - 1);
  if (e.key === "ArrowRight") openPage(vPage + 1);
});
$("#menuBtn").onclick = () => $("#toc").classList.toggle("open");

function route() {
  const h = location.hash.slice(1) || "/";
  let m;
  if ((m = h.match(/^\/s\/(.+)$/))) return viewSection(decodeURIComponent(m[1]));
  if (h === "/flow") return viewFlow();
  if ((m = h.match(/^\/q\/(.+)$/))) { viewChat(); return ask(decodeURIComponent(m[1])); }
  viewChat();
}

/* ---------------------------------------------------------------- 시작 */
fetch("data/manual.json").then((r) => r.json()).then((data) => {
  M = data;
  for (const p of M.parts) for (const c of p.chapters) {
    c.part = p;
    CH.set(c.id, c);
    for (const s of c.sections) { s.part = p; s.ch = c; SEC.set(s.id, s); ORDER.push(s); }
  }
  INDEX = buildIndex();
  $("#ver").textContent = `${M.meta.version || ""} · 갱신 ${M.meta.built}`;
  buildToc();
  window.addEventListener("hashchange", route);
  route();
}).catch((e) => { $("#main").innerHTML = `<p class="nohit">편람 데이터를 불러오지 못했습니다: ${esc(e.message)}</p>`; });
