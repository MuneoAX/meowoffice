/**
 * @file 세션 알림 창(notify.html) 스크립트 — 권한 요청(수락/거절)·질문 카드 + 응답 대기 세션 카드.
 * Rust 가 "permits"·"alerts" 이벤트로 목록을 밀어주면 render() 가 카드 목록을 다시 그린다.
 * 공통 도우미(invoke·$·escapeHtml·fmtAgo)는 common.js.
 * 공개 진입점: setAlerts(list) · setPermits(list) · setShown(bool) · setAutoHide(sec) (Tauri 이벤트로 호출).
 */
/**
 * @typedef {Object} PermitOption
 * @property {string} label 선택지 이름
 * @property {string} [description] 선택지 설명
 */
/**
 * @typedef {Object} PermitQuestion
 * @property {string} question 질문 문장(답 모음의 키)
 * @property {string} [header] 질문 머리말 칩
 * @property {boolean} [multiSelect] 복수 선택 여부
 * @property {PermitOption[]} [options] 선택지
 */
/**
 * @typedef {Object} Permit
 * @property {string} id Rust 가 붙인 요청 id ("p1"…)
 * @property {"tool"|"question"} kind 카드 형식
 * @property {"claude"|"chatgpt"|"antigravity"|"gemini"} provider 요청을 보낸 서비스
 * @property {string} project 프로젝트 이름
 * @property {string} tool 도구 이름
 * @property {string} detail 카드 본문(명령·경로·URL)
 * @property {string} description 도구 설명
 * @property {string} created_at 생성 시각(ISO)
 * @property {PermitQuestion[]} [questions] question 형식일 때 질문 목록
 * @property {string} [session] 세션 id (permit.rs Permit)
 */
/**
 * @typedef {Object} PickState
 * @property {string[]} sel 고른 선택지 label(기타는 OTHER 값)
 * @property {string} other 기타 입력 텍스트
 */
/**
 * @typedef {Object} CardFormat
 * @property {function(Permit):string} pill 알약 문구
 * @property {string} cls 알약 CSS 클래스
 * @property {function():string} ok 수락 단추 문구
 * @property {function(Permit):string} title 카드 제목
 * @property {function(Permit):string} body 본문 HTML
 * @property {function(Permit):(Object<string,string>|null|undefined)} answers 답 모음(null=미완성, undefined=해당 없음)
 */
const listEl = $("list");
// 사용자 입력이 필요한 건(need_input)만 "입력 대기", 로컬 턴 종료(done)는 "응답 완료", 나머지(검토 준비 등)는 일반 알림.
const STATES = {
  need_input: { key: "notify.state.need_input", cls: "pill-amber" },
  done: { key: "notify.state.done", cls: "pill-green" },
  update: { key: "notify.state.update", cls: "pill-purple" },
  status: { key: "notify.state.status", cls: "pill-red" },
  recovered: { key: "notify.state.recovered", cls: "pill-green" },
};
/**
 * 알림 → 카드 하단 단추 정의.
 * 업데이트 → 지금 설치, 로컬 세션 → 확인(열 링크 없음), 연결 불안정 → 상태 페이지,
 * 그 외(클라우드·원격 세션의 검토 대기, 연결 복구 등 일반 상태 알림) → 자세히.
 * @param {Alert} a 알림 (common.js 의 Alert)
 * @returns {{act: "install"|"open", id: "install"|"ok"|"status"|"details", key: string}} 동작·단추 종류(비교용)·사전 키
 * @see footButton, keepOpen, 클릭 핸들러(install_update·open_alert)
 */
const buttonOf = (a) =>
  a.env === "update"
    ? { act: "install", id: "install", key: "notify.btn.install" }
    : a.env === "local"
      ? { act: "open", id: "ok", key: "notify.btn.ok" }
      : a.env === "status" && a.state === "status"
        ? { act: "open", id: "status", key: "notify.btn.status_page" }
        : { act: "open", id: "details", key: "notify.btn.details" };
/**
 * 알림 카드 하단 단추 HTML.
 * buttonOf 결과의 act 를 data-act 속성으로, key 의 번역 문구를 글자로 쓴다.
 * 로컬 알림에 같은 세션의 원격 제어 알림이 합쳐진 카드(twin + url)는 웹 대화를 여는 [자세히] 를 앞에 하나 더 둔다.
 * @param {Alert} a 알림
 * @returns {string} <button> HTML
 * @see buttonOf, render
 */
