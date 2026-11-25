/**
 * @file 시연용 일과와 요청 이벤트, 실제 세션 모드 연동 (OfficeDemo).
 * 시연용 가짜 일과와 요청 이벤트. (임시) 나중에 Rust office 모듈이 보내는 지시로 대체한다.
 * 평소: 일 → 책장 → 토의 → 커피 → 휴식 → 산책을 섞는다.
 * 요청: 권한(결재 줄) · 질문(팻말) · 완료(상자 배달) · 오류(연기). 사용자가 누르면 카드가 열리고 응답한다.
 * 공개 API: start(office, cats, boss, ui, opts) → { tick, click, clickDesk, state, queue, agents, add, setBusy, remove, syncPermits, autoPermit, grab, drop }.
 * opts.live 면 실제 세션 모드: 가짜 요청 없이 고양이가 add/remove 로 들고 나고, setBusy 로 일/휴식이 정해지며, syncPermits·autoPermit 이 앱의 권한 요청을 결재 줄·팻말로 보여 준다.
 * 시간 단위는 초, 거리·좌표는 m (월드 x·z 가 바닥), 각도는 라디안.
 *
 * @typedef {Object} Spot 사무실의 자리 (office.byKind / office.desks 가 돌려줌)
 * @property {BABYLON.Vector3} pos 자리 위치 (월드, m)
 * @property {number} rotY 바라볼 방향 (라디안)
 * @property {string} [kind] 자리 종류 desk | fish | skate | shelf | board | meeting | present | coffee | cafe | sofa | bench | park | deliver ...
 * @property {string} [act] 앉은 뒤 할 동작 (없으면 idle)
 * @property {string} [room] 속한 회의실 이름 (meeting·present 자리)
 * @property {string|null} [taken] 이 자리를 맡은 고양이 id (비었으면 null)
 * @property {string} [pose] 도착 뒤 자세 (걷기 목적지로 쓸 때)
 *
 * @typedef {Object} Alert 일꾼에게 걸린 요청 하나
 * @property {string} kind 종류 permission(권한) | question(질문) | deliver(완료 배달) | report(실제 세션 작업 완료 보고) | error(오류)
 * @property {number} t 요청이 뜬 뒤 흐른 시간(초)
 * @property {string} [tool] 권한: 도구 이름 (Bash, Edit ...)
 * @property {string} [detail] 권한: 요청 내용
 * @property {string} [desc] 권한: 도구 설명
 * @property {string} [permitId] 실제 요청 id (시연용 가짜 요청이면 없음)
 * @property {boolean} [autoApproved] 이미 자동 허용된 요청인가 (결재 줄·도장 연출만 보임)
 * @property {string} [q] 질문 문장
 * @property {string[]} [options] 질문 선택지 이름들
 * @property {string} [question] 실제 질문 원문 (답을 돌려줄 때 열쇠)
 * @property {boolean} [multi] 여러 개를 고르는 질문인가 (사무실 카드로는 답 못 함)
 * @property {boolean} [queued] 결재 줄에 서 있는 질문인가
 * @property {boolean} [open] 카드가 열려 있는가
 * @property {boolean} [arrived] 배달: 자리에 도착했는가
 * @property {number} [wait] 배달: 도착 뒤 기다린 시간(초)
 * @property {string} [msg] 오류 메시지
 *
 * @typedef {Object} Agent 일꾼 = 고양이 하나와 그 일과 상태
 * @property {Cat} cat 고양이 (cat.js 의 Cat)
 * @property {Spot} desk 맡은 책상
 * @property {Spot|null} spot 지금 예약한 자리
 * @property {Spot|null} [at] 지금 앉아 있는 자리 (이동 중이면 null)
 * @property {number} until 지금 하는 일을 마칠 때까지 남은 시간(초, Infinity 면 무기한)
 * @property {string} what 지금 일과 work | fish | skate | read | board | meeting | coffee | rest | walk | alert
 * @property {Alert|null} alert 걸린 요청
 * @property {string} project 프로젝트 이름
 * @property {boolean} [busy] 이동 중이거나 연출 중이라 새 일을 받지 않는가
 * @property {boolean} [dropped] 결재판을 대표 책상에 올려놓았는가 (자리로 돌아가 답을 기다리는 중)
 * @property {number} [slotIdx] 결재판 내려놓는 줄의 순번 (0 이 책상 정면, 줄에 없으면 null)
 * @property {number} [headT] 책상 위 결재판 중 가장 오래된 요청으로 기다린 시간(초, 시연 자동 결재용)
 * @property {boolean} [pendingLine] 줄이 가득 차 자리가 나기를 기다리는가
 * @property {number} [token] 이동 지시 번호 (바뀌면 지난 걷기·앉기 콜백 무효)
 * @property {boolean} [held] 사용자가 집어 든 상태인가
 * @property {boolean} [leaving] 퇴근 중인가
 * @property {{spots: Spot[], n: number}|null} [leading] 회의 진행 중이면 진행 자리 둘과 순번
 * @property {boolean} [liveBusy] (실시간) 세션이 일하는 중인가
 * @property {boolean} [donePending] (실시간) 바쁨 → 쉼을 한 번 봄 — 다음 조회에서도 쉬면 작업 완료 보고
 * @property {number} [reportAt] (실시간) 마지막 작업 완료 보고 시각 (performance.now ms)
 * @property {Object} [info] (실시간) 세션 정보 (project, busy 등)
 *
 * @typedef {Object} Office OpenOffice 결과 (사무실 장면과 자리·길 안내). 이 파일이 쓰는 부분만
 * @property {function(): boolean} frozen 중정 연못이 얼었는가 (얼면 낚시 대신 스케이트)
 * @property {function(Cat): (Spot|null)} skating 얼음 위에서 오르내리는 중인 고양이의 스케이트 자리
 * @property {Spot[]} desks 책상 자리들
 * @property {Spot} boss 대표 자리
 * @property {function(string): Spot[]} byKind 종류별 자리 목록
 * @property {{pts: BABYLON.Vector3[], slots: {pos: BABYLON.Vector3, rotY: number}[], board: {x: number, z: number, y: number, dy: number, max: number}}} drop 결재판 내려놓는 짧은 줄 자리(slots, 0 이 책상 정면)와 책상 위 결재판 더미 자리(board)
 * @property {function(): boolean} boardAdd 책상에 결재판 하나 올리기
 * @property {function(): boolean} boardRemove 책상 맨 위 결재판 하나 치우기
 * @property {function(): number} boardCount 책상 위에 보이는 결재판 수
 * @property {BABYLON.Vector3[]} walkPoints 산책·퇴근에 쓰는 길목 점들
 * @property {function(Cat, Spot, function(): void): void} stand 앉은 고양이를 일으킨다
 * @property {function(Cat, Spot, function(): void): void} sit 자리에 앉힌다
 * @property {function(Cat, Spot|null): void} release 자리 점유를 푼다 (의자 등)
 * @property {function(Spot|null, BABYLON.Vector3, Spot): Array<{x: number, z: number}>} pathTo 경로 점들
 * @property {function(BABYLON.Vector3, BABYLON.Vector3): Array<{x: number, z: number}>} route 두 점 사이 경로
 * @property {function(Spot, boolean): void} smoke 책상 연기 켜고 끄기
 * @property {function(): void} pileAdd 대표 책상에 완료 상자 하나 쌓기
 * @property {function(): number} pileClear 쌓인 상자를 치우고 개수를 돌려줌
 * @property {function(string): void} unlock 장식 해제 (예 catTower)
 *
 * @typedef {Object} CardSpec ui.card 에 넘기는 카드
 * @property {string} kind permission | question | complete | error
 * @property {string} title 제목
 * @property {string} project 프로젝트 이름
 * @property {Cat} cat 고양이
 * @property {Array<[string, string]>} rows [이름, 내용] 줄들
 * @property {Array<[string, string]>} buttons [단추 id, 글자] 목록
 *
 * @typedef {Object} DemoUi start 에 넘기는 화면 연결
 * @property {function(CardSpec): Promise<string|undefined>} card 카드를 열고 누른 단추 id 를 돌려줌 (닫으면 undefined)
 * @property {function({queue: number, points: number}): void} hud 상단 표시 갱신
 * @property {function(string): void} toast 알림 글 띄우기
 * @property {function(string, Cat): void} [sfx] 울음 소리 (이벤트 이름, 고양이)
 * @property {function(string, Cat): void} [fx] 효과음 (이름, 고양이)
 *
 * @typedef {Object} DemoOpts start 옵션
 * @property {boolean} [live] 실제 세션 모드 (가짜 요청 없음)
 * @property {boolean} [rush] 가짜 요청을 자주 낸다
 * @property {boolean} [noserve] 결재 줄 맨 앞을 자동으로 처리하지 않는다
 * @property {function(string, boolean, Object=): Promise<boolean>} [answer] 앱에 응답을 보낸다 (요청 id, 승인 여부, 질문 답 {질문: 선택})
 *
 * @typedef {Object} PermitReq joinQueue 에 넘기는 실제 요청 요약 (없으면 시연용 무작위 요청)
 * @property {string} [tool] 도구 이름
 * @property {string} [detail] 요청 내용
 * @property {string} [desc] 도구 설명
 * @property {string} [permitId] 요청 id
 * @property {boolean} [autoApproved] 자동 허용 여부
 * @property {string} [q] 질문 문장 (있고 options 도 있으면 질문으로 줄에 섬)
 * @property {string[]} [options] 질문 선택지
 * @property {string} [question] 질문 원문
 * @property {boolean} [multi] 여러 개 고르는 질문
 *
 * @typedef {Object} Permit 앱의 get_permits 가 돌려주는 권한 요청 하나 (이 파일이 읽는 필드만)
 * @property {string} id 요청 id
 * @property {string} session 세션 id
 * @property {string} [provider] 서비스 claude | chatgpt | antigravity (없으면 claude)
 * @property {string} [kind] 'question' 이면 질문, 아니면 도구 권한
 * @property {string} [tool] 도구 이름
 * @property {string} [detail] 요청 내용
 * @property {string} [description] 도구 설명
 * @property {Array<{question?: string, multiSelect?: boolean, options?: Array<{label?: string}|string>}>} [questions] 질문들
 *
 * @typedef {Object} DemoApi start() 가 돌려주는 조종 객체
 * @property {function(number): void} tick 매 프레임
 * @property {function(string): Promise<void>} click 고양이를 눌렀을 때 (고양이 id)
 * @property {function(): void} clickDesk 대표 책상을 눌렀을 때
 * @property {{points: number, unlocked: boolean}} state 간식 점수와 타워 해제 여부
 * @property {Agent[]} queue 결재 대기 일꾼 (요청 순서대로, 결재판을 들고 가는 중이거나 책상에 올려놓은 일꾼)
 * @property {Agent[]} agents 모든 일꾼
 * @property {function(Cat, Object=): (Spot|null)} add 새 세션 고양이 들이기
 * @property {function(string, boolean, Object=): void} setBusy 세션 바쁨 여부 갱신
 * @property {function(string, function(Cat): void): void} remove 세션 끝남 (퇴근)
 * @property {function(Permit[]): void} syncPermits 남은 요청 목록과 맞추기
 * @property {function(Permit): void} autoPermit 이미 자동 허용된 요청 연출
 * @property {function(string): void} turnDone 앱이 알린 작업 완료 → 보고 연출 (turn_done 이벤트)
 * @property {function(string[]): void} markDone 앱이 이미 센 작업 완료 표시 (take_treats 의 recent)
 * @property {function(number): void} giveTreats 오피스 밖에서 모인 몫만큼 간식 지급 (앱의 take_treats 결과)
 * @property {function(Cat): boolean} grab 고양이 집어 들기
 * @property {function(Cat): void} drop 고양이 내려놓기
 */
