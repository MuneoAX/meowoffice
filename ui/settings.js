/**
 * @file 설정 화면 (오피스 office/ 가 Shadow DOM 으로 띄움).
 * mount(root, host, opts): root = document 또는 ShadowRoot, host = 화면을 넣을 요소.
 *   opts: { invoke, toast, getPlan() → 마지막 플랜 조회 결과, onSaved(갱신 주기, API 설정 저장 여부) }
 * 반환: { open(pane?), close(), toggle(), isOpen() }
 * 필요한 전역: escapeHtml, ORIGIN_BADGES (common.js), I18N·t (i18n.js), MeowWeather (weather.js), meowLocation·setMeowLocation·meowProviders (common.js).
 * 공개 API: MeowSettings.mount. 저장 단추는 Tauri 명령 save_config · save_api_config, 연동 스위치는 set_provider_on · set_provider_hook 를 부른다.
 * 웹 서비스 장애 알림(알림 메뉴의 카드)은 바로 저장: get_web_services · set_web_status_alert.
 */
/**
 * @typedef {Object} Cfg
 * @property {string} version 앱 버전
 * @property {string} os 운영체제 이름
 * @property {string} arch CPU 아키텍처
 * @property {number} hook_port 훅 수신 포트
 * @property {number} refresh_interval_minutes 자동 갱신 주기(분)
 * @property {boolean} autostart Windows 로그인 시 자동 시작
 * @property {number} alert_auto_hide_seconds [자세히] 알림 자동 숨김(초, 0=끔)
 * @property {AlertKind[]} alert_kinds 알림 종류 정의(alerts::KINDS)
 * @property {string[]} muted_alert_kinds 끈 알림 종류 id
 * @property {boolean} permission_hook 권한 요청 훅 연동
 * @property {boolean} auto_allow 자동 수락 모드
 * @property {boolean} open_in_desktop 링크를 Claude 데스크톱 앱으로 열기
 * @property {boolean} panel_on_top 오피스 창 항상 위
 * @property {number} api_allocated_usd 월 할당 크레딧(USD)
 * @property {boolean} api_key_set Admin API 키 저장 여부(키 자체는 안 보냄)
 * @property {boolean} desktop_app Claude 데스크톱 앱 설치 여부
 * @property {string} claude_dir Claude 데이터 폴더
 * @property {string} config_path 설정 파일 경로
 * @property {string|null} note 참고 문구 (main.rs Cfg)
 */
/**
 * @typedef {Object} AlertKind
 * @property {string} id 종류 id
 * @property {string} label 화면 이름
 * @property {string} desc 설명
 * @property {"local"|"remote"|"app"} origin 출처 뱃지
 * @property {boolean} needs_hook Claude Code 훅이 있어야 받는 종류 (alerts.rs Kind)
 */
/**
 * @typedef {Object} ProviderLimit
 * @property {string} kind 안정 식별자(session|weekly|monthly|credits…)
 * @property {string} label 화면 이름
 * @property {number|null} percent 사용 %
 * @property {string|null} resets_at 초기화 시각(RFC3339)
 */
/**
 * @typedef {Object} ProviderSession
 * @property {string} id 세션 id
 * @property {string} title 제목
 * @property {string} project 작업 폴더 이름
 * @property {string} cwd 작업 폴더
 * @property {string} status "busy" | "idle" | ""(끝남)
 * @property {string|null} started_at 시작 시각
 * @property {string|null} last_at 마지막 활동
 * @property {string} url 열기 링크
 */
/**
 * @typedef {Object} ProviderSnapshot
 * @property {string} provider "chatgpt" | "antigravity"
 * @property {boolean} installed 설치됨
 * @property {boolean} logged_in 로그인됨
 * @property {string} account 계정 표시 이름
 * @property {string} plan 요금제 이름
 * @property {ProviderLimit[]} limits 한도 목록
 * @property {ProviderSession[]} sessions 최근 세션
 * @property {string} error 일부 실패 설명
 * @property {string} fetched_at 만든 시각
 * @property {boolean} auth_expired 로그인 만료 (providers.rs Snapshot)
 * @property {("not_installed"|"logged_out"|"connected"|"expired"|"degraded")} state 연결 상태 (providers.rs ConnState)
 */
/**
 * @typedef {Object} ProviderHookState
 * @property {boolean} enabled 설정이 켜져 있고 훅 파일에 항목 있음
 * @property {boolean} installed 훅 파일에 항목 있음
 * @property {boolean} stale 등록 경로가 현재 실행 파일과 다름
 * @property {boolean} auto_allow 자동 수락
 * @property {string} path 수정하는 훅 파일 경로
 * @property {boolean} present 서비스 설정 폴더가 이 PC 에 있음
 * @property {string|null} warning 알릴 문제 (main.rs ProviderHookState)
 */
/**
 * @typedef {Object} SettingsOpts
 * @property {function} [invoke] Tauri invoke (없으면 브라우저 미리보기)
 * @property {function(string):void} [toast] 알림 표시
 * @property {function():(Object|null)} [getPlan] 마지막 플랜 조회 결과({ plan?, error?, state? })
 * @property {function(number, boolean):void} [onSaved] 저장 뒤 (갱신 주기, API 설정 저장 여부)
 */
/**
 * @typedef {Object} SettingsApi
 * @property {function(string=):Promise<void>} open 설정 열기(pane: general|alerts|claude|chatgpt|antigravity|info)
 * @property {function():void} close 닫기
 * @property {function():(Promise<void>|void)} toggle 열림/닫힘 전환
 * @property {function():boolean} isOpen 열려 있는지
 */
'use strict';