const footButton = (a) => {
  const b = buttonOf(a);
  const remote = a.twin && a.url && b.id === "ok" ? `<button class="btn btn-soft" data-act="open-remote">${escapeHtml(t("notify.btn.details"))}</button>` : "";
  return `${remote}<button class="btn btn-primary" data-act="${b.act}">${escapeHtml(t(b.key))}</button>`;
};
/**
 * 카드 머리 둘째 줄(프로젝트 뱃지 + 경과 시간) HTML.
 * 첫 줄은 상태 알약·출처 뱃지(·닫기)만 두고, 프로젝트 이름과 시간은 다음 줄에 같이 둔다.
 * @param {string} project 프로젝트 이름
 * @param {string} title 카드 제목(프로젝트와 같으면 뱃지 생략)
 * @param {string} at 시각(ISO)
 * @returns {string} HTML
 * @see projectTag, fmtAgo
 */
const subLine = (project, title, at) => `<div class="a-sub">${projectTag(project, title)}<span class="a-ago">${fmtAgo(at)}</span></div>`;
const NOTICE = { key: "notify.state.notice", cls: "pill-purple" };

let alerts = [];
let permits = [];
// [자세히]만 있는 일반 상태 알림 자동 숨김(초, 0 = 끔). 마우스를 올려 둔 동안은 멈추고, 떼면 처음부터 다시.
// 카운트는 알림 창이 실제로 보이는 동안만 — 패널이 열려 창이 숨어 있을 때 받은 카드는 창이 뜰 때부터 셈.
// 숨겨도 Rust 쪽에선 읽지 않은 알림으로 남음(트레이 배지·패널 알림 탭).
let autoHide = 30;
let shown = false;
const hideTimers = {};
/** 마우스가 올라가 있어 카운트를 멈춘 카드 key. */
let paused = null;
/**
 * 이 카드는 자동 숨김 대상이 아닌지 판정.
 * 자동 숨김은 버튼이 [자세히]뿐인 카드만. 로컬 세션(응답 완료·권한 확인)·업데이트·연결 불안정, 그리고 입력 대기는
 * 버튼과 관계없이 직접 닫거나 해소될 때까지 남김(닫기 ×는 가능). 목록에 없는 key 도 true.
 * @param {string} key 알림 key
 * @returns {boolean} true 면 자동 숨김 제외
 * @see armHide, buttonOf
 */
const keepOpen = (key) => {
  const a = alerts.find((x) => x.key === key);
  return !a || a.state === "need_input" || buttonOf(a).id !== "details";
};
/**
 * 카드 하나의 자동 숨김 타이머를 (재)설정.
 * 기존 타이머를 지우고, 창이 보이는 중·자동 숨김 사용·마우스 미보류·미리보기 아님·자동 숨김 대상일 때만 autoHide 초 뒤 expire_alert 를 호출하도록 건다.
 * @param {string} key 알림 key
 * @returns {void}
 * @see keepOpen, Tauri 명령 expire_alert
 */
function armHide(key) {
  clearTimeout(hideTimers[key]);
  if (!invoke || !shown || !autoHide || key === paused || key.startsWith("preview-") || keepOpen(key)) return;
  hideTimers[key] = setTimeout(() => invoke("expire_alert", { key }), autoHide * 1000);
}
/**
 * 현재 알림 목록·표시 상태에 맞춰 타이머를 맞춘다.
 * 창이 숨었거나 사라진 알림의 타이머를 지우고, 창이 보이는 동안 타이머 없는 알림에 armHide 를 건다.
 * @returns {void}
 * @see armHide, setShown, setAlerts
 */
function syncHideTimers() {
  for (const key of Object.keys(hideTimers)) {
    if (!shown || !alerts.some((a) => a.key === key)) (clearTimeout(hideTimers[key]), delete hideTimers[key]);
  }
  if (shown) for (const a of alerts) if (!(a.key in hideTimers)) armHide(a.key);
}
/**
 * 알림 창 표시 여부 반영(notify_visible 이벤트).
 * 카운트는 창이 실제로 보이는 동안만 세므로 값이 바뀌면 타이머를 다시 맞춘다.
 * @param {boolean} v 창이 보이는지
 * @returns {void}
 * @see syncHideTimers
 */