'use strict';

const OfficeDemo = (() => {
  /**
   * 구간 [a, b) 의 무작위 실수.
   * @param {number} a 최소
   * @param {number} b 최대 (미포함)
   * @returns {number}
   */
  const rnd = (a, b) => a + Math.random() * (b - a);
  /**
   * 배열에서 무작위로 하나 고른다.
   * @template T
   * @param {T[]} arr 후보 배열 (비어 있으면 undefined)
   * @returns {T}
   */
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  /**
   * 시연용 프로젝트 이름들 (일꾼 번호 순서대로 돌려 배정).
   * @type {string[]}
   */
  const PROJECTS = ['meowoffice', 'cat-cafe', 'weather-app', 'shop-api'];
  /**
   * 시연용 권한 요청 표: [도구 이름, 요청 내용].
   * @type {Array<[string, string]>}
   */
  const REQUESTS = [
    ['Bash', 'npm run build'], ['Bash', 'git push origin feat/office'], ['Edit', 'src-tauri/src/main.rs'],
    ['Write', 'ui/office/office.js'], ['WebFetch', 'https://docs.example.com/api'], ['Bash', 'cargo test --release'],
  ];
  /**
   * 시연용 질문 표: [질문 문장, 선택지들].
   * @type {Array<[string, string[]]>}
   */
  const QUESTIONS = [
    ['파일 저장 위치를 어디로 할까요?', ['assets/cats/', 'ui/office/models/', '직접 입력']],
    ['테스트 실패 3건, 어떻게 할까요?', ['고치고 다시 실행', '건너뛰기', '자세히 보기']],
    ['배포 전에 검수 돌릴까요?', ['예', '아니요']],
  ];
  /**
   * 시연용 오류 메시지들.
   * @type {string[]}
   */
  const ERRORS = ['빌드 실패: cannot find module "babylon"', 'API 응답 529 (과부하)', '테스트 시간 초과 (120초)'];

  /**
   * 시연·실시간 일과를 시작한다.
   * office: OpenOffice 결과, cats: 일하는 고양이들, boss: 대표 고양이,
   * ui: { card(spec) → Promise<선택값>, hud(state), toast(text) }
   * opts.live: 실제 세션 모드 — 고양이는 add/remove 로 들고 나고, setBusy 로 일/휴식이 정해진다. 가짜 요청 없음
   * 고양이마다 일꾼(Agent)을 만들어 책상에 앉히고, 대표를 자리에 앉힌 뒤 조종 객체를 돌려준다. 이후 일은 tick(dt) 이 매 프레임 진행한다.
   * @param {Office} office OpenOffice 결과 (자리·길·결재 줄)
   * @param {Cat[]} cats 일하는 고양이들 (office.desks 순서대로 책상 배정)
   * @param {Cat} boss 대표 고양이
   * @param {DemoUi} ui 화면 연결 { card, hud, toast, sfx?, fx? }
   * @param {DemoOpts} [opts={}] live, rush, noserve, answer
   * @returns {DemoApi} 조종 객체 { tick, click, clickDesk, state, queue, agents, add, setBusy, remove, syncPermits, autoPermit, grab, drop }
   */
  function start(office, cats, boss, ui, opts = {}) {
    /**
     * 모든 일꾼 목록 (시연이면 처음 고양이마다 하나, 실시간이면 add/remove 로 변함).
     * @type {Agent[]}
     */
    const agents = cats.map((cat, i) => ({
      cat, desk: office.desks[i], spot: null, until: rnd(1, 12), what: 'work', alert: null,
      project: PROJECTS[i % PROJECTS.length],
    }));
    agents.forEach((a) => {
      reserve(a, a.desk); a.at = a.desk; OfficeCat.setSpot(a.cat, a.desk); a.cat.root.position.y = 0;
      OfficeCat.setPose(a.cat, 'sit', 0.5); OfficeCat.setAct(a.cat, 'type');
    });
    OfficeCat.setSpot(boss, office.boss);
    OfficeCat.setPose(boss, 'sit', 0.5);
    /**
     * 결재 대기 일꾼 (요청 순서대로)
     * @type {Agent[]}
     */
    const queue = []; // 결재 대기 일꾼 (요청 순서대로)
    /**
     * 권한 id 가 없는 자동 허용 요청에 'auto-N' 이름을 붙이기 위한 순번.
     * @type {number}
     */
    let autoPermitSeq = 0;
    /**
     * 자동 허용 간식 왕복 간격(ms): 고양이 한 마리는 이 시간에 한 번만 대표에게 다녀온다.
     * 자동 허용은 1분에 20건 넘게 올 수 있어, 건마다 다녀오면 고양이가 책상에 앉지 못한다. 그 사이 온 요청은 개수(agent.autoN)만 센다.
     * @type {number}
     */
    const AUTO_TRIP_MS = 120000;
    /**
     * 사용자 결정을 기다리는 줄의 일꾼인가 (자동 허용 왕복 중인 일꾼은 제외).
     * @param {Agent} x 줄에 선 일꾼
     * @returns {boolean}
     */
    const isWaiting = (x) => !(x.alert && x.alert.autoApproved);
    /**
     * 간식을 저장해 두는 localStorage 열쇠 (실시간 모드만 — 오피스 창은 닫으면 없어지므로 다시 열어도 이어지게).
     * @type {string}
     */
    const TREATS_KEY = 'meow.office.treats';
    /**
     * 간식 점수(points)와 고양이 타워 해제 여부(unlocked). 실시간 모드면 저장해 둔 값에서 시작한다.
     * @type {{points: number, unlocked: boolean}}
     */
    const state = (() => {
      const s0 = { points: 0, unlocked: false, cats: {}, spent: 0 };
      if (!opts.live) return s0;
      // 앱 데이터 폴더 파일(opts.savedProgress, 업데이트에도 남음)과 예전 localStorage 값 중 큰 쪽 — 옮겨 오는 동안 잃지 않게
      let ls = null;
      try { ls = JSON.parse(localStorage.getItem(TREATS_KEY) || 'null'); } catch (_) { /* 저장소를 못 쓰면 파일 값만 */ }
      const ok = (v) => v && Number.isFinite(v.points) && v.points >= 0;
      const fp = opts.savedProgress;
      const pts = Math.floor(Math.max(ok(fp) ? fp.points : 0, ok(ls) ? ls.points : 0));
      const unlocked = !!((ok(fp) && fp.unlocked) || (ok(ls) && ls.unlocked)) || pts >= 10;
      // 고양이(품종)별 경험치: 둘 중 큰 쪽
      const cats = {};
      for (const src of [fp && fp.cats, ls && ls.cats]) if (src && typeof src === 'object') for (const [k, v] of Object.entries(src)) if (Number.isFinite(v) && v > (cats[k] || 0)) cats[k] = Math.floor(v);
      const spent = Math.floor(Math.max(ok(fp) && Number.isFinite(fp.spent) ? fp.spent : 0, ok(ls) && Number.isFinite(ls.spent) ? ls.spent : 0));
      return { points: pts, unlocked, cats, spent };
    })();
    /**
     * 남은 간식(받은 누계 - 고양이에게 준 누계).
     * @returns {number}
     */
    const balance = () => Math.max(0, state.points - (state.spent || 0));
    /**
     * 진행 기록(간식 누계·타워·고양이별 경험치) 저장: 앱 데이터 폴더(set_progress, 설정과 같은 곳)와 localStorage(앱 명령이 없을 때 대비) 둘 다.
     * @returns {void}
     */
    const saveTreats = () => {
      try { localStorage.setItem(TREATS_KEY, JSON.stringify(state)); } catch (_) { /* 무시 */ }
      try { if (window.__TAURI__) window.__TAURI__.core.invoke('set_progress', { progress: { points: state.points, unlocked: state.unlocked, cats: state.cats, spent: state.spent || 0 } }).catch(() => {}); } catch (_) { /* 무시 */ }
    };
    if (opts.live && (!opts.savedProgress || opts.savedProgress.points !== state.points)) saveTreats(); // 처음 한 번: localStorage 값을 파일로 옮긴다
    /**
     * 경험치 → 레벨. 레벨 L 에 필요한 누적 경험치 = 5 × L(L-1)/2 (Lv2 5 · Lv3 15 · Lv4 30 · Lv5 50 …) — 오를수록 조금씩 더 든다.
     * @param {number} xp 경험치(받아 온 간식 수)
     * @returns {number} 레벨 (1부터)
     */
    const levelFromXp = (xp) => { let l = 1; while (5 * l * (l + 1) / 2 <= xp) l++; return l; };
    /**
     * 품종의 레벨과 경험치.
     * @param {string} breed 품종
     * @returns {{level: number, xp: number, next: number}} next = 다음 레벨까지 필요한 누적 경험치
     */
    const levelOf = (breed) => { const xp = state.cats[breed] || 0, level = levelFromXp(xp); return { level, xp, next: 5 * level * (level + 1) / 2 }; };
    if (state.unlocked) office.unlock('catTower');
    /**
     * 다음 가짜 요청까지 남은 시간(초).
     * @type {number}
     */
    let nextEvent = rnd(2, 5);
    /**
     * 지난 프레임의 연못 결빙 여부 (얼거나 녹는 순간을 잡는다).
     * @type {boolean}
     */
    let wasFrozen = office.frozen();
    /**
     * 가짜 요청 간격 범위 [최소, 최대] (초). rush 면 짧게.
     * @type {number[]}
     */
    const rate = opts.rush ? [1.2, 2.5] : [6, 11];

    /**
     * 일꾼의 자리 예약을 바꾼다: 이전 자리의 taken 을 풀고 새 자리에 이 고양이 id 를 적는다.
     * @param {Agent} a 일꾼
     * @param {Spot|null} s 새 자리 (null 이면 예약 해제)
     * @returns {void}
     */
    function reserve(a, s) {
      if (a.spot && a.spot !== s) a.spot.taken = null;
      a.spot = s;
      if (s) s.taken = a.cat.id;
    }
    /**
     * 종류별 빈 자리 목록 (taken 이 없는 것).
     * @param {string} kind 자리 종류
     * @returns {Spot[]}
     */
    function free(kind) { return office.byKind(kind).filter((s) => !s.taken); }
    /**
     * 일꾼을 자리로 보낸다: (앉아 있었다면) 일어나기 → 걷기 → 자리 앞에서 앉기(의자 빼고 앉아 당기기).
     * 머무는 시간(stay)은 앉은 뒤부터 센다.
     * 그사이 다른 지시가 오면(token 이 바뀌면) 남은 콜백은 무효가 된다. waypoints 가 있으면 그 점들을 차례로 거쳐 간다.
     * 앉는 중·일어서는 중에 새 지시가 오면 그 움직임(tween)을 먼저 끊는다(a.moveSpot). 안 끊으면 끝날 때 자세를 덮어써
     * 앉은 채로 걷는다(2026-11-20 삼색이 제보).
     * @param {Agent} a 일꾼
     * @param {Spot} s 목적지 자리 (kind 가 없으면 예약하지 않는 임시 자리)
     * @param {number} stay 앉은 뒤 머물 시간(초, Infinity 면 무기한)
     * @param {function(): void} [then] 앉은 직후 부를 콜백
     * @param {BABYLON.Vector3[]} [waypoints] 거쳐 갈 길목 점들
     * @returns {void}
     * @see reserve
     */
    function goTo(a, s, stay, then, waypoints) {
      // 책 읽기·커피 흐름이 아닌 다른 지시가 오면 들고 있던 책·잔은 내려놓는다(사라짐). 흐름 안의 이동은 keep 표시(a.keepGear)로 유지
      if (!a.keepGear) { a.book = null; a.cat.book = null; a.cat.cup = false; }
      a.keepGear = false;
      const from = a.at || office.skating(a.cat); // 얼음에서 나가는 중에 다른 지시가 와도 물가로 나온 뒤 출발
      // 보고 자리(대표 책상 앞)는 로비 서쪽 길로 드나든다: 동쪽에서 오가면 결재판 줄에 선 고양이들을 뚫고 지나가 서로 막힌다
      if (!waypoints && office.drop.report) {
        if (s.kind === 'deliver') waypoints = office.drop.report;
        else if (from && from.kind === 'deliver') waypoints = [office.drop.report[0]];
      }
      if (!from && a.moveSpot) office.release(a.cat, a.moveSpot); // 앉는 중·일어서는 중이던 움직임을 완료 콜백 없이 끊는다
      a.moveSpot = from || null; // 일어서는 동안
      a.at = null;
      a.busy = true;
      reserve(a, s.kind ? s : null);
      a.until = Infinity;
      OfficeCat.setAct(a.cat, 'idle');
      const token = (a.token = (a.token || 0) + 1);
      /**
       * 앉아 있었다면 일어난 뒤, 아니면 곧바로 done 을 부른다.
       * @param {function(): void} done 일어난 뒤 이어서 할 일
       * @returns {void}
       */
      const leave = (done) => (from ? office.stand(a.cat, from, done) : done());
      leave(() => {
        if (token !== a.token) return; // 그사이 다른 지시가 왔다
        a.moveSpot = null; // 다 일어났다 (의자 밀어 넣기는 그 자리를 다른 고양이가 쓸 수 있으니 끊지 않는다)
        let pts;
        if (waypoints && waypoints.length) {
          pts = office.pathTo(from, a.cat.root.position, { pos: waypoints[0] });
          let cur = waypoints[0];
          for (const w of waypoints.slice(1)) { pts.push(...office.route(cur, w)); cur = w; }
          pts.push(...office.pathTo(null, cur, s));
        } else {
          pts = office.pathTo(from, a.cat.root.position, s);
        }
        OfficeCat.walk(a.cat, pts, null, () => {
          if (token !== a.token) return;
          a.moveSpot = s; // 앉는 동안
          office.sit(a.cat, s, () => {
            if (token !== a.token) return;
            a.moveSpot = null;
            a.at = s.kind ? s : null;
            a.busy = false;
            OfficeCat.setAct(a.cat, s.act || 'idle');
            a.until = stay;
            if (then) then();
          });
        });
      });
    }
    /**
     * 고양이 끌어 옮기기: 집어 들면 하던 일을 멈추고, 놓으면 그 자리에 5초(DROP_STAY) 머문 뒤 제 책상으로 걸어 돌아간다.
     * 결재 줄에 섰거나 알림(배달·질문·오류)을 처리 중인 고양이는 집지 않는다.
     * 집을 수 있으면 지난 걷기·앉기 콜백을 무효로 하고 자리를 놓아 서 있는 자세로 둔 뒤 held 로 표시한다.
     * @param {Cat} cat 집을 고양이
     * @returns {boolean} 집었으면 true, 집을 수 없는 상태면 false
     * @see drop
     */
    function grab(cat) {
      const a = agents.find((x) => x.cat === cat);
      if (!a || a.alert || a.leaving || cat.landing || queue.includes(a)) return false;
      a.token = (a.token || 0) + 1; // 걷기·앉기 끝 콜백 무효
      office.release(cat, a.at || a.moveSpot || a.spot); // 일어서는 중이면 떠나는 자리의 의자까지
      a.moveSpot = null;
      reserve(a, null);
      a.at = null; a.busy = true; a.until = Infinity; a.held = true; cat.held = true;
      cat.path = null; cat.goal = null; cat.onArrive = null; cat.base = null;
      OfficeCat.setPose(cat, 'stand');
      OfficeCat.setAct(cat, 'idle');
      return true;
    }
    /**
     * 놓은 뒤 그 자리에 머무는 시간(초): 옮겨 놓은 고양이에게 간식을 줄 틈.
     * @type {number}
     */
    const DROP_STAY = 5;
    /**
     * 집어 든 고양이를 놓는다: held 를 풀고 DROP_STAY 초 동안 그 자리에 서 있다가 제 책상으로 걸어 돌아가 일하게 한다.
     * 그사이 다른 지시(간식 반응·다시 집기·결재 줄·퇴근)가 오면 token 이 바뀌어 책상 복귀는 취소된다.
     * @param {Cat} cat 놓을 고양이 (집힌 상태가 아니면 아무 일도 없음)
     * @returns {void}
     * @see grab
     * @see goTo
     */
    function drop(cat) {
      const a = agents.find((x) => x.cat === cat);
      if (!a || !a.held) return;
      a.held = false; cat.held = false;
      cat.root.position.y = 0;
      a.what = 'work';
      a.busy = true; a.until = Infinity; // 머무는 동안 다른 일과를 고르지 않게
      const token = (a.token = (a.token || 0) + 1);
      timer(DROP_STAY, () => {
        if (token !== a.token || a.held || a.alert || a.leaving) return; // 그사이 다른 지시가 왔다
        goTo(a, a.desk, rnd(20, 45));
      });
    }
    /**
     * 잠깐 다른 동작을 했다가 되돌리기
     * act 를 sec 초 동안 하다가 그 동작이 그대로면 idle 로 되돌리고 after 를 부른다.
     * @param {Cat} cat 고양이
     * @param {string} act 잠깐 할 동작
     * @param {number} sec 지속 시간(초)
     * @param {function(): void} [after] 끝난 뒤 부를 콜백
     * @returns {void}
     * @see timer
     */
    function briefly(cat, act, sec, after) {
      OfficeCat.setAct(cat, act);
      timer(sec, () => { if (cat.act === act) OfficeCat.setAct(cat, 'idle'); if (after) after(); });
    }

    /**
     * 회의 진행: 진행 자리 둘을 번갈아 가서 4~6초씩 말한다
     * 팀원이 다 빠지면 회의를 끝내고 일하러 돌려보낸다.
     * @param {Agent} a 회의를 이끄는 일꾼 (a.leading 이 있어야 함)
     * @returns {void}
     * @see goTo
     * @see work
     */
    function lead(a) {
      const L = a.leading;
      if (!L) return;
      if (!agents.some((b) => b !== a && b.what === 'meeting')) { work(a); return; } // 팀원이 다 빠지면 회의 끝
      const s = L.spots[L.n % 2];
      L.n++;
      goTo(a, s, rnd(4, 6), () => OfficeCat.setAct(a.cat, 'talk'));
    }

    /**
     * 일꾼을 제 책상으로 보내 일하게 한다 (20~45초 머문 뒤 다음 일과).
     * 실시간 모드에서 세션이 일을 시작했으면 걷는 속도를 1.8배로 서둘러 자리로 간다.
     * @param {Agent} a 일꾼
     * @returns {void}
     * @see goTo
     */
    function work(a) {
      a.leading = null;
      a.what = 'work';
      // 실제 세션이 일을 시작했으면 자리로 서둘러 간다 (밖에 있다가도 빨리 돌아오게)
      a.cat.hurry = opts.live && a.liveBusy ? 1.8 : 1;
      goTo(a, a.desk, rnd(20, 45), () => { a.cat.hurry = 1; });
    }

    /**
     * 일과 표: [이름, 가중치, 시작 함수(a) → 시작했으면 true / 갈 곳이 없으면 false].
     * 가중치 비율로 무작위 선택한다: work 4, fish 0.8(얼지 않았을 때) · skate 0.8(얼었을 때), read 1(책장), board 0.5(게시판), meeting 1.2, coffee 1.2, rest 1(소파), walk 0.7(벤치·공원).
     * 시작 함수는 자리를 구해 goTo 로 보낸다. 자리가 없으면 false 를 돌려줘 chooseNext 가 다른 일을 고른다.
     * @type {Array<[string, number, function(Agent): boolean]>}
     */
    const ACTS = [
      ['work', 4, (a) => { work(a); return true; }],
      ['fish', 0.8, (a) => { if (office.frozen()) return false; const s = free('fish'); if (!s.length) return false; goTo(a, pick(s.filter((x) => x.id.startsWith('fish-b')).length && Math.random() < 0.75 ? s.filter((x) => x.id.startsWith('fish-b')) : s), rnd(14, 24)); return true; }],
      // 연못이 얼면 낚시 대신 스케이트: 물가로 가서 얼음 위 고리를 돈다 (오르내림은 office.sit / stand 의 skate 갈래)
      ['skate', 0.8, (a) => { if (!office.frozen()) return false; const s = free('skate'); if (!s.length) return false; goTo(a, pick(s), rnd(16, 26)); return true; }],
      /**
       * 책 읽기: 책장 앞(선 자리)에서 책을 꺼내(reach) 덮은 채 들고 → 서재 책상·읽는 소파로 가 앉아 펼쳐 읽고(3.5초마다 한 장) →
       * 시간이 다 되면 덮고(returnBook) 같은 책장으로 돌아가 꽂는다. 앉을 자리가 없으면 책장 앞에 서서 읽는다.
       * @param {Agent} a 일꾼
       * @returns {boolean} 시작했으면 true
       */
      ['read', 1, (a) => {
        const shelves = free('shelf').filter((s) => s.pose === 'stand');
        if (!shelves.length) return false;
        const sh = pick(shelves);
        goTo(a, sh, Infinity, () => {
          if (a.what !== 'read') return;
          briefly(a.cat, 'reach', 1.1, () => {
            if (a.what !== 'read') return;
            a.book = { shelf: sh };
            a.cat.book = 'closed';
            const seats = free('shelf').filter((s) => s.pose === 'sit').concat(free('sofa').filter((s) => s.act === 'read'));
            if (!seats.length) { a.cat.book = 'open'; OfficeCat.setAct(a.cat, 'read'); a.until = rnd(9, 14); return; } // 책장 앞에 서서 읽는다
            a.keepGear = true;
            goTo(a, pick(seats), rnd(14, 22), () => { a.cat.book = 'open'; });
          });
        });
        return true;
      }],
      ['board', 0.5, (a) => { const s = free('board'); if (!s.length) return false; goTo(a, s[0], rnd(10, 14)); return true; }],
      /**
       * 회의: 일하는 동료 2~3 마리를 모아 한 회의실에 다 같이 앉을 수 있는 방을 고르고, 리더(a)는 화이트보드·TV 앞(present 자리)을 오가며 설명한다.
       * 동료가 없거나 알맞은 방이 없으면 false.
       * @param {Agent} a 회의를 여는 일꾼
       * @returns {boolean} 회의를 시작했으면 true
       */
      ['meeting', 1.2, (a) => {
        const mates = agents.filter((b) => b !== a && !b.alert && !b.busy && b.what === 'work').slice(0, 2 + Math.floor(Math.random() * 2));
        // 한 회의실에 다 같이 앉을 수 있는 방을 고른다
        const rooms = {};
        for (const s of free('meeting')) (rooms[s.room] = rooms[s.room] || []).push(s);
        const fit = Object.values(rooms).filter((r) => r.length >= mates.length + 1);
        const seats = fit.length ? pick(fit) : [];
        if (seats.length < mates.length + 1 || !mates.length) return false;
        const end = rnd(22, 32);
        // 팀 리더(회의를 연 고양이)는 앉지 않고 화이트보드와 TV 앞을 오가며 설명한다
        const stage = office.byKind('present').filter((s) => s.room === seats[0].room && !s.taken);
        if (stage.length >= 2) {
          mates.forEach((m, i) => { m.what = 'meeting'; goTo(m, seats[i], end); });
          a.what = 'meeting';
          a.leading = { spots: stage.slice(0, 2), n: 0 };
          lead(a);
          return true;
        }
        [a, ...mates].forEach((m, i) => { m.what = 'meeting'; goTo(m, seats[i], end); });
        return true;
      }],
      /**
       * 커피: 커피 머신 자리와 카페 자리가 모두 비어 있어야 한다. 머신 앞에서 가루·끓는 소리 연출 후 3초 뒤 카페 자리에 앉아 잔 소리를 낸다.
       * @param {Agent} a 일꾼
       * @returns {boolean} 시작했으면 true
       */
      ['coffee', 1.2, (a) => {
        const c = free('coffee');
        if (!c.length || !free('cafe').length) return false;
        const machine = c[0];
        goTo(a, machine, Infinity, () => {
          // 머신 아래 조리대에 컵을 놓고 3초 동안 커피가 차오른다
          a.cat.cup = 'fill'; a.cat.cupT0 = a.cat.t || 0;
          fx('grounds', a.cat);
          timer(1.2, () => fx('boil', a.cat));
          timer(3.2, () => {
            if (a.what !== 'coffee') return;
            const seats = free('cafe');
            if (!seats.length) { a.cat.cup = false; work(a); return; }
            a.cat.cup = 'hand'; // 컵을 들고 빈 카페 자리로 — 앉아서 홀짝이다(drink) 시간이 다 되면 머신으로 반납(returnCup)
            a.cupBack = machine;
            a.keepGear = true;
            goTo(a, pick(seats), rnd(12, 20), () => fx('clink', a.cat));
          });
        });
        return true;
      }],
      ['rest', 1, (a) => { const s = free('sofa'); if (!s.length) return false; goTo(a, pick(s), rnd(16, 30)); return true; }],
      /**
       * 산책: 벤치·공원 자리 중 하나로 길목 두 곳을 거쳐 걸어간다.
       * @param {Agent} a 일꾼
       * @returns {boolean} 갈 곳이 있으면 true
       */
      ['walk', 0.7, (a) => {
        const dest = free('bench').concat(free('park'));
        if (!dest.length) return false;
        const wps = office.walkPoints.slice().sort(() => Math.random() - 0.5).slice(0, 2);
        goTo(a, pick(dest), rnd(10, 16), null, wps);
        return true;
      }],
    ];
    /**
     * ACTS 가중치의 합.
     * @type {number}
     */
    const total = ACTS.reduce((s, x) => s + x[1], 0);

    /**
     * 짧은 지연 실행 (프레임 시간 기준)
     * { t: 남은 시간(초), fn: 실행할 함수 } 목록. tick 이 줄이며 0 이 되면 실행한다.
     * @type {Array<{t: number, fn: function(): void}>}
     */
    const timers = [];
    /**
     * sec 초 뒤 fn 을 한 번 실행하도록 예약한다 (실시간이 아니라 tick 의 dt 누적 기준).
     * @param {number} sec 지연 시간(초)
     * @param {function(): void} fn 실행할 함수
     * @returns {void}
     */
    function timer(sec, fn) { timers.push({ t: sec, fn }); }

    /**
     * 실시간 모드에서 쉬는 고양이가 고르는 일과 (회의는 일하는 동료를 끌어오므로 뺀다)
     * 일(work)과 회의(meeting)를 뺀 ACTS 항목.
     * @type {Array<[string, number, function(Agent): boolean]>}
     */
    const REST = ACTS.filter((x) => !['work', 'meeting'].includes(x[0]));
    /**
     * REST 가중치의 합.
     * @type {number}
     */
    const restTotal = REST.reduce((s, x) => s + x[1], 0);
    /**
     * 다 마신 컵을 커피 머신 앞 조리대에 반납(내려놓고 1초 뒤 사라짐)하고 다음 일과를 고른다.
     * 머신 자리를 다른 고양이가 쓰고 있으면 반납을 건너뛰고(컵 내려놓음) 다음 일로.
     * @param {Agent} a 커피를 마신 일꾼 (a.cupBack = 머신 자리)
     * @returns {void}
     */
    function returnCup(a) {
      const spot = a.cupBack;
      a.cupBack = null; // 다시 들어오지 않게
      a.until = Infinity;
      if (!spot || (spot.taken && spot.taken !== a)) { a.cat.cup = false; chooseNext(a); return; }
      a.keepGear = true;
      goTo(a, spot, Infinity, () => {
        if (a.what !== 'coffee') return;
        a.cat.cup = 'place';
        timer(1.0, () => { a.cat.cup = false; if (a.what === 'coffee' && !a.alert) chooseNext(a); });
      });
    }
    /**
     * 다 읽은 책을 덮고(0.8초) 꺼낸 책장으로 돌아가 꽂는다(reach 1초) — 그다음 일과를 고른다.
     * 꺼낸 책장을 다른 고양이가 쓰고 있으면 빈 다른 책장으로. 빈 책장이 없으면 책을 내려놓고(사라짐) 다음 일로.
     * @param {Agent} a 읽던 일꾼 (a.book 이 있어야 함)
     * @returns {void}
     */
    function returnBook(a) {
      const b = a.book;
      a.book = null; // 다시 들어오지 않게
      a.until = Infinity;
      a.cat.book = 'closed';
      OfficeCat.setAct(a.cat, 'idle');
      timer(0.8, () => {
        if (a.what !== 'read' || a.alert || a.held) return;
        const sh = b && b.shelf && (!b.shelf.taken || b.shelf.taken === a.cat.id) ? b.shelf : pick(free('shelf').filter((s) => s.pose === 'stand'));
        if (!sh) { a.cat.book = null; chooseNext(a); return; }
        /**
         * 책장 앞에서 책을 꽂고 다음 일로.
         * @returns {void}
         */
        const putBack = () => briefly(a.cat, 'reach', 1.0, () => { a.cat.book = null; if (a.what === 'read' && !a.alert) chooseNext(a); });
        if (a.at === sh) { putBack(); return; }
        a.keepGear = true;
        goTo(a, sh, Infinity, () => { if (a.what === 'read') putBack(); });
      });
    }
    /**
     * 일꾼이 다음에 할 일을 고른다.
     * 실시간에서 바쁜 세션은 놀러 가지 않고 일한다. 그 밖에는 가중치 무작위로 6번까지 시작 가능한 일을 찾고, 없으면 시연은 일하러 보내고 실시간은 5~10초 뒤 다시 고른다.
     * @param {Agent} a 일꾼
     * @returns {void}
     * @see ACTS
     * @see work
     */
    function chooseNext(a) {
      if (opts.live && a.liveBusy) { work(a); return; } // 바쁜 세션은 놀러 가지 않는다
      const live = opts.live && !a.liveBusy;
      const list = live ? REST : ACTS, sum = live ? restTotal : total;
      for (let tries = 0; tries < 6; tries++) {
        let r = Math.random() * sum;
        const act = list.find((x) => (r -= x[1]) <= 0) || list[0];
        a.what = act[0];
        if (act[2](a)) return;
      }
      if (live) { a.until = rnd(5, 10); return; } // 갈 곳이 없으면 잠시 그대로
      work(a);
    }

    /**
     * 울음 소리를 낸다 (ui.sfx 가 있을 때만).
     * @param {string} ev 이벤트 이름 (attention, happy, sad, question, deliver, five, error)
     * @param {Agent} a 소리 낼 일꾼
     * @returns {void}
     */
    const sfx = (ev, a) => { if (ui.sfx) ui.sfx(ev, a.cat); };
    /**
     * 효과음을 낸다 (ui.fx 가 있을 때만).
     * @param {string} name 효과음 이름 (stamp, grounds, boil, clink)
     * @param {Cat} cat 소리가 나는 곳의 고양이
     * @returns {void}
     */
    const fx = (name, cat) => { if (ui.fx) ui.fx(name, cat); };

    // ── 요청 이벤트 ─────────────────────────────────────────
    /**
     * 간식 점수를 올리고 알림 글을 띄운다. 처음 10개가 되면 라운지 고양이 타워를 해제한다.
     * 실시간 모드면 점수를 저장(TREATS_KEY)하고 앱 로그에 한 줄 남긴다.
     * @param {number} n 더할 점수
     * @param {string} [why] 알림에 쓸 사유 (타워가 풀리는 순간엔 쓰지 않음)
     * @returns {void}
     */
    function addPoints(n, why, a) {
      state.points += n;
      // 그 간식을 받아 온 고양이(품종)의 경험치 — 같은 세션은 늘 같은 품종이라 그 고양이로 계속 자란다
      const br = a && a.cat && a.cat.breed;
      let up = 0;
      if (br && br !== 'boss') { const before = levelFromXp(state.cats[br] || 0); state.cats[br] = (state.cats[br] || 0) + n; const after = levelFromXp(state.cats[br]); if (after > before) up = after; }
      if (opts.live) {
        saveTreats();
        // 제보 진단용: 간식 지급을 앱 로그에 남긴다
        try { if (window.__TAURI__) window.__TAURI__.core.invoke('log_ui', { level: 'info', message: `간식 +${n} (${why || '고양이 타워'}) → ${state.points}개` }).catch(() => {}); } catch (_) { /* 무시 */ }
      }
      if (!state.unlocked && state.points >= 10) {
        state.unlocked = true;
        office.unlock('catTower');
        ui.toast(t('office.demo.tower'));
      } else if (up) {
        ui.toast(t('office.demo.levelUp', { breed: CatModel.breedName(br), lv: up, n }));
        OfficeCat.hop(a.cat, 1.2);
      } else if (why) ui.toast(t('office.demo.gain', { why, n }));
    }

    // 1) 권한 요청 → 결재판을 대표 책상에 내려놓기
    /**
     * 결재판을 내려놓으러 선 줄 (앞에서부터, 맨 앞이 책상 정면 자리). 다 내려놓고 자리로 돌아가면 빠진다.
     * @type {Agent[]}
     */
    const line = [];
    const coming = []; // 줄 들머리(동쪽 길목)로 오는 중인 일꾼들 — 들머리에 닿은 순서대로 줄(line)에 선다 (먼저 부른 일꾼이 늦게 와도 줄 선 고양이를 뚫고 앞자리로 가지 않게)
    /**
     * 책상 위 결재판 더미의 논리 장수 (눈에 보이는 장수는 office.boardCount() 로 최대 DROP.board.max 장).
     * @type {number}
     */
    let stackN = 0;
    /**
     * 내려놓는 줄의 i 번째 자리 (책상을 보고 서는 임시 자리).
     * @param {number} i 줄 순번 (0 이 책상 정면)
     * @returns {Spot}
     */
    const slotSpot = (i) => { const sl = office.drop.slots[Math.min(i, office.drop.slots.length - 1)]; return { pos: sl.pos, rotY: sl.rotY, pose: 'stand', act: 'idle' }; };
    /**
     * 줄의 일꾼을 순번에 맞는 자리로 보낸다 (자리가 바뀐 일꾼만 다시 걷는다). 맨 앞에 선 일꾼은 책상에 결재판을 올려놓는다.
     * @returns {void}
     * @see goTo
     * @see dropBoard
     */
    function advanceLine() {
      line.forEach((a, i) => {
        if (a.slotIdx === i) return;
        a.slotIdx = i;
        const al = a.alert;
        goTo(a, slotSpot(i), Infinity, () => {
          if (a.alert !== al || a.slotIdx !== i) return;
          if (i !== 0) return; // 뒷자리: 서서 차례를 기다린다
          OfficeCat.setAct(a.cat, 'present');
          boss.heading = Math.atan2(-(a.cat.root.position.x - boss.root.position.x), -(a.cat.root.position.z - boss.root.position.z));
          sfx('attention', a);
          timer(1.1, () => { if (a.alert === al && line[0] === a && !a.dropped) dropBoard(a); });
        });
      });
    }
    /**
     * 책상에 결재판을 올려놓는다: 더미 맨 위에 한 장 얹고, 일꾼은 줄에서 빠져 제 자리로 돌아가 답을 기다린다.
     * @param {Agent} a 줄 맨 앞 일꾼
     * @returns {void}
     * @see advanceLine
     */
    function dropBoard(a) {
      const i = line.indexOf(a);
      if (i >= 0) line.splice(i, 1);
      a.slotIdx = null;
      a.dropped = true;
      a.dropT = 0;
      stackN++;
      office.boardAdd();
      OfficeCat.setProp(a.cat, null);
      OfficeCat.setAct(a.cat, 'idle');
      fx('stamp', boss);
      const al = a.alert;
      goTo(a, a.desk, Infinity, () => {
        if (a.alert !== al) return;
        OfficeCat.setAct(a.cat, 'type');
        if (!al.autoApproved) { OfficeCat.setSignal(a.cat, 'permission'); a.cat.signalText = t(al.q ? 'office.demo.sig.answer' : 'office.demo.sig.permit'); } // 질문 요청은 결재가 아니라 답을 기다린다
      }, office.drop.exit); // 줄 선 고양이들을 거슬러 가지 않게 서쪽 길목으로 빠진다
      advanceLine();
    }
    /**
     * 줄 들머리(동쪽 길목 office.drop.enter)로 간다. 닿으면 그 순서대로 줄 맨 뒤에 선다(advanceLine).
     * 오는 동안은 coming 에 있어 줄 자리 수에 함께 센다. 그사이 요청이 풀리면(leaveQueue) coming 에서 빠지고 닿아도 줄에 서지 않는다.
     * @param {Agent} a 일꾼 (alert 가 걸린 상태)
     * @returns {void}
     * @see advanceLine
     */
    function approach(a) {
      const al = a.alert, gate = office.drop.enter[0];
      coming.push(a);
      goTo(a, { pos: gate, rotY: Math.PI / 2, pose: 'stand', act: 'idle' }, Infinity, () => {
        const ci = coming.indexOf(a);
        if (ci < 0 || a.alert !== al) return;
        coming.splice(ci, 1);
        line.push(a); advanceLine(); // 닿은 순서대로 뒤에 선다
      });
    }
    /**
     * 결재판을 들고 대표 책상으로 간다 (줄이 가득이면 제자리에서 차례를 기다린다).
     * req 가 있으면 실제 요청, 없으면 시연용 무작위 요청. 일꾼에 alert 를 걸고 결재판을 든 채 짧은 줄에 서서, 맨 앞에 서면 책상에 결재판을 올려놓고 자리로 돌아간다.
     * @param {Agent} a 일꾼
     * @param {PermitReq} [req] 실제 요청 요약
     * @returns {void}
     * @see advanceLine
     */
    function joinQueue(a, req) {
      // (isWaiting: 사용자 결정을 기다리는 일꾼인가 — 자동 허용 왕복은 제외. 아래 tick·말풍선·배지가 쓴다)
      const [tool, detail] = req ? [req.tool, req.detail] : pick(REQUESTS);
      a.alert = req && req.options
        ? { kind: 'question', t: 0, q: req.q, options: req.options, permitId: req.permitId, question: req.question, multi: req.multi, queued: true }
        : { kind: 'permission', t: 0, tool, detail, permitId: req && req.permitId, desc: req && req.desc, autoApproved: !!(req && req.autoApproved) };
      a.what = 'alert';
      a.dropped = false;
      queue.push(a);
      OfficeCat.setProp(a.cat, 'board');
      if (line.length + coming.length < office.drop.slots.length) approach(a);
      else a.pendingLine = true; // 줄이 가득 — 자리가 나면 tick 이 세운다
    }
    /**
     * 결재 대기에서 빠진다: 줄에 서 있었으면 줄에서, 책상에 결재판을 올려놨으면 맨 위 한 장을 치운다 (줄 순번 다시 맞춤, 새 맨 앞 대기 시간 0).
     * @param {Agent} a 일꾼
     * @returns {void}
     */
    function leaveQueue(a) {
      const i = queue.indexOf(a);
      if (i >= 0) queue.splice(i, 1);
      const li = line.indexOf(a);
      if (li >= 0) { line.splice(li, 1); a.slotIdx = null; }
      const ci = coming.indexOf(a);
      if (ci >= 0) coming.splice(ci, 1);
      a.pendingLine = false;
      if (a.dropped) {
        a.dropped = false;
        stackN = Math.max(0, stackN - 1);
        if (office.boardCount() > stackN) office.boardRemove(); // 가득 차서 안 보이던 장은 치울 것이 없음
      }
      const first = queue.find((x) => x.dropped);
      if (first) first.dropT = 0;
      if (li >= 0) advanceLine();
    }
    /**
     * 요청이 끝난 일꾼을 일하는 자리로: 이미 제 책상에 앉아 있으면 그대로 타자를 치고, 아니면 걸어 돌아간다.
     * @param {Agent} a 일꾼
     * @returns {void}
     * @see work
     */
    function settle(a) {
      if (a.at === a.desk && !a.busy) { a.what = 'work'; a.until = rnd(20, 45); OfficeCat.setAct(a.cat, 'type'); return; }
      work(a);
    }
    /**
     * 결재 처리: 대표가 도장을 찍고(승인) 또는 고개를 젓고(반려) 일꾼은 기뻐하거나 시무룩해진 뒤 자리로 돌아간다.
     * 승인이면 기분·뛰기·간식 +1, 반려면 기분 하락. 일꾼의 요청을 지우고 한가해지면 대기 중인 자동 허용 요청(drainAuto)을 이어서 처리한다.
     * @param {Agent} a 결재받는 일꾼
     * @param {boolean} approved 승인이면 true, 반려면 false
     * @returns {void}
     * @see leaveQueue
     * @see addPoints
     * @see drainAuto
     */
    function serve(a, approved) {
      const treats = (a.alert && a.alert.treats) || 1; // 자동 허용: 그동안 쌓인 건수만큼 한꺼번에
      leaveQueue(a);
      OfficeCat.setSignal(a.cat, null);
      a.cat.signalText = null;
      OfficeCat.setProp(a.cat, null);
      a.alert = null;
      // 대표가 도장을 찍는다 (책상 위 결재판 맨 위 한 장은 leaveQueue 가 치웠다)
      boss.heading = Math.atan2(-(a.cat.root.position.x - boss.root.position.x), -(a.cat.root.position.z - boss.root.position.z));
      briefly(boss, approved ? 'stamp' : 'shake', 0.9, () => { boss.heading = office.boss.rotY; });
      fx('stamp', boss);
      timer(0.25, () => sfx(approved ? 'happy' : 'sad', a));
      a.busy = true; // 기뻐하는 동안 새 요청을 받지 않는다
      if (approved) {
        OfficeCat.setMood(a.cat, a.cat.mood + 0.4);
        if (!a.at) OfficeCat.hop(a.cat, 1.0); // 앉아 있으면 뛰지 않는다
        addPoints(treats, t('office.demo.why.approved'), a); // 빠를수록 더 주지 않음 (서둘러 승인하게 만들지 않도록)
        timer(0.9, () => { if (!a.alert) { a.busy = false; settle(a); drainAuto(a); } });
      } else {
        OfficeCat.setMood(a.cat, a.cat.mood - 0.1);
        OfficeCat.setAct(a.cat, 'sad');
        timer(1.6, () => { if (!a.alert) { a.busy = false; settle(a); drainAuto(a); } });
      }
    }

    // 2) 질문 → 자리에서 팻말
    /**
     * 질문 이벤트: 일꾼이 제 자리로 가서 질문 팻말을 든다.
     * @param {Agent} a 일꾼
     * @param {{q: string, options: string[], permitId?: string, question?: string, multi?: boolean}} [real] 실제 질문 (없으면 시연용 무작위)
     * @returns {void}
     * @see goTo
     */
    function ask(a, real) {
      const [q, options] = real ? [real.q, real.options] : pick(QUESTIONS);
      a.alert = { kind: 'question', t: 0, q, options, permitId: real && real.permitId, question: real && real.question, multi: real && real.multi };
      a.what = 'alert';
      goTo(a, a.desk, Infinity, () => {
        OfficeCat.setProp(a.cat, 'sign');
        OfficeCat.setAct(a.cat, 'sign');
        OfficeCat.setSignal(a.cat, 'waiting');
        sfx('question', a);
      });
    }
    /**
     * 질문에 답이 왔다: 팻말을 내리고 고개를 끄덕인 뒤 일하러 돌아간다 (결재 줄에 서 있던 질문이면 줄에서도 빠짐).
     * 기분 +0.3, 간식 +1. 끄덕임이 끝나면 대기 중인 자동 허용 요청(drainAuto)을 이어서 처리한다.
     * @param {Agent} a 일꾼
     * @returns {void}
     * @see leaveQueue
     * @see drainAuto
     */
    function answer(a) {
      const queued = !!(a.alert && a.alert.queued); // 결재 줄에 서 있던 질문인가
      leaveQueue(a); // 결재 줄에 서 있던 질문이면 줄에서 빠진다
      a.alert = null;
      OfficeCat.setSignal(a.cat, null);
      a.cat.signalText = null;
      OfficeCat.setProp(a.cat, null);
      OfficeCat.setMood(a.cat, a.cat.mood + 0.3);
      addPoints(1, t('office.demo.why.answered'), a);
      // 줄에 서 있던 고양이는 대표 책상 앞에 남지 않게 자리로 돌려보낸다 (결재와 같은 흐름)
      briefly(a.cat, 'nod', 1.2, () => { if (queued) { settle(a); drainAuto(a); return; } OfficeCat.setAct(a.cat, 'type'); a.what = 'work'; a.until = rnd(15, 30); drainAuto(a); });
    }

    // 3) 완료 → 상자 배달
    /**
     * 완료 이벤트: 상자를 들고 배달 자리로 가서 대표 쪽을 보고 선다.
     * @param {Agent} a 일꾼
     * @returns {boolean} 빈 배달 자리가 없으면 false
     * @see goTo
     */
    function deliver(a) {
      const spot = free('deliver')[0];
      if (!spot) return false;
      a.alert = { kind: 'deliver', t: 0 };
      a.what = 'alert';
      OfficeCat.setProp(a.cat, 'box');
      goTo(a, spot, Infinity, () => {
        OfficeCat.setAct(a.cat, 'present');
        OfficeCat.setSignal(a.cat, 'complete');
        boss.heading = Math.atan2(-(a.cat.root.position.x - boss.root.position.x), -(a.cat.root.position.z - boss.root.position.z));
        a.alert.arrived = true;
        sfx('deliver', a);
      });
      return true;
    }
    /**
     * 배달 상자를 받았다: 대표 책상에 상자를 쌓고, 하이파이브면 둘이 손을 들어 간식 +2, 아니면 그냥 일하러 돌아간다.
     * @param {Agent} a 배달한 일꾼
     * @param {boolean} highfive 하이파이브를 했는가
     * @returns {void}
     */
    function receive(a, highfive) {
      a.alert = null;
      OfficeCat.setSignal(a.cat, null);
      OfficeCat.setProp(a.cat, null);
      office.pileAdd();
      boss.heading = office.boss.rotY;
      if (highfive) {
        briefly(boss, 'highfive', 1.2);
        sfx('five', a);
        briefly(a.cat, 'highfive', 1.2, () => { OfficeCat.hop(a.cat, 0.8); work(a); });
        OfficeCat.setMood(a.cat, a.cat.mood + 0.4);
        addPoints(2, t('office.demo.why.highfive'), a);
      } else {
        work(a);
      }
    }

    // 4) 오류 → 연기
    /**
     * 오류 이벤트: 일꾼이 제 책상으로 가서 책상에서 연기가 난다.
     * @param {Agent} a 일꾼
     * @returns {void}
     * @see goTo
     */
    function fail(a) {
      a.alert = { kind: 'error', t: 0, msg: pick(ERRORS) };
      a.what = 'alert';
      goTo(a, a.desk, Infinity, () => {
        OfficeCat.setSignal(a.cat, 'error');
        OfficeCat.setAct(a.cat, 'idle');
        office.smoke(a.desk, true);
        sfx('error', a);
      });
    }
    /**
     * 오류 확인: 연기를 끄고 다시 일한다 (간식 +1).
     * @param {Agent} a 일꾼
     * @returns {void}
     */
    function fixError(a) {
      a.alert = null;
      office.smoke(a.desk, false);
      OfficeCat.setSignal(a.cat, null);
      OfficeCat.setAct(a.cat, 'type');
      a.what = 'work';
      a.until = rnd(15, 30);
      addPoints(1, t('office.demo.why.errorSeen'), a);
    }

    /**
     * 시연용 가짜 요청 하나를 무작위로 낸다: 50% 결재 줄, 20% 질문, 20% 배달(책상에 있는 일꾼 중, 실패 시 결재 줄), 10% 오류.
     * 요청이 없고 바쁘지 않은 일꾼 중에서 고른다.
     * @returns {void}
     * @see joinQueue
     * @see ask
     * @see deliver
     * @see fail
     */
    function raiseEvent() {
      const cands = agents.filter((a) => !a.alert && !a.busy);
      if (!cands.length) return;
      const r = Math.random();
      const a = pick(cands);
      if (r < 0.5) joinQueue(a);
      else if (r < 0.7) ask(a);
      else if (r < 0.9) { const atDesk = cands.filter((b) => b.at === b.desk); if (!atDesk.length || !deliver(pick(atDesk))) joinQueue(a); }
      else fail(a);
    }

    // ── 사용자가 누름 ─────────────────────────────────────────
    /**
     * 사용자가 고양이를 눌렀다: 그 일꾼의 요청 종류에 맞는 카드를 열어 응답을 처리한다.
     * 권한: 승인/반려 (실시간이면 opts.answer 로 앱에 전달, 이미 끝난 요청이면 liveResolved), 질문: 선택지 (여러 개 고르는 질문은 알림 카드로 안내),
     * 배달: 하이파이브/확인, 오류: 확인. 카드가 떠 있는 동안 al.open 으로 중복 열림을 막는다.
     * @param {string} catId 누른 고양이 id
     * @returns {Promise<void>}
     * @see serve
     * @see answer
     * @see receive
     * @see fixError
     * @see liveResolved
     */
    async function click(catId) {
      const a = agents.find((x) => x.cat.id === catId);
      if (!a) return;
      const al = a.alert;
      if (!al || al.open) return;
      if (al.autoApproved) return; // 자동 허용 왕복 중: 결정할 것이 없어 카드를 열지 않는다
      al.open = true;
      try {
        if (al.kind === 'permission') {
          const pos = queue.indexOf(a) + 1;
          const r = await ui.card({
            kind: 'permission', title: t('office.demo.card.permit'), project: a.project, cat: a.cat,
            rows: [[t('office.demo.row.request'), `${al.tool}${al.desc ? ' · ' + al.desc : ''}`], [t('office.demo.row.detail'), al.detail || '-'], [t('office.demo.row.wait'), t('office.demo.wait', { pos, sec: Math.round(al.t) })]],
            buttons: [['approve', t('office.demo.approve')], ['deny', t('office.demo.deny')]],
          });
          if (r && a.alert === al) {
            if (al.permitId && opts.answer) {
              const ok = await opts.answer(al.permitId, r === 'approve');
              if (!ok) { liveResolved(a); return; } // 이미 끝난 요청 (터미널에서 처리·시간 초과)
            }
            serve(a, r === 'approve');
          }
        } else if (al.kind === 'question') {
          if (al.multi) { ui.toast(t('office.demo.multi')); return; }
          const r = await ui.card({
            kind: 'question', title: t('office.demo.card.question'), project: a.project, cat: a.cat,
            rows: [[t('office.demo.row.question'), al.q]], buttons: al.options.map((o, i) => ['o' + i, o]),
          });
          if (r && a.alert === al) {
            if (al.permitId && opts.answer) {
              const label = al.options[Number(r.slice(1))];
              const ok = await opts.answer(al.permitId, true, { [al.question]: label });
              if (!ok) { liveResolved(a); return; }
            }
            answer(a);
          }
        } else if (al.kind === 'deliver' && al.arrived) {
          const r = await ui.card({
            kind: 'complete', title: t('office.demo.card.complete'), project: a.project, cat: a.cat,
            rows: [[t('office.demo.row.result'), t('office.demo.result')]], buttons: [['five', t('office.demo.five')], ['ok', t('office.demo.ok')]],
          });
          if (r && a.alert === al) receive(a, r === 'five');
        } else if (al.kind === 'error') {
          const r = await ui.card({
            kind: 'error', title: t('office.demo.card.error'), project: a.project, cat: a.cat,
            rows: [[t('office.demo.row.detail'), al.msg]], buttons: [['ok', t('office.demo.ok')]],
          });
          if (r && a.alert === al) fixError(a);
        }
      } finally {
        al.open = false;
      }
    }
    /**
     * 사용자가 대표 책상을 눌렀다: 쌓인 완료 상자를 치우고 개수만큼 간식을 준다.
     * @returns {void}
     */
    function clickDesk() {
      const n = office.pileClear();
      if (n) { briefly(boss, 'nod', 1.0); addPoints(n, t('office.demo.why.boxes', { n })); }
    }

    // ── 매 프레임 ─────────────────────────────────────────────
    /**
     * 매 프레임 진행.
     * 순서: 예약한 타이머 실행 → (시연이면) 다음 가짜 요청 → 결재판 내려놓는 줄 정리·뒷자리 고양이 발 동동 →
     * 일꾼마다 실시간 상태 맞추기·요청 대기 시간·자동 처리·일과 교체 → HUD 갱신.
     * @param {number} dt 지난 프레임 이후 경과 시간(초)
     * @returns {void}
     */
    function tick(dt) {
      for (let i = timers.length - 1; i >= 0; i--) {
        const t = timers[i];
        t.t -= dt;
        if (t.t <= 0) { timers.splice(i, 1); t.fn(); }
      }
      // 연못이 얼거나 녹는 순간: 낚시하던(가던) 고양이·스케이트 타던 고양이는 바로 다른 일을 고른다
      const fz = office.frozen();
      if (fz !== wasFrozen) {
        wasFrozen = fz;
        const gone = fz ? 'fish' : 'skate';
        for (const a of agents) if (a.what === gone && !a.alert && !a.held && !a.leaving && !a.cat.landing) chooseNext(a);
      }
      nextEvent -= dt;
      if (!opts.live && nextEvent <= 0) { raiseEvent(); nextEvent = rnd(rate[0], rate[1]); }

      // 결재판 내려놓는 줄: 가득 차서 못 서던 일꾼은 자리가 나면 세운다. 줄 뒷자리 고양이는 기다린 시간에 따라 발을 동동 구른다
      for (const c of coming.slice()) if (!c.alert || c.leaving) coming.splice(coming.indexOf(c), 1); // 안전망: 요청이 풀렸는데 오는 중 목록에 남은 일꾼은 뺀다 (자리 수를 영영 차지하지 않게)
      while (line.length + coming.length < office.drop.slots.length) {
        const w = queue.find((x) => x.pendingLine);
        if (!w) break;
        w.pendingLine = false; approach(w);
      }
      line.forEach((a, i) => {
        if (i === 0 || a.busy || !a.alert) return;
        OfficeCat.setAct(a.cat, a.alert.t < 12 ? 'idle' : 'fidget');
      });

      for (const a of agents) {
        if (a.cat.landing || a.leaving) continue; // 내려오는 중 · 퇴근 중
        if (a.autoN) drainAuto(a); // 쌓인 자동 허용: 왕복 간격이 지났고 한가하면 대표에게
        if (opts.live && !a.alert) {
          // 바쁜 세션은 책상에서 계속 타자, 쉬면 일과를 고른다
          if (a.liveBusy && a.what !== 'work') { work(a); continue; }
          if (a.liveBusy && a.at === a.desk && !a.busy) { a.until = Infinity; continue; }
          // 바쁜데 자리에 없고 서 있음(끌어다 놓은 뒤·길이 끊김 등): 바로 자리로
          if (a.liveBusy && !a.busy && !a.held) { work(a); continue; }
          if (!a.liveBusy && a.what === 'work' && a.until === Infinity) a.until = rnd(3, 8);
        }
        if (a.alert) {
          const al = a.alert;
          if (!a.busy || al.kind === 'permission' || al.queued) al.t += dt;
          if (al.t > 12) OfficeCat.setMood(a.cat, a.cat.mood - dt * 0.006);
          if (al.open) continue;
          // 시연: 사용자가 다른 곳(트레이 카드 등)에서 응답했다고 치고 자동 처리
          if (al.autoApproved) { if (a.dropped && (a.dropT = (a.dropT || 0) + dt) > 1.2) serve(a, true); continue; } // 자동 허용: 결재판을 올려놓으면 잠깐 뒤 차례와 무관하게 바로 도장·간식(맨 위 한 장이 사라진다)
          if (opts.live) continue; // 실제 요청은 사용자가 응답할 때까지 기다린다
          if (al.kind === 'permission' && a.dropped && queue.find((x) => x.dropped && !x.alert.autoApproved) === a) {
            a.headT = (a.headT || 0) + dt; // 책상에 올려놓은 결재판 중 가장 오래된 요청부터 한 장씩
            if (!opts.noserve && a.headT > (opts.rush ? 2.5 : 14)) serve(a, Math.random() < 0.85);
          } else if (al.kind === 'question' && al.t > 60) answer(a);
          else if (al.kind === 'deliver' && al.arrived && (al.wait = (al.wait || 0) + dt) > 15) receive(a, false);
          else if (al.kind === 'error' && al.t > 45) fixError(a);
          continue;
        }
        if (a.busy) continue;
        a.until -= dt;
        if (a.until > 0) continue;
        if (a.leading) { lead(a); continue; } // 리더는 다음 진행 자리로
        if (a.what === 'read' && a.book) { returnBook(a); continue; } // 다 읽음: 덮고 책장에 꽂으러
        if (a.what === 'coffee' && a.cupBack) { returnCup(a); continue; } // 다 마심: 컵을 머신 쪽 조리대에 반납
        if (a.what === 'meeting') {
          // 회의 끝: 앉은 팀원과 (걷는 중이어도) 리더 모두 자리로
          agents.filter((b) => b.what === 'meeting' && !b.alert && (!b.busy || b.leading)).forEach((b) => work(b));
          continue;
        }
        chooseNext(a);
      }
      ui.hud({ queue: queue.filter(isWaiting).length, points: balance() });
    }

    // ── 실시간 모드: 고양이 들고 나기 ─────────────────────────
    /**
     * 새 세션 고양이: 빈 책상을 하나 맡아 앉힌다. 반환: 맡은 책상(없으면 null)
     * @param {Cat} cat 새 고양이
     * @param {{project?: string, busy?: boolean}} [info={}] 세션 정보
     * @returns {Spot|null} 맡은 책상 (빈 책상이 없으면 null)
     */
    function add(cat, info = {}) {
      const used = new Set(agents.map((x) => x.desk));
      const desk = office.desks.find((d) => !used.has(d) && !d.taken);
      if (!desk) return null;
      const a = { cat, desk, spot: null, until: rnd(4, 9), what: 'work', alert: null, project: info.project || '', liveBusy: !!info.busy, info };
      agents.push(a);
      reserve(a, desk); a.at = desk; OfficeCat.setSpot(cat, desk); cat.root.position.y = 0;
      OfficeCat.setPose(cat, 'sit', 0.5); OfficeCat.setAct(cat, 'type');
      if (a.liveBusy) a.until = Infinity;
      return desk;
    }
    /**
     * 작업 완료 보고 사이 최소 간격(ms): 세션 상태가 바쁨↔쉼으로 잠깐 깜빡여도 간식이 부풀지 않게.
     * @type {number}
     */
    const REPORT_GAP_MS = 30000;
    /**
     * 앱이 오피스 밖 몫으로 이미 센 작업 완료: 고양이 id → 표시 시각(ms). REPORT_GAP_MS 안에는 오피스가 다시 보고하지 않는다(이중 지급 방지).
     * @type {Map<string, number>}
     */
    const doneElsewhere = new Map();
    /**
     * 앱이 알린 작업(턴) 완료 (turn_done 이벤트, "<서비스>:<세션 id>"): 그 고양이가 대표에게 보고하러 간다 (고양이당 REPORT_GAP_MS 에 한 번).
     * 훅·로그로 정확히 안 완료라 조회(바쁨→쉼) 추정보다 우선한다. 고양이가 없으면 간식만 준다.
     * @param {string} key "claude:<세션>" | "chatgpt:<세션>" | "antigravity:<세션>"
     * @returns {void}
     * @see report
     */
    function turnDone(key) {
      const i = key.indexOf(':');
      if (i < 0) return;
      const p = key.slice(0, i), sid = key.slice(i + 1);
      const id = p === 'claude' ? `L:${sid}` : `P:${p}:${sid}`;
      const a = agents.find((x) => x.cat.id === id);
      if (!a || a.leaving) { addPoints(1, t('office.demo.why.done')); return; } // 고양이가 없으면(빈 책상 없음 등) 간식만
      const now = performance.now();
      a.donePending = false; // 조회로 기다리던 완료 판정은 이 이벤트로 대신
      if (a.reportAt != null && now - a.reportAt < REPORT_GAP_MS) return;
      a.reportAt = now;
      report(a);
    }
    /**
     * 앱의 take_treats 가 준 최근 작업 완료("<서비스>:<세션 id>")를 고양이 id 로 바꿔 표시해 둔다 (고양이가 아직 없어도 됨).
     * @param {string[]} keys "claude:<세션>" | "chatgpt:<세션>" | "antigravity:<세션>"
     * @returns {void}
     */
    function markDone(keys) {
      const now = performance.now();
      for (const k of keys) {
        const i = k.indexOf(':');
        if (i < 0) continue;
        const p = k.slice(0, i), sid = k.slice(i + 1);
        doneElsewhere.set(p === 'claude' ? `L:${sid}` : `P:${p}:${sid}`, now);
      }
    }
    /**
     * 작업(턴)이 끝난 실제 세션: 대표 앞(배달 자리)으로 보고하러 가서 서 있으면 대표가 끄덕이고 간식 +1 (도장은 없음).
     * 고양이가 다른 일(요청 처리·결재 줄·들림·출퇴근)을 하고 있거나 보고 자리가 차 있으면 연출 없이 간식만 준다.
     * 보고가 끝나면 다음 일과를 고른다(다시 바빠졌으면 자리로, 아니면 쉬러).
     * @param {Agent} a 일꾼
     * @returns {void}
     * @see setBusy, addPoints
     */
    function report(a) {
      // 권한·질문을 기다리는 중이면 작업이 끝난 게 아니다 (세션 상태가 잠시 쉼으로 보여도) — 세지 않는다
      if (a.alert && (a.alert.kind === 'permission' || a.alert.kind === 'question')) { a.reportAt = null; return; }
      const spot = free('deliver')[0];
      if (!spot || a.alert || a.held || a.cat.landing || queue.includes(a)) { addPoints(1, t('office.demo.why.report'), a); return; }
      const al = (a.alert = { kind: 'report', t: 0 });
      a.what = 'alert';
      OfficeCat.setProp(a.cat, 'board'); // 결재판(보고서)을 들고 간다
      goTo(a, spot, Infinity, () => {
        if (a.alert !== al) return;
        OfficeCat.setAct(a.cat, 'present');
        OfficeCat.setSignal(a.cat, 'complete');
        boss.heading = Math.atan2(-(a.cat.root.position.x - boss.root.position.x), -(a.cat.root.position.z - boss.root.position.z));
        sfx('deliver', a);
        timer(1.6, () => {
          if (a.alert !== al) return;
          finishReport(a);
          a.until = 0; // 다음 틱에 다음 일과
        });
      });
    }
    /**
     * 보고를 마친다: 대표가 끄덕이고 간식 +1, 보고 표시를 지운다. 퇴근·창 닫기로 중간에 끝나도 간식은 준다.
     * @param {Agent} a 보고 중인 일꾼 (a.alert.kind === 'report')
     * @returns {void}
     * @see report
     */
    function finishReport(a) {
      a.alert = null;
      OfficeCat.setSignal(a.cat, null);
      OfficeCat.setProp(a.cat, null);
      OfficeCat.setAct(a.cat, 'idle');
      boss.heading = office.boss.rotY;
      if (!boss.landing) briefly(boss, 'nod', 1.0);
      addPoints(1, t('office.demo.why.report'), a);
    }
    /**
     * 세션의 바쁨 여부와 정보를 갱신한다 (바쁘면 책상에 붙어 일하고, 쉬면 일과를 고름).
     * 바쁨 → 쉼이 다음 조회까지 이어지면(깜빡임 거름) 작업 완료로 보고 report 를 부른다 (고양이당 REPORT_GAP_MS 에 한 번).
     * @param {string} id 고양이 id
     * @param {boolean} busy 일하는 중인가
     * @param {{project?: string}} [info] 새 세션 정보 (있으면 일꾼의 info·project 를 바꿈)
     * @param {boolean} [exact=false] 완료를 앱이 turn_done 으로 정확히 알려 주는 세션(채팅): 바쁨→쉼 추정을 하지 않는다 (중단·실패 턴을 완료로 세지 않게)
     * @returns {void}
     */
    function setBusy(id, busy, info, exact = false) {
      const a = agents.find((x) => x.cat.id === id);
      if (!a) return;
      if (exact) a.donePending = false;
      else if (a.liveBusy === true && !busy) a.donePending = true; // 일하던 세션이 쉼으로 — 다음 조회에서도 쉬면 작업(턴) 끝
      else if (busy) a.donePending = false;
      else if (a.donePending) {
        a.donePending = false;
        const now = performance.now();
        const elsewhere = doneElsewhere.get(id);
        if (elsewhere != null && now - elsewhere < REPORT_GAP_MS) a.reportAt = elsewhere; // 앱이 이미 셈 → 보고하지 않음
        if (!a.leaving && (a.reportAt == null || now - a.reportAt > REPORT_GAP_MS)) { a.reportAt = now; report(a); }
      }
      a.liveBusy = !!busy;
      if (info) { a.info = info; a.project = info.project || a.project; }
    }
    /**
     * 세션이 끝남: 공원 쪽으로 걸어 나간 뒤 사라진다. gone(cat) 이 불린다
     * 일꾼 목록·결재 줄·자리 예약에서 빼고 gone 콜백으로 고양이를 넘긴다. 아직 내려오는 중(landing)이면 바로 처리한다.
     * @param {string} id 고양이 id
     * @param {function(Cat): void} gone 퇴근이 끝났을 때 호출되는 콜백
     * @returns {void}
     * @see goTo
     */
    function remove(id, gone) {
      const a = agents.find((x) => x.cat.id === id);
      if (!a || a.leaving) return;
      // 요청을 들고 있었으면 먼저 정리한다 (퇴근 중에 liveResolved 가 work 로 퇴근 걸음을 무효화하거나, 줄에 남지 않게)
      // 왕복을 기다리던 자동 수락 몫(쌓인 autoN + 줄에 선 alert.treats)은 퇴근 전에 간식으로 준다
      const owed = autoOwed(a);
      if (a.alert && a.alert.kind === 'report') finishReport(a); // 보고하러 가던 중이면 간식은 준다
      if (a.alert) { leaveQueue(a); a.alert = null; OfficeCat.setSignal(a.cat, null); a.cat.signalText = null; OfficeCat.setProp(a.cat, null); }
      a.autoN = 0;
      if (owed) addPoints(owed, t('office.demo.why.auto'), a);
      a.leaving = true;
      /**
       * 퇴근 마무리: 일꾼을 목록·줄·자리에서 빼고 gone 을 부른다.
       * @returns {void}
       */
      const done = () => {
        const i = agents.indexOf(a);
        if (i >= 0) agents.splice(i, 1);
        reserve(a, null);
        const q = queue.indexOf(a);
        if (q >= 0) queue.splice(q, 1);
        gone(a.cat);
      };
      if (a.cat.landing) { done(); return; }
      const exit = office.walkPoints[Math.floor(Math.random() * office.walkPoints.length)];
      a.token = (a.token || 0) + 1;
      goTo(a, { pos: exit, rotY: 0, pose: 'stand', act: 'idle' }, Infinity, done);
    }

    // ── 실시간: 앱의 권한 요청 ↔ 고양이 ─────────────────────────
    /**
     * 권한 요청 하나: 도구 요청은 결재 줄, 질문은 자리에서 팻말
     * 이미 같은 요청이 걸렸거나 다른 요청을 처리하는 중이면 다음 동기화 때로 미룬다. 질문도 도구 요청과 같이 결재 줄에 서고 답은 카드에서 한다.
     * @param {string} id 고양이 id (Claude 'L:<세션>', 그 밖 'P:<서비스>:<세션>')
     * @param {Permit} p 권한 요청
     * @param {boolean} [autoApproved=false] 이미 자동 허용된 요청인가
     * @returns {void}
     * @see joinQueue
     */
    function livePermit(id, p, autoApproved = false) {
      const a = agents.find((x) => x.cat.id === id);
      const permitId = p.id || `auto-${++autoPermitSeq}`;
      if (!a || a.leaving || (a.alert && a.alert.permitId === permitId)) return;
      if (a.alert) return; // 다른 요청을 처리하는 중이면 다음 동기화 때
      if (a.cat.landing) return; // 내려오는 중 — 착지 뒤 다음 동기화(3초) 때 줄에 선다
      if (a.held) return; // 집어 든 중 — 내려놓은 뒤 다음 동기화 때 줄에 선다 (든 채 줄에 서면 놓을 때 줄 걷기가 끊겨 줄이 멈춘다)
      if (p.kind === 'question') {
        const q = (p.questions || [])[0] || {};
        const multi = (p.questions || []).length > 1 || !!q.multiSelect;
        // 도구 요청과 같이 결재 줄에 선다 (답은 카드에서)
        joinQueue(a, { q: q.question || t('office.demo.question'), options: (q.options || []).map((o) => o.label || String(o)), permitId, question: q.question, multi });
      } else {
        joinQueue(a, { tool: p.tool, detail: p.detail, desc: p.description, permitId, autoApproved });
      }
    }
    /**
     * 이미 자동 허용된 요청: 건수만 세어 두고, 왕복 간격(AUTO_TRIP_MS)마다 한 번 결재 줄·대표 도장 연출로 간식을 한꺼번에 받는다.
     * 요청 자체는 쌓아 두지 않는다(마지막 한 건만 결재판에 적을 내용으로 기억). 질문이나 세션 없는 요청, 고양이가 없는 세션은 무시.
     * @param {Permit} p 자동 허용된 요청 (session, provider 로 고양이 id 를 정함)
     * @returns {void}
     * @see drainAuto
     */
    function autoPermit(p) {
      if (!p || !p.session || p.kind === 'question') return;
      const id = p.provider && p.provider !== 'claude' ? `P:${p.provider}:${p.session}` : `L:${p.session}`;
      const a = agents.find((x) => x.cat.id === id);
      // 고양이가 없거나 퇴근 중이면 왕복 연출 없이 간식만 바로 준다 (오피스가 닫혀 있을 때와 같은 몫)
      if (!a || a.leaving) { addPoints(1, t('office.demo.why.auto')); return; }
      a.autoN = (a.autoN || 0) + 1;
      a.autoLast = p;
      drainAuto(a);
    }
    /**
     * 쌓인 자동 허용이 있고, 일꾼이 한가하며, 지난 왕복에서 AUTO_TRIP_MS 가 지났으면 대표에게 다녀오게 한다.
     * 결재 줄에 서는 데 성공하면 쌓인 건수를 alert.treats 로 넘기고(serve 가 그만큼 간식 지급) 세던 수를 0으로 되돌린다.
     * @param {Agent} a 일꾼 (autoN: 쌓인 건수, autoLast: 마지막 요청, autoAt: 지난 왕복 시작 시각 ms)
     * @returns {void}
     * @see autoPermit
     * @see livePermit
     * @see serve
     */
    function drainAuto(a) {
      if (!a.autoN || a.alert || a.leaving || a.cat.landing || a.held) return;
      const now = performance.now();
      if (a.autoAt != null && now - a.autoAt < AUTO_TRIP_MS) return;
      livePermit(a.cat.id, a.autoLast, true);
      if (!a.alert || !a.alert.autoApproved) return; // 줄에 서지 못함: 다음 틱에 다시
      a.alert.treats = a.autoN;
      a.autoN = 0;
      a.autoLast = null;
      a.autoAt = now;
    }
    /**
     * 다른 곳(알림 카드·터미널)에서 처리됐거나 시간이 지나 사라진 요청: 조용히 자리로
     * 결재 줄에서 빼고 요청·소품·신호를 지운 뒤 일하러 돌려보내고 대기 중인 자동 허용 요청을 이어서 처리한다.
     * @param {Agent} a 일꾼
     * @returns {void}
     * @see leaveQueue
     * @see work
     * @see drainAuto
     */
    function liveResolved(a) {
      const al = a.alert;
      if (!al) return;
      if (al.kind === 'permission' || al.queued) leaveQueue(a);
      a.alert = null;
      OfficeCat.setSignal(a.cat, null);
      a.cat.signalText = null;
      OfficeCat.setProp(a.cat, null);
      a.busy = false;
      settle(a);
      drainAuto(a);
    }
    /**
     * 지금 남아 있는 요청 목록과 맞추기 (permits: 앱의 get_permits 결과)
     * 목록에 없어진 요청은 liveResolved 로 정리하고, 새 요청은 livePermit 으로 고양이에게 건다.
     * 고양이 id 열쇠는 Claude 는 'L:<세션>', ChatGPT(Codex)·Antigravity 는 'P:<서비스>:<세션>' (office.js syncSessions 의 열쇠와 같게).
     * @param {Permit[]} permits 앱의 현재 권한 요청 목록
     * @returns {void}
     * @see liveResolved
     * @see livePermit
     */
    function syncPermits(permits) {
      const live = new Set(permits.map((p) => p.id));
      // 자동 허용 왕복(permitId 'auto-N')은 앱의 요청 목록에 원래 없으므로 '사라진 요청'으로 치우지 않는다
      for (const a of agents) if (a.alert && a.alert.permitId && !a.alert.autoApproved && !live.has(a.alert.permitId) && !a.alert.open) liveResolved(a);
      // Claude 는 'L:<세션>', ChatGPT(Codex)·Antigravity 는 'P:<서비스>:<세션>' (office.js syncSessions 의 열쇠와 같게)
      for (const p of permits) if (p.session) livePermit(p.provider && p.provider !== 'claude' ? 'P:' + p.provider + ':' + p.session : 'L:' + p.session, p);
    }

    /**
     * 일꾼이 아직 받지 못한 자동 수락 몫: 왕복을 기다리며 쌓인 autoN + 결재 줄에 서서 기다리는 alert.treats.
     * @param {Agent} a 일꾼
     * @returns {number} 몫
     * @see drainAuto, serve
     */
    function autoOwed(a) {
      return (a.autoN || 0) + (a.alert && a.alert.autoApproved ? a.alert.treats || 0 : 0);
    }
    // 오피스 창을 닫을 때 왕복을 기다리던 자동 수락 몫을 잃지 않게 한꺼번에 지급·저장한다 (localStorage 는 동기라 닫히기 전에 끝남)
    if (opts.live) {
      window.addEventListener('pagehide', () => {
        let owed = 0;
        for (const a of agents) {
          owed += autoOwed(a) + (a.alert && a.alert.kind === 'report' ? 1 : 0);
          a.autoN = 0;
          if (a.alert && a.alert.autoApproved) a.alert.treats = 0;
          if (a.alert && a.alert.kind === 'report') a.alert = null;
        }
        if (owed) addPoints(owed, t('office.demo.why.settle'), a);
      });
    }
    /**
     * 오피스 밖에서 모인 몫(알림 카드 수락·오피스가 닫혀 있던 동안 자동 수락·작업 완료)만큼 간식을 준다.
     * 결재 연출 없이 대표가 고개를 끄덕이고 한꺼번에 지급한다.
     * @param {number} n 몫 (0 이하면 아무 일도 없음)
     * @returns {void}
     * @see addPoints
     */
    function giveTreats(n) {
      if (!(n > 0)) return;
      briefly(boss, 'nod', 1.0);
      addPoints(n, t('office.demo.why.outside', { n }));
    }
    /**
     * 공개 API (DemoApi): tick, click, clickDesk, state, queue, agents, add, setBusy, remove, syncPermits, autoPermit, giveTreats, markDone, turnDone, grab, drop.
     */
    /**
     * 간식 반응: 하던 일을 멈추고(가던 길·앉기 움직임 끊기) 앉아 있었으면 의자·소파에서 바닥으로 내려와,
     * 반은 발라당(뒤로 누워 뒹굴기 2.6초), 반은 생선 간식을 들고 그르렁거리며 먹기(3초). 끝나면 바쁜 세션은 자리로, 아니면 다음 일과.
     * 들고 있던 책·잔은 내려놓는다(goTo 규칙과 같음).
     * @param {Agent} a 일꾼
     * @returns {void}
     */
    function react(a) {
      const cat = a.cat;
      a.reacting = true;
      a.token = (a.token || 0) + 1; // 가던 길·앉기 끝 콜백 무효
      a.busy = true; a.until = Infinity;
      a.book = null; cat.book = null; cat.cup = false;
      if (a.moveSpot) { office.release(cat, a.moveSpot); a.moveSpot = null; }
      cat.path = null; cat.goal = null; cat.onArrive = null; cat.base = null;
      const seat = a.at;
      reserve(a, null);
      a.at = null;
      /**
       * 바닥에서 반응하고 끝나면 이어서 할 일로.
       * @returns {void}
       */
      const go = () => {
        OfficeCat.setPose(cat, 'stand');
        const roll = Math.random() < 0.5;
        sfx(roll ? 'roll' : 'eat', a);
        briefly(cat, roll ? 'roll' : 'eat', roll ? 2.6 : 3.0, () => {
          a.reacting = false; a.busy = false;
          if (a.alert || a.held || a.leaving) return;
          if (opts.live && a.liveBusy) work(a); else chooseNext(a);
        });
      };
      if (seat && seat.pose !== 'stand') office.stand(cat, seat, go); // 의자·소파에서 내려선다
      else go();
    }
    /**
     * 고양이에게 간식을 직접 준다(남은 간식 1개를 쓴다). 그 품종 경험치 +1, 반응은 무작위:
     * 바닥에 서 있으면 반은 발라당(뒤로 누워 뒹굴기), 반은 앞발로 생선 간식을 들고 먹기. 앉아 있거나 얼음 위면 먹기.
     * 결재·알림을 처리 중이거나 들려 있거나 걷는 중이면 경험치만 오르고 반응은 건너뛴다(하던 일을 끊지 않게).
     * @param {string} id 고양이 id
     * @returns {boolean} 줬으면 true (간식이 없거나 고양이가 없으면 false)
     */
    function feed(id) {
      const a = agents.find((x) => x.cat.id === id);
      if (!a) return false;
      if (balance() <= 0) { ui.toast(t('office.demo.noTreats')); return false; }
      state.spent = (state.spent || 0) + 1;
      const br = a.cat.breed, before = levelFromXp(state.cats[br] || 0);
      state.cats[br] = (state.cats[br] || 0) + 1;
      const after = levelFromXp(state.cats[br]);
      saveTreats();
      const cat = a.cat;
      // 하던 일을 멈추고 바닥에서 반응한다(결재·보고 처리 중·들림·착지 중·얼음 위는 제외 — 얼음 위는 그 자리에서 먹기)
      if (!a.alert && !a.held && !cat.landing && !cat.held && !a.reacting) {
        OfficeCat.setMood(cat, Math.min(1, (cat.mood ?? 0.7) + 0.3));
        if (cat.skating) { sfx('eat', a); briefly(cat, 'eat', 3.0); }
        else react(a);
      }
      ui.toast(after > before ? t('office.demo.fedUp', { breed: CatModel.breedName(br), lv: after, n: balance() }) : t('office.demo.fed', { breed: CatModel.breedName(br), n: balance() }));
      return true;
    }
    /**
     * 개발·확인용: 고양이 하나에게 일과(ACTS 이름: read·coffee·fish·skate…)를 바로 시작시킨다.
     * @param {string} id 고양이 id
     * @param {string} name 일과 이름
     * @returns {boolean} 시작했으면 true
     */
    function startAct(id, name) {
      const a = agents.find((x) => x.cat.id === id), act = ACTS.find((x) => x[0] === name);
      if (!a || !act || a.alert) return false;
      a.what = name;
      return act[2](a);
    }
    return { tick, click, clickDesk, state, queue, agents, add, setBusy, remove, syncPermits, autoPermit, giveTreats, markDone, turnDone, grab, drop, levelOf, feed, balance, startAct };
  }

  return { start };
})();