const MeowSettings = (() => {
  const MARKUP = `    <div class="overlay" id="settings" hidden>
      <div class="modal modal-settings">
        <aside class="set-side">
          <div class="set-brand">
            <span class="brand-logo brand-logo-lg"></span>
            <div class="set-brand-text"><b>Meowffice</b><small>v<span id="side-version">—</span></small></div>
          </div>
          <nav class="set-nav" id="settings-tab">
            <div class="nav-h">공통</div>
            <button data-pane="general" class="on"><i class="ic ic-settings"></i>일반</button>
            <button data-pane="alerts"><i class="ic ic-bell"></i>알림</button>
            <button data-pane="info"><i class="ic ic-info"></i>정보</button>
            <div class="nav-h">AI 서비스</div>
            <button data-pane="claude"><i class="svc-logo svc-claude"></i>Claude<span class="nav-state" id="nav-claude-state"></span></button>
            <button data-pane="chatgpt"><i class="svc-logo svc-chatgpt"></i>ChatGPT<span class="nav-state" id="nav-chatgpt-state"></span></button>
            <button data-pane="antigravity"><i class="svc-logo svc-antigravity"></i>Antigravity<span class="nav-state" id="nav-antigravity-state"></span></button>
          </nav>
          <div class="set-status" id="set-status"><i class="dot"></i><span>확인 중</span></div>
        </aside>

        <section class="set-main">
          <button class="set-close" id="btn-close" title="닫기"><i class="ic ic-x"></i></button>
          <div class="set-scroll">
            <!-- 일반 -->
            <div class="settings-pane" data-pane="general">
              <div class="set-head">
                <i class="ic ic-settings"></i>
                <div><h2>일반 설정</h2><p>기본 동작과 표시 방식을 관리합니다.</p></div>
              </div>
              <div class="set-card">
                <div class="set-row">
                  <i class="ic ic-clock row-ic"></i>
                  <div class="row-text"><b>자동 갱신 주기</b><small>플랜 한도와 트레이 아이콘을 다시 불러오는 주기입니다.</small></div>
                </div>
                <select class="input row-under" id="in-interval">
                  <option value="1">1분</option>
                  <option value="3">3분</option>
                  <option value="5">5분</option>
                  <option value="10">10분</option>
                  <option value="15">15분</option>
                  <option value="30">30분</option>
                  <option value="60">1시간</option>
                </select>
              </div>
              <div class="set-card">
                <div class="set-row">
                  <i class="ic ic-clock row-ic"></i>
                  <div class="row-text"><b data-i18n="loc.title"></b><small data-i18n="loc.desc"></small></div>
                </div>
                <div class="loc-box row-under">
                  <div class="loc-now" id="loc-now"></div>
                  <div class="loc-search">
                    <input class="input" id="in-loc-q" type="search" autocomplete="off" spellcheck="false" data-i18n-placeholder="loc.search.placeholder" />
                    <div class="loc-res" id="loc-res" hidden></div>
                  </div>
                  <div class="loc-btns">
                    <button type="button" class="btn btn-sm loc-btn" id="btn-loc-cur" data-i18n="loc.current" data-i18n-title="loc.current.title"></button>
                    <button type="button" class="btn btn-sm loc-btn" id="btn-loc-auto" data-i18n="loc.auto" data-i18n-title="loc.auto.title"></button>
                  </div>
                </div>
              </div>
              <div class="set-card">
                <label class="set-row">
                  <i class="ic ic-power row-ic"></i>
                  <div class="row-text"><b>Windows 로그인 시 자동 시작</b><small>PC 를 켜면 트레이에 자동으로 실행합니다.</small></div>
                  <input type="checkbox" class="switch" id="in-autostart" />
                </label>
                <label class="set-row">
                  <i class="ic ic-app-window row-ic"></i>
                  <div class="row-text"><b>세션·링크를 Claude 데스크톱 앱으로 열기</b><small id="desktop-hint">Claude 데스크톱 앱이 설치돼 있으면 브라우저 대신 앱에서 엽니다.</small></div>
                  <input type="checkbox" class="switch" id="in-desktop" />
                </label>
                <label class="set-row">
                  <i class="ic ic-pin row-ic"></i>
                  <div class="row-text"><b>오피스 창을 항상 위에 표시</b><small>켜면 다른 창을 눌러도 오피스 창이 위에 남습니다.</small></div>
                  <input type="checkbox" class="switch" id="in-on-top" />
                </label>
              </div>
            </div>

            <!-- 알림 -->
            <div class="settings-pane" data-pane="alerts" hidden>
              <div class="set-head">
                <i class="ic ic-bell"></i>
                <div><h2>알림 설정</h2><p>알림 창에 띄울 알림 종류와 표시 방식을 관리합니다.</p></div>
                <button class="btn btn-soft btn-sm head-btn" id="btn-preview-alert"><i class="ic ic-eye"></i>미리보기</button>
              </div>
              <div class="set-card">
                <div class="card-title"><b>알림 종류</b><small>끈 종류는 알림 창·트레이 숫자·오피스 최근 알림 어디에도 남기지 않습니다.</small></div>
                <div id="alert-kinds"></div>
                <div class="note" id="kinds-hook-note" hidden><i class="ic ic-info"></i><span>로컬·에이전트 알림은 Claude Code 훅으로 받습니다. <a href="#" data-goto="claude">연동</a>에서 권한 요청 연동을 켜야 받을 수 있습니다.</span></div>
              </div>
              <div class="set-card">
                <div class="card-title"><b data-i18n="web.card.title"></b><small data-i18n="web.card.desc"></small></div>
                <div id="web-status-rows"></div>
              </div>
              <div class="set-card">
                <div class="set-row">
                  <i class="ic ic-timer row-ic"></i>
                  <div class="row-text"><b>[자세히] 알림 자동 숨김</b><small>클라우드·원격 세션의 검토 대기, 연결 복구처럼 [자세히] 버튼만 있는 알림에만 적용됩니다. 숨겨도 읽지 않은 알림으로 남습니다.</small></div>
                  <select class="input input-sm" id="in-auto-hide">
                    <option value="0">끄기</option>
                    <option value="5">5초</option>
                    <option value="10">10초</option>
                    <option value="20">20초</option>
                    <option value="30">30초</option>
                    <option value="60">1분</option>
                  </select>
                </div>
              </div>
            </div>

            <!-- AI 서비스: Claude (Claude Code 연동 + API 크레딧) -->
            <div class="settings-pane" data-pane="claude" hidden>
              <div class="set-head">
                <i class="svc-logo svc-claude lg"></i>
                <div><h2>Claude</h2><p>Claude 계정 한도, 이 PC 의 Claude Code 연동(권한 요청·로컬 세션 알림), API 크레딧을 관리합니다.</p></div>
              </div>
              <div class="sub-h">Claude Code 연동</div>
              <div class="set-card">
                <div class="card-top"><span class="state-pill" id="hook-state"><i class="dot"></i>연결 안 됨</span></div>
                <label class="set-row">
                  <i class="ic ic-plug row-ic"></i>
                  <div class="row-text"><b>권한 요청을 알림에서 수락/거절</b><small>Claude Code 설정(settings.json)에 훅을 등록합니다. 앱이 꺼져 있거나 2분 안에 응답하지 않으면 터미널에서 평소처럼 확인합니다.</small></div>
                  <input type="checkbox" class="switch" id="in-permit" />
                </label>
                <dl class="kv">
                  <dt><i class="ic ic-folder"></i>Claude 데이터 경로</dt><dd class="mono" id="claude-dir">—</dd>
                  <dt><i class="ic ic-terminal"></i>수신 주소</dt><dd class="mono" id="hook-addr">—</dd>
                </dl>
              </div>
              <div class="set-card">
                <label class="set-row">
                  <i class="ic ic-zap row-ic"></i>
                  <div class="row-text"><b>자동 수락 모드</b><small>권한 요청을 알림 없이 바로 수락합니다. 질문 선택지(AskUserQuestion)·계획 승인(ExitPlanMode)처럼 직접 골라야 하는 요청만 카드로 띄웁니다.</small></div>
                  <input type="checkbox" class="switch" id="in-auto-allow" />
                </label>
              </div>
              <div class="sub-h">API 크레딧 (Console)</div>
              <div class="set-card">
                <div class="card-top"><span class="state-pill" id="api-key-state"><i class="dot"></i>키 없음</span></div>
                <div class="set-row">
                  <i class="ic ic-key row-ic"></i>
                  <div class="row-text"><b>Admin API 키</b><small>Console → Settings → Admin keys 에서 만든 sk-ant-admin… 키. 이 PC 의 현재 사용자 계정으로 암호화해 저장합니다. 일반 API 키(sk-ant-api…)로는 조회되지 않습니다.</small></div>
                </div>
                <div class="input-row row-under">
                  <input class="input" id="in-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-admin..." />
                  <button class="btn btn-soft" id="btn-api-validate">검증</button>
                  <button class="btn btn-soft" id="btn-api-clear" hidden>키 삭제</button>
                </div>
              </div>
              <div class="set-card">
                <div class="set-row">
                  <i class="ic ic-activity row-ic"></i>
                  <div class="row-text"><b>월 할당 크레딧 (USD)</b><small>남은 선불 잔액을 주는 공개 API 가 없어 직접 입력합니다. 0 이면 사용액만 표시합니다.</small></div>
                </div>
                <input class="input row-under" id="in-api-alloc" type="number" min="0" step="1" placeholder="예: 500" />
              </div>
            </div>

            <!-- AI 서비스: ChatGPT (준비 중) -->
            <div class="settings-pane" data-pane="chatgpt" hidden>
              <div class="set-head">
                <i class="svc-logo svc-chatgpt lg"></i>
                <div><h2>ChatGPT</h2><p>ChatGPT 계정과 이 PC 의 Codex(CLI·앱)를 연결합니다.</p></div>
              </div>
              <div class="set-card">
                <div class="card-top"><span class="state-pill" id="pv-chatgpt-state"><i class="dot"></i>확인 중</span></div>
                <div class="pv-info" id="pv-chatgpt-info"></div>
                <div class="pv-login" id="pv-chatgpt-login" hidden></div>
                <div class="note" id="pv-chatgpt-webhint" hidden><i class="ic ic-info"></i><span><span data-i18n="web.hint.chatgpt"></span> <a href="#" data-goto="alerts" data-i18n="web.hint.goto"></a></span></div>
                <label class="set-row">
                  <i class="ic ic-plug row-ic"></i>
                  <div class="row-text"><b>ChatGPT 세션을 사무실에 표시</b><small>켜면 ChatGPT 세션이 고양이로 출근하고 사용 한도가 오피스 현황에 나옵니다. 이 PC 에 저장된 Codex 로그인 정보로 chatgpt.com 에 사용량을 묻습니다 (로그인 정보는 바꾸거나 저장하지 않음).</small></div>
                  <input type="checkbox" class="switch" id="pv-chatgpt-on" />
                </label>
              </div>
              <div class="set-card" id="pvh-chatgpt-card">
                <div class="card-title row-titled"><i class="ic ic-shield-check"></i><b>권한 요청 연동</b><span class="state-pill" id="pvh-chatgpt-state"><i class="dot"></i>꺼짐</span></div>
                <label class="set-row">
                  <i class="ic ic-plug row-ic"></i>
                  <div class="row-text"><b>Codex 권한 요청을 알림 카드에서 수락/거절</b><small>켜면 <code id="pvh-chatgpt-path">~/.codex/hooks.json</code> 에 Meowffice 훅을 추가합니다(기존 훅은 그대로, 처음 한 번 백업, 끄면 이 앱 항목만 삭제). Codex 의 notify 설정은 건드리지 않습니다. Codex 가 승인을 물을 때만 카드가 뜹니다.</small></div>
                  <input type="checkbox" class="switch" id="pvh-chatgpt-on" />
                </label>
                <label class="set-row">
                  <i class="ic ic-zap row-ic"></i>
                  <div class="row-text"><b>자동 수락</b><small>Codex 가 물어보는 승인을 카드 없이 바로 수락합니다. 기본은 꺼짐.</small></div>
                  <input type="checkbox" class="switch" id="pvh-chatgpt-auto" />
                </label>
                <div class="note" id="pvh-chatgpt-trust" hidden><i class="ic ic-info"></i><span><b>Codex 앱에서 훅을 한 번 신뢰해야 동작합니다.</b> Codex 앱의 <b>설정 &gt; 훅(Hooks)</b>(또는 "훅 검토 Review hooks")에서 <b>Meowffice</b> 항목을 열어 <b>신뢰(Trust)</b>를 누르세요. 신뢰하기 전에는 Codex 가 이 훅을 실행하지 않아 평소처럼 Codex 안에서 승인합니다. Meowffice 를 업데이트하거나 옮겨 실행 파일 경로가 바뀌면 훅 명령이 바뀌어 다시 신뢰해야 합니다. 또한 Codex 의 자동 검토가 먼저 승인한 요청은 카드가 뜨지 않을 수 있습니다.</span></div>
                <div class="note" id="pvh-chatgpt-stale" hidden><i class="ic ic-info"></i><span>등록된 훅의 앱 경로가 지금과 다릅니다. 스위치를 껐다 켜면 갱신되며, 그 뒤 Codex 에서 다시 신뢰해야 합니다. (앱을 켜면 켜져 있는 연동은 자동으로 갱신됩니다.)</span></div>
              </div>
            </div>

            <!-- AI 서비스: Antigravity (준비 중) -->
            <div class="settings-pane" data-pane="antigravity" hidden>
              <div class="set-head">
                <i class="svc-logo svc-antigravity lg"></i>
                <div><h2>Antigravity</h2><p>Google 계정과 이 PC 의 Antigravity 를 연결합니다.</p></div>
              </div>
              <div class="set-card">
                <div class="card-top"><span class="state-pill" id="pv-antigravity-state"><i class="dot"></i>확인 중</span></div>
                <div class="pv-info" id="pv-antigravity-info"></div>
                <div class="pv-login" id="pv-antigravity-login" hidden></div>
                <div class="note" id="pv-antigravity-webhint" hidden><i class="ic ic-info"></i><span><span data-i18n="web.hint.gemini"></span> <a href="#" data-goto="alerts" data-i18n="web.hint.goto"></a></span></div>
                <label class="set-row">
                  <i class="ic ic-plug row-ic"></i>
                  <div class="row-text"><b>Antigravity 세션을 사무실에 표시</b><small>켜면 Antigravity 대화가 고양이로 출근하고 사용 한도가 오피스 현황에 나옵니다. 사용 한도는 이 PC 에서 실행 중인 Antigravity 에게만 묻습니다 (밖으로 보내는 것 없음).</small></div>
                  <input type="checkbox" class="switch" id="pv-antigravity-on" />
                </label>
              </div>
              <div class="set-card" id="pvh-antigravity-card">
                <div class="card-title row-titled"><i class="ic ic-shield-check"></i><b>권한 요청·응답 완료 연동</b><span class="state-pill" id="pvh-antigravity-state"><i class="dot"></i>꺼짐</span></div>
                <label class="set-row">
                  <i class="ic ic-plug row-ic"></i>
                  <div class="row-text"><b>Antigravity 권한 요청을 알림 카드에서 수락/거절, 응답 완료 알림</b><small>켜면 <code id="pvh-antigravity-path">~/.gemini/config/hooks.json</code> 에 Meowffice 훅을 추가합니다(기존 훅은 그대로, 처음 한 번 백업, 끄면 이 앱 항목만 삭제). 권한 카드는 Antigravity 가 직접 물었을 터미널 명령(run_command)에만 뜹니다(Antigravity 의 권한 설정은 읽기만 함). Turbo·터미널 샌드박스 모드처럼 Antigravity 가 묻지 않고 실행하는 설정에서는 카드 훅을 등록하지 않고 '응답 완료' 알림만 켜집니다(설정을 바꾸면 이 앱을 켤 때·스위치를 다시 켤 때 맞춰집니다). 앱이 꺼져 있으면 Antigravity 가 평소대로 동작합니다.</small></div>
                  <input type="checkbox" class="switch" id="pvh-antigravity-on" />
                </label>
                <label class="set-row">
                  <i class="ic ic-zap row-ic"></i>
                  <div class="row-text"><b>자동 수락</b><small>터미널 명령 실행 전 확인을 카드 없이 바로 수락합니다. 기본은 꺼짐.</small></div>
                  <input type="checkbox" class="switch" id="pvh-antigravity-auto" />
                </label>
                <div class="note" id="pvh-antigravity-stale" hidden><i class="ic ic-info"></i><span>등록된 훅의 앱 경로가 지금과 다릅니다. 스위치를 껐다 켜면 갱신됩니다. (앱을 켜면 켜져 있는 연동은 자동으로 갱신됩니다.)</span></div>
              </div>
            </div>

            <!-- 정보 -->
            <div class="settings-pane" data-pane="info" hidden>
              <div class="set-head">
                <i class="ic ic-info"></i>
                <div><h2>정보</h2><p>버전과 시스템 정보, 개발자 정보, 설정·로그 위치를 확인합니다.</p></div>
              </div>
              <div class="set-grid">
                <div class="set-card">
                  <div class="card-title row-titled"><i class="ic ic-package"></i><b>버전 정보</b></div>
                  <dl class="kv kv-right">
                    <dt>앱 버전</dt><dd id="app-version">—</dd>
                    <dt>업데이트</dt><dd>상단 버튼에서 확인</dd>
                  </dl>
                </div>
                <div class="set-card">
                  <div class="card-title row-titled"><i class="ic ic-cpu"></i><b>시스템 정보</b></div>
                  <dl class="kv kv-right">
                    <dt>운영체제</dt><dd id="sys-os">—</dd>
                    <dt>아키텍처</dt><dd id="sys-arch">—</dd>
                  </dl>
                </div>
              </div>
              <div class="set-card">
                <div class="card-title row-titled"><i class="ic ic-building"></i><b>개발자 정보</b></div>
                <dl class="kv kv-right">
                  <dt>개발사</dt><dd>주식회사 문어AI <span class="kv-sub">Muneo AI Co., Ltd.</span></dd>
                  <dt>웹사이트</dt><dd><a href="https://muneo.co.kr" class="kv-link" id="dev-web"><i class="ic ic-link"></i>muneo.co.kr</a></dd>
                  <dt>문의</dt><dd><a href="https://github.com/MuneoAX/meowoffice/issues" class="kv-link" id="dev-mail"><i class="ic ic-link"></i>GitHub Issues</a></dd>
                </dl>
              </div>
              <div class="set-card">
                <div class="set-row">
                  <i class="ic ic-file-text row-ic"></i>
                  <div class="row-text"><b>설정 파일</b><small class="mono" id="config-path">—</small></div>
                </div>
              </div>
              <div class="set-card">
                <div class="set-row">
                  <i class="ic ic-activity row-ic"></i>
                  <div class="row-text"><b>로그</b><small>오늘·어제분을 보관합니다. 문제가 있으면 [보내기]로 바로 접수하거나, 내보내기로 저장해 보내 주세요.</small></div>
                  <span class="btn-pair">
                    <button class="btn btn-soft btn-sm" id="btn-log-dir">폴더 열기</button>
                    <button class="btn btn-soft btn-sm" id="btn-log-export">내보내기</button>
                    <button class="btn btn-primary btn-sm" id="btn-log-open-send">보내기</button>
                  </span>
                </div>
                <div class="log-send" id="log-send" hidden>
                  <label class="field-label" for="in-log-symptom">어떤 문제가 있었나요? <span class="log-count" id="log-symptom-count">0/2000</span></label>
                  <textarea class="input log-symptom" id="in-log-symptom" maxlength="2000" rows="4" placeholder="예: 권한을 승인했는데 간식이 늘지 않아요. 오후 2시쯤 사무실 창을 열었다 닫았습니다."></textarea>
                  <p class="log-send-note">보내는 내용: 앱 버전·OS, 이 PC 의 접수를 묶는 무작위 설치 번호, 오늘·어제 로그(사용자 폴더 이름은 가림), 위에 쓴 내용. muneo.co.kr 서버에 90일 보관한 뒤 자동으로 지웁니다(서버는 보낸 곳의 IP 주소도 함께 기록합니다). 로그인 정보(토큰)는 로그에 기록하지 않으며, 보내기 전에 아래에서 로그를 직접 확인할 수 있습니다.</p>
                  <details class="log-preview" id="log-preview"><summary>보낼 로그 보기 <span id="log-preview-size"></span></summary><pre class="mono log-preview-text" id="log-preview-text">불러오는 중…</pre></details>
                  <label class="check-row"><input type="checkbox" id="in-log-consent" /> 위 내용을 보내는 데 동의합니다</label>
                  <div class="log-send-result" id="log-send-result" role="status" aria-live="polite"></div>
                  <div class="log-send-actions">
                    <button class="btn btn-soft btn-sm" id="btn-log-cancel">닫기</button>
                    <button class="btn btn-primary btn-sm" id="btn-log-send" disabled>보내기</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="set-foot">
            <span class="conn-state" id="conn"><i class="dot"></i></span>
            <button class="btn btn-ghost" id="btn-quit">앱 종료</button>
            <button class="btn btn-primary" id="btn-save">저장</button>
          </div>
        </section>
      </div>
    </div>
`;

  /**
   * 설정 화면 마크업을 넣고 모든 동작을 연결한다.
   * MARKUP 을 host 에 삽입 → 위치 검색·서비스 연동 스위치·훅 연동·알림 종류·API 키·저장/닫기 단추 이벤트를 단다. 설정 값은 열 때(openSettings) get_config 로 채우고 [저장]에서 save_config(+save_api_config)로 보낸다.
   * @param {Document|ShadowRoot} root 요소를 id 로 찾을 범위
   * @param {HTMLElement} host 화면을 넣을 요소
   * @param {SettingsOpts} [opts={}] 주입 도구
   * @returns {SettingsApi} 열기·닫기 제어 객체
   * @see openSettings, closeSettings, Tauri 명령 get_config · save_config · save_api_config
   */
  function mount(root, host, opts = {}) {
    host.insertAdjacentHTML('beforeend', MARKUP);
    /**
     * mount 범위(root) 안에서 id 로 요소 찾기.
     * 전역 $ 와 달리 ShadowRoot 에서도 동작하도록 root.getElementById 를 쓴다.
     * @param {string} id 요소 id
     * @returns {HTMLElement|null} 요소
     */
    const $ = (id) => root.getElementById(id);
    const invoke = opts.invoke || null;
    const toast = opts.toast || ((m) => console.log(m));
    const dropEl = $("settings");
    $("btn-quit").addEventListener("click", () => invoke && invoke("quit_app"));
    // 사무실 위치: 도시 이름 검색(Open-Meteo 지명) · 현재 위치 · 자동(컴퓨터 시간대). 고르면 바로 저장 (저장 단추와 별개)
    if (typeof I18N !== "undefined") I18N.apply(root);
    const locNow = $("loc-now"), locQ = $("in-loc-q"), locRes = $("loc-res");
    if (locNow && locQ && typeof meowLocation === "function") {
      /**
       * "지금: 위치" 줄 갱신.
       * 현재 사무실 위치(meowLocation)의 이름을 loc.now 문구로 표시.
       * @returns {void}
       * @see meowLocation (common.js)
       */
      const showNow = () => { const c = meowLocation(); locNow.textContent = t("loc.now", { name: c.name }); };
      /**
       * 사무실 위치를 고르면 바로 저장하고 화면을 정리.
       * setMeowLocation 으로 저장 → 현재 위치 표시 갱신 → 검색 결과·입력 비움 → 토스트. 저장 단추와 별개로 즉시 적용.
       * @param {string} id "auto" | "custom"
       * @param {Place} [place] custom 일 때 { name, lat, lon, tz }
       * @returns {void}
       * @see setMeowLocation, meowLocation
       */
      const pick = (id, place) => {
        setMeowLocation(id, place);
        showNow();
        locRes.hidden = true; locQ.value = "";
        toast(t("loc.changed", { name: meowLocation().name }));
      };
      showNow();
      window.addEventListener("meow-location", showNow);
      let timer = null, seq = 0, found = [];
      /**
       * 도시 검색 입력 처리(디바운스 300ms).
       * 두 글자 미만이면 결과를 숨기고, 아니면 300ms 뒤 MeowWeather.searchPlace 로 찾아 목록을 그린다. 늦게 온 이전 응답은 seq 번호로 버린다.
       * @returns {void}
       * @see MeowWeather.searchPlace
       */
      locQ.addEventListener("input", () => {
        clearTimeout(timer);
        const q = locQ.value.trim();
        if (q.length < 2) { locRes.hidden = true; return; }
        timer = setTimeout(async () => {
          const my = ++seq;
          try {
            found = await MeowWeather.searchPlace(q);
            if (my !== seq) return;
            locRes.innerHTML = found.length
              ? found.map((p, i) => `<button type="button" class="loc-item" data-i="${i}"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.label)} · ${escapeHtml(p.tz)}</small></button>`).join("")
              : `<div class="loc-empty">${escapeHtml(t("loc.search.empty"))}</div>`;
          } catch (_) {
            if (my !== seq) return;
            found = [];
            locRes.innerHTML = `<div class="loc-empty">${escapeHtml(t("loc.search.fail"))}</div>`;
          }
          locRes.hidden = false;
        }, 300);
      });
      /**
       * 도시 검색 입력의 키 처리.
       * Enter 는 첫 결과를 선택, Escape 는 결과 목록을 닫는다.
       * @param {KeyboardEvent} e 키 이벤트
       * @returns {void}
       * @see pick
       */
      locQ.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && found.length && !locRes.hidden) { e.preventDefault(); const p = found[0]; pick("custom", { name: p.label, lat: p.lat, lon: p.lon, tz: p.tz }); }
        if (e.key === "Escape") locRes.hidden = true;
      });
      /**
       * 검색 결과 항목 클릭 → 그 장소를 선택.
       * data-i 로 found 배열의 항목을 찾아 pick("custom", …).
       * @param {MouseEvent} e 클릭 이벤트
       * @returns {void}
       * @see pick
       */
      locRes.addEventListener("click", (e) => {
        const b = e.target.closest("[data-i]");
        if (!b) return;
        const p = found[+b.dataset.i];
        if (p) pick("custom", { name: p.label, lat: p.lat, lon: p.lon, tz: p.tz });
      });
      $("btn-loc-auto").addEventListener("click", () => pick("auto"));
      /**
       * [현재 위치로] 단추: 브라우저 위치 → 시간대 조회 → 저장.
       * geolocation 으로 좌표를 받고(제한 12초) MeowWeather.timezoneAt 으로 시간대를 구한다(실패하면 컴퓨터 시간대). 위치 서비스가 없거나 거부되면 토스트.
       * @returns {void}
       * @see MeowWeather.timezoneAt, pick
       */
      $("btn-loc-cur").addEventListener("click", () => {
        if (!navigator.geolocation) return toast(t("loc.current.fail"));
        navigator.geolocation.getCurrentPosition(async (pos) => {
          const lat = +pos.coords.latitude.toFixed(4), lon = +pos.coords.longitude.toFixed(4);
          const tz = (await MeowWeather.timezoneAt(lat, lon)) || Intl.DateTimeFormat().resolvedOptions().timeZone;
          pick("custom", { name: `${t("loc.current.name")} (${lat.toFixed(2)}, ${lon.toFixed(2)})`, lat, lon, tz });
        }, () => toast(t("loc.current.fail")), { timeout: 12000, maximumAge: 600000 });
      });
    }
    /**
     * 설정 하단 연결 상태 문구 표시.
     * text 가 비면 지우고, 있으면 점 + 이스케이프한 문구를 넣는다.
     * @param {string} text 표시할 문구(빈 문자열이면 지움)
     * @param {string} [cls] 상태 CSS 클래스("ok" | "err")
     * @returns {void}
     */
    function setConn(text, cls) {
      const el = $("conn");
      el.className = "conn-state" + (cls ? " " + cls : "");
      el.innerHTML = text ? `<i class="dot"></i>${escapeHtml(text)}` : "";
    }
    // 다른 AI 서비스(ChatGPT·Antigravity): 연결 상태·계정·한도 표시, "사무실에 표시" 켜고 끄기 (localStorage meow.provider.<이름>)
    const PV = ["chatgpt", "antigravity"];
    /**
     * 이 서비스를 "사무실에 표시"로 켜 뒀는지(화면 사본, 기본 꺼짐).
     * @param {string} n 서비스 이름("chatgpt" | "antigravity")
     * @returns {boolean} 켜짐 여부
     * @see meowProviders.on (common.js)
     */
    const pvOn = (n) => { try { return localStorage.getItem("meow.provider." + n) === "on"; } catch (_) { return false; } }; // 기본 꺼짐
    for (const n of PV) {
      const sw = $(`pv-${n}-on`);
      if (!sw) continue;
      sw.checked = pvOn(n);
      /**
       * "사무실에 표시" 스위치 변경 처리.
       * meowProviders.set 으로 저장(실패 시 토스트), 같은 창의 오피스가 바로 다시 조회하도록 storage 이벤트를 흉내 내 보낸 뒤 서비스 상태를 새로 그린다.
       * @returns {Promise<void>}
       * @see meowProviders.set, refreshProviders
       */
      sw.addEventListener("change", async () => {
        try { await meowProviders.set(n, sw.checked); } catch (e) { toast("저장하지 못했습니다: " + e); }
        window.dispatchEvent(new StorageEvent("storage", { key: "meow.provider." + n })); // 같은 창(오피스)도 바로 다시 조회
        refreshProviders();
      });
    }
    /**
     * 권한 요청 연동(공식 훅) 카드 상태 그리기.
     * 켜고 끄면 바로 훅 파일에 반영한다 (Claude 의 [저장] 방식과 달리 즉시 적용 — 파일 수정 결과를 바로 보여 주려고). 상태 알약·스위치·자동 수락·경로·신뢰/경로 갱신 안내를 맞춘다.
     * @param {string} n 서비스 이름("chatgpt" | "antigravity")
     * @param {ProviderHookState|null} st 훅 상태
     * @returns {void}
     * @see refreshHook, Tauri 명령 get_provider_hook · set_provider_hook
     */
    function renderHook(n, st) {
      const pill = $(`pvh-${n}-state`), on = $(`pvh-${n}-on`), auto = $(`pvh-${n}-auto`);
      if (!pill || !on) return;
      const enabled = !!(st && st.enabled);
      on.checked = enabled;
      auto.checked = enabled && !!st.auto_allow;
      auto.disabled = !enabled;
      pill.className = "state-pill" + (enabled ? " ok" : "");
      pill.innerHTML = `<i class="dot"></i>${enabled ? (st.stale ? "경로 갱신 필요" : "연결됨") : st && st.installed ? "꺼짐(항목 남음)" : "꺼짐"}`;
      if (st && st.path) $(`pvh-${n}-path`).textContent = st.path;
      const trust = $(`pvh-${n}-trust`);
      if (trust) trust.hidden = !enabled;
      $(`pvh-${n}-stale`).hidden = !(enabled && st.stale);
    }
    /**
     * 서비스 훅 상태를 Rust 에서 받아 그린다.
     * Tauri 밖이거나 오류면 아무것도 안 한다.
     * @param {string} n 서비스 이름
     * @returns {Promise<void>}
     * @see get_provider_hook, renderHook
     */
    async function refreshHook(n) {
      if (!invoke) return;
      try { renderHook(n, await invoke("get_provider_hook", { name: n })); } catch (_) {}
    }
    /**
     * 위험한 설정을 켜기 전에 묻는 확인 창(설정 창 위). [켜기]면 true, [취소]·바깥 클릭·Esc 면 false.
     * window.confirm 은 macOS 웹뷰에서 뜨지 않을 수 있어 직접 그린다.
     * @param {string} title 제목
     * @param {string} body 설명 (글자 그대로 표시)
     * @returns {Promise<boolean>} 켜기로 했으면 true
     */
    function confirmRisk(title, body) {
      return new Promise((resolve) => {
        const ov = document.createElement("div");
        ov.className = "overlay";
        ov.style.cssText = "position:fixed;z-index:60";
        ov.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true"><b style="font-size:14px"></b><p style="margin:10px 0 16px;font-size:12px;line-height:1.6;color:var(--text2);white-space:pre-line"></p><div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-soft" data-k="0">취소</button><button class="btn btn-ghost" data-k="1">켜기</button></div></div>`;
        ov.querySelector("b").textContent = title;
        ov.querySelector("p").textContent = body;
        const done = (ok) => { document.removeEventListener("keydown", onKey, true); ov.remove(); resolve(ok); };
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } };
        ov.addEventListener("click", (e) => { const k = e.target.closest("[data-k]"); if (k) done(k.dataset.k === "1"); else if (e.target === ov) done(false); });
        document.addEventListener("keydown", onKey, true);
        $("settings").parentNode.appendChild(ov); // 설정 화면과 같은 (그림자) DOM — 설정 스타일이 적용되게
        ov.querySelector('[data-k="0"]').focus();
      });
    }
    /** 자동 수락을 켤 때 확인 창에 보이는 경고 */
    const AUTO_ALLOW_WARN = "AI 가 요청하는 파일 수정·명령 실행이 묻지 않고 바로 실행됩니다.\n잘못된 명령이나 악성 지시(프롬프트 주입)도 그대로 실행될 수 있습니다. 믿을 수 있는 작업에서만 켜세요.";
    $("in-auto-allow").addEventListener("change", async () => {
      const sw = $("in-auto-allow"); // 그림자 DOM 에선 이벤트가 끝나면 e.target 이 비워지므로 요소를 직접 잡는다
      if (!sw.checked) return;
      if (!(await confirmRisk("자동 수락 모드를 켤까요?", AUTO_ALLOW_WARN))) sw.checked = false;
    });
    for (const n of PV) {
      const on = $(`pvh-${n}-on`), auto = $(`pvh-${n}-auto`);
      if (!on) continue;
      /**
       * 훅 연동 스위치(켬/자동 수락) 변경을 훅 파일에 적용.
       * 두 스위치를 잠그고 set_provider_hook 호출 → 결과로 카드를 그리고 토스트(경고·ChatGPT 는 신뢰 안내). 실패하면 revert() 로 스위치를 되돌리고 상태를 다시 읽는다.
       * @param {function():void} revert 실패 시 스위치를 되돌리는 함수
       * @returns {Promise<void>}
       * @see set_provider_hook, renderHook, refreshHook
       */
      const apply = async (revert) => {
        on.disabled = auto.disabled = true;
        try {
          const st = await invoke("set_provider_hook", { name: n, enabled: on.checked, autoAllow: auto.checked });
          renderHook(n, st);
          toast(st.warning ? st.warning : on.checked ? (n === "chatgpt" ? "연동했습니다. Codex 앱에서 훅을 신뢰해 주세요" : "연동했습니다") : "연동을 껐습니다");
        } catch (e) {
          revert();
          toast("적용하지 못했습니다: " + e);
          await refreshHook(n);
        }
        on.disabled = false;
        auto.disabled = !on.checked;
      };
      on.addEventListener("change", () => apply(() => { on.checked = !on.checked; }));
      auto.addEventListener("change", async () => {
        if (auto.checked && !(await confirmRisk("자동 수락을 켤까요?", AUTO_ALLOW_WARN))) { auto.checked = false; return; }
        apply(() => { auto.checked = !auto.checked; });
      });
    }
    // 로그인 안내: 켜 둔 서비스가 설치돼 있는데 로그아웃·만료일 때만 보인다. 버튼을 눌러야만 실행 (자동 실행 없음)
    const PV_LOGIN = {
      chatgpt: { btn: "Codex 로그인", how: "버튼을 누르면 터미널에서 codex login 을 실행합니다. Codex CLI 를 찾지 못하면 Codex 앱을 엽니다." },
      antigravity: { btn: "Antigravity 앱 열기", how: "버튼을 누르면 Antigravity 앱을 엽니다. 앱에서 Google 계정으로 로그인하세요." },
    };
    /**
     * 로그인 안내 상자 표시.
     * PV_LOGIN 의 문구와 [로그인] 단추를 그린다. 단추를 누르면 provider_login 을 실행(터미널 CLI 또는 앱 열기), 15초 뒤 서비스 상태를 다시 읽고 4초 뒤 단추를 푼다.
     * @param {string} n 서비스 이름
     * @param {boolean} expired true 면 "만료", false 면 "필요" 문구
     * @returns {void}
     * @see PV_LOGIN, Tauri 명령 provider_login, refreshProviders
     */
    function showLoginGuide(n, expired) {
      const box = $(`pv-${n}-login`), g = PV_LOGIN[n];
      if (!box || !g) return;
      box.hidden = false;
      box.innerHTML = `<b>${expired ? "로그인이 만료되었습니다" : "로그인이 필요합니다"}</b><p>${escapeHtml(g.how)}</p><button class="btn btn-primary btn-sm" data-pv-login="${n}">${escapeHtml(g.btn)}</button><small class="pv-login-msg"></small>`;
      box.querySelector("button").addEventListener("click", async (ev) => {
        const b = ev.currentTarget, msg = box.querySelector(".pv-login-msg");
        b.disabled = true;
        try {
          const how = await invoke("provider_login", { name: n });
          msg.textContent = how === "cli" ? "터미널 창에서 로그인을 진행하세요. 끝나면 이 화면이 자동으로 갱신됩니다." : "앱을 열었습니다. 앱에서 로그인하세요.";
          setTimeout(refreshProviders, 15000);
        } catch (e) { msg.textContent = "실행하지 못했습니다: " + e; }
        setTimeout(() => { b.disabled = false; }, 4000);
      });
    }
    /**
     * ChatGPT·Antigravity 연결 상태·계정·한도 카드를 새로 그린다.
     * 꺼진 서비스는 아무것도 읽지 않고 "꺼짐". 켜진 서비스는 get_provider 스냅샷으로 알약·사이드 상태·정보 줄(계정·요금제·한도·진행 중 세션·참고)을 그리고, 설치돼 있는데 로그아웃·만료면 로그인 안내를 띄운다.
     * @returns {Promise<void>}
     * @see Tauri 명령 get_provider, pvOn, showLoginGuide
     */
    async function refreshProviders() {
      if (!invoke) return;
      await Promise.all(PV.map(async (n) => {
        const pill = $(`pv-${n}-state`), info = $(`pv-${n}-info`), nav = $(`nav-${n}-state`), login = $(`pv-${n}-login`), hint = $(`pv-${n}-webhint`);
        if (!pill) return;
        if (login) { login.hidden = true; login.innerHTML = ""; }
        if (hint) hint.hidden = true;
        if (!pvOn(n)) {
          // 꺼져 있으면 로그인 정보를 읽지도, 네트워크에 묻지도 않는다
          // 웹만 쓰는 사용자는 연동을 켜지 않으므로, 꺼진 상태에서도 웹 안내를 보인다
          if (hint) hint.hidden = false;
          pill.className = "state-pill";
          pill.innerHTML = `<i class="dot"></i>꺼짐`;
          if (nav) { nav.textContent = ""; nav.className = "nav-state"; }
          info.innerHTML = "";
          return;
        }
        let snap = null;
        try { snap = await invoke("get_provider", { name: n }); } catch (_) {}
        const st = (snap && snap.state) || "not_installed";
        const ok = st === "connected" || st === "degraded";
        pill.className = "state-pill" + (ok ? " ok" : "");
        pill.innerHTML = `<i class="dot"></i>${escapeHtml(I18N.t("conn." + st))}`;
        if (nav) { nav.textContent = ok ? "연동" : st === "not_installed" ? "" : "로그인"; nav.className = "nav-state" + (ok ? "" : " soon"); }
        if (hint) hint.hidden = st !== "not_installed";
        const rows = [];
        if (snap && snap.account) rows.push(["계정", snap.account]);
        if (snap && snap.plan) rows.push(["요금제", snap.plan]);
        for (const l of (snap && snap.limits) || []) if (l.percent != null) rows.push([l.label || l.kind, `${Math.round(l.percent)}% 사용`]);
        if (snap) rows.push(["최근 세션", `${(snap.sessions || []).filter((x) => x.status).length}개 진행 중`]);
        if (snap && snap.error) rows.push(["참고", snap.error]);
        info.innerHTML = rows.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join("");
        if (st === "logged_out" || st === "expired") showLoginGuide(n, st === "expired");
      }));
    }
    /**
     * 설정 열기.
     * 서비스 훅·연동 사본을 설정 파일 기준으로 맞추고, get_config 결과(Cfg)로 모든 입력·표시를 채운 뒤 지정한 메뉴(기본 일반)로 보이게 한다. 설정을 못 읽으면 API 설정 저장은 건드리지 않도록 apiCfgLoaded=false 로 둔다.
     * @param {string} [pane="general"] 메뉴 이름(general|alerts|claude|chatgpt|antigravity|info)
     * @returns {Promise<void>}
     * @see Tauri 명령 get_config, refreshHook, refreshProviders, renderKinds, syncAutoAllow, syncApiKey, setSideStatus, setSettingsPane
     */
    async function openSettings(pane) {
      // 연동 켬 여부는 설정 파일 기준으로 맞춘 뒤 표시
      for (const n of PV) refreshHook(n);
      meowProviders.sync().then(() => { for (const n of PV) { const sw = $(`pv-${n}-on`); if (sw) sw.checked = pvOn(n); } refreshProviders(); });
      refreshWeb();
      apiCfgLoaded = false;
      if (invoke) {
        try {
          const c = await invoke("get_config");
          apiCfgLoaded = true;
          const sel = $("in-interval");
          sel.value = String(c.refresh_interval_minutes || 5);
          if (!sel.value) sel.value = "5"; // 프리셋에 없는 값이면 기본
          $("in-autostart").checked = !!c.autostart;
          renderKinds(c.alert_kinds || [], c.muted_alert_kinds || []);
          const hide = $("in-auto-hide");
          hide.value = String(c.alert_auto_hide_seconds ?? 30);
          if (!hide.value) hide.value = "30"; // 프리셋에 없는 값이면 기본
          $("in-permit").checked = !!c.permission_hook;
          $("in-auto-allow").checked = !!c.auto_allow;
          syncAutoAllow();
          $("in-desktop").checked = !!c.open_in_desktop;
          $("in-on-top").checked = !!c.panel_on_top;
          apiKeySet = !!c.api_key_set;
          apiClear = false;
          $("in-api-key").value = "";
          $("in-api-alloc").value = c.api_allocated_usd > 0 ? String(c.api_allocated_usd) : "";
          syncApiKey();
          $("in-desktop").disabled = !c.desktop_app && !c.open_in_desktop;
          $("desktop-hint").textContent = c.desktop_app
            ? "Claude 데스크톱 앱이 설치돼 있으면 브라우저 대신 앱에서 엽니다."
            : "Claude 데스크톱 앱이 설치돼 있지 않습니다 — 브라우저로 엽니다.";
          $("app-version").textContent = c.version || "—";
          $("side-version").textContent = c.version || "—";
          $("sys-os").textContent = c.os || "—";
          $("sys-arch").textContent = c.arch || "—";
          $("claude-dir").textContent = c.claude_dir;
          $("hook-addr").textContent = `127.0.0.1:${c.hook_port}`;
          $("nav-claude-state").textContent = c.permission_hook ? "연동" : "";
          $("config-path").textContent = c.config_path;
          const hs = $("hook-state");
          hs.className = "state-pill" + (c.permission_hook ? " ok" : "");
          hs.innerHTML = `<i class="dot"></i>${c.permission_hook ? "연결됨" : "연결 안 됨"}`;
        } catch (_) {}
      }
      setConn("", "");
      setSideStatus();
      setSettingsPane(pane || "general");
      dropEl.hidden = false;
    }
    /**
     * 설정 왼쪽 아래 상태: 마지막 플랜 조회 결과.
     * opts.getPlan() 의 state(없으면 plan 유무)가 연결됨이면 "정상 동작 중", 그 밖의 상태나 error 만 있으면 "연결 확인 필요", 그 외 "확인 중".
     * @returns {void}
     * @see opts.getPlan
     */
    function setSideStatus() {
      const el = $("set-status");
      const lastPlan = opts.getPlan ? opts.getPlan() : null;
      const st = lastPlan?.state;
      const ok = st ? st === "connected" : !!lastPlan?.plan,
        err = !ok && (!!st || !!lastPlan?.error);
      el.className = "set-status" + (ok ? " ok" : err ? " err" : "");
      el.querySelector("span").textContent = ok ? "정상 동작 중" : err ? "연결 확인 필요" : "확인 중";
    }
    /**
     * 웹 서비스 장애 알림 카드(알림 메뉴)를 새로 그린다.
     * Rust get_web_services 결과로 서비스마다 로고·계정·상태 문구·[웹에서 열기]·스위치 한 줄. Claude 는 항상 확인이라 스위치가 잠겨 있다.
     * @returns {Promise<void>}
     * @see Tauri 명령 get_web_services
     */
    async function refreshWeb() {
      const box = $("web-status-rows");
      if (!box) return;
      const list = invoke ? await invoke("get_web_services").catch(() => []) : [];
      const tr = (k, p) => I18N.t(k, p);
      box.innerHTML = list.map((w) => {
        const sub = w.issue ? tr("web.row.issue", { detail: w.issue.detail }) : !w.alertable ? tr("web.row.always") : !w.alerts_on ? tr("web.row.off") : !w.checked ? tr("web.state.checking") : tr("web.row.ok");
        return `<div class="set-row kind-row">
          <i class="svc-logo svc-${escapeHtml(w.id)} row-ic"></i>
          <div class="row-text"><b>${escapeHtml(w.label)}<span class="tag tag-app">${escapeHtml(w.account)}</span></b><small>${escapeHtml(sub)}</small></div>
          <button type="button" class="btn btn-soft btn-sm" data-web-open="${escapeHtml(w.url)}">${escapeHtml(tr("web.open"))}</button>
          <input type="checkbox" class="switch" data-web-alert="${escapeHtml(w.id)}" ${w.alerts_on ? "checked" : ""} ${w.alertable ? "" : "disabled"} />
        </div>`;
      }).join("");
    }
    const webBox = $("web-status-rows");
    if (webBox) {
      /**
       * [웹에서 열기] 단추 → open_url (허용된 주소만 Rust 가 연다).
       * @param {MouseEvent} e 클릭 이벤트
       * @returns {void}
       */
      webBox.addEventListener("click", (e) => {
        const b = e.target.closest("[data-web-open]");
        if (b && invoke) invoke("open_url", { url: b.dataset.webOpen }).catch((err) => toast(String(err)));
      });
      /**
       * 웹 서비스 스위치 → set_web_status_alert 로 바로 저장 (연동 스위치와 같은 방식, [저장] 단추와 무관).
       * 실패하면 스위치를 되돌리고 알린다.
       * @param {Event} e change 이벤트
       * @returns {Promise<void>}
       */
      webBox.addEventListener("change", async (e) => {
        const el = e.target.closest("[data-web-alert]");
        if (!el || !invoke) return;
        try {
          await invoke("set_web_status_alert", { name: el.dataset.webAlert, on: el.checked });
          toast(I18N.t(el.checked ? "web.on.toast" : "web.off.toast"));
          refreshWeb();
        } catch (err) {
          el.checked = !el.checked;
          toast(I18N.t("web.save.fail", { err }));
        }
      });
    }
    // 알림 종류 토글 목록 — 종류 정의(이름·설명·출처)는 Rust(alerts::KINDS)에서 받아 그대로 그림. 켬 = 알림 창에 띄움.
    // 아이콘·출처 뱃지만 화면 쪽 표시 정보.
    const KIND_ICONS = {
      local_done: "message-done",
      local_input: "message-question",
      agent: "bot",
      codex_done: "message-done",
      agy_done: "message-done",
      remote_input: "message-question",
      remote_review: "pull-request",
      update: "download",
      status: "activity",
    };
    const KIND_ORIGINS = {
      local: ORIGIN_BADGES.local,
      remote: { label: "원격·클라우드", cls: "tag-remote" },
      app: { label: "앱", cls: "tag-app" },
    };
    /**
     * 알림 종류 토글 목록 그리기.
     * 종류마다 아이콘·이름·출처 뱃지·설명·스위치 한 줄. 끈 종류(muted)는 체크 해제. 훅이 필요한 종류는 data-hook=1.
     * @param {AlertKind[]} kinds 종류 정의(Rust alerts::KINDS)
     * @param {string[]} muted 끈 종류 id
     * @returns {void}
     * @see KIND_ICONS, KIND_ORIGINS, mutedKinds
     */
    function renderKinds(kinds, muted) {
      $("alert-kinds").innerHTML = kinds
        .map((k) => {
          const o = KIND_ORIGINS[k.origin];
          return `<label class="set-row kind-row" data-hook="${k.needs_hook ? 1 : 0}">
            <i class="ic ic-${KIND_ICONS[k.id] || "bell"} row-ic"></i>
            <div class="row-text"><b>${escapeHtml(k.label)}${o ? `<span class="tag ${o.cls}">${o.label}</span>` : ""}</b><small>${escapeHtml(k.desc || "")}</small></div>
            <input type="checkbox" class="switch" value="${escapeHtml(k.id)}"${muted.includes(k.id) ? "" : " checked"} />
          </label>`;
        })
        .join("");
    }
    /**
     * 체크 해제된(끈) 알림 종류 id 목록.
     * @returns {string[]} 끈 종류 id
     * @see save_config 의 mutedAlertKinds
     */
    const mutedKinds = () => [...$("alert-kinds").querySelectorAll("input:not(:checked)")].map((i) => i.value);
    /**
     * 권한 요청 연동 상태에 맞춰 의존 스위치 활성/비활성·안내 표시.
     * 자동 수락·로컬/에이전트 알림은 권한 요청 연동(훅)이 켜져 있어야 의미가 있음.
     * @returns {void}
     */
    function syncAutoAllow() {
      $("in-auto-allow").disabled = !$("in-permit").checked;
      for (const el of $("alert-kinds").querySelectorAll('[data-hook="1"] input')) el.disabled = !$("in-permit").checked;
      $("kinds-hook-note").hidden = $("in-permit").checked;
    }
    $("in-permit").addEventListener("change", syncAutoAllow);
    // 설정 메뉴 — 열 때마다 "일반"부터.
    // API 크레딧 설정: 키는 화면에 다시 보내지 않음 — 비워 두면 그대로, [키 삭제] 후 저장하면 지움.
    let apiKeySet = false;
    let apiClear = false;
    let apiCfgLoaded = false; // 설정을 못 읽었으면 저장 때 API 설정은 건드리지 않음(빈 입력으로 덮어쓰기 방지)
    /**
     * Admin API 키 입력·상태 알약 표시 맞추기.
     * 저장된 키(apiKeySet)와 삭제 예정(apiClear)에 따라 입력 안내문·[키 삭제] 단추·알약 문구를 정한다.
     * @param {string} [text] 알약에 쓸 문구(없으면 상태에 따라 자동)
     * @param {boolean} [ok] 알약을 "ok" 색으로 할지(없으면 저장돼 있는지)
     * @returns {void}
     * @see validate_api_key
     */
    function syncApiKey(text, ok) {
      const has = apiKeySet && !apiClear;
      $("in-api-key").placeholder = apiClear ? "저장하면 키를 삭제합니다" : has ? "저장됨 — 바꾸려면 새 키 입력" : "sk-ant-admin...";
      $("btn-api-clear").hidden = !has;
      const st = $("api-key-state");
      st.className = "state-pill" + ((ok ?? has) ? " ok" : "");
      st.innerHTML = `<i class="dot"></i>${escapeHtml(text || (apiClear ? "삭제 예정" : has ? "저장됨" : "키 없음"))}`;
    }
    /**
     * [키 삭제]: 저장 때 키를 지우도록 표시.
     * apiClear 를 켜고 입력을 비운 뒤 알약을 "삭제 예정"으로.
     * @returns {void}
     * @see syncApiKey
     */
    $("btn-api-clear").addEventListener("click", () => {
      apiClear = true;
      $("in-api-key").value = "";
      syncApiKey();
    });
    /**
     * 키 입력 시 삭제 예정을 취소하고 상태를 다시 그린다.
     * @returns {void}
     * @see syncApiKey
     */
    $("in-api-key").addEventListener("input", () => {
      if ($("in-api-key").value) apiClear = false;
      syncApiKey();
    });
    /**
     * [검증]: 입력한 키를 validate_api_key 로 확인.
     * 입력이 비어 있고 저장된 키도 없으면 안내만. 확인 중 → 연결됨 / 오류 문구를 알약에 표시한다.
     * @returns {Promise<void>}
     * @see Tauri 명령 validate_api_key, syncApiKey
     */
    $("btn-api-validate").addEventListener("click", async () => {
      if (!invoke) return;
      const key = $("in-api-key").value.trim();
      if (!key && (!apiKeySet || apiClear)) return syncApiKey("키를 입력하세요", false);
      syncApiKey("확인 중…", false);
      try {
        await invoke("validate_api_key", { key });
        syncApiKey("연결됨", true);
      } catch (e) {
        syncApiKey(String(e), false);
      }
    });

    /**
     * 설정 메뉴 전환.
     * 예전 메뉴 이름(hook·api)은 claude 로 바꾼다. 해당 메뉴 단추 강조·본문 표시를 맞추고 스크롤을 맨 위로. (열 때마다 "일반"부터는 openSettings 가 호출.)
     * @param {string} name 메뉴 이름
     * @returns {void}
     * @see openSettings
     */
    function setSettingsPane(name) {
      if (name === "hook" || name === "api") name = "claude"; // 예전 메뉴 이름
      for (const b of $("settings-tab").querySelectorAll("button")) b.classList.toggle("on", b.dataset.pane === name);
      for (const p of dropEl.querySelectorAll(".settings-pane")) p.hidden = p.dataset.pane !== name;
      dropEl.querySelector(".set-scroll").scrollTop = 0;
    }
    // 안내 문구 속 다른 메뉴 링크(예: 알림 → 연동).
    /**
     * 안내 문구 속 다른 메뉴 링크(data-goto) 클릭 → 그 메뉴로 이동.
     * 예: 알림 → 연동.
     * @param {MouseEvent} e 클릭 이벤트
     * @returns {void}
     * @see setSettingsPane
     */
    dropEl.addEventListener("click", (e) => {
      const a = e.target.closest("[data-goto]");
      if (!a) return;
      e.preventDefault();
      setSettingsPane(a.dataset.goto);
    });
    /**
     * 왼쪽 메뉴 단추 클릭 → 해당 메뉴 표시.
     * @param {MouseEvent} e 클릭 이벤트
     * @returns {void}
     * @see setSettingsPane
     */
    $("settings-tab").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pane]");
      if (b) setSettingsPane(b.dataset.pane);
    });
    /**
     * 설정 창 닫기(숨김).
     * @returns {void}
     */
    function closeSettings() {
      dropEl.hidden = true;
    }
    $("btn-close").addEventListener("click", closeSettings);
    $("btn-preview-alert").addEventListener("click", () => invoke && invoke("preview_alert"));
    /**
     * 바깥(어두운 배경) 클릭 시 설정 닫기.
     * @param {MouseEvent} e 클릭 이벤트
     * @returns {void}
     * @see closeSettings
     */
    dropEl.addEventListener("click", (e) => {
      if (e.target === dropEl) closeSettings();
    });
    /**
     * [저장]: 설정을 Rust 에 보내고 닫는다.
     * save_config 로 일반·알림·연동 값을 저장하고, 설정을 읽어 둔 경우에만 save_api_config(할당 크레딧·키)도 저장한다. 성공하면 onSaved 콜백·"저장됨" 표시 후 0.7초 뒤 닫고, 실패하면 오류를 표시한다.
     * @returns {Promise<void>}
     * @see Tauri 명령 save_config · save_api_config, opts.onSaved, closeSettings
     */
    $("btn-save").addEventListener("click", async () => {
      if (!invoke) return closeSettings();
      const interval = parseInt($("in-interval").value, 10) || 5;
      try {
        await invoke("save_config", {
          refreshIntervalMinutes: interval,
          autostart: $("in-autostart").checked,
          alertAutoHideSeconds: parseInt($("in-auto-hide").value, 10) || 0,
          mutedAlertKinds: mutedKinds(),
          permissionHook: $("in-permit").checked,
          autoAllow: $("in-auto-allow").checked,
          openInDesktop: $("in-desktop").checked,
          panelOnTop: $("in-on-top").checked,
        });
        if (apiCfgLoaded) {
          const alloc = parseFloat($("in-api-alloc").value);
          await invoke("save_api_config", {
            allocated: Number.isFinite(alloc) && alloc > 0 ? alloc : 0,
            key: apiClear ? "" : $("in-api-key").value.trim() || null,
          });
        }
        if (opts.onSaved) opts.onSaved(interval, apiCfgLoaded);
        setConn("저장됨 (갱신 주기는 다음 주기부터 적용)", "ok");
        setTimeout(closeSettings, 700);
      } catch (e) {
        setConn("저장 실패: " + String(e), "err");
      }
    });


    /**
     * 개발사 웹사이트 링크: 기본 브라우저로 연다.
     * Tauri 밖(브라우저 미리보기)에서는 링크 기본 동작. 열기에 실패하면 오류를 토스트.
     * @param {MouseEvent} e 클릭 이벤트
     * @returns {void}
     * @see Tauri 명령 open_url
     */
    $("dev-web").addEventListener("click", (e) => {
      if (!invoke) return;
      e.preventDefault();
      invoke("open_url", { url: "https://muneo.co.kr" }).catch((err) => toast(String(err)));
    });
    /**
     * 개발자 문의: 공개 저장소의 Issues 페이지를 기본 브라우저로 연다.
     * 열기에 실패하면 주소를 클립보드에 복사하고(그것도 안 되면 주소를 토스트) 알린다. 브라우저 미리보기는 링크 기본 동작.
     * @param {MouseEvent} e 클릭 이벤트
     * @returns {void}
     * @see Tauri 명령 open_url
     */
    $("dev-mail").addEventListener("click", (e) => {
      if (!invoke) return; // 브라우저 미리보기는 링크 기본 동작
      e.preventDefault();
      const url = $("dev-mail").href;
      invoke("open_url", { url }).catch(() =>
        navigator.clipboard.writeText(url).then(() => toast("주소를 복사했습니다"), () => toast(url)));
    });
    /**
     * [폴더 열기]: 로그 폴더를 연다(문제 제보 시 이 폴더의 파일을 전달).
     * @returns {void}
     * @see Tauri 명령 open_log_dir
     */
    $("btn-log-dir").addEventListener("click", () => invoke && invoke("open_log_dir").catch((e) => toast(String(e))));
    /**
     * [내보내기]: 로그를 바탕화면으로 내보낸다(문제 제보 시 이 파일을 전달).
     * 저장된 경로의 파일 이름을 토스트로 알린다.
     * @returns {Promise<void>}
     * @see Tauri 명령 export_log
     */
    $("btn-log-export").addEventListener("click", async () => {
      if (!invoke) return;
      try {
        const path = await invoke("export_log");
        toast("로그를 저장했습니다: " + path.split(/[\\/]/).pop());
      } catch (e) {
        toast("로그 내보내기 실패: " + String(e));
      }
    });

    // ── 로그 보내기 (원격 접수) ──────────────────────────────
    // 상태: 닫힘 → 열림(작성) → 보내는 중 → 접수됨(접수번호) | 실패(문구, 다시 보내기 가능). 보내는 중에는 단추를 막아 중복 접수를 막는다.
    const logSend = $("log-send"), logSym = $("in-log-symptom"), logConsent = $("in-log-consent"), logBtn = $("btn-log-send"), logRes = $("log-send-result");
    let logSending = false, logPreviewLoaded = false;
    /**
     * 보내기 단추를 켤지 정한다: 동의에 체크했고 보내는 중이 아닐 때만.
     * @returns {void}
     */
    const logSyncBtn = () => { logBtn.disabled = logSending || !logConsent.checked; logBtn.textContent = logSending ? "보내는 중…" : "보내기"; };
    /**
     * 바이트 수를 읽기 쉬운 크기 글자로.
     * @param {number} n 바이트 수
     * @returns {string} 예: "12.3 KB"
     */
    const sizeText = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(1) + " KB");
    /**
     * [보내기](로그 행): 작성 칸을 열고, 이미 열려 있으면 닫는다. 보내는 중에는 닫지 않고, 접수 결과(접수번호)는 다시 열어도 남겨 둔다.
     * @returns {void}
     */
    $("btn-log-open-send").addEventListener("click", () => {
      if (logSending && !logSend.hidden) return;
      logSend.hidden = !logSend.hidden;
      if (!logSend.hidden) { logSyncBtn(); logSym.focus(); }
    });
    $("btn-log-cancel").addEventListener("click", () => { if (!logSending) logSend.hidden = true; });
    logSym.addEventListener("input", () => { $("log-symptom-count").textContent = `${logSym.value.length}/2000`; });
    logConsent.addEventListener("change", logSyncBtn);
    /**
     * "보낼 로그 보기"를 처음 펼칠 때 가린 로그를 불러온다.
     * @returns {Promise<void>}
     * @see Tauri 명령 log_send_preview
     */
    $("log-preview").addEventListener("toggle", async (e) => {
      if (!e.target.open || logPreviewLoaded || !invoke) return;
      try {
        const p = await invoke("log_send_preview");
        $("log-preview-text").textContent = p.text + (p.cut ? "\n…(화면에는 앞부분만 표시, 보낼 때는 전체)" : "");
        $("log-preview-size").textContent = `(${sizeText(p.bytes)})`;
        logPreviewLoaded = true;
      } catch (err) {
        $("log-preview-text").textContent = "로그를 불러오지 못했습니다: " + String(err);
      }
    });
    /**
     * 접수 결과 칸을 채운다. 성공이면 접수번호와 복사 단추.
     * @param {boolean} ok 성공 여부
     * @param {string} text 보일 문구 (성공이면 접수번호)
     * @param {boolean} [trimmed] 로그 앞부분을 잘랐는가
     * @returns {void}
     */
    const logShow = (ok, text, trimmed) => {
      logRes.className = "log-send-result " + (ok ? "ok" : "err");
      logRes.textContent = "";
      if (!ok) { logRes.textContent = text; return; }
      const b = document.createElement("b"); b.textContent = text;
      const copy = document.createElement("button"); copy.className = "btn btn-soft btn-sm"; copy.textContent = "복사";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(text); copy.textContent = "복사됨"; setTimeout(() => (copy.textContent = "복사"), 1200); } catch (_) { toast("복사하지 못했습니다"); }
      });
      logRes.append("접수됐습니다. 접수번호 ", b, " ", copy, trimmed ? " (로그가 커서 오래된 앞부분은 빼고 보냈습니다)" : "");
    };
    /**
     * [보내기](작성 칸): 증상·동의를 넘겨 서버에 접수한다. 자동 재시도는 하지 않는다(중복 접수 방지).
     * @returns {Promise<void>}
     * @see Tauri 명령 send_log
     */
    logBtn.addEventListener("click", async () => {
      if (!invoke || logSending || !logConsent.checked) return;
      logSending = true; logSyncBtn();
      logRes.className = "log-send-result"; logRes.textContent = "";
      try {
        const r = await invoke("send_log", { symptom: logSym.value, consent: true });
        logShow(true, r.id || "(번호 없음)", r.trimmed);
        logSym.value = ""; $("log-symptom-count").textContent = "0/2000"; logConsent.checked = false;
      } catch (err) {
        logShow(false, String(err));
      } finally {
        logSending = false; logSyncBtn();
      }
    });

    return {
      /**
       * 설정을 연다.
       * @param {string} [pane] 메뉴 이름
       * @returns {Promise<void>}
       * @see openSettings
       */
      open: (pane) => openSettings(pane),
      /**
       * 설정을 닫는다.
       * @returns {void}
       * @see closeSettings
       */
      close: () => closeSettings(),
      /**
       * 열려 있으면 닫고, 닫혀 있으면 연다.
       * @returns {Promise<void>|void}
       * @see openSettings, closeSettings
       */
      toggle: () => (dropEl.hidden ? openSettings() : closeSettings()),
      /**
       * 설정이 열려 있는지.
       * @returns {boolean}
       */
      isOpen: () => !dropEl.hidden,
    };
  }

  return { mount };
})();