function setShown(v) {
  shown = !!v;
  syncHideTimers();
}
/**
 * 자동 숨김 시간 변경(auto_hide 이벤트·설정값).
 * 음수·소수는 0 이상 정수로 바로잡고, 모든 카드 타이머를 새 시간으로 다시 건다.
 * @param {number} sec 초 (0 = 끔)
 * @returns {void}
 * @see armHide, Tauri 명령 get_config
 */
function setAutoHide(sec) {
  autoHide = Math.max(0, sec | 0);
  for (const key of Object.keys(hideTimers)) armHide(key);
}
// 질문 카드 선택 상태(재렌더에도 유지): picks[permitId][질문 index] = { sel: [label...], other: "" }.
const picks = {};
const OTHER = "\u0000other";

/**
 * 질문 카드의 한 질문 선택 상태를 가져오고 없으면 만든다.
 * picks[permitId][질문 index] 에 저장되어 재렌더에도 유지.
 * @param {string} id 권한 요청 id
 * @param {number} qi 질문 index
 * @returns {PickState} 선택 상태(참조)
 * @see questionAnswers, questionBody, onPick
 */
const pickOf = (id, qi) => ((picks[id] ||= [])[qi] ||= { sel: [], other: "" });
/**
 * 질문별 답 모음 만들기.
 * 질문별 답: 선택 label + (기타 선택 시) 입력 텍스트, 복수 선택은 ", " 로 연결. 하나라도 비면 null.
 * @param {Permit} p question 형식 권한 요청
 * @returns {(Object<string,string>|null)} 질문 문장 → 답. 미완성이면 null
 * @see pickOf, Tauri 명령 answer_permit
 */
function questionAnswers(p) {
  const out = {};
  for (const [qi, q] of (p.questions || []).entries()) {
    const { sel, other } = pickOf(p.id, qi);
    const parts = sel.map((v) => (v === OTHER ? other.trim() : v)).filter(Boolean);
    if (!parts.length) return null;
    out[q.question] = parts.join(", ");
  }
  return out;
}

/**
 * question 형식 카드 본문 HTML.
 * 질문마다 선택지(라디오/체크박스)·"기타" 선택 + 직접 입력칸을 그린다. 현재 선택 상태를 checked·hidden 으로 복원.
 * @param {Permit} p question 형식 권한 요청
 * @returns {string} 본문 HTML
 * @see pickOf, FORMATS.question
 */
function questionBody(p) {
  return (p.questions || [])
    .map((q, qi) => {
      const { sel, other } = pickOf(p.id, qi);
      const type = q.multiSelect ? "checkbox" : "radio";
      const opt = (value, label, desc) => `
            <label class="q-opt">
              <input type="${type}" name="${escapeHtml(p.id)}-${qi}" value="${escapeHtml(value)}"${sel.includes(value) ? " checked" : ""} />
              <span><b>${escapeHtml(label)}</b>${desc ? `<small>${escapeHtml(desc)}</small>` : ""}</span>
            </label>`;
      return `
        <div class="q" data-q="${qi}">
          <div class="q-head">
            ${q.header ? `<span class="q-chip">${escapeHtml(q.header)}</span>` : ""}
            <span class="q-hint">${escapeHtml(t(q.multiSelect ? "notify.q.multi" : "notify.q.single"))}</span>
          </div>
          <div class="q-text">${escapeHtml(q.question)}</div>
          <div class="q-opts">
            ${(q.options || []).map((o) => opt(o.label, o.label, o.description)).join("")}
            ${opt(OTHER, t("notify.q.other"), "")}
            <input class="q-other" placeholder="${escapeHtml(t("notify.q.other.placeholder"))}" value="${escapeHtml(other)}"${sel.includes(OTHER) ? "" : " hidden"} />
          </div>
        </div>`;
    })
    .join("");
}

/**
 * 카드 형식 공통 관리표.
 * Permit.kind 플래그로 한 카드 안에서 분기(형식 추가 시 여기만 늘림). 각 형식은 pill·cls·ok·title·body·answers 를 가진다.
 * @type {Object<string, CardFormat>}
 * @see formatOf, permitCard
 */
const FORMATS = {
  tool: {
    /**
     * tool 형식 알약 문구.
     * 항상 "권한 요청".
     * @param {Permit} p 권한 요청
     * @returns {string} 문구
     */
    pill: () => t("notify.pill.permit"), cls: "pill-red", ok: () => t("notify.btn.allow"),
    /**
     * tool 형식 카드 제목.
     * 도구 이름 + (있으면) " · 설명".
     * @param {Permit} p 권한 요청
     * @returns {string} 제목
     */
    title: (p) => {
      return `${p.tool}${p.description ? ` · ${p.description}` : ""}`;
    },
    /**
     * tool 형식 본문 HTML.
     * detail(명령·경로·URL)이 있을 때만 이스케이프해서 코드 상자로.
     * @param {Permit} p 권한 요청
     * @returns {string} HTML 또는 빈 문자열
     */
    body: (p) => (p.detail ? `<div class="a-cmd">${escapeHtml(p.detail)}</div>` : ""),
    /**
     * tool 형식은 답 모음이 없다.
     * @returns {undefined} 항상 undefined (→ 수락 단추 항상 활성)
     */
    answers: () => undefined,
  },
  question: {
    /**
     * question 형식 알약 문구 — 항상 "질문".
     * @returns {string}
     */
    pill: () => t("notify.pill.question"), cls: "pill-purple", ok: () => t("notify.btn.answer"),
    /**
     * question 형식 카드 제목 — 항상 "Claude 의 질문"(현재 언어).
     * @returns {string}
     */
    title: () => t("notify.title.question"),
    body: questionBody,
    answers: questionAnswers,
  },
};
/**
 * 권한 요청의 카드 형식 찾기.
 * 알 수 없는 kind 는 tool 형식으로.
 * @param {Permit} p 권한 요청
 * @returns {CardFormat} 형식
 * @see FORMATS
 */
const formatOf = (p) => FORMATS[p.kind] || FORMATS.tool;

// 카드 좌상단 서비스 로고(흰 둥근 바탕). provider: claude | chatgpt | antigravity | gemini | app(서비스 무관 앱 알림 → 고양이).
const PROVIDER_LABELS = { claude: "Claude", chatgpt: "ChatGPT", antigravity: "Antigravity", gemini: "Gemini", app: "Meowffice" };
/**
 * 카드 좌상단 서비스 로고 배지 HTML.
 * 알 수 없는 provider 는 claude 로 처리, 툴팁에 서비스 이름.
 * @param {string} provider claude | chatgpt | antigravity | gemini | app
 * @returns {string} 배지 HTML
 * @see PROVIDER_LABELS
 */
function svcBadge(provider) {
  const k = PROVIDER_LABELS[provider] ? provider : "claude";
  return `<span class="svc-badge" title="${PROVIDER_LABELS[k]}"><i class="svc-logo svc-${k}"></i></span>`;
}

/**
 * 권한 요청·질문 카드 HTML 한 장.
 * 서비스 배지·알약·출처·프로젝트·경과 시간·제목·본문과 [거절]/[수락] 단추. 질문이 미완성이면 수락 단추를 비활성.
 * @param {Permit} p 권한 요청
 * @returns {string} 카드 HTML
 * @see formatOf, svcBadge, sourceBadges, projectTag, fmtAgo
 */
function permitCard(p) {
  const f = formatOf(p);
  return `
      <div class="alert-card" data-permit="${escapeHtml(p.id)}">
        <div class="a-top">
          ${svcBadge(p.provider)}
          <span class="pill sm ${f.cls}"><i class="dot"></i>${f.pill(p)}</span>
          ${sourceBadges({ env: "local" })}
        </div>
        ${subLine(p.project, "", p.created_at)}
        <div class="a-title">${escapeHtml(f.title(p))}</div>
        ${f.body(p)}
        <div class="a-foot two">
          <button class="btn btn-deny" data-act="deny">${escapeHtml(t("notify.btn.deny"))}</button>
          <button class="btn btn-primary" data-act="allow"${f.answers(p) === null ? " disabled" : ""}>${escapeHtml(f.ok())}</button>
        </div>
      </div>`;
}

/**
 * 권한 카드 + 알림 카드 전체 다시 그리기.
 * "기타" 입력 포커스·커서 위치를 기억했다가 복원하고, 마우스 올림으로 멈춘 카드가 실제로 hover 중인지 재확인한 뒤 창 높이를 맞춘다.
 * @returns {void}
 * @see permitCard, svcBadge, sourceBadges, projectTag, fit, syncHideTimers
 */
function render() {
  // 재렌더로 '기타' 입력 포커스가 사라지지 않게 위치 기억 후 복원.
  const a = document.activeElement;
  const focus = a?.classList.contains("q-other")
    ? { id: a.closest(".alert-card").dataset.permit, q: a.closest(".q").dataset.q, at: a.selectionStart }
    : null;
  listEl.innerHTML = permits.map(permitCard).join("") + alerts
    .map((a) => {
      const st = STATES[a.state] || NOTICE;
      return `
      <div class="alert-card" data-key="${escapeHtml(a.key)}">
        <div class="a-top">
          ${svcBadge(a.provider)}
          <span class="pill sm ${st.cls}"><i class="dot"></i>${escapeHtml(t(st.key))}</span>
          ${sourceBadges(a)}
          <button class="a-x" data-act="dismiss" title="${escapeHtml(t("notify.btn.close"))}">×</button>
        </div>
        ${subLine(a.project, a.title, a.updated_at)}
        <div class="a-title" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</div>
        <div class="a-msg">${escapeHtml(a.message)}</div>
        <div class="a-foot two">${footButton(a)}</div>
      </div>`;
    })
    .join("");
  if (focus) {
    const el = listEl.querySelector(`.alert-card[data-permit="${CSS.escape(focus.id)}"] .q[data-q="${focus.q}"] .q-other`);
    if (el) (el.focus(), el.setSelectionRange(focus.at, focus.at));
  }
  // 카드 요소를 새로 그렸으므로 멈춘 카드 위에 실제로 마우스가 있는지 다시 확인.
  if (paused && !listEl.querySelector(`.alert-card[data-key="${CSS.escape(paused)}"]:hover`)) {
    paused = null;
    syncHideTimers();
  }
  fit();
}
/**
 * 알림 목록 교체(alerts 이벤트·get_alerts).
 * @param {Alert[]|null} list 알림 목록
 * @returns {void}
 * @see syncHideTimers, render, Tauri 명령 get_alerts
 */
function setAlerts(list) {
  alerts = list || [];
  syncHideTimers();
  render();
}
/**
 * 권한 요청 목록 교체(permits 이벤트·get_permits).
 * 사라진 요청의 질문 선택 상태(picks)는 정리한다.
 * @param {Permit[]|null} list 권한 요청 목록
 * @returns {void}
 * @see render, Tauri 명령 get_permits
 */
function setPermits(list) {
  permits = list || [];
  for (const id of Object.keys(picks)) if (!permits.some((p) => p.id === id)) delete picks[id];
  render();
}

/**
 * 창 높이를 카드 목록에 맞춤(body 패딩 포함, 논리 px).
 * Tauri 밖이거나 카드가 없으면 아무것도 안 한다. 다음 프레임에 scrollHeight 를 알려 준다.
 * @returns {void}
 * @see Tauri 명령 notify_resize
 */
function fit() {
  if (!invoke || !(alerts.length + permits.length)) return;
  requestAnimationFrame(() => invoke("notify_resize", { height: Math.ceil(document.body.scrollHeight) }));
}

/**
 * 카드 단추 클릭 처리(이벤트 위임).
 * 권한 카드: 수락/거절 → answer_permit(실패하면 목록 재동기화 resync_notify). 알림 카드: install → install_update(실패 시 문구 복구), open → open_alert,
 * open-remote(합친 카드의 [자세히]) → 짝인 원격 제어 알림 key 로 open_alert(웹 대화를 열고 카드는 둘 다 닫힘), 그 외 → dismiss_alert.
 * @param {MouseEvent} e 클릭 이벤트
 * @returns {Promise<void>}
 * @see answer_permit, resync_notify, install_update, open_alert, dismiss_alert
 */
listEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  const card = e.target.closest(".alert-card");
  if (!btn || !card || !invoke) return;
  if (card.dataset.permit) {
    const id = card.dataset.permit;
    const p = permits.find((x) => x.id === id);
    const allow = btn.dataset.act === "allow";
    const answers = allow && p ? formatOf(p).answers(p) : undefined;
    if (answers === null) return;
    try {
      await invoke("answer_permit", { id, allow, answers, source: "card" }); // card: 수락이면 앱이 간식 몫을 모아 오피스에서 지급
    } catch (_) {
      // 시간 초과·터미널에서 처리됨·미리보기 → 실제 목록으로 재동기화.
      setPermits(permits.filter((p) => p.id !== id));
      invoke("resync_notify");
    }
    return;
  }
  const key = card.dataset.key;
  if (btn.dataset.act === "install") {
    btn.disabled = true;
    btn.textContent = t("notify.btn.installing");
    try {
      await invoke("install_update"); // 성공하면 앱이 다시 시작됨
    } catch (err) {
      btn.disabled = false;
      btn.textContent = t("notify.btn.retry");
      card.querySelector(".a-msg").textContent = t("notify.update.fail", { err: String(err) });
    }
    return;
  }
  try {
    const twin = btn.dataset.act === "open-remote" && alerts.find((x) => x.key === key)?.twin;
    if (twin) await invoke("open_alert", { key: twin });
    else await invoke(btn.dataset.act === "open" ? "open_alert" : "dismiss_alert", { key });
  } catch (_) {
    // 이미 처리된 알림 등 — 카드만 닫음.
    invoke("dismiss_alert", { key });
  }
});

/**
 * 질문 카드 선택/입력 반영.
 * 선택 상태를 갱신하고 "기타" 입력칸 표시, 답변 단추 활성 여부, 창 높이만 갱신한다(카드 전체는 다시 안 그림).
 * @param {Event} e change / input 이벤트
 * @returns {void}
 * @see pickOf, formatOf, fit
 */
function onPick(e) {
  const card = e.target.closest(".alert-card[data-permit]");
  const qEl = e.target.closest(".q");
  if (!card || !qEl) return;
  const id = card.dataset.permit;
  const p = permits.find((x) => x.id === id);
  if (!p) return;
  const pick = pickOf(id, +qEl.dataset.q);
  if (e.target.classList.contains("q-other")) {
    pick.other = e.target.value;
  } else {
    pick.sel = [...qEl.querySelectorAll("input:checked")].map((i) => i.value);
    const other = qEl.querySelector(".q-other");
    other.hidden = !pick.sel.includes(OTHER);
    if (!other.hidden && e.target.value === OTHER && e.target.checked) other.focus();
  }
  card.querySelector('button[data-act="allow"]').disabled = formatOf(p).answers(p) === null;
  fit();
}
listEl.addEventListener("change", onPick);
// 단순 알림 카드에 마우스 → 자동 숨김 보류(paused). 재렌더로 카드 요소가 바뀌거나 창이 움직여 mouseout 을
// 못 받아도 멈춘 채로 남지 않게: 창 밖으로 나가면 풀고, 렌더 후 실제로 그 카드 위에 있는지 다시 확인.
listEl.addEventListener("mouseover", (e) => {
  const key = e.target.closest(".alert-card[data-key]")?.dataset.key;
  if (key && key !== paused) {
    paused = key;
    clearTimeout(hideTimers[key]);
    delete hideTimers[key];
  }
});
listEl.addEventListener("mouseout", (e) => {
  const card = e.target.closest(".alert-card[data-key]");
  if (card && !card.contains(e.relatedTarget) && card.dataset.key === paused) {
    paused = null;
    syncHideTimers();
  }
});
document.documentElement.addEventListener("mouseleave", () => {
  paused = null;
  syncHideTimers();
});
listEl.addEventListener("input", (e) => e.target.classList.contains("q-other") && onPick(e));

// 언어가 바뀌면(설정 창·다른 창) 이미 떠 있는 카드도 새 언어로 다시 그린다.
window.addEventListener("meow-lang", () => render());
// "n분 전" 표기 갱신.
setInterval(() => alerts.length + permits.length && render(), 60e3);

/**
 * 창 시작 초기화.
 * Tauri 밖이면 데모 권한 요청·알림으로 미리보기. 안이면 이벤트(alerts·auto_hide·notify_visible·permits)를 구독하고 설정값·현재 목록·창 표시 여부를 받아 맞춘다.
 * @returns {Promise<void>}
 * @see get_config, get_permits, get_alerts, setAlerts, setPermits, setShown, setAutoHide
 */
/**
 * 브라우저 미리보기용 데모 카드(권한 요청·질문·알림 여러 종류). 문구는 현재 언어 사전에서 가져온다.
 * @returns {void}
 * @see setPermits, setAlerts
 */
function demo() {
  const now = () => new Date().toISOString();
  setPermits([
    { id: "preview", kind: "tool", provider: "claude", project: "meowoffice", tool: "Bash", detail: "npm run build", description: t("notify.demo.perm.desc"), created_at: now() },
    { id: "preview-q", kind: "question", provider: "claude", project: "meowoffice", tool: "AskUserQuestion", detail: "", description: "", created_at: now(),
      questions: [
        { header: t("notify.demo.q1.header"), question: t("notify.demo.q1.text"), multiSelect: false, options: [{ label: t("notify.demo.q1.o1"), description: t("notify.demo.q1.o1d") }, { label: t("notify.demo.q1.o2"), description: t("notify.demo.q1.o2d") }] },
        { header: t("notify.demo.q2.header"), question: t("notify.demo.q2.text"), multiSelect: true, options: [{ label: t("notify.demo.q2.o1") }, { label: t("notify.demo.q2.o2") }, { label: t("notify.demo.q2.o3") }] },
      ] },
  ]);
  setAlerts([
    { key: "s1@1", id: "s1", title: "laptop-quiet-otter", message: t("notify.demo.a1.msg"), state: "need_input", env: "local", also: ["bridge"], twin: "b1@1", provider: "claude", project: "shop-api", url: "https://claude.ai/code", updated_at: new Date(Date.now() - 120e3).toISOString() },
    { key: "s2@1", id: "s2", title: t("notify.demo.a2.title"), message: t("notify.demo.a2.msg"), state: "review_ready", env: "cloud", provider: "claude", url: "", updated_at: now() },
    { key: "l1@1", id: "l1#a1", title: t("notify.demo.a3.title"), message: t("notify.demo.a3.msg"), state: "done", env: "local", provider: "claude", project: "shop-api", agent: true, url: "", updated_at: now() },
    { key: "codex:1@1", id: "codex:1", title: t("notify.demo.a4.title"), message: t("notify.demo.a4.msg"), state: "done", env: "local", provider: "chatgpt", project: "shop-api", url: "", updated_at: now() },
    { key: "agy:1@1", id: "agy:1", title: t("notify.demo.a5.title"), message: t("notify.demo.a5.msg"), state: "done", env: "local", provider: "antigravity", project: "meowoffice", url: "", updated_at: now() },
    { key: "app-update@1", id: "u", title: t("notify.demo.a6.title"), message: t("notify.demo.a6.msg"), state: "update", env: "update", provider: "app", url: "", updated_at: now() },
  ]);
}

(async function init() {
  if (!invoke) {
    // 브라우저 미리보기용 데모.
    demo();
    window.addEventListener("meow-lang", demo); // 언어가 바뀌면 데모 문구도 다시
    return;
  }
  TAURI.event.listen("alerts", (ev) => setAlerts(ev.payload));
  TAURI.event.listen("auto_hide", (ev) => setAutoHide(ev.payload));
  TAURI.event.listen("notify_visible", (ev) => setShown(ev.payload));
  try {
    setAutoHide((await invoke("get_config")).alert_auto_hide_seconds);
  } catch (_) {}
  TAURI.event.listen("permits", (ev) => setPermits(ev.payload));
  permits = await invoke("get_permits");
  setAlerts(await invoke("get_alerts"));
  // 리스너 등록 전에 창이 이미 떴을 수 있음 — 현재 표시 상태로 맞춤.
  try {
    setShown(await TAURI.window.getCurrentWindow().isVisible());
  } catch (_) {}
})();
