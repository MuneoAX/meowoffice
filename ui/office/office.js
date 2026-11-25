/**
 * @file 가상 오피스 렌더러 (시제품). 판단 로직 없이 받은 지시대로 그리기만 한다.
 * 하나의 async 즉시 실행 함수가 Babylon 장면(ㄷ자 사무실·카메라·조명·그림자·후처리), 고양이 14마리와 대표, 위쪽 막대(HUD)·말풍선·확대 막대·마우스 안내를 만들고,
 * 앱(Tauri) 안이면 실제 세션·알림·권한 요청을 주기적으로 받아 고양이로 보여 주며, 브라우저에서는 demo.js 의 시연 일과로 움직인다.
 * 공개 API 는 없고 개발용 핸들 window.__office = { engine, scene, camera, office, cats, boss, demo, demoTick, step, tourFocus } 와 window.__officeHint, window.__icon 만 노출한다.
 *
 * 쿼리 스트링(개발용): quality · lite · cam · breed · cats · demo · mocklive · weather · temp · wind · gust · sim · providers · nointro · speed · rush · noserve · time · dayspeed
 * Tauri 명령: get_plan · get_local · get_cloud · get_provider · get_provider_image · get_session_image · get_alert_history · get_permits · answer_permit · open_local_session · open_url · get_web_services · set_web_status_alert · log_ui
 * Tauri 이벤트: plan · alert_history · permits · auto_permit · treats · turn_done (명령 take_treats·get_config 도 씀)
 * 이 파일이 쓰는 다른 스크립트: OpenOffice · OfficeCat · CatModel · OfficeDemo · OfficeIntro · OfficeDay · OfficeWeatherFx · MeowWeather · OfficePanel · OfficeUsage · OfficeSound · OfficeTour · OfficeApp · MeowSettings · meowProviders
 */
// 가상 오피스 렌더러 (시제품). 판단 로직 없음: 받은 지시대로 그리기만 한다.
// 지금은 ㄷ자 사무실과 시연용 일과·요청(demo.js)으로 고양이 14마리와 대표(사용자)를 움직인다.
'use strict';

/**
 * @typedef {Object} PlanLimit Claude 플랜 한도 한 줄 (Rust oauth::Limit)
 * @property {string} kind 종류: "session"(5시간) | "weekly_all"(주간 전체) | "weekly_scoped"(모델별) 등
 * @property {string} label 화면에 보일 이름
 * @property {number} percent 사용한 비율 0~100
 * @property {string} severity 심각도 표시
 * @property {?string} resets_at 초기화 시각 (RFC3339)
 * @property {?number} share_of_weekly 모델별 한도: 이 모델이 쓴 양 = 주간 전체의 몇 %
 * @property {?number} allowance_of_weekly 모델별 한도: 이 모델에 허용된 양 = 주간 전체의 몇 %
 */

/**
 * @typedef {Object} Plan Claude 플랜 (Rust oauth::Plan)
 * @property {string} plan 요금제 이름
 * @property {string} tier 등급
 * @property {PlanLimit[]} limits 한도 목록
 * @property {{name: string, percent: number}[]} breakdown 주간 사용 비중 (Claude Code · Chats · Cowork …)
 * @property {?{used: number, limit: ?number, currency: string}} extra 추가 사용량
 * @property {?Object} credits 사용 크레딧 잔액 (balance · currency · promos · auto_reload)
 * @property {Object[]} promos 프로모션 사용량
 * @property {?{name: string, email: string, org_name: string}} account 계정 정보 (조회 실패 시 null)
 */

/**
 * @typedef {Object} PlanSnap get_plan 명령과 plan 이벤트가 돌려주는 플랜 스냅샷 (Rust main.rs PlanSnap). 오류도 값으로 전달된다
 * @property {?Plan} plan 플랜 (실패하면 null)
 * @property {?string} error 오류 문구
 * @property {?string} error_kind 오류 종류: "no_credentials" | "expired" | "auth" 이면 로그인 안내
 * @property {?string} state 연결 상태: "logged_out" | "connected" | "expired" | "degraded" (다른 서비스와 같은 이름, 조회 전 null)
 * @property {string} fetched_at 만든 시각 (RFC3339)
 */

/**
 * @typedef {Object} ProviderLimit 다른 AI 서비스의 한도 한 줄 (Rust providers::Limit)
 * @property {string} kind "session" | "weekly" | "monthly" | "credits" | 서비스 고유 값
 * @property {string} label 화면에 보일 이름
 * @property {?number} percent 사용한 비율 0~100 (모르면 null)
 * @property {?string} resets_at 초기화 시각 (RFC3339, 모르면 null)
 */

/**
 * @typedef {Object} ProviderSession 다른 AI 서비스의 세션(대화) 하나 (Rust providers::PSession)
 * @property {string} id 세션 id
 * @property {string} title 제목
 * @property {string} project 작업 폴더 이름
 * @property {string} cwd 작업 폴더 경로
 * @property {string} status "busy"(응답·도구 실행 중) | "idle"(열려 있지만 쉼) | ""(끝남·오래됨)
 * @property {?string} started_at 시작 시각
 * @property {?string} last_at 마지막 활동 시각
 * @property {string} url 열기 링크 (없으면 빈 문자열)
 */

/**
 * @typedef {Object} ServiceSnapshot 다른 AI 서비스(ChatGPT·Antigravity) 한 곳의 현재 상태 (Rust providers::Snapshot, get_provider 결과)
 * @property {string} provider "chatgpt" | "antigravity"
 * @property {boolean} installed 이 PC 에 설치됨(사용 흔적 있음)
 * @property {boolean} logged_in 로그인돼 있음
 * @property {string} account 계정 표시 이름 또는 이메일
 * @property {string} plan 요금제 이름
 * @property {ProviderLimit[]} limits 한도 목록
 * @property {ProviderSession[]} sessions 최근 세션
 * @property {string} error 일부 실패 설명 (비밀값 없음)
 * @property {string} fetched_at 만든 시각
 * @property {boolean} auth_expired 로그인 정보는 있으나 서버가 거절함
 * @property {string} state 연결 상태: "not_installed" | "logged_out" | "connected" | "expired" | "degraded" (Rust providers::ConnState)
 */

/**
 * @typedef {Object} ProviderPlan 현황 카드가 읽는 서비스 요금제 모양 (providerPlan 의 결과)
 * @property {string} name 계정 이름
 * @property {{plan: string, limits: PlanLimit[]}} plan 요금제 이름과 한도 (첫 한도 = 큰 숫자, 둘째 = 막대)
 */

/**
 * @typedef {Object} LocalSession 로컬 Claude 세션 한 개 (Rust local::Session, get_local 의 sessions 원소)
 * @property {string} id 세션 id
 * @property {string} title 제목
 * @property {string} project 프로젝트 이름
 * @property {string} cwd 작업 폴더
 * @property {string} model 모델
 * @property {number} total 누적 토큰
 * @property {number} turns 대화 횟수
 * @property {?string} started_at 시작 시각
 * @property {?string} last_at 마지막 활동 시각
 * @property {string} status "busy" | "idle"(실행 중) | ""(종료)
 */

/**
 * @typedef {Object} CloudSession claude.ai/code 세션 (Rust oauth::CloudSession, get_cloud 결과의 원소. 이 파일이 읽는 필드 위주)
 * @property {string} id 세션 id
 * @property {string} title 제목
 * @property {string} status "running" | "archived" 등
 * @property {string} env "cloud" | "bridge"(로컬 PC 원격 제어) 등
 * @property {string} created_at 만든 시각
 * @property {string} updated_at 갱신 시각
 * @property {string} url 열기 링크
 * @property {string} project 프로젝트 이름 (모르면 빈 값)
 */

/**
 * @typedef {Object} OpenTarget 세션·알림을 여는 방법
 * @property {("local"|"url"|"alert")} kind 로컬 세션 | 링크 | 알림
 * @property {string} [id] 로컬 세션 id
 * @property {string} [cwd] 로컬 세션 작업 폴더
 * @property {boolean} [active] 실행 중인 세션인지
 * @property {string} [url] 열 링크
 * @property {string} [project] 알림이 속한 프로젝트 (알림일 때)
 */

/**
 * @typedef {Object} LiveSession 실시간 세션 한 개 (pollSessions · pollProviders 가 만들어 live.sessions 에 담는 값)
 * @property {string} key 고양이 열쇠: "L:" 로컬 · "C:" 클라우드 · "P:서비스:" 다른 서비스 + id
 * @property {Provider} provider 서비스 이름
 * @property {boolean} busy 지금 일하는 중인지
 * @property {string} project 프로젝트 이름
 * @property {string} title 제목
 * @property {string} [lastAt] 마지막 활동 시각
 * @property {string} [startedAt] 시작 시각
 * @property {?OpenTarget} open 여는 방법 (없으면 null)
 */

/**
 * @typedef {Object} EndedSession 지난 세션 한 줄 (pollEnded 의 결과, live.ended 원소)
 * @property {string} key 열쇠 ("L:" 또는 "C:" + id)
 * @property {string} title 제목
 * @property {string} project 프로젝트 이름
 * @property {string} lastAt 마지막 활동 시각
 * @property {OpenTarget} open 여는 방법
 */

/**
 * @typedef {Object} LiveState 실시간 상태 (live)
 * @property {Map<string, LiveSession>} sessions 지금 고양이로 보이는 세션
 * @property {?Plan} plan Claude 플랜
 * @property {string} name 계정 이름
 * @property {AlertEntry[]} alerts 알림 기록
 * @property {Object<string, ?ServiceSnapshot>} providers 서비스별 상태 (chatgpt · antigravity)
 * @property {EndedSession[]} ended 지난 세션
 */

/**
 * @typedef {Object} Cat 고양이 하나 (cat.js OfficeCat.create 의 결과. 이 파일이 읽는 필드 위주)
 * @property {string} id 고양이 id (실시간에서는 세션 열쇠)
 * @property {string} breed 품종
 * @property {BABYLON.TransformNode} root 위치·회전을 가진 뿌리 노드
 * @property {BABYLON.AbstractMesh[]} meshes 몸 메시들
 * @property {string} pose 자세: stand | sit | loaf | walk
 * @property {string} act 행동: idle | type | read | talk | drink | sleep 등
 * @property {?string} signal 말풍선 종류 (없으면 null)
 * @property {?string} [signalText] 말풍선 글자 (없으면 기본 문구)
 * @property {Provider} [provider] 서비스 이름
 * @property {boolean} [landing] 패러글라이더로 내려오는 중
 * @property {boolean} [leaving] 퇴근 중
 * @property {boolean} [held] 목덜미 잡혀 들린 중
 * @property {number} hopT 폴짝 남은 시간
 * @property {boolean} [quad] 네 발로 걷는 중 (건물 밖)
 * @property {Object} [model] 3D 모델 연결 (CatModel.attach 결과, 없으면 임시 모형)
 */

/**
 * @typedef {Object} DeskSpot 책상 자리 (open office 의 desk 항목)
 * @property {string} id 책상 id
 * @property {BABYLON.Vector3} pos 자리 위치
 * @property {number} rotY 앉은 방향(rad)
 */

/**
 * @typedef {Object} Agent 고양이 한 마리의 일과 상태 (demo.js 가 관리, demo.agents 의 원소. 이 파일이 읽는 필드 위주)
 * @property {Cat} cat 고양이
 * @property {?DeskSpot} desk 자기 책상
 * @property {*} at 지금 있는 자리 (desk 와 같으면 책상에 앉아 있음)
 * @property {string} what 하는 일 ("work" 등)
 * @property {?{kind: string}} alert 진행 중인 요청 (kind = permission | question | complete | error 등)
 * @property {string} project 프로젝트 이름
 * @property {boolean} liveBusy 실시간: 일하는 중인지
 * @property {?LiveSession} info 실시간 세션 정보
 * @property {boolean} [leaving] 퇴근 중
 * @property {string} [img] 모니터에 띄울 그림 (data URL)
 * @property {string} [imgAt] 그림의 기록 시각
 */

/**
 * @typedef {Object} AlertEntry 알림 기록 한 건 (Rust alerts::Entry = Alert + read · resolved, get_alert_history 결과)
 * @property {string} key 열쇠
 * @property {string} id 알림 id
 * @property {string} title 제목
 * @property {string} message 본문
 * @property {string} state 상태 (done · need_input · update 등)
 * @property {string} env 환경 (local · cloud · update 등)
 * @property {string} [url] 열 링크
 * @property {string} updated_at 갱신 시각 (RFC3339)
 * @property {boolean} [agent] 서브·백그라운드 에이전트 알림
 * @property {string} project 프로젝트 이름
 * @property {string} [kind] 종류 id
 * @property {("claude"|"chatgpt"|"antigravity"|"app")} provider 서비스 id ("app" = 서비스 무관 앱 알림)
 * @property {boolean} read 읽음
 * @property {boolean} resolved 대기 상태가 풀림 (사용자가 처리)
 */

/**
 * @typedef {Object} PermitInfo 권한 요청·질문 한 건 (Rust permit::Permit, get_permits 결과와 permits · auto_permit 이벤트)
 * @property {string} id 요청 id
 * @property {("tool"|"question")} kind 카드 형식
 * @property {Provider} provider 요청을 보낸 서비스
 * @property {string} project 프로젝트 이름
 * @property {string} tool 도구 이름
 * @property {string} detail 본문 (Bash 명령 · 파일 경로 · URL 등)
 * @property {string} description 설명
 * @property {string} created_at 만든 시각
 * @property {Object[]} [questions] question 형식의 질문 목록 (header · question · options · multiSelect)
 * @property {string} session 요청한 세션 (고양이 찾기용)
 */

/**
 * @typedef {Object} CardSpec 요청 카드 설명
 * @property {string} kind 카드 종류 ("permission" 이면 승인·반려 도장 연출)
 * @property {string} title 제목
 * @property {string} [project] 프로젝트 이름
 * @property {Array<[string, string]>} rows 본문 줄들 [이름, 값]
 * @property {Array<[string, string]>} buttons 단추들 [값, 글자] (첫 단추가 기본)
 */

/**
 * @typedef {Object} ScreenPlace 화면 판 하나의 놓을 곳
 * @property {number} x 월드 x
 * @property {number} y 월드 y
 * @property {number} z 월드 z
 * @property {number} rotY 앞면이 보는 방향(rad)
 * @property {number} w 가로(m)
 * @property {number} h 세로(m)
 * @property {number} [tilt] 위가 뒤로 눕는 각도(rad)
 * @property {boolean} [desk] 책상 모니터인지 (true 면 책상 위 빛도 만든다)
 */

/**
 * @typedef {Object} ScreenEntry 화면 판 하나의 상태 (screens 맵의 값)
 * @property {BABYLON.Mesh} mesh 화면 판
 * @property {string} url 내용: 이미지 data URL | "console" | "off"
 * @property {?BABYLON.StandardMaterial} own 이미지용 재질
 * @property {BABYLON.Mesh} halo 화면 둘레 후광
 * @property {?BABYLON.Mesh} pool 책상 위로 번지는 빛
 */

/**
 * 사무실 화면 전체를 만들고 돌리는 진입점.
 * 장면·카메라·조명·후처리·사무실·고양이를 만들고, 위쪽 막대·말풍선·확대 막대·안내·설정·업데이트 단추를 붙인 뒤, 렌더 루프를 시작한다.
 * 앱 안(LIVE)이면 세션·알림·권한 요청을 주기 조회로 받고, 아니면 시연 모드. 초기화에 실패하면 끝의 catch 가 안내 문구를 띄우고 log_ui 로 앱 로그에 남긴다.
 * @returns {Promise<void>}
 * @see OpenOffice.create, OfficeDemo.start, OfficeIntro.start, OfficeApp.start
 */
(async () => {
  const canvas = document.getElementById('view');
  const bubbleLayer = document.getElementById('bubbles');
  const engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false, antialias: true }, true);
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 2));

  const scene = new BABYLON.Scene(engine);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#eef0f6';
  scene.clearColor = BABYLON.Color4.FromHexString(bg + 'ff');
  scene.ambientColor = new BABYLON.Color3(0.3, 0.3, 0.32);
  scene.skipPointerMovePicking = true;
  scene.autoClear = true;

  // 카메라: 비스듬히 내려다보는 시점. 휠 = 확대·축소, 왼쪽 끌기 = 평면 이동, 오른쪽 끌기(또는 Shift+끌기) = 돌리기, Q/E = 45° 돌리기.
  const camera = new BABYLON.ArcRotateCamera('cam', -Math.PI * 0.68, 0.78, 30, new BABYLON.Vector3(0, 0, 0), scene);
  camera.fov = 0.5;
  camera.minZ = 0.1;
  camera.maxZ = 500;
  camera.lowerRadiusLimit = 6;
  camera.upperRadiusLimit = 50; // 처음 화각(반지름 50) = 1배. 그보다 멀리는 빼지 않는다
  camera.wheelDeltaPercentage = 0.02; // 휠 한 칸 확대·축소 비율 (0.01 은 느리다는 의견으로 2배)
  camera.inputs.removeByType('ArcRotateCameraPointersInput');
  camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
  camera.attachControl(canvas, true);
  {
    let drag = null;
    const ground = BABYLON.Plane.FromPositionAndNormal(BABYLON.Vector3.Zero(), BABYLON.Vector3.Up());
    /**
     * 화면 좌표 아래의 바닥(y=0 평면) 위치 구하기.
     * 카메라에서 그 점으로 광선을 쏘아 바닥 평면과 만나는 점을 돌려준다. 하늘 쪽이면 null.
     * @param {number} x 캔버스 안 x(px)
     * @param {number} y 캔버스 안 y(px)
     * @returns {?BABYLON.Vector3} 바닥의 월드 좌표
     */
    const hit = (x, y) => {
      const ray = scene.createPickingRay(x, y, BABYLON.Matrix.Identity(), camera);
      const t = ray.intersectsPlane(ground);
      return t == null ? null : ray.origin.add(ray.direction.scale(t));
    };
    let down = null, rot = null;
    const BETA = [0.42, 1.22]; // 위에서 내려다보는 각도 범위 (너무 눕거나 바로 위에서 보지 않게)
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    let carry = null; // 끌고 있는 고양이 { cat, moved }
    /**
     * 포인터 누름: 화면 끌기·돌리기·고양이 끌기 시작.
     * 오른쪽 단추·Shift 면 카메라 돌리기를 시작한다. 고양이(대표 제외, 집을 수 있는 것) 위에서 누르면 고양이 끌기 준비(조금 움직여야 시작, 그냥 놓으면 클릭), 아니면 바닥 점을 잡아 화면 끌기를 시작한다.
     * @param {PointerEvent} e 포인터 이벤트
     * @returns {void}
     * @see hit, canGrab, catById, bossCat
     */
    canvas.addEventListener('pointerdown', (e) => {
      down = [e.offsetX, e.offsetY];
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 2 || e.shiftKey) { rot = [e.offsetX, e.offsetY]; return; }
      // 고양이 위에서 누르면 고양이 끌기(조금 움직여야 시작, 그냥 놓으면 클릭), 아니면 화면 끌기
      const h = scene.pick(e.offsetX, e.offsetY, (m) => m.isPickable && m.isEnabled() && m.metadata && m.metadata.catId);
      const cat = h && h.hit && catById(h.pickedMesh.metadata.catId);
      if (cat && cat !== bossCat() && canGrab(cat)) { carry = { cat, moved: false }; canvas.classList.add('carrying'); return; } // 누르는 순간 잡는 손 모양
      drag = hit(e.offsetX, e.offsetY);
    });
    /**
     * 포인터 이동: 돌리기 · 고양이 들고 옮기기 · 화면 끌기 · 커서 모양.
     * 돌리는 중이면 카메라 alpha·beta 를 바꾼다(beta 는 BETA 범위로 제한). 고양이를 잡았으면 6px 넘게 움직인 뒤 grabCat 으로 들어 올려 바닥 위 0.5m 에서 따라오게 한다.
     * 화면 끌기는 잡은 바닥 점과 현재 점의 차이만큼 카메라 목표를 옮기고 따라가기를 멈춘다. 아무것도 안 잡았으면 hover 로 커서만 정한다.
     * @param {PointerEvent} e 포인터 이벤트
     * @returns {void}
     * @see hit, hover, grabCat, stopFollow
     */
    canvas.addEventListener('pointermove', (e) => {
      if (rot) {
        camera.alpha -= (e.offsetX - rot[0]) * 0.006;
        camera.beta = Math.max(BETA[0], Math.min(BETA[1], camera.beta - (e.offsetY - rot[1]) * 0.004));
        rot = [e.offsetX, e.offsetY];
        return;
      }
      if (carry) {
        if (!carry.moved) {
          if (Math.hypot(e.offsetX - down[0], e.offsetY - down[1]) < 6) return;
          if (!grabCat(carry.cat)) { carry = null; canvas.classList.remove('carrying'); return; } // 지금은 못 집는 고양이
          carry.moved = true;
        }
        const p = hit(e.offsetX, e.offsetY);
        if (p) carry.cat.root.position.set(p.x, 0.5, p.z); // 목덜미를 잡아 들어 올린 채 따라온다(발이 바닥에서 뜸)
        return;
      }
      if (!drag) { hover(e.offsetX, e.offsetY); return; }
      const p = hit(e.offsetX, e.offsetY);
      if (p) { camera.target.addInPlace(drag.subtract(p)); stopFollow(); }
    });
    // 고양이 위면 커서를 고양이 발로 (고르기는 프레임당 한 번만)
    let hoverAt = null;
    /**
     * 고양이 위인지 보고 커서 모양 바꾸기 (프레임당 한 번만 고르기).
     * 좌표를 기억해 두고 다음 프레임에 한 번만 scene.pick 으로 고양이 메시를 찾아 on-cat 클래스를 켜고 끈다.
     * @param {number} x 캔버스 안 x(px)
     * @param {number} y 캔버스 안 y(px)
     * @returns {void}
     */
    const hover = (x, y) => {
      if (hoverAt) { hoverAt = [x, y]; return; }
      hoverAt = [x, y];
      requestAnimationFrame(() => {
        const [hx, hy] = hoverAt; hoverAt = null;
        const h = scene.pick(hx, hy, (m) => m.isPickable && m.isEnabled() && m.metadata && m.metadata.catId);
        canvas.classList.toggle('on-cat', !!(h && h.hit));
      });
    };
    canvas.addEventListener('pointerleave', () => canvas.classList.remove('on-cat'));
    /**
     * 포인터 뗌: 끌기 끝내기 또는 클릭 처리.
     * 고양이를 들고 옮겼다면 dropCat 으로 내려놓는다. 돌리던 중이면 끝낸다. 거의 움직이지 않았으면(6px 미만) 클릭으로 보고 onPick 을 부른다.
     * @param {PointerEvent} e 포인터 이벤트
     * @returns {void}
     * @see dropCat, onPick
     */
    canvas.addEventListener('pointerup', (e) => {
      drag = null;
      if (carry) {
        const c = carry; carry = null;
        canvas.classList.remove('carrying');
        if (c.moved) { dropCat(c.cat, e); down = null; return; }
      }
      if (rot) { rot = null; down = null; return; }
      // 거의 안 움직였으면 누르기: 고양이 또는 대표 책상
      if (down && Math.hypot(e.offsetX - down[0], e.offsetY - down[1]) < 6) onPick(e.offsetX, e.offsetY);
      down = null;
    });
  }
  let onPick = () => {};
  let stopFollow = () => {};
  // 고양이 끌기 연결점 (아래에서 demo 가 준비되면 채운다)
  let catById = () => null, bossCat = () => null, canGrab = () => false, grabCat = () => false, dropCat = () => {};
  // Q/E: 45° 씩 부드럽게 돌리기
  let spinTo = null;
  /**
   * 입력창에 글을 쓰는 중인지.
   * 이벤트 경로의 첫 요소가 INPUT · TEXTAREA · SELECT 인지 본다 (단축키를 건너뛰기 위해).
   * @param {Event} e 이벤트
   * @returns {boolean} 입력 중이면 true
   */
  const typing = (e) => { const t = (e.composedPath && e.composedPath()[0]) || e.target; return t && /INPUT|TEXTAREA|SELECT/.test(t.tagName); };
  /**
   * Q · E 로 카메라를 45도씩 돌리기.
   * 입력 중이 아니면 spinTo 목표 각도를 45도 더해 두고, 렌더 전 처리에서 부드럽게 따라간다.
   * @param {KeyboardEvent} e 키 이벤트
   * @returns {void}
   * @see typing
   */
  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    const k = e.key.toLowerCase();
    if (k === 'q' || k === 'e') spinTo = (spinTo ?? camera.alpha) + (k === 'q' ? 1 : -1) * Math.PI / 4;
  });
  scene.onBeforeRenderObservable.add(() => {
    if (spinTo == null) return;
    const d = spinTo - camera.alpha;
    if (Math.abs(d) < 0.002) { camera.alpha = spinTo; spinTo = null; return; }
    camera.alpha += d * Math.min(1, engine.getDeltaTime() / 120);
  });

  // 조명: 하늘빛 + 해. 그림자는 해 하나만.
  const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0.2, 1, -0.3), scene);
  hemi.intensity = 0.8;
  hemi.diffuse = new BABYLON.Color3(1, 0.985, 0.97);
  hemi.groundColor = new BABYLON.Color3(0.72, 0.68, 0.7);
  const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(0.45, -1, 0.6), scene);
  sun.position = new BABYLON.Vector3(-4, 8, -5);
  sun.intensity = 0.65;
  sun.diffuse = new BABYLON.Color3(1, 0.96, 0.9);
  // 그래픽 품질: low(그림자 1024·후처리 없음) / mid(그림자 2048·SSAO 없음, 기본) / high(그림자 4096·SSAO). ?lite = low
  /**
   * 그래픽 품질 정하기.
   * 우선순위: 쿼리 lite = low, 쿼리 quality, 저장소 office.quality, 기본 mid. low(그림자 1024·후처리 없음) / mid(그림자 2048·SSAO 없음) / high(그림자 4096·SSAO·조명 번짐).
   * @returns {("low"|"mid"|"high")} 품질 이름
   */
  const QUALITY = (() => {
    const q = new URLSearchParams(location.search).get('quality');
    if (new URLSearchParams(location.search).has('lite')) return 'low';
    if (['low', 'mid', 'high'].includes(q)) return q;
    try { const v = localStorage.getItem('office.quality'); if (['low', 'mid', 'high'].includes(v)) return v; } catch (e) { /* 저장소 없음 */ }
    return 'mid';
  })();
  const shadows = new BABYLON.ShadowGenerator({ low: 1024, mid: 2048, high: 4096 }[QUALITY], sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
  shadows.darkness = 0.4;
  shadows.bias = 0.002;

  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  scene.imageProcessingConfiguration.exposure = 1.0;

  // 후처리: 모서리 그늘(SSAO) + 조명 번짐 + 대비. ?lite 로 끈다(성능 비교용).
  let pipe = null; // 후처리 (낮·밤 노출 조절에 씀)
  if (QUALITY !== 'low') {
    if (QUALITY === 'high') {
      const ssao = new BABYLON.SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [camera]);
      ssao.radius = 1.2;
      ssao.totalStrength = 1.1;
      ssao.samples = 16;
      ssao.maxZ = 120;
      ssao.expensiveBlur = true;
    }
    pipe = new BABYLON.DefaultRenderingPipeline('post', true, scene, [camera]);
    pipe.fxaaEnabled = true;
    pipe.bloomEnabled = QUALITY === 'high'; // 조명 번짐은 높음에서만
    pipe.bloomThreshold = 0.97;
    pipe.bloomWeight = 0.25;
    pipe.bloomKernel = 48;
    pipe.imageProcessingEnabled = true;
    pipe.imageProcessing.toneMappingEnabled = true;
    pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
    pipe.imageProcessing.contrast = 1.25;
    pipe.imageProcessing.exposure = 0.88;
    pipe.imageProcessing.vignetteEnabled = false;
    pipe.imageProcessing.vignetteWeight = 0.6;
    pipe.imageProcessing.vignetteColor = new BABYLON.Color4(0.85, 0.85, 0.92, 0);
  }

  // ── 개방형 사무실 + 시연용 일과 (고양이 14마리 + 대표)
  const office = await OpenOffice.create(scene, { shadows });
  OfficeCat.setDoors(office.doors); // 문 양보 규칙
  OfficeCat.setKeepOut(office.keepOut); // 물체 간격 띠 (걷는 고양이가 가구를 스치거나 뚫지 않게)
  // 낮·밤: 컴퓨터 시각에 맞춘 해·달·조명 (?time=19:30, ?dayspeed=600 으로 시험)
  const day = OfficeDay.start(scene, { sun, hemi, shadows, pipe, lineTops: office.glassTops, lineY: office.wallH, lights: office.lights });
  // 날씨·계절: 사무실 위치의 현재 날씨(30분마다)를 장면에 (비·눈·우박·안개·흐림, 바람(돌풍), 계절 나무·바닥, 언 연못). 개발용 ?weather=rain|hail ?wind=45 등
  const wxFx = OfficeWeatherFx.start(scene, { camera, day, quality: QUALITY, ground: office.ground });
  // 방 표지판: 멀리서 볼 때 방마다 "이름 · 용도" (roomsigns.js)
  const roomSigns = OfficeRoomSigns.start({ scene, camera, stage: document.getElementById('stage') });
  // 연말 크리스마스 트리: 로비 대표 책상 서쪽 앞(openoffice.js XMAS 자리 — 배치 검사·고양이 피해 가기에 들어가 있음)
  const xmas = typeof OfficeXmas !== 'undefined' && office.xmas ? OfficeXmas.start({ scene, shadows, leafShadow: QUALITY !== 'low', x: office.xmas.x, z: office.xmas.z }) : null;
  {
    const fake = new URLSearchParams(location.search).get('weather');
    const temp = new URLSearchParams(location.search).get('temp');
    if (fake) wxFx.apply({ kind: fake, temp: temp != null ? +temp : 12, place: '시험', at: Date.now() });
    else {
      window.addEventListener('meow-weather', (e) => wxFx.apply(e.detail));
      MeowWeather.start();
      const w0 = MeowWeather.get();
      if (w0) wxFx.apply(w0);
    }
  }
  camera.target.set(15, 0, 12);
  camera.radius = 50;
  const params = new URLSearchParams(location.search);
  // 개발용: ?cam=x,z,반지름
  const camQ = params.get('cam');
  if (camQ) {
    const [x, z, r] = camQ.split(',').map(Number);
    camera.target.set(x, 0, z);
    if (r) camera.radius = r;
  }

  await CatModel.preload(scene); // 3D 고양이 모델 (실패하면 임시 모형)
  const cats = [];
  // 품종: 도감 16종을 돌아가며 (개발용 ?breed=bengal 로 한 품종만)
  const breedQ = params.get('breed');
  const BREED_CYCLE = breedQ ? [breedQ] : CatModel.breeds();
  // 앱(Tauri) 안이면 실제 세션으로, 브라우저면 시연. 개발용 ?demo 로 앱에서도 시연
  // 개발용: ?mocklive — 브라우저에서 가짜 세션으로 실시간 모드 시험 (세션 수·바쁨이 시간에 따라 바뀐다)
  if (params.has('mocklive') && !window.__TAURI__) {
    const t0 = Date.now();
    const sess = (n) => Array.from({ length: n }, (_, i) => ({ id: 'mock' + i, status: (Math.floor((Date.now() - t0) / 15000) + i) % 3 ? 'busy' : 'idle', project: ['meowoffice', 'cat-cafe', 'shop-api'][i % 3], title: '시험 세션 ' + i }));
    window.__TAURI__ = {
      core: {
        invoke: async function (cmd) {
          const k = Math.floor((Date.now() - t0) / 20000); // 20초마다 세션 수 변화
          if (cmd === 'get_local') return { sessions: sess(4 + (k % 4)).map((x, i) => ({ ...x, last_at: String(Math.floor((Date.now() - t0) / 30000) + i) })) };
          if (cmd === 'get_cloud') return [];
          if (cmd === 'get_alert_history') { // 시험 알림 기록: 서비스별 로고 확인용
            const at = (m) => new Date(Date.now() - m * 60e3).toISOString();
            return [
              { key: 'a1', id: 'a1', title: 'cat-cafe 응답 완료', message: '작업을 마쳤습니다.', state: 'done', env: 'local', project: 'cat-cafe', provider: 'claude', updated_at: at(1), read: false, resolved: false },
              { key: 'a2', id: 'codex:1', title: 'Codex 응답 완료', message: '리팩터링을 끝냈습니다.', state: 'done', env: 'local', project: 'shop-api', provider: 'chatgpt', updated_at: at(4), read: false, resolved: false },
              { key: 'a3', id: 'agy:1', title: 'Antigravity 응답 완료', message: '변경 사항을 정리했습니다.', state: 'done', env: 'local', project: 'meowoffice', provider: 'antigravity', updated_at: at(9), read: true, resolved: false },
              { key: 'a4', id: 'u', title: '새 버전 0.9.0', message: '업데이트할 수 있습니다.', state: 'update', env: 'update', provider: 'app', updated_at: at(30), read: true, resolved: false },
            ];
          }
          if (cmd === 'get_permits') { // 시험 요청: 도구 하나, 질문 하나 (10초 뒤부터)
            if (Date.now() - t0 < 10000) return [];
            window.__mockPermits = window.__mockPermits || [
              { id: 'p1', kind: 'tool', session: 'mock1', project: 'cat-cafe', tool: 'Bash', detail: 'npm run build', description: '빌드 실행', created_at: new Date().toISOString() },
              { id: 'p2', kind: 'question', session: 'mock2', project: 'shop-api', tool: 'AskUserQuestion', detail: '', description: '', created_at: new Date().toISOString(),
                questions: [{ question: '배포 전에 검수 돌릴까요?', options: [{ label: '예' }, { label: '아니요' }], multiSelect: false }] },
            ];
            return window.__mockPermits;
          }
          if (cmd === 'answer_permit') { const id = arguments[1].id; window.__mockPermits = (window.__mockPermits || []).filter((p) => p.id !== id); console.log('[mock] answer', JSON.stringify(arguments[1])); return null; }
          if (cmd === 'get_session_image') { // 세션 둘에 하나꼴로 시험 그림
            if (Number(String(arguments[1] && arguments[1].id).replace(/\D/g, '')) % 2) return null;
            const c = document.createElement('canvas'); c.width = 320; c.height = 180;
            const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 320, 180);
            gr.addColorStop(0, '#ffb86b'); gr.addColorStop(1, '#6b8cff'); g.fillStyle = gr; g.fillRect(0, 0, 320, 180);
            g.fillStyle = '#fff'; g.font = 'bold 48px sans-serif'; g.fillText('IMG ' + arguments[1].id, 20, 110);
            return c.toDataURL('image/png');
          }
          if (cmd === 'get_plan') return { plan: { account: { name: '시험 계정' }, limits: [{ kind: 'session', percent: 42 }, { kind: 'weekly_all', percent: 17 }] } };
          return null;
        },
      },
      event: { listen: async () => () => {} },
    };
  }
  const LIVE = !!(window.__TAURI__ && window.__TAURI__.core) && !params.has('demo');
  const nCats = LIVE ? 0 : Number(params.get('cats')) || 14;
  for (let i = 0; i < Math.min(nCats, office.desks.length); i++) {
    const cat = OfficeCat.create(scene, { id: 'c' + i, breed: BREED_CYCLE[i % BREED_CYCLE.length] || 'korean_cheese' });
    cats.push(cat);
  }
  const boss = OfficeCat.create(scene, { id: 'boss', breed: 'boss' });
  [...cats, boss].forEach((c) => c.meshes.forEach((m) => { shadows.addShadowCaster(m); m.receiveShadows = true; }));
  const all = [...cats, boss];
  // 소리: 지난번에 켜 두었으면 첫 클릭 때 다시 켠다 (자동 재생 제한)
  if (OfficeSound.savedOn()) window.addEventListener('pointerdown', () => OfficeSound.setEnabled(true), { once: true });

  // 위쪽 막대 아이콘 (선 아이콘, 24 칸)
  const ICON = {
    stamp: '<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-3-3c-1.66 0-3 1-3 3s1 2 1 3.5V13"/>',
    fish: '<path d="M6.5 12c.94-3.46 4.94-6 8.5-6 3.56 0 6.06 2.54 7 6-.94 3.47-3.44 6-7 6s-7.56-2.53-8.5-6Z"/><path d="M18 12v.5"/><path d="M16 17.93a9.77 9.77 0 0 1 0-11.86"/><path d="M7 10.67C7 8 5.58 5.97 2.73 5.5c-1 1.5-1 5 .23 6.5-1.24 1.5-1.24 5-.23 6.5C5.58 18.03 7 16 7 13.33"/>',
    volOn: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    volOff: '<path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sunrise: '<path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    sunset: '<path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    max: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    min: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  };
  /**
   * 위쪽 막대 아이콘 이름으로 선 아이콘 SVG 만들기.
   * ICON 표의 경로를 24칸 선 아이콘 틀에 끼운다. window.__icon 으로도 노출해 panel.js 등이 같은 아이콘을 쓴다.
   * @param {string} k ICON 의 키
   * @returns {string} <svg> 마크업
   */
  const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  window.__icon = svg; // panel.js 등에서도 같은 아이콘
  /**
   * 화질 아이콘: n×n 픽셀 (칸이 많을수록 고화질).
   * 16칸 영역을 n 등분해 작은 둥근 사각형을 격자로 깐다.
   * @param {number} n 한 변의 칸 수 (low 3 · mid 4 · high 5)
   * @returns {string} <svg> 마크업
   */
  const pixels = (n) => {
    const a = 4, w = 16, c = w / n, g = Math.max(0.6, c * 0.18);
    let r = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) r += `<rect x="${(a + x * c + g / 2).toFixed(2)}" y="${(a + y * c + g / 2).toFixed(2)}" width="${(c - g).toFixed(2)}" height="${(c - g).toFixed(2)}" rx="0.4"/>`;
    return `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${r}</svg>`;
  };

  // ── 화면 UI: 상단 현황, 알림 토스트, 요청 카드(결재 도장)
  /**
   * 화면 UI 모음: 상단 현황(HUD), 소리, 토스트, 요청 카드.
   * DOM 요소(#hud · #toast · #card)와 타이머를 안쪽에 두고 아래 메서드가 달린 객체를 돌려준다. demo.js 에 ui 로 넘겨 쓴다.
   * @returns {{limits: function(PlanLimit[]): void, hud: function({queue: number, points: number}): void, fx: function(string, Cat): void, sfx: function(string, Cat): void, toast: function(string): void, card: function(CardSpec): Promise<?string>}} UI 객체
   */
  const ui = (() => {
    const hud = document.getElementById('hud');
    const toastEl = document.getElementById('toast');
    const cardEl = document.getElementById('card');
    let toastTimer = 0;
    let lastHud = '';
    return {
      /**
       * 한도 문구 정하기.
       * 세션(5시간)·주간 전체 한도를 "Claude 5시간 N% · 주간 N%" 로 만들어 limitText 에 두고, 다음 hud 호출에서 다시 그리게 한다.
       * @param {PlanLimit[]} list 한도 목록
       * @returns {void}
       */
      limits(list) {
        const pick = (k) => list.find((l) => l.kind === k);
        const f = (l) => (l ? Math.round(l.percent) + '%' : '-');
        this.limitText = `Claude 5시간 ${f(pick('session'))} · 주간 ${f(pick('weekly_all'))}`;
        lastHud = '';
      },
      /**
       * 위쪽 막대(HUD) 단추들 그리기.
       * 결재 대기 수·간식 수·소리 켬 여부·한도 문구가 직전과 같으면 다시 그리지 않는다. 다르면 결재 · 간식 · 소리 · 화질 단추를 만들고 클릭을 연결한다.
       * 결재 단추 = 대표 책상으로 이동(focusCat), 화질 단추 = 다음 품질을 저장하고 페이지 다시 열기, 소리 단추 = 켜고 끄기.
       * @param {{queue: number, points: number}} state 결재 대기 건수와 간식 개수
       * @returns {void}
       * @see focusCat, OfficeSound.setEnabled
       */
      hud({ queue, points }) {
        const k = queue + '|' + points + '|' + OfficeSound.isOn() + '|' + (this.limitText || '') + '|' + (this.treatHint || '');
        if (k === lastHud) return;
        lastHud = k;
        const q = { low: '낮음', mid: '보통', high: '높음' }[QUALITY];
        hud.innerHTML = `<button class="ib h-q" title="결재 대기 ${queue}건 (누르면 대표 책상으로)">${svg('stamp')}${queue ? `<em class="bad">${queue}</em>` : ''}</button>`
          // 안내 문구에 큰따옴표가 있어 속성값에 그대로 넣으면 그 자리에서 title 이 끊긴다 → 속성용으로 바꿔 넣는다
          + `<button class="ib h-p" title="${`간식 ${points}개${this.treatHint ? ' · ' + this.treatHint : ''}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${svg('fish')}<em class="cnt">${points}</em></button>`
          + `<button class="ib h-snd" title="고양이 소리 ${OfficeSound.isOn() ? '켬' : '끔'} (누르면 바꿈)">${svg(OfficeSound.isOn() ? 'volOn' : 'volOff')}</button>`
          + `<button class="ib h-q2" title="화질 ${q} (누르면 바꿈, 낮을수록 가벼움)">${pixels({ low: 3, mid: 4, high: 5 }[QUALITY])}</button>`;
        hud.querySelector('.h-q').onclick = () => { if (typeof focusCat === 'function') focusCat('boss'); };
        hud.querySelector('.h-q2').onclick = () => {
          const next = { low: 'mid', mid: 'high', high: 'low' }[QUALITY];
          try { localStorage.setItem('office.quality', next); } catch (e) { /* 저장 못 해도 이번만 */ }
          const u = new URL(location.href); u.searchParams.set('quality', next); location.replace(u.toString());
        };
        hud.querySelector('.h-snd').onclick = async () => { await OfficeSound.setEnabled(!OfficeSound.isOn()); lastHud = ''; };
      },
      /**
       * 고양이 효과음 재생 (보는 곳에서 멀수록 작게).
       * 소리가 켜져 있을 때만. 고양이의 화면 위치로 좌우를, 카메라 목표와의 거리로 크기를 정한다.
       * @param {string} name 효과음 이름
       * @param {Cat} cat 소리를 낸 고양이
       * @returns {void}
       * @see OfficeSound.fx
       */
      fx(name, cat) {
        if (!OfficeSound.isOn()) return;
        const w = engine.getRenderWidth(), h = engine.getRenderHeight();
        const p = BABYLON.Vector3.Project(cat.root.position, BABYLON.Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(w, h));
        // 보고 있는 곳에서 멀수록 작게
        const d = BABYLON.Vector3.Distance(cat.root.position, camera.target) + camera.radius * 0.3;
        OfficeSound.fx(name, 1 - Math.max(0, d - 8) / 30, (p.x / w) * 2 - 1);
      },
      /**
       * 고양이 소리 재생 (품종별).
       * 소리가 켜져 있을 때만. 고양이의 화면 좌우 위치로 소리 방향을 정한다.
       * @param {string} ev 소리 이벤트 이름
       * @param {Cat} cat 소리를 낸 고양이
       * @returns {void}
       * @see OfficeSound.play
       */
      sfx(ev, cat) {
        if (!OfficeSound.isOn()) return;
        // 화면 좌우 위치로 소리 방향
        const w = engine.getRenderWidth(), h = engine.getRenderHeight();
        const p = BABYLON.Vector3.Project(cat.root.position, BABYLON.Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(w, h));
        OfficeSound.play(ev, cat.breed, (p.x / w) * 2 - 1);
      },
      /**
       * 화면 아래 토스트 문구를 2.2초 동안 띄우기.
       * @param {string} text 문구
       * @returns {void}
       */
      toast(text) {
        toastEl.textContent = text;
        toastEl.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2200);
      },
      /**
       * 요청 카드 열고 사용자의 선택 기다리기.
       * 제목·프로젝트·줄·단추로 카드를 채워 연다. 권한(permission) 카드는 단추를 누르면 승인/반려 도장을 찍고 0.65초 뒤 닫는다. × 는 null 을 돌려준다.
       * @param {CardSpec} spec 카드 설명
       * @returns {Promise<?string>} 누른 단추의 값 (× 로 닫으면 null)
       */
      card(spec) {
        return new Promise((resolve) => {
          cardEl.dataset.kind = spec.kind;
          cardEl.innerHTML = `
            <div class="c-head"><span class="c-title"></span><span class="c-proj"></span><button class="c-x" aria-label="닫기">×</button></div>
            <div class="c-body"></div>
            <div class="c-btns"></div>
            <div class="c-stamp"></div>`;
          cardEl.querySelector('.c-title').textContent = spec.title;
          cardEl.querySelector('.c-proj').textContent = spec.project || '';
          const body = cardEl.querySelector('.c-body');
          for (const [k, v] of spec.rows) {
            const r = document.createElement('div');
            r.className = 'c-row';
            r.innerHTML = '<span class="k"></span><span class="v"></span>';
            r.querySelector('.k').textContent = k;
            r.querySelector('.v').textContent = v;
            body.appendChild(r);
          }
          const close = (v) => { cardEl.classList.remove('on'); resolve(v); };
          cardEl.querySelector('.c-x').onclick = () => close(null);
          const btns = cardEl.querySelector('.c-btns');
          spec.buttons.forEach(([v, label], i) => {
            const bt = document.createElement('button');
            bt.textContent = label;
            bt.className = i === 0 ? 'primary' : '';
            bt.onclick = () => {
              if (spec.kind === 'permission') {
                // 도장 쾅
                const st = cardEl.querySelector('.c-stamp');
                st.textContent = v === 'approve' ? '승인' : '반려';
                st.className = 'c-stamp on ' + (v === 'approve' ? 'ok' : 'no');
                btns.querySelectorAll('button').forEach((x) => (x.disabled = true));
                setTimeout(() => close(v), 650);
              } else close(v);
            };
            btns.appendChild(bt);
          });
          cardEl.classList.add('on');
        });
      },
    };
  })();

  // 실제 요청 응답: 앱의 answer_permit (실패 = 이미 끝난 요청)
  /**
   * 실제 권한 요청·질문에 응답.
   * 앱의 answer_permit 으로 보낸다. 실패 = 이미 끝난 요청이므로 토스트로 알리고 false.
   * @param {string} id 요청 id
   * @param {boolean} allow 승인 여부
   * @param {*} [answers] 질문 답변
   * @returns {Promise<boolean>} 보냈으면 true
   * @see answer_permit
   */
  const answer = async (id, allow, answers) => {
    try { await window.__TAURI__.core.invoke('answer_permit', { id, allow, answers }); return true; } catch (e) { ui.toast('이미 처리된 요청이에요'); return false; }
  };
  // 진행 기록(간식 누계·고양이별 경험치): 앱 데이터 폴더에 저장된 값(업데이트에도 남음). 못 읽으면 null → demo 가 localStorage 값으로 대신한다
  const savedProgress = LIVE ? await window.__TAURI__.core.invoke('get_progress').catch(() => null) : null;
  const demo = OfficeDemo.start(office, cats, boss, ui, { rush: params.has('rush'), noserve: params.has('noserve'), live: LIVE, answer: LIVE ? answer : null, savedProgress });
  /**
   * id 로 고양이 찾기 (대표 포함).
   * @param {string} id 고양이 id
   * @returns {?Cat} 고양이 (없으면 null)
   */
  catById = (id) => all.find((c) => c.id === id) || null;
  /**
   * 대표 고양이 돌려주기.
   * @returns {Cat} 대표
   */
  bossCat = () => boss;
  /**
   * 지금 이 고양이를 집을 수 있는지.
   * 시작 연출이 진행 중이거나 패러글라이더로 내려오는 중·퇴근 중이면 못 집는다.
   * @param {Cat} cat 고양이
   * @returns {boolean}
   */
  canGrab = (cat) => !((intro && !intro.done) || cat.landing || cat.leaving);
  /**
   * 고양이를 집어 들기.
   * 못 집으면 false. demo.grab 이 거절해도 false. 선택된 고양이면 끄는 동안 카메라가 따라 움직이지 않게 따라가기를 끈다.
   * @param {Cat} cat 고양이
   * @returns {boolean} 집었으면 true
   * @see canGrab
   */
  grabCat = (cat) => {
    if (!canGrab(cat)) return false; // 패러글라이더로 내려오는 중·퇴근 중에는 못 집는다
    if (!demo.grab(cat)) return false;
    if (sel.cat === cat) sel.follow = false; // 끄는 동안 카메라가 따라 움직이면 손과 어긋난다
    return true;
  };
  /**
   * 들고 있던 고양이 내려놓기.
   * 조직도(팀 칸, data-team) 위에 놓으면 office:assign 이벤트로 팀 배정 요청만 알리고(조직도 화면이 처리), 고양이는 어느 쪽이든 제자리로 돌아간다. 선택된 고양이면 따라가기를 다시 켠다.
   * @param {Cat} cat 고양이
   * @param {PointerEvent} e 놓은 순간의 포인터 이벤트
   * @returns {void}
   * @see demo.drop
   */
  dropCat = (cat, e) => {
    // 조직도(팀 칸) 위에 놓으면 팀 배정 요청만 알리고(조직도 화면이 받아 처리), 고양이는 어느 쪽이든 제자리로 돌아간다
    const team = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-team]');
    if (team) window.dispatchEvent(new CustomEvent('office:assign', { detail: { catId: cat.id, team: team.dataset.team } }));
    demo.drop(cat);
    if (sel.cat === cat) sel.follow = true;
  };
  /**
   * 화면 클릭 처리: 고양이 · 대표 책상 · 빈 곳.
   * 빈 곳이면 선택 해제. 고양이면 확대해 따라가고(focusCat) 요청이 있으면 카드도 연다(demo.click). 대표 책상이면 demo.clickDesk.
   * @param {number} x 캔버스 안 x(px)
   * @param {number} y 캔버스 안 y(px)
   * @returns {void}
   * @see focusCat, clearSelection
   */
  onPick = (x, y) => {
    const hit = scene.pick(x, y, (m) => m.isPickable && m.isEnabled() && m.metadata && (m.metadata.catId || m.metadata.bossDesk));
    const md = hit && hit.pickedMesh && hit.pickedMesh.metadata;
    if (!md) { clearSelection(); return; } // 빈 곳 = 선택 해제
    if (md.catId) { focusCat(md.catId); demo.click(md.catId); } // 고양이로 확대해 다가가고, 요청이 있으면 카드도 연다
    else if (md.bossDesk) demo.clickDesk();
  };
  scene.meshes.forEach((m) => { m.receiveShadows = true; });

  // ── 말풍선 (HTML 겹침)
  const LABEL = { thinking: ['…', '생각 중'], permission: ['!', '결재 대기'], waiting: ['?', '질문 있어요'], complete: ['✓', '완료 배달'], error: ['!', '오류'] };
  const bubbles = new Map();
  /**
   * 고양이 말풍선 DOM 을 신호에 맞춰 만들고 지우고 갱신하기.
   * 신호가 없으면 말풍선을 지운다. 있으면 없을 때 만들고, 종류·글자가 바뀐 경우에만 아이콘·문구를 바꾼다 (LABEL 표 사용).
   * @param {Cat} cat 고양이
   * @returns {void}
   */
  function syncBubble(cat) {
    let el = bubbles.get(cat.id);
    if (!cat.signal) { if (el) { el.remove(); bubbles.delete(cat.id); } return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'bubble';
      el.innerHTML = '<span class="ic"></span><span class="tx"></span>';
      bubbleLayer.appendChild(el);
      bubbles.set(cat.id, el);
    }
    const key = cat.signal + '|' + (cat.signalText || '');
    if (el.dataset.key === key) return;
    const [ic, tx] = LABEL[cat.signal] || ['!', cat.signal];
    el.dataset.key = key;
    el.dataset.st = cat.signal;
    el.querySelector('.ic').textContent = ic;
    el.querySelector('.tx').textContent = cat.signalText || tx;
  }

  // 대표 이름표: 사용자 계정 이름 (모르면 '대표')
  const bossTag = document.createElement('div');
  bossTag.className = 'nametag';
  bubbleLayer.appendChild(bossTag);
  /**
   * 대표 이름표를 대표 머리 위 화면 위치에 놓기.
   * 월드 위치를 화면에 투영해 CSS 좌표로 옮기고, 이름은 계정 이름(live.name) 또는 "대표".
   * @returns {void}
   */
  function placeBossTag() {
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const scale = canvas.clientWidth / w;
    const p = BABYLON.Vector3.Project(boss.root.position.add(new BABYLON.Vector3(0, -0.05, 0)), BABYLON.Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(w, h));
    const name = (typeof live !== 'undefined' && live.name) || '대표';
    if (bossTag.textContent !== name) bossTag.textContent = name;
    bossTag.style.left = (p.x * scale).toFixed(1) + 'px';
    bossTag.style.top = (p.y * scale).toFixed(1) + 'px';
  }
  /**
   * 모든 고양이 말풍선을 화면 위치에 놓기.
   * 고양이 머리 위 기준점(OfficeCat.bubbleAnchor)을 화면에 투영하고, 이미 놓은 풍선과 겹치면 위로 쌓는다 (최대 8번 밀기).
   * @returns {void}
   */
  function placeBubbles() {
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const scale = canvas.clientWidth / w;
    const vp = camera.viewport.toGlobal(w, h);
    const tm = scene.getTransformMatrix();
    const placed = [];
    for (const cat of all) {
      const el = bubbles.get(cat.id);
      if (!el) continue;
      const at = OfficeCat.bubbleAnchor(cat);
      const top = coinTop.get(cat.id);
      if (top != null) at.y = top + 0.04; // 머리 위 동전·알약을 가리지 않게 그 위에
      const p = BABYLON.Vector3.Project(at, BABYLON.Matrix.Identity(), tm, vp);
      let x = p.x * scale, y = p.y * scale;
      // 겹치면 위로 쌓는다
      const bw = el.offsetWidth || 90, bh = (el.offsetHeight || 26) + 4;
      for (let guard = 0; guard < 8; guard++) {
        const o = placed.find((q) => Math.abs(q.x - x) < (q.w + bw) / 2 && Math.abs(q.y - y) < bh);
        if (!o) break;
        y = o.y - bh;
      }
      placed.push({ x, y, w: bw });
      el.style.left = x.toFixed(1) + 'px';
      el.style.top = y.toFixed(1) + 'px';
    }
    placeFeed(tm, vp, scale);
  }
  // ── 간식 주기 단추: 고른 고양이 머리 위 동전 바로 왼쪽에 나란히 ──
  const feedBtn = document.createElement('button');
  feedBtn.className = 'feed-btn';
  feedBtn.hidden = true;
  bubbleLayer.appendChild(feedBtn);
  feedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const c = sel.cat;
    if (c && demo.feed(c.id)) refreshPanel();
  });
  /**
   * 간식 주기 단추를 고른 고양이의 동전 왼쪽에 놓는다(대표·일꾼이 아닌 고양이·동전 없음이면 숨김).
   * 남은 간식 수를 함께 보이고, 없으면 흐리게 막는다.
   * @param {BABYLON.Matrix} tm 장면 변환 행렬
   * @param {BABYLON.Viewport} vp 화면 영역
   * @param {number} scale 렌더 픽셀 → CSS 픽셀
   * @returns {void}
   */
  function placeFeed(tm, vp, scale) {
    const c = sel.cat;
    const top = c && coinTop.get(c.id);
    if (!c || c === boss || top == null || !demo.agents.some((a) => a.cat === c)) { feedBtn.hidden = true; return; }
    const at = OfficeCat.bubbleAnchor(c);
    at.y = top - 0.12; // 동전 가운데 높이쯤
    at.addInPlace(camera.getDirection(BABYLON.Vector3.Right()).scale(-0.2)); // 동전 왼쪽
    const p = BABYLON.Vector3.Project(at, BABYLON.Matrix.Identity(), tm, vp);
    if (p.z < 0 || p.z > 1) { feedBtn.hidden = true; return; }
    const n = demo.balance();
    const label = `간식 주기 ${n}`;
    if (feedBtn.textContent !== label) feedBtn.textContent = label;
    feedBtn.disabled = n <= 0;
    feedBtn.title = n > 0 ? '남은 간식 1개를 이 고양이에게 줍니다 (경험치 +1, 먹거나 발라당)' : '남은 간식이 없어요 — 결재·작업 완료로 모을 수 있어요';
    feedBtn.hidden = false;
    feedBtn.style.left = (p.x * scale).toFixed(1) + 'px';
    feedBtn.style.top = (p.y * scale).toFixed(1) + 'px';
  }

  // 한 걸음 진행 (그리기 제외)
  let intro = null; // 시작 연출(패러글라이더). 진행 중엔 사무실 일과를 멈춘다
  const landings = []; // 실시간: 새 세션 고양이 하나씩 내려오기 { cat, run }
  const coins = new Map(); // cat.id → 동전 노드
  /**
   * 고양이 머리 위에 서비스 동전 달기.
   * 이미 있으면 무시. 서비스 이름이 없으면 claude.
   * @param {Cat} cat 고양이
   * @returns {void}
   * @see OfficeIntro.coin
   */
  function addCoin(cat) { if (!coins.has(cat.id)) coins.set(cat.id, OfficeIntro.coin(scene, cat.provider || 'claude')); }
  let coinSpin = 0;
  const coinTop = new Map(); // cat.id → 동전·알약 위쪽 끝 월드 높이 (말풍선이 그 위에 놓인다)
  /**
   * 에이전트(고양이 일과) 한 마리의 상태 정보. 패널 목록과 머리 위 알약이 같은 입력으로 OfficeStatus.of 를 부른다.
   * @param {Agent} a 에이전트
   * @returns {StatusCat} doing·atDesk·alert·leaving·landing
   * @see OfficeStatus.of
   */
  function statusInfo(a) {
    return { doing: a.what, atDesk: a.at === a.desk, alert: a.alert && a.alert.kind, leaving: !!a.leaving, landing: !!a.cat.landing };
  }
  /**
   * 동전들을 고양이 머리 위에 놓고 돌리기, 상태 알약 문구 맞추기.
   * 고양이가 사라졌으면 동전을 지운다. 위치는 말풍선 기준점 위, 회전은 시간에 따라 계속 증가. 알약 문구는 OfficeStatus.of 가 정한다.
   * 알약은 카메라가 멀수록 커지고 바뀔 때만 다시 그려진다(OfficeIntro.coin).
   * @param {number} dt 지난 시간(초)
   * @returns {void}
   * @see OfficeIntro.coin, OfficeStatus.of
   */
  function placeCoins(dt) {
    coinSpin += dt * 2.4;
    const view = { pos: camera.position, right: camera.getDirection(BABYLON.Vector3.Right()), fwd: camera.getDirection(BABYLON.Vector3.Forward()) };
    for (const [id, node] of coins) {
      const cat = all.find((c) => c.id === id);
      if (!cat) { node.dispose(); coins.delete(id); coinTop.delete(id); continue; }
      const a = demo.agents.find((x) => x.cat === cat);
      coinTop.set(id, node.update(dt, OfficeCat.bubbleAnchor(cat), view, coinSpin, a ? OfficeStatus.of(statusInfo(a)) : null));
    }
  }
  /**
   * 한 걸음 진행 (그리기 제외).
   * 시작 연출 중에는 고양이 갱신과 연출 진행만 하고 일과는 멈춘다. 그 외에는 자동문 → 일과(demo.tick) → 고양이 갱신(건물 밖은 네 발 걷기) → 새 세션 착지 진행 → 겹침 풀기 → 동전 → 낮밤 → 화면 콘솔 순으로 진행한다.
   * @param {number} dt 지난 시간(초)
   * @returns {void}
   * @see OfficeIntro, demo.tick, OfficeCat.update, OfficeCat.resolveOverlaps
   */
  function step(dt) {
    if (xmas) xmas.update(dt);
    office.setFrozen(wxFx.frozen()); // 언 연못: 낚시 대신 스케이트 (weatherfx → openoffice → demo)
    if (intro && !intro.done) {
      for (const cat of all) OfficeCat.update(cat, dt);
      intro.tick(dt);
      office.update(dt, all);
      return;
    }
    office.update(dt, all); // 자동문은 고양이 위치를 본다
    demo.tick(dt);
    for (const cat of all) {
      // 건물 밖(중정·공원)에서는 네 발로 걷는다
      const q = cat.root.position;
      cat.quad = !((q.z > 0 && q.z < 18 && ((q.x > 0 && q.x < 10) || (q.x > 22 && q.x < 32))) || (q.z >= 18 && q.z < 28 && q.x > 0 && q.x < 32));
      OfficeCat.update(cat, dt);
    }
    for (let i = landings.length - 1; i >= 0; i--) {
      const L = landings[i];
      L.run.tick(dt);
      if (L.run.done) { L.cat.landing = false; landings.splice(i, 1); }
    }
    OfficeCat.resolveOverlaps(all);
    placeCoins(dt);
    day.update(dt);
    con.tick(dt);
  }

  // ── 실시간: 세션 → 고양이 ─────────────────────────────────
  // 로컬(실행 중) + 클라우드(실행 중이거나 3시간 안에 움직인 보관 전 세션). 같은 세션은 다시 켜도 같은 품종(아이디 해시)
  /**
   * 문자열 해시 (FNV-1a 32비트).
   * 같은 세션 열쇠는 다시 켜도 같은 품종이 되게 하는 데 쓴다.
   * @param {string} s 문자열
   * @returns {number} 부호 없는 32비트 정수
   */
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const BREEDS = CatModel.breeds();
  // 새 대화에서 고른 고양이(품종): 세션 열쇠 → 품종. 저장해 두어 앱을 다시 켜도 같은 고양이가 나온다 (office.catPick, 최근 200개)
  const catPick = (() => { try { return JSON.parse(localStorage.getItem('office.catPick') || '{}') || {}; } catch (e) { return {}; } })();
  /**
   * 세션의 고양이 품종을 정해 둔다(새 대화에서 고른 것) 또는 다른 열쇠로 옮긴다.
   * @param {string} key 세션 열쇠
   * @param {string} breed 품종 키 (BREEDS 에 없는 값이면 무시)
   * @returns {void}
   */
  function setCatPick(key, breed) {
    if (!key || !BREEDS.includes(breed)) return;
    delete catPick[key]; catPick[key] = breed; // 맨 뒤로 (오래된 것부터 버린다)
    const keys = Object.keys(catPick);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete catPick[k];
    try { localStorage.setItem('office.catPick', JSON.stringify(catPick)); } catch (e) { /* 무시 */ }
  }
  /**
   * 세션 열쇠의 고양이 품종: 새 대화에서 고른 것이 있으면 그것, 없으면 열쇠 해시로 정한다.
   * @param {string} key 세션 열쇠
   * @returns {string} 품종 키
   */
  const breedFor = (key) => (BREEDS.includes(catPick[key]) ? catPick[key] : BREEDS[hash(key) % BREEDS.length]);
  /**
   * 세션 하나를 고양이로 출근시키기.
   * 아직 퇴근 중인 같은 세션이면 건너뛴다(퇴근 뒤 despawn 이 다시 내려오게 한다). 열쇠 해시로 품종을 정해 만들고 빈 책상이 없으면 되돌린다.
   * 책상이 있으면 패러글라이더로 내려오는 연출과 서비스 동전을 단다.
   * @param {LiveSession} info 세션 정보
   * @returns {void}
   * @see OfficeCat.create, demo.add, OfficeIntro.start, addCoin
   */
  function spawn(info) {
    if (all.some((c) => c.id === info.key)) return; // 아직 퇴근 중인 같은 세션: 나간 뒤 다시 내려온다(despawn 참고)
    const cat = OfficeCat.create(scene, { id: info.key, breed: breedFor(info.key) });
    cat.provider = info.provider;
    cat.meshes.forEach((m) => { shadows.addShadowCaster(m); m.receiveShadows = true; });
    if (!demo.add(cat, info)) { OfficeCat.remove(cat); return; } // 빈 책상이 없음
    cats.push(cat); all.push(cat);
    cat.landing = true;
    landings.push({ cat, run: OfficeIntro.start(scene, [cat], { shadows }) });
    addCoin(cat);
  }
  /**
   * 고양이 퇴근시키기.
   * demo.remove 로 퇴근 걸음을 보낸 뒤, 다 나가면 목록·말풍선·그림자·고양이를 정리한다. 나가는 사이 세션이 다시 살아났으면 새로 내려오게 한다.
   * @param {string} id 고양이 id (세션 열쇠)
   * @returns {void}
   * @see demo.remove, spawn
   */
  function despawn(id) {
    demo.remove(id, (cat) => {
      for (const list of [cats, all]) { const i = list.indexOf(cat); if (i >= 0) list.splice(i, 1); }
      const el = bubbles.get(cat.id); if (el) { el.remove(); bubbles.delete(cat.id); }
      cat.meshes.forEach((m) => shadows.removeShadowCaster(m));
      OfficeCat.remove(cat);
      const back = live.sessions.get(cat.id); // 나가는 사이 세션이 다시 살아났으면 새로 내려온다
      if (back) spawn(back);
    });
  }
  const live = { sessions: new Map(), plan: null, name: '', alerts: [], providers: {}, ended: [] };
  // 다른 AI 서비스 (Rust get_provider): 설정에서 켠 서비스만 세션을 고양이로, 한도를 현황 카드에
  const PROVIDERS = ['chatgpt', 'antigravity'];
  // 기본은 꺼짐: 설정에서 켜야 이 PC 의 로그인 정보로 조회한다 (ChatGPT 는 chatgpt.com 에 사용량을 묻는다)
  /**
   * 설정에서 해당 서비스 연동을 켰는지.
   * localStorage meow.provider.<이름> 이 on 일 때만 true (기본 꺼짐: 켜야 이 PC 의 로그인 정보로 조회한다).
   * @param {string} name 서비스 이름 ("chatgpt" | "antigravity")
   * @returns {boolean} 켜져 있으면 true
   */
  const providerOn = (name) => { try { return localStorage.getItem('meow.provider.' + name) === 'on'; } catch (e) { return false; } };
  /**
   * 제공사 상태 → 현황 카드가 읽는 { name, plan: { plan, limits } } (첫 한도 = 큰 숫자, 둘째 = 막대).
   * 설치 안 됨·로그인 안 됨(state)이면 null. 퍼센트가 있는 한도만 쓰고, session·weekly 가 있으면 그 순서로 앞에 놓고, 모델별 한도뿐이면 많이 쓴 순으로 정렬한다.
   * 앞의 둘은 kind 를 session · weekly_all 로 바꿔 Claude 카드와 같은 모양으로 맞춘다.
   * @param {?ServiceSnapshot} snap 서비스 상태
   * @returns {?ProviderPlan} 현황 카드용 요금제 (설치 안 됨·로그인 안 됐으면 null)
   */
  function providerPlan(snap) {
    if (!snap || snap.state === 'not_installed' || snap.state === 'logged_out') return null;
    let lims = (snap.limits || []).filter((l) => l.percent != null);
    const typed = lims.some((l) => l.kind === 'session' || l.kind === 'weekly');
    if (typed) lims = [...lims.filter((l) => l.kind === 'session'), ...lims.filter((l) => l.kind === 'weekly'), ...lims.filter((l) => l.kind !== 'session' && l.kind !== 'weekly')];
    else lims = lims.slice().sort((a, b) => b.percent - a.percent); // 모델별 한도: 가장 많이 쓴 것이 큰 숫자
    const conv = lims.map((l, i) => ({ ...l, kind: i === 0 ? 'session' : i === 1 ? 'weekly_all' : l.kind }));
    return { name: snap.account || '', plan: { plan: snap.plan || '', limits: conv } };
  }
  // ── 위젯: 계정·한도 / 업무 현황 / 최근 알림 ─────────────────
  // 고양이 선택: 0.2초 ease-in 으로 확대해 다가간 뒤 그 고양이를 계속 따라간다(끌어서 옮기면 따라가기만 멈춤).
  // 고른 고양이에는 얇은 초록 외곽선. 위젯 목록·고양이·대표 클릭이 같이 쓴다. 빈 곳 클릭·상세 닫기 = 선택 해제
  const FOCUS_MS = 200;
  const OUTLINE = BABYLON.Color3.FromHexString('#22c55e');
  const OUTLINE_W = 0.012; // 월드 단위(m). 메시 축척으로 나눠 어느 품종이나 같은 두께
  const sel = { cat: null, follow: false, ob: null };
  /**
   * 고양이 외곽선(선택 표시) 켜고 끄기.
   * 정점이 있는 메시마다 renderOutline 을 바꾸고, 켤 때는 메시 축척으로 나눠 어느 품종이나 같은 두께(OUTLINE_W)의 초록 선으로 한다.
   * @param {?Cat} c 고양이 (없으면 아무것도 안 함)
   * @param {boolean} on 켜기 여부
   * @returns {void}
   */
  function outline(c, on) {
    if (!c) return;
    for (const m of c.meshes) {
      if (!m.getTotalVertices || !m.getTotalVertices()) continue;
      m.renderOutline = on;
      if (!on) continue;
      const sc = new BABYLON.Vector3();
      m.computeWorldMatrix(true).decompose(sc);
      m.outlineWidth = OUTLINE_W / Math.max(1e-4, Math.abs(sc.x));
      m.outlineColor = OUTLINE;
    }
  }
  /**
   * 고양이 선택·따라가기 풀기.
   * 카메라 따라가기 관찰자를 지우고 외곽선을 끄며 sel 을 비운다.
   * @returns {void}
   */
  function unfocus() {
    if (sel.ob) scene.onBeforeRenderObservable.remove(sel.ob);
    outline(sel.cat, false);
    sel.cat = null; sel.follow = false; sel.ob = null;
  }
  /**
   * 고양이를 선택해 0.2초 ease-in 으로 확대해 다가간 뒤 계속 따라가기.
   * 대표가 아니면 패널 선택도 맞춘다. 초록 외곽선을 켜고 카메라 목표·반지름을 보간한다. 위젯 목록·고양이·대표 클릭이 같이 쓴다.
   * 고양이가 퇴근해 사라지면 선택을 푼다. 끌어서 화면을 옮기면 따라가기만 멈춘다(stopFollow).
   * @param {string} id 고양이 id (대표는 "boss")
   * @returns {void}
   * @see OfficePanel.select, outline, unfocus
   */
  function focusCat(id) {
      const c = all.find((x) => x.id === id);
      if (!c) return;
      // 패널 쪽 오류(목록 그리기 등)가 나도 고양이 선택·카메라 따라가기는 끊기지 않게 (0.6.0 퇴행 재발 방지)
      if (c !== boss) { try { OfficePanel.select(id); } catch (e) { console.error(e); } }
      unfocus();
      sel.cat = c; sel.follow = true;
      outline(c, true);
      const from = camera.target.clone(), r0 = camera.radius, r1 = Math.min(r0, 8);
      let t = 0;
      sel.ob = scene.onBeforeRenderObservable.add(() => {
        if (!all.includes(c)) { unfocus(); return; } // 퇴근(사라짐)
        const to = c.root.position;
        if (t < 1) {
          t = Math.min(1, t + engine.getDeltaTime() / FOCUS_MS);
          const k = t * t; // ease-in
          camera.target.copyFrom(BABYLON.Vector3.Lerp(from, to, k));
          camera.radius = r0 + (r1 - r0) * k;
        } else if (sel.follow) camera.target.copyFrom(to);
      });
  }
  /**
   * 선택 해제 (빈 곳 클릭 · 상세 닫기).
   * 카메라 선택과 패널 선택을 함께 푼다.
   * @returns {void}
   * @see unfocus, OfficePanel.unselect
   */
  function clearSelection() { unfocus(); OfficePanel.unselect(); }
  // 처음 안내용: 패널 선택 없이 카메라만 그 고양이로 확대해 따라감 → 되돌리기 함수 반환(원래 화각으로 부드럽게)
  /**
   * 처음 안내용: 패널 선택 없이 카메라만 그 고양이로 확대해 따라가기.
   * 반지름은 13 이하로 제한해 책상·주변이 함께 보이게 한다. 돌려주는 함수를 부르면 원래 화각으로 0.35초 동안 부드럽게 되돌린다.
   * @param {string} id 고양이 id
   * @returns {function(): void} 되돌리기 함수 (고양이가 없으면 아무것도 안 하는 함수)
   * @see tour.js catRect
   */
  function tourFocus(id) {
    const c = all.find((x) => x.id === id);
    if (!c) return () => {};
    unfocus();
    const home = { t: camera.target.clone(), r: camera.radius };
    const from = camera.target.clone(), r0 = camera.radius, r1 = Math.min(r0, 13); // 너무 가깝지 않게: 책상·주변이 함께 보이는 정도
    let t = 0;
    const ob = scene.onBeforeRenderObservable.add(() => {
      if (!all.includes(c)) return;
      t = Math.min(1, t + engine.getDeltaTime() / 450);
      const k = 1 - (1 - t) * (1 - t);
      camera.target.copyFrom(BABYLON.Vector3.Lerp(from, c.root.position, k));
      camera.radius = r0 + (r1 - r0) * k;
    });
    return () => {
      scene.onBeforeRenderObservable.remove(ob);
      const f = camera.target.clone(), rr = camera.radius;
      let u = 0;
      const back = scene.onBeforeRenderObservable.add(() => {
        u = Math.min(1, u + engine.getDeltaTime() / 350);
        const k = 1 - (1 - u) * (1 - u);
        camera.target.copyFrom(BABYLON.Vector3.Lerp(f, home.t, k));
        camera.radius = rr + (home.r - rr) * k;
        if (u >= 1) scene.onBeforeRenderObservable.remove(back);
      });
    };
  }
  /**
   * 카메라 따라가기만 멈추기 (선택은 유지).
   * @returns {void}
   */
  stopFollow = () => { sel.follow = false; };
  // 세션·알림 열기: 로컬 = 데스크톱 앱 세션이면 앱, 실행 중이면 브라우저(원격 제어 세션 또는 세션 목록), 끝났으면 새 터미널에서 재개 · 클라우드·알림 = 링크
  /**
   * 세션·알림 열기.
   * 로컬 세션: 앱 안이 아니면 새 창, 앱이면 open_local_session 결과에 따라 실행 중이면 브라우저(원격 제어 링크 또는 세션 목록), 데스크톱 앱이면 앱, 끝난 세션은 새 터미널에서 재개한다.
   * 클라우드·링크는 open_url. 로컬 세션 알림은 같은 프로젝트의 실행 중 로컬 세션을 같은 방식으로 열고, 없으면 세션 목록 페이지를 연다.
   * @param {?OpenTarget} o 여는 방법 (없으면 아무것도 안 함)
   * @returns {Promise<void>}
   * @see open_local_session, open_url
   */
  async function openTarget(o) {
    const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (!o) return;
    if (o.kind === 'local') {
      if (!inv) { window.open(o.url || 'https://claude.ai/code', '_blank'); return; }
      try {
        const how = await inv('open_local_session', { id: o.id, cwd: o.cwd || '', active: !!o.active });
        if (how === 'active') {
          // 실행 중인 터미널 세션: 명령 복사 대신 브라우저로. 원격 제어로 연결된 웹 세션이 있으면 그 세션, 없으면 Claude Code 세션 목록
          await inv('open_url', { url: o.url || 'https://claude.ai/code' });
          ui.toast(o.url ? '브라우저에서 세션 여는 중' : '브라우저에서 Claude Code 세션 목록 여는 중 (원격 제어로 연결된 세션이 없음)');
        } else ui.toast(how === 'desktop' ? '데스크톱 앱에서 여는 중' : '새 터미널에서 재개하는 중');
      } catch (e) { ui.toast(String(e)); }
      return;
    }
    if (o.kind === 'alert' && !o.url) {
      // 로컬 세션 알림: 같은 프로젝트의 실행 중 로컬 세션을 같은 방식으로 열고, 없으면 브라우저에 세션 목록
      const info = [...live.sessions.values()].find((x) => x.open && x.open.kind === 'local' && o.project && x.project === o.project);
      if (info) return openTarget(info.open);
      o = { kind: 'url', url: 'https://claude.ai/code' };
    }
    if (o.kind === 'url' || o.kind === 'alert') {
      if (!inv) { window.open(o.url, '_blank'); return; }
      try { await inv('open_url', { url: o.url }); } catch (e) { ui.toast(String(e)); }
    }
  }
  OfficePanel.init(document.getElementById('stage'), {
    onFocus: focusCat, onUnselect: unfocus, onOpen: openTarget, onAlertsShown: () => appBits && appBits.onAlertsShown(), clock: () => day.state,
    // 채팅 도크(실시간 모드만): 고른 고양이 상세는 도크의 '정보' 탭, 고르면 대화 탭이 열린다. 시연 모드는 예전 상세 카드
    ...(LIVE ? { onChat: (id) => { if (id) OfficeChat.show(id); else OfficeChat.hide(); }, onInfo: (c, html, extra) => OfficeChat.setInfo(c, html, extra) } : {}),
  });

  // ── 아래 상태 바: 왼쪽 시스템 사용률, 오른쪽 확대 막대 (statusbar.js). 3D 화면은 상태 바 높이만큼 줄어든다
  const statusBar = OfficeStatusBar.init({ scene, onResize: () => engine.resize() });
  // ── 확대 막대 (상태 바 오른쪽, 늘 보임): 처음 화각 = 1배
  const R1 = camera.upperRadiusLimit;
  const ZMAX = R1 / camera.lowerRadiusLimit;
  const zoomNav = statusBar.zoomSlot;
  zoomNav.innerHTML = `<div class="zn">
      <button class="zn-b" data-z="out" title="축소">−</button>
      <input class="zn-r" type="range" min="0" max="1000" step="1" aria-label="확대 배율" />
      <button class="zn-b" data-z="in" title="확대">+</button>
      <b class="zn-v">100%</b>
      <button class="zn-1" title="처음 화면으로 (100%)">100%</button>
    </div>`;
  const zr = zoomNav.querySelector('.zn-r'), zv = zoomNav.querySelector('.zn-v');
  /**
   * 현재 확대 배율.
   * 처음 화각(반지름 R1)을 1배로 본 비율.
   * @returns {number} 배율 (1 이상)
   */
  const zoomOf = () => R1 / camera.radius;
  // 막대는 로그 눈금 (1배~최대가 고르게)
  /**
   * 배율 → 확대 막대 값 (로그 눈금, 0~1000).
   * @param {number} z 배율
   * @returns {number} 막대 값
   */
  const toSlider = (z) => Math.round((Math.log(z) / Math.log(ZMAX)) * 1000);
  /**
   * 확대 막대 값 → 배율 (toSlider 의 반대).
   * @param {number} v 막대 값 (0~1000)
   * @returns {number} 배율
   */
  const fromSlider = (v) => Math.exp((v / 1000) * Math.log(ZMAX));
  let zoomAnim = null;
  /**
   * 배율을 부드럽게 바꾸기 (0.2초 ease-in).
   * 배율은 1~ZMAX 로 제한한다. 이전 애니메이션이 있으면 지우고 새로 시작하며, target 이 있으면 카메라 목표도 함께 옮긴다.
   * @param {number} z 목표 배율
   * @param {BABYLON.Vector3} [target] 함께 옮길 카메라 목표
   * @returns {void}
   */
  function zoomTo(z, target) {
    z = Math.max(1, Math.min(ZMAX, z));
    const r0 = camera.radius, r1 = R1 / z, t0 = camera.target.clone();
    if (zoomAnim) scene.onBeforeRenderObservable.remove(zoomAnim);
    let t = 0;
    zoomAnim = scene.onBeforeRenderObservable.add(() => {
      t = Math.min(1, t + engine.getDeltaTime() / FOCUS_MS);
      const k = t * t; // 선택 확대와 같은 ease-in
      camera.radius = r0 + (r1 - r0) * k;
      if (target) camera.target.copyFrom(BABYLON.Vector3.Lerp(t0, target, k));
      if (t >= 1) { scene.onBeforeRenderObservable.remove(zoomAnim); zoomAnim = null; }
    });
  }
  const homeTarget = camera.target.clone();
  zr.addEventListener('input', () => { if (zoomAnim) { scene.onBeforeRenderObservable.remove(zoomAnim); zoomAnim = null; } camera.radius = R1 / fromSlider(+zr.value); });
  zoomNav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]');
    if (b) zoomTo(zoomOf() * (b.dataset.z === 'in' ? 1.5 : 1 / 1.5));
    if (e.target.closest('.zn-1')) { clearSelection(); zoomTo(1, homeTarget); }
  });
  let lastZ = -1;
  scene.onBeforeRenderObservable.add(() => {
    const z = zoomOf();
    if (Math.abs(z - lastZ) < 0.005) return;
    lastZ = z;
    zoomNav.classList.toggle('z1', z <= 1.02); // 100%(처음 화면)면 '100%' 단추를 흐리게
    if (document.activeElement !== zr) zr.value = toSlider(z);
    zv.textContent = Math.round(z * 100) + '%'; // 처음 화면 = 100%
  });

  // ── 마우스 안내 (아래 가운데): 처음 몇 번만 저절로, 위쪽 ? 단추로 언제든
  const HINT_KEY = 'office.mouseHint';
  const MOUSE = (btn) => `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="18" rx="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3v7" stroke="currentColor" stroke-width="1.6"/>${btn === 'L' ? '<path d="M12 3.8a5.2 5.2 0 0 0-5.2 5.2V10H12Z" fill="currentColor"/>' : btn === 'R' ? '<path d="M12 3.8a5.2 5.2 0 0 1 5.2 5.2V10H12Z" fill="currentColor"/>' : btn === 'W' ? '<rect x="10.9" y="5.5" width="2.2" height="4" rx="1.1" fill="currentColor"/>' : ''}</svg>`;
  const hint = document.createElement('section');
  hint.className = 'mouse-hint';
  hint.hidden = true;
  hint.innerHTML = `<div class="mh-items">
      <div><i>${MOUSE('L')}</i><b>클릭</b><span>고양이 선택 · 따라가기</span></div>
      <div><i>${MOUSE('L')}</i><b>고양이 끌기</b><span>자리 옮기기 (놓으면 제자리로)</span></div>
      <div><i>${MOUSE('L')}</i><b>빈 곳 끌기</b><span>화면 이동</span></div>
      <div><i>${MOUSE('R')}</i><b>오른쪽 끌기</b><span>돌려 보기 (Shift+끌기, Q·E)</span></div>
      <div><i>${MOUSE('W')}</i><b>휠</b><span>확대 · 축소</span></div>
    </div>
    <button class="mh-x" title="닫기" aria-label="닫기"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>`;
  (document.getElementById('widgets') || document.getElementById('stage')).appendChild(hint);
  /**
   * 마우스 안내를 자동으로 보여 준 횟수.
   * localStorage office.mouseHint 값 (닫기 단추를 누르면 99). 저장소를 못 쓰면 0.
   * @returns {number} 횟수
   */
  const hintSeen = () => { try { return +localStorage.getItem(HINT_KEY) || 0; } catch (e) { return 0; } };
  /**
   * 마우스 안내 보이기·숨기기.
   * @param {boolean} on 보일지
   * @returns {void}
   */
  const showHint = (on) => { hint.hidden = !on; };
  hint.querySelector('.mh-x').onclick = () => { showHint(false); try { localStorage.setItem(HINT_KEY, 99); } catch (e) { /* 무시 */ } };
  // 처음 사용자: 착지 연출이 끝나면(모두 내려앉고 위쪽 결재 단추가 생기면, 늦어도 20초) 화면 가운데 안내부터. 본 뒤로는 아래 마우스 안내를 처음 몇 번만
  if (!OfficeTour.seen()) {
    const t0 = performance.now();
    const wait = setInterval(() => {
      const landed = demo.agents.every((a) => a.cat.root.position.y < 0.6) && document.querySelector('#hud .h-q');
      if (!landed && performance.now() - t0 < 20000) return;
      if (document.querySelector('.ap-notes-ov:not([hidden]), .ap-login-ov:not([hidden])')) return; // 업데이트 완료·로그인 안내를 닫은 뒤에 시작
      clearInterval(wait);
      if (!OfficeTour.isOpen()) OfficeTour.start();
    }, 300);
  } else if (hintSeen() < 3) { // 처음 세 번은 저절로 보여 주고 12초 뒤 접는다
    try { localStorage.setItem(HINT_KEY, hintSeen() + 1); } catch (e) { /* 무시 */ }
    showHint(true);
    setTimeout(() => showHint(false), 12000);
  }
  window.__officeHint = () => showHint(hint.hidden);
  const DEMO_PLAN = { plan: 'Max', limits: [
    { kind: 'session', label: '5시간 세션', percent: 42, resets_at: new Date(Date.now() + 2.3 * 3600e3).toISOString() },
    { kind: 'weekly_all', label: '주간 · 전체 모델', percent: 67, resets_at: new Date(Date.now() + 2.4 * 86400e3).toISOString() },
  ] };
  /**
   * 패널(현황·업무·알림 카드)에 현재 상태 밀어 넣기 (1초마다).
   * 계정 이름·플랜·지난 세션·서비스별 요금제(claude · chatgpt · antigravity)·알림과 고양이별 업무 현황(제목·프로젝트·하는 일·책상에 앉았는지·열기 방법 등)을 OfficePanel.update 로 보낸다. 시연 모드는 DEMO_PLAN 을 쓴다.
   * @returns {void}
   * @see OfficePanel.update, providerPlan
   */
  function refreshPanel() {
    OfficePanel.update({
      name: live.name || (LIVE ? '' : '시연 계정'),
      plan: live.plan || (LIVE ? null : DEMO_PLAN),
      ended: live.ended || [],
      plans: {
        claude: (live.plan || !LIVE) ? { name: live.name || (LIVE ? '' : '시연 계정'), plan: live.plan || DEMO_PLAN } : null,
        chatgpt: providerPlan(live.providers.chatgpt),
        antigravity: providerPlan(live.providers.antigravity),
      },
      alerts: live.alerts,
      cats: demo.agents.map((a) => ({
        id: a.cat.id, name: CatModel.breedName(a.cat.breed), level: demo.levelOf(a.cat.breed), treats: demo.balance(), provider: a.cat.provider || 'claude',
        title: (a.info && a.info.title) || '', project: a.project || '', ...statusInfo(a),
        busy: LIVE ? a.liveBusy : a.what === 'work',
        startedAt: a.info && a.info.startedAt, lastAt: a.info && a.info.lastAt,
        open: (a.info && a.info.open) || null,
      })),
    });
  }
  setInterval(refreshPanel, 1000);
  // ── 화면들: 책상 모니터 · 회의실 벽걸이 TV ─────────────────
  // 내용: 이미지(data URL) 또는 CONSOLE(픽셀 콘솔 애니메이션: 글자는 안 보이는 줄들이 흘러가고 커서가 깜박임)
  const CONSOLE = 'console';
  /**
   * 픽셀 콘솔 애니메이션 텍스처 (작업 중인 모니터·TV 에 쓰는 화면).
   * 96×56 칸을 3배 확대(NEAREST)해 픽셀 느낌을 낸다. 글자는 안 보이는 색 막대 줄들이 위로 흐르고 마지막 줄 끝에서 커서가 깜박인다.
   * @returns {{tex: BABYLON.DynamicTexture, tick: function(number): void}} 텍스처와 매 프레임 진행 함수
   */
  const con = (() => {
    const W = 96, H = 56, PX = 3; // 저해상도 → 확대하면 픽셀 느낌 (NEAREST)
    const tex = new BABYLON.DynamicTexture('console', { width: W * PX, height: H * PX }, scene, false, BABYLON.Texture.NEAREST_SAMPLINGMODE);
    const g = tex.getContext();
    const COLORS = ['#7ee787', '#a5d6ff', '#c9d1d9', '#c9d1d9', '#8b949e', '#f2cc60'];
    const rows = [];
    /**
     * 콘솔 한 줄 만들기.
     * 폭 2~13 의 색 막대를 최대 6개 이어 붙인다 (25% 확률로 일찍 끝, 30% 확률로 들여쓰기).
     * @returns {Array<[number, number, string]>} 막대들 [x, 폭, 색]
     */
    const newRow = () => { const segs = []; let x = 2 + (Math.random() < 0.3 ? 4 : 0); while (x < W - 6 && segs.length < 6) { const w = 2 + Math.floor(Math.random() * 12); segs.push([x, Math.min(w, W - 4 - x), COLORS[Math.floor(Math.random() * COLORS.length)]]); x += w + 2; if (Math.random() < 0.25) break; } return segs; };
    for (let i = 0; i < 12; i++) rows.push(newRow());
    let t = 0, scroll = 0, blink = 0;
    /**
     * 콘솔 텍스처 다시 그리기.
     * 어두운 바탕에 보이는 줄들을 그리고, 깜박임 단계가 켜져 있으면 마지막 줄 끝에 커서를 그린 뒤 텍스처를 갱신한다.
     * @returns {void}
     */
    function draw() {
      g.fillStyle = '#0d1117'; g.fillRect(0, 0, W * PX, H * PX);
      const lh = 4, top = 2;
      rows.forEach((segs, i) => {
        const y = top + i * lh - scroll;
        if (y < 0 || y > H - 3) return;
        for (const [x, w, c] of segs) { g.fillStyle = c; g.fillRect(x * PX, y * PX, w * PX, 2 * PX); }
      });
      // 커서: 마지막 줄 끝에서 깜박임
      if (blink < 0.5) {
        const last = rows[rows.length - 1], y = top + (rows.length - 1) * lh - scroll;
        const cx = last.length ? last[last.length - 1][0] + last[last.length - 1][1] + 1 : 2;
        g.fillStyle = '#e6edf3'; g.fillRect(cx * PX, y * PX, 2 * PX, 3 * PX);
      }
      tex.update(false);
    }
    draw();
    return {
      tex,
      /**
       * 콘솔 한 걸음 진행.
       * 커서 깜박임은 매번, 줄 흐름·다시 그리기는 초당 8번쯤만 한다. 4칸 흐르면 맨 위 줄을 버리고 새 줄을 아래에 붙인다.
       * @param {number} dt 지난 시간(초)
       * @returns {void}
       */
      tick(dt) {
        t += dt; blink = (blink + dt * 1.6) % 1;
        if (t < 0.12) return; // 초당 8번쯤만 다시 그림
        t = 0;
        scroll += 1;
        if (scroll >= 4) { scroll = 0; rows.shift(); rows.push(newRow()); }
        draw();
      },
    };
  })();
  const conMat = new BABYLON.StandardMaterial('consoleMat', scene);
  conMat.emissiveTexture = con.tex; conMat.disableLighting = true;
  // 꺼진 화면: 검은 유리 (빛은 살짝 반사)
  const OFF = 'off';
  const offMat = new BABYLON.StandardMaterial('screenOff', scene);
  offMat.diffuseColor = BABYLON.Color3.FromHexString('#0d0f13'); offMat.specularColor = new BABYLON.Color3(0.25, 0.25, 0.28); offMat.specularPower = 64;
  const screens = new Map(); // 화면 이름 → { mesh, url }
  // 켜진 화면의 빛: 화면 둘레 후광 + 책상 위에 번지는 푸르스름한 빛 (가산 혼합). 밤일수록 진하게
  const glowTex = new BABYLON.DynamicTexture('screenGlowTex', { width: 128, height: 128 }, scene, true);
  {
    const g = glowTex.getContext();
    const gr = g.createRadialGradient(64, 64, 6, 64, 64, 64);
    gr.addColorStop(0, 'rgba(170,205,255,0.9)'); gr.addColorStop(0.45, 'rgba(150,190,255,0.35)'); gr.addColorStop(1, 'rgba(140,180,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); glowTex.update(); glowTex.hasAlpha = true;
  }
  const glowMat = new BABYLON.StandardMaterial('screenGlow', scene);
  glowMat.emissiveTexture = glowTex; glowMat.opacityTexture = glowTex; glowMat.disableLighting = true;
  glowMat.alphaMode = BABYLON.Engine.ALPHA_ADD; glowMat.backFaceCulling = false;
  // 화면 백라이트 후광은 사각형 (화면 모양 그대로 가장자리만 부드럽게 번짐)
  const rectTex = new BABYLON.DynamicTexture('screenRectGlowTex', { width: 256, height: 160 }, scene, true);
  {
    const g = rectTex.getContext();
    g.clearRect(0, 0, 256, 160);
    g.filter = 'blur(14px)';
    g.fillStyle = 'rgba(160,200,255,0.85)';
    g.fillRect(52, 38, 152, 84); // 화면 크기 비율(가운데), 둘레로 흐림
    g.filter = 'none';
    rectTex.update(); rectTex.hasAlpha = true;
  }
  const rectMat = new BABYLON.StandardMaterial('screenRectGlow', scene);
  rectMat.emissiveTexture = rectTex; rectMat.opacityTexture = rectTex; rectMat.disableLighting = true;
  rectMat.alphaMode = BABYLON.Engine.ALPHA_ADD; rectMat.backFaceCulling = false;
  /**
   * 화면 판 하나를 만들거나 내용 바꾸기.
   * url 이 비어 있으면 판을 지운다. 같은 내용이면 그대로 둔다. 처음이면 판·후광(·책상 위 빛)을 만들고, 켜진 화면은 밤일수록 후광을 진하게 한다.
   * 내용은 "console"(콘솔 재질), "off"(검은 유리), 그 외에는 이미지 data URL (판 전용 재질에 텍스처로).
   * @param {string} id 화면 이름 (책상 id · "boss" · TV id)
   * @param {?string} url 내용: 이미지 data URL | CONSOLE | OFF | 비면 판 삭제
   * @param {ScreenPlace} place 놓을 곳 (판이 이미 있으면 쓰지 않음)
   * @returns {void}
   */
  function setScreen(id, url, place) {
    let sc = screens.get(id);
    if (!url) { if (sc) { if (sc.own) sc.own.dispose(true, true); sc.mesh.dispose(); screens.delete(id); } return; }
    if (sc && sc.url === url) return;
    if (!sc) {
      const mesh = BABYLON.MeshBuilder.CreatePlane('screen:' + id, { width: place.w, height: place.h }, scene);
      mesh.position.set(place.x, place.y, place.z);
      mesh.rotation.y = place.rotY + Math.PI; // 판 앞면(-Z)이 rotY 방향을 보게
      mesh.rotation.x = place.tilt || 0; // 모니터처럼 위가 뒤로 눕게
      mesh.isPickable = false;
      // 후광 (화면보다 크게, 살짝 앞) + 책상 위 빛 (화면 앞쪽 바닥판, 책상이 있는 화면만)
      const halo = BABYLON.MeshBuilder.CreatePlane('screenHalo', { width: place.w * 1.7, height: place.h * 1.9 }, scene);
      halo.parent = mesh; halo.position.z = -0.004; halo.material = rectMat; halo.isPickable = false;
      let pool = null;
      if (place.desk) {
        pool = BABYLON.MeshBuilder.CreateGround('screenPool', { width: place.w * 1.6, height: 0.7 }, scene);
        pool.position.set(place.x - Math.sin(place.rotY) * -0.3, 0.775, place.z - Math.cos(place.rotY) * -0.3);
        pool.rotation.y = place.rotY;
        pool.material = rectMat; pool.isPickable = false; // 책상 위에도 화면 모양(사각) 빛
      }
      sc = { mesh, url: '', own: null, halo, pool };
      screens.set(id, sc);
    }
    sc.url = url;
    const lit = url !== OFF;
    const k = lit ? 0.35 + 0.5 * ((day && day.state.night) || 0) : 0;
    sc.halo.visibility = k * 0.7;
    if (sc.pool) sc.pool.visibility = k;
    if (url === CONSOLE) { sc.mesh.material = conMat; return; }
    if (url === OFF) { sc.mesh.material = offMat; return; }
    if (!sc.own) { sc.own = new BABYLON.StandardMaterial('screenMat:' + id, scene); sc.own.disableLighting = true; }
    if (sc.own.emissiveTexture) sc.own.emissiveTexture.dispose();
    sc.own.emissiveTexture = new BABYLON.Texture(url, scene, true, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
    sc.mesh.material = sc.own;
  }
  /**
   * 책상 자리 → 모니터 화면 위치 (모니터 모델 화면 바로 앞).
   * 의자 뒤쪽 방향으로 책상 가운데에서 약 0.84 만큼 가서 모니터 화면 면(폭 0.758 · 높이 0.466, 위가 뒤로 약 8도 눕음)에 맞춘다.
   * @param {DeskSpot} desk 책상 자리
   * @returns {ScreenPlace} 화면 판 위치
   */
  function deskPlace(desk) {
    const out = new BABYLON.Vector3(Math.sin(desk.rotY), 0, Math.cos(desk.rotY)); // 의자 뒤쪽
    // 모니터 모델(computerScreen ×2) 화면 면: 폭 0.758, 높이 0.462(책상 위 0.112~0.574), 위가 뒤로 약 8° 눕음, 책상 가운데에서 뒤로 0.16
    const c = desk.pos.subtract(out.scale(0.69 + 0.16 - 0.006));
    return { x: c.x, y: 0.77 + 0.343, z: c.z, rotY: desk.rotY, w: 0.758, h: 0.466, tilt: Math.atan2(0.064, 0.462), desk: true };
  }
  // 회의실 사이 유리벽(긴 벽) 양면의 벽걸이 TV: 받침(검은 틀) + 화면
  const TVS = [{ id: 'tv-A', x: 6.0, z: 23.5, rotY: -Math.PI / 2 }, { id: 'tv-B', x: 6.2, z: 23.5, rotY: Math.PI / 2 }];
  const tvFrame = new BABYLON.StandardMaterial('tvFrame', scene);
  tvFrame.diffuseColor = BABYLON.Color3.FromHexString('#24262b');
  tvFrame.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
  for (const tv of TVS) {
    const f = BABYLON.MeshBuilder.CreateBox('tvBody', { width: 2.12, height: 1.24, depth: 0.05 }, scene);
    f.position.set(tv.x + Math.sin(tv.rotY) * 0.03, 1.55, tv.z);
    f.rotation.y = tv.rotY;
    f.material = tvFrame;
    f.isPickable = false;
    shadows.addShadowCaster(f);
    tv.place = { x: tv.x + Math.sin(tv.rotY) * 0.058, y: 1.55, z: tv.z, rotY: tv.rotY, w: 2.0, h: 1.12 };
    setScreen(tv.id, CONSOLE, tv.place);
  }
  // 1초마다 화면 내용 정하기: 이미지가 있으면 이미지, 일하는 중이면 콘솔, 아니면 끔. TV 는 가장 최근 이미지(없으면 콘솔)
  /**
   * 1초마다 화면 내용 정하기.
   * 책상 주인이 일하는 중이면 받은 이미지 또는 콘솔, 아니면 꺼짐. 주인 없는 책상도 꺼진 화면. TV 는 가장 최근 이미지(없으면 콘솔).
   * @returns {void}
   * @see setScreen, deskPlace
   */
  function refreshScreens() {
    const used = new Set();
    let latest = null;
    for (const a of demo.agents) {
      if (!a.desk) continue;
      const working = LIVE ? a.liveBusy : a.at === a.desk && a.what === 'work';
      const want = working ? a.img || CONSOLE : OFF; // 일할 때만 켜짐: 받은 이미지 또는 콘솔. 쉬거나 비면 꺼짐
      setScreen(a.desk.id, want, deskPlace(a.desk));
      used.add(a.desk.id);
      if (a.img && (!latest || (a.imgAt || '') > (latest.imgAt || ''))) latest = a;
    }
    // 주인 없는 책상 모니터도 꺼진 화면
    for (const d of office.desks) if (!used.has(d.id)) setScreen(d.id, OFF, deskPlace(d));
    for (const tv of TVS) setScreen(tv.id, latest ? latest.img : CONSOLE, tv.place);
  }
  setInterval(refreshScreens, 1000);

  // ── 대표 컴퓨터: 지금 보고 있는 이 오피스 화면을 찍어 띄운다 (처음 15초 뒤, 이후 1시간마다)
  // 3D 화면(그리기 버퍼 보존 켜짐)을 줄여 그리고, 그 위에 카드·위쪽 단추를 간단한 반투명 판과 글줄 막대로 겹친다
  let bossShot = null;
  const BOSS_W = 640, BOSS_H = Math.round(640 * 0.466 / 0.758); // 모니터 화면 비율
  /**
   * 대표 컴퓨터 화면용으로 지금 오피스 화면을 찍어 두기 (처음 15초 뒤, 이후 1시간마다).
   * 3D 캔버스를 모니터 비율로 줄여 그리고(preserveDrawingBuffer 필요), 그 위에 카드·위쪽 버튼 자리를 반투명 흰 판과 글줄 막대로 간단히 덧그린 뒤 JPEG data URL 로 bossShot 에 둔다. 실패하면 경고만.
   * @returns {void}
   * @see setScreen
   */
  function captureBoss() {
    try {
      const src = engine.getRenderingCanvas();
      const sw = src.width, sh = src.height;
      if (!sw || !sh) return;
      const c = document.createElement('canvas');
      c.width = BOSS_W; c.height = BOSS_H;
      const g = c.getContext('2d');
      // 화면 가운데를 모니터 비율로 꽉 채워 자른다
      const s = Math.max(BOSS_W / sw, BOSS_H / sh), dx = (BOSS_W - sw * s) / 2, dy = (BOSS_H - sh * s) / 2;
      g.drawImage(src, dx, dy, sw * s, sh * s);
      const css = sw / (src.clientWidth || sw); // CSS 픽셀 → 캔버스 픽셀
      const map = (r) => ({ x: dx + r.left * css * s, y: dy + r.top * css * s, w: r.width * css * s, h: r.height * css * s });
      const round = (r, rad, fill) => { g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, rad); g.fillStyle = fill; g.fill(); };
      for (const el of document.querySelectorAll('#widgets .wg, #widgets .topbar .pill, #widgets .topbar .ib, #widgets .topbar #hud button')) {
        if (el.hidden || el.closest('[hidden]')) continue;
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        const r = map(b);
        const card = el.classList.contains('wg');
        round(r, Math.max(2, (card ? 18 : 20) * css * s), 'rgba(255,255,255,0.86)');
        if (!card) continue;
        // 카드 안: 제목 막대 + 글줄 막대 몇 개 (글자는 작아서 안 읽히니 모양만)
        const pad = Math.max(3, 18 * css * s), lh = Math.max(3, 12 * css * s);
        g.fillStyle = 'rgba(31,36,48,0.55)';
        g.fillRect(r.x + pad, r.y + pad, r.w * 0.35, lh * 0.7);
        g.fillStyle = 'rgba(31,36,48,0.18)';
        for (let y = r.y + pad + lh * 2, i = 0; y < r.y + r.h - pad && i < 14; y += lh * 1.6, i++) g.fillRect(r.x + pad, y, (r.w - pad * 2) * (0.55 + ((i * 37) % 40) / 100), lh * 0.5);
        g.fillStyle = '#8b6dff'; // 기본 색 점 하나 (카드 머리)
        g.fillRect(r.x + r.w - pad - lh, r.y + pad, lh * 0.7, lh * 0.7);
      }
      bossShot = c.toDataURL('image/jpeg', 0.82);
    } catch (e) { console.warn('대표 화면 찍기 실패', e); }
  }
  setTimeout(captureBoss, 15000);
  setInterval(captureBoss, 3600e3);
  setInterval(() => { setScreen('boss', bossShot || CONSOLE, deskPlace(office.boss)); }, 1000);
  setInterval(() => {
    const n = (day && day.state.night) || 0;
    for (const sc of screens.values()) {
      const k = sc.url && sc.url !== OFF ? 0.35 + 0.5 * n : 0;
      sc.halo.visibility = k * 0.7; if (sc.pool) sc.pool.visibility = k;
    }
  }, 2000);
  const imgSeen = new Map(); // 세션 키 → 마지막으로 확인한 기록 시각
  /**
   * 모니터에 띄울 그림 가져오기 (8초마다).
   * Claude 로컬 세션(L:)과 Antigravity 대화(P:antigravity:)만 그림이 있다 (Codex 는 기록에 그림 경로가 없어 제외). 마지막 활동 시각이 같으면 건너뛰고, 바뀌었으면 가져와 에이전트의 img·imgAt 에 둔다.
   * @returns {Promise<void>}
   * @see get_session_image, get_provider_image
   */
  async function pollImages() {
    const inv = window.__TAURI__.core.invoke;
    for (const a of demo.agents) {
      const key = a.cat.id;
      // Claude 로컬 세션(L:) 과 Antigravity 대화(P:antigravity:) 만 그림이 있다 (Codex 는 기록에 그림 경로가 없어 제외)
      const agy = key.startsWith('P:antigravity:');
      if ((!key.startsWith('L:') && !agy) || !a.desk) continue;
      const info = live.sessions.get(key);
      const stamp = (info && info.lastAt) || '';
      if (imgSeen.get(key) === stamp) continue;
      imgSeen.set(key, stamp);
      const url = await (agy ? inv('get_provider_image', { name: 'antigravity', id: key.slice('P:antigravity:'.length) }) : inv('get_session_image', { id: key.slice(2) })).catch(() => null);
      if (url && url !== a.img) { a.img = url; a.imgAt = stamp; }
    }
  }
  /**
   * 로컬·클라우드 Claude 세션 조회 (5초마다).
   * 둘 다 실패하면 지난 상태를 유지한다. 로컬은 status 가 있는(실행 중) 것, 클라우드는 실행 중이거나 3시간 안에 갱신된 보관 전 세션만 열쇠 L: · C: 로 모아 syncSessions 로 고양이에 맞춘다 (P: 열쇠는 건드리지 않는다).
   * @returns {Promise<void>}
   * @see get_local, get_cloud, syncSessions
   */
  async function pollSessions() {
    const inv = window.__TAURI__.core.invoke;
    const [loc, cloud] = await Promise.all([inv('get_local', { days: 1 }).catch(() => null), inv('get_cloud', { days: 1 }).catch(() => null)]);
    if (!loc && !cloud) return; // 둘 다 실패: 지난 상태 유지
    const now = Date.now(), seen = new Map();
    // 로컬 세션 ↔ claude.ai 원격 제어(bridge) 세션: 같은 프로젝트 폴더면 그 웹 링크로 연다 (가장 최근 것)
    /**
     * 로컬 세션 ↔ claude.ai 원격 제어(bridge) 세션 연결 링크 찾기.
     * 같은 프로젝트 폴더의 보관되지 않은 bridge 세션 중 가장 최근 것의 링크.
     * @param {string} project 프로젝트 이름
     * @returns {string} 링크 (없으면 빈 문자열)
     */
    const bridgeUrl = (project) => {
      const b = (cloud || []).filter((c) => c.env === 'bridge' && c.url && c.project && c.project === project && c.status !== 'archived')
        .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0];
      return b ? b.url : '';
    };
    for (const s of (loc && loc.sessions) || []) {
      if (!s.status) continue; // 끝난 세션
      seen.set('L:' + s.id, { key: 'L:' + s.id, provider: 'claude', busy: s.status === 'busy', project: s.project, title: s.title, lastAt: s.last_at || '', startedAt: s.started_at || '', open: { kind: 'local', id: s.id, cwd: s.cwd || '', active: !!s.status, url: bridgeUrl(s.project) } });
    }
    for (const s of cloud || []) {
      if (s.status === 'archived') continue;
      const fresh = now - Date.parse(s.updated_at || s.created_at || 0) < 3 * 3600e3;
      if (s.status !== 'running' && !fresh) continue;
      seen.set('C:' + s.id, { key: 'C:' + s.id, provider: 'claude', busy: s.status === 'running', project: s.project, title: s.title, startedAt: s.created_at, lastAt: s.updated_at, open: s.url ? { kind: 'url', url: s.url } : null });
    }
    syncSessions(seen, (k) => !k.startsWith('P:'));
  }
  // 지난 세션 (업무 현황 아래, 최근 7일·8개): 끝난 로컬 세션은 새 터미널에서 재개, 지난 클라우드 세션은 링크. 무거워서 1분마다 따로
  /**
   * 지난 세션 목록 조회 (업무 현황 아래 최근 7일·8개, 무거워서 1분마다 따로).
   * 끝난 로컬 세션은 새 터미널에서 재개, 지난(보관·오래된) 클라우드 세션은 링크로 열도록 담아 최근 순 8개를 live.ended 에 둔다. 둘 다 실패하면 그대로 둔다.
   * @returns {Promise<void>}
   * @see get_local, get_cloud
   */
  async function pollEnded() {
    const inv = window.__TAURI__.core.invoke;
    const [loc, cloud] = await Promise.all([inv('get_local', { days: 7 }).catch(() => null), inv('get_cloud', { days: 7 }).catch(() => null)]);
    if (!loc && !cloud) return;
    const now = Date.now(), ended = [];
    for (const s of (loc && loc.sessions) || []) if (!s.status) ended.push({ key: 'L:' + s.id, title: s.title, project: s.project, lastAt: s.last_at || '', open: { kind: 'local', id: s.id, cwd: s.cwd || '', active: false } });
    for (const s of cloud || []) {
      const fresh = now - Date.parse(s.updated_at || s.created_at || 0) < 3 * 3600e3;
      if (s.status !== 'running' && (s.status === 'archived' || !fresh) && s.url) ended.push({ key: 'C:' + s.id, title: s.title, project: s.project, lastAt: s.updated_at || '', open: { kind: 'url', url: s.url } });
    }
    live.ended = ended.sort((a, b) => Date.parse(b.lastAt || 0) - Date.parse(a.lastAt || 0)).slice(0, 8);
  }
  /**
   * 고양이 맞추기: owns(k) 인 열쇠만 이번 목록(seen)대로 출근·퇴근.
   * Claude 조회와 다른 서비스 조회가 서로의 고양이를 건드리지 않게 한다. 새 열쇠는 spawn, 있던 열쇠는 일 상태 갱신(demo.setBusy), 이번 목록에 없는 자기 몫은 despawn.
   * 마지막에 live.sessions 를 (남의 몫 + 이번 목록) 으로 바꾼다.
   * @param {Map<string, LiveSession>} seen 이번에 조회된 세션들
   * @param {function(string): boolean} owns 이번 조회가 담당하는 열쇠인지
   * @returns {void}
   * @see spawn, despawn, demo.setBusy
   */
  function syncSessions(seen, owns) {
    for (const [k, c] of chatSeen) if (owns(k)) seen.set(k, chatMerge(c, seen.get(k))); // 채팅 세션: 턴 사이에도 남고, busy 는 채팅 쪽 우선 (설계서 7.6)
    for (const [k, info] of seen) {
      if (!live.sessions.has(k)) spawn(info);
      else demo.setBusy(k, info.busy, info, chatSeen.has(k)); // 채팅 세션은 완료를 turn_done 으로만 센다
    }
    for (const k of [...live.sessions.keys()]) if (owns(k) && !seen.has(k)) despawn(k);
    const next = new Map([...live.sessions].filter(([k]) => !owns(k)));
    for (const [k, v] of seen) next.set(k, v);
    live.sessions = next;
  }
  // ── 채팅 세션 (Rust runner 의 chat_sessions): 고양이 목록에 덮어쓰고, 대화 도크와 이어 준다 ──
  const chatSeen = new Map(); // 열쇠 → chat_sessions 항목 {key, service, state, cwd, project, title, started_at, last_at}
  const CHAT_BUSY = new Set(['sending', 'streaming', 'awaiting_approval', 'interrupting']);
  const CHAT_PROVIDER = { claude: 'claude', codex: 'chatgpt', gemini: 'gemini' };
  /**
   * chat_sessions 항목을 고양이용 세션 정보로 합친다(같은 열쇠의 기존 정보가 있으면 채팅 쪽이 우선).
   * 일하는 중(busy) = 상태가 sending·streaming·awaiting_approval·interrupting.
   * @param {Object} c chat_sessions 항목
   * @param {?LiveSession} prev 다른 조회가 만든 같은 열쇠의 정보
   * @returns {LiveSession}
   */
  function chatMerge(c, prev) {
    const p = prev || {};
    return {
      ...p, key: c.key, provider: CHAT_PROVIDER[String(c.service).toLowerCase()] || p.provider || 'claude',
      busy: c.state === 'view_only' ? !!(p.busy || c.busy) : CHAT_BUSY.has(c.state), project: c.project || p.project || '', title: c.title || p.title || '',
      // 시작은 원래 세션 쪽(실행기가 등록한 시각이 아님), 마지막 갱신은 둘 중 늦은 쪽
      lastAt: (Date.parse(c.last_at) || 0) >= (Date.parse(p.lastAt) || 0) ? c.last_at || p.lastAt || '' : p.lastAt, startedAt: p.startedAt || c.started_at || '',
      open: p.open || (c.key.startsWith('L:') ? { kind: 'local', id: c.key.slice(2), cwd: c.cwd || '', active: false } : null),
    };
  }
  /**
   * chat_sessions 를 읽어 chatSeen 에 두고, 새 세션은 바로 출근시키고 있던 세션은 일 상태를 맞춘다.
   * 목록에서 빠진 세션의 퇴근은 다음 5초 조회(syncSessions)가 처리한다. 명령이 없거나 실패하면 지난 상태를 둔다.
   * @returns {Promise<void>}
   * @see chat_sessions, chatMerge, syncSessions
   */
  async function pollChat() {
    const list = await window.__TAURI__.core.invoke('chat_sessions').catch(() => null);
    if (!Array.isArray(list)) return;
    chatSeen.clear();
    for (const c of list) if (c && c.key) chatSeen.set(c.key, c);
    for (const [k, c] of chatSeen) {
      const info = chatMerge(c, live.sessions.get(k));
      if (!live.sessions.has(k)) spawn(info);
      else demo.setBusy(k, info.busy, info, true); // 채팅 세션은 완료를 turn_done 으로만 센다
      live.sessions.set(k, info);
    }
  }
  let chatRefreshTimer = 0;
  /**
   * 채팅 세션 목록을 곧(0.3초 뒤 한 번) 다시 읽는다 (상태 이벤트가 몰려도 한 번만).
   * @returns {void}
   */
  function chatRefreshSoon() {
    if (chatRefreshTimer) return;
    chatRefreshTimer = setTimeout(() => { chatRefreshTimer = 0; pollChat().catch(() => {}); }, 300);
  }
  /**
   * 새 대화·사본이 만들어졌을 때: 목록을 읽어 고양이를 출근시키고 그 대화로 도크를 연다.
   * 빈 책상이 없어 고양이가 없으면 토스트로 알리고 고양이 없이 도크만 연다.
   * @param {string} key 새 세션 열쇠
   * @returns {Promise<void>}
   * @see pollChat, focusCat
   */
  async function chatCreated(key) {
    const arriving = pollChat();
    await (typeof OfficeLoading !== 'undefined' ? OfficeLoading.wrap(arriving, document.getElementById('stage'), t('chat.new.arriving'), { dim: false }) : arriving); // 새 고양이가 올 때까지
    if (all.some((c) => c.id === key)) { focusCat(key); OfficeChat.show(key, 'chat'); } // 새 대화는 대화 탭으로
    else { ui.toast(t('chat.new.no_desk')); OfficeChat.show(key, 'chat'); }
  }
  /**
   * 새 대화 창에서 쓸 최근 작업 폴더들 (채팅·실행 중·지난 세션의 cwd 중복 제거, 최대 8개).
   * @returns {string[]}
   */
  function recentFolders() {
    const out = [];
    const add = (p) => { if (p && !out.includes(p)) out.push(p); };
    for (const c of chatSeen.values()) add(c.cwd);
    for (const v of live.sessions.values()) add(v.open && v.open.kind === 'local' && v.open.cwd);
    for (const e of live.ended || []) add(e.open && e.open.kind === 'local' && e.open.cwd);
    return out.slice(0, 8);
  }
  // 다른 AI 서비스 (켜 둔 서비스만): 느린 조회(네트워크·언어 서버)가 Claude 고양이를 붙잡지 않게 따로 10초마다
  /**
   * 다른 AI 서비스 조회 (켜 둔 서비스만, 10초마다).
   * 느린 조회(네트워크·언어 서버)가 Claude 고양이를 붙잡지 않게 따로 돈다. 서비스별 상태를 live.providers 에 두고, 진행 중 세션을 열쇠 P:서비스:id 로 모아 syncSessions 로 맞춘다.
   * @returns {Promise<void>}
   * @see get_provider, syncSessions
   */
  async function pollProviders() {
    const inv = window.__TAURI__.core.invoke;
    const snaps = await Promise.all(PROVIDERS.map((n) => (providerOn(n) ? inv('get_provider', { name: n }).catch(() => null) : Promise.resolve(null))));
    const seen = new Map();
    PROVIDERS.forEach((n, i) => {
      const snap = snaps[i];
      live.providers[n] = snap;
      if (!snap) return;
      for (const ps of snap.sessions || []) {
        if (!ps.status) continue;
        const k = 'P:' + n + ':' + ps.id;
        seen.set(k, { key: k, provider: n, busy: ps.status === 'busy', project: ps.project, title: ps.title, lastAt: ps.last_at || '', startedAt: ps.started_at || '', open: ps.url ? { kind: 'url', url: ps.url } : null });
      }
    });
    syncSessions(seen, (k) => k.startsWith('P:'));
  }
  /**
   * 이전 회차가 끝나기 전에는 다시 돌지 않는 주기 실행.
   * 즉시 한 번 돌리고 ms 마다 반복한다. 오류는 삼켜 다음 회차에 맡긴다.
   * @param {function(): Promise<*>} fn 돌릴 비동기 함수
   * @param {number} ms 간격(밀리초)
   * @returns {function(): Promise<void>} 지금 한 번 돌리는 함수 (겹치면 건너뜀)
   */
  function loop(fn, ms) {
    let busy = false;
    const run = async () => { if (busy) return; busy = true; try { await fn(); } catch (e) { /* 다음 회차에 */ } finally { busy = false; } };
    run();
    setInterval(run, ms);
    return run;
  }
  let appBits = null, lastPlanSnap = null; // 업데이트·로그인 안내·알림 읽음 (appbits.js, 위쪽 막대가 생긴 뒤 시작)
  /**
   * 플랜 스냅샷 반영.
   * 저장해 두고 appBits 에 알려 로그인 안내를 열거나 닫는다. plan 이 있으면 live.plan·live.name 을 갱신한다.
   * @param {PlanSnap} snap 플랜 스냅샷
   * @returns {void}
   * @see appBits.onPlan
   */
  function applyPlan(snap) {
    lastPlanSnap = snap;
    if (appBits) appBits.onPlan(snap); // 로그인 안 됨·만료 → 가운데 로그인 안내
    const p = snap && snap.plan;
    if (!p) return;
    live.plan = p;
    live.name = (p.account && p.account.name) || '';
  }
  if (LIVE) {
    const ev = window.__TAURI__.event;
    window.__TAURI__.core.invoke('get_plan', { force: false }).then(applyPlan, () => {});
    if (ev) ev.listen('plan', (e) => applyPlan(e.payload));
    // 채팅 도크: 이벤트 "chat" {key, seq, ev} 를 도크로, 상태가 바뀔 만한 이벤트는 세션 목록 다시 읽기(고양이 일 상태)
    OfficeChat.init({
      widgets: document.getElementById('widgets'),
      invoke: window.__TAURI__.core.invoke,
      toast: (m) => ui.toast(m),
      onClose: () => clearSelection(),
      chatInfo: (k) => chatSeen.get(k) || null,
      recentFolders,
      onCreated: (key, svc, breed) => { if (breed) setCatPick(key, breed); chatCreated(key).catch(() => {}); },
      catPreview: typeof OfficeCatPreview !== 'undefined' ? OfficeCatPreview.create(scene) : null,
      catChoices: () => BREEDS.map((b) => ({ id: b, name: CatModel.breedName(b), level: demo.levelOf(b).level })),
      onRekey: (from, to) => { if (catPick[from]) setCatPick(to, catPick[from]); // 열쇠가 바뀌어도 고른 고양이 그대로
        chatRefreshSoon(); setTimeout(() => { if (all.some((c) => c.id === to)) focusCat(to); }, 1500); },
      onChanged: () => chatRefreshSoon(),
      openTarget: (k) => { const info = live.sessions.get(k); if (info && info.open) openTarget(info.open); },
    });
    if (ev) ev.listen('chat', (e) => {
      const p = e.payload;
      OfficeChat.onEvent(p);
      const t0 = p && p.ev && p.ev.t;
      if (t0 === 'state' || t0 === 'rekey' || t0 === 'turn_end') chatRefreshSoon();
    });
    loop(pollChat, 5000);
    loop(pollSessions, 5000);
    loop(pollEnded, 60000);
    const runProviders = loop(pollProviders, 10000);
    meowProviders.sync().then((changed) => { if (changed) runProviders(); }); // 연동 켬 여부는 설정 파일 기준 (다시 실행해도 유지)
    window.addEventListener('storage', (e) => { if (e.key && e.key.startsWith('meow.provider.')) runProviders(); }); // 설정에서 켜고 끄면 바로 (겹쳐 돌지 않게 같은 문으로)
    setInterval(() => pollImages().catch(() => {}), 8000); // 모니터 이미지
    /**
     * 알림 기록 가져오기.
     * get_alert_history 결과를 live.alerts 에 두고 appBits 에 알려 읽음 처리를 시도한다. alert_history 이벤트와 10초마다 폴링이 같이 쓴다.
     * @returns {Promise<void>}
     * @see get_alert_history, appBits.onAlerts
     */
    const pollAlerts = () => window.__TAURI__.core.invoke('get_alert_history').then((l) => { live.alerts = l || []; if (appBits) appBits.onAlerts(live.alerts); }, () => {});
    if (ev) ev.listen('alert_history', (e) => { live.alerts = e.payload || []; if (appBits) appBits.onAlerts(live.alerts); });
    // 권한 요청 → 결재 줄: 앱이 바뀔 때마다 보내 주고(permits 이벤트), 혹시 놓쳐도 3초마다 맞춘다
    /**
     * 권한 요청 목록을 결재 줄에 맞추기.
     * get_permits 결과를 demo.syncPermits 로 보낸다. permits 이벤트를 놓쳐도 3초마다 맞춘다. 실패는 무시.
     * @returns {Promise<void>}
     * @see get_permits, demo.syncPermits
     */
    const pollPermits = () => window.__TAURI__.core.invoke('get_permits').then((l) => demo.syncPermits(l || []), () => {});
    if (ev) ev.listen('permits', (e) => demo.syncPermits(e.payload || []));
    // auto_permit·treats 리스너 등록이 끝난 뒤 take_treats 를 불러야 앱이 '오피스 준비됨'으로 보고 이벤트를 보낸다 (그 전 자동 수락은 몫으로 모임)
    const treatListens = ev ? [ev.listen('auto_permit', (e) => demo.autoPermit(e.payload))] : [];
    // 오피스 밖에서 승인된 몫(알림 카드 수락·창이 닫혀 있던 동안 자동 수락)을 간식으로: 열 때 한 번, 그 뒤엔 treats 이벤트마다
    /**
     * 앱에 모인 간식 몫을 꺼내 지급하고, 앱이 이미 센 작업 완료는 오피스가 다시 보고하지 않게 표시한다. 실패는 무시(다음 이벤트·다음 열기 때 다시).
     * @returns {Promise<void>}
     * @see take_treats, demo.giveTreats
     */
    const takeTreats = () => window.__TAURI__.core.invoke('take_treats').then((r) => { demo.markDone((r && r.recent) || []); demo.giveTreats((r && r.n) || 0); }, () => {});
    if (ev) treatListens.push(ev.listen('treats', takeTreats));
    if (ev) treatListens.push(ev.listen('turn_done', (e) => demo.turnDone(String(e.payload || ''))));
    Promise.all(treatListens).then(takeTreats, takeTreats);
    // 권한 연동이 꺼져 있으면 결재가 오지 않아 간식을 거의 못 받는다: 간식 단추 설명에 늘 적고, 처음 한 번은 알림 글로도 알린다
    window.__TAURI__.core.invoke('get_config').then((c) => {
      if (!c || c.permission_hook) return;
      ui.treatHint = '설정 › Claude 의 "권한 요청을 알림에서 수락/거절"을 켜면 결재 간식을 받을 수 있어요';
      try {
        if (!localStorage.getItem('meow.office.treatHintShown')) { localStorage.setItem('meow.office.treatHintShown', '1'); ui.toast(ui.treatHint); }
      } catch (_) { /* 저장소를 못 쓰면 알림 글은 생략 */ }
    }, () => {});
    pollPermits();
    setInterval(pollPermits, 3000);
    pollAlerts();
    setInterval(pollAlerts, 10000);
  } else {
    // 시연: 동전도 보여 준다
    setTimeout(() => cats.forEach(addCoin), 0); // ?providers=mix 가 정해진 뒤
  }
  // 개발용: ?sim=초 — 그리기 전에 그만큼 미리 진행 (헤드리스 캡처로 줄 서기 등 확인)
  const simSec = Number(params.get('sim')) || 0;
  for (let t = 0; t < simSec; t += 0.1) step(0.1);
  // 개발용: ?providers=mix — 서비스를 Claude·ChatGPT·Antigravity 로 돌아가며 붙여 본다 (실데이터 연결 전)
  if (params.get('providers') === 'mix') cats.forEach((c, i) => { c.provider = ['claude', 'chatgpt', 'antigravity'][i % 3]; });
  // 시작 연출: 고양이들이 패러글라이더로 내려온다 (개발용 ?nointro 또는 ?sim 이면 건너뜀)
  if (!simSec && !params.has('nointro')) {
    if (LIVE) { boss.landing = true; landings.push({ cat: boss, run: OfficeIntro.start(scene, [boss], { shadows }) }); } // 실시간: 세션 고양이는 들어올 때마다 따로 내려온다
    else intro = OfficeIntro.start(scene, all, { shadows });
  }

  // ── 그리기: 초당 최대 30번, 창이 가려지면 멈춤
  // 초당 30번, 화면을 만지지 않고 3초 지나면 15번 (내려오는 고양이가 있을 땐 30번)
  const FRAME_FAST = 1000 / 30, FRAME_SLOW = 1000 / 15;
  let lastInput = performance.now();
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) window.addEventListener(ev, () => { lastInput = performance.now(); }, { passive: true });
  let camKey = '';
  const SPEED = Number(new URLSearchParams(location.search).get('speed')) || 1; // 개발용: 시간 배속
  let last = 0;
  /**
   * 렌더 루프: 초당 최대 30번(화면을 만지지 않고 3초 지나면 15번), 창이 가려지면 멈춤.
   * 시간 간격으로 step → 말풍선 갱신 → 소리 갱신(그르렁·실내외 환경음·타자 소리) → 그리기 → 말풍선·이름표 위치 순으로 한다. 내려오는 고양이·시작 연출 중에는 30번 유지.
   * 개발용 window.__freeze 면 진행 없이 그리기만 한다. SPEED 로 시간 배속.
   * @returns {void}
   * @see step, syncBubble, placeBubbles, OfficeSound
   */
  engine.runRenderLoop(() => {
    if (document.hidden) return;
    if (window.__freeze) { scene.render(); placeBubbles(); placeBossTag(); roomSigns.update(); return; } // 개발용: 장면 멈춰 캡처
    const now = performance.now();
    const ck = camera.target.x.toFixed(2) + camera.target.z.toFixed(2) + camera.radius.toFixed(2);
    if (ck !== camKey) { camKey = ck; lastInput = now; }
    const busy = now - lastInput < 3000 || landings.length > 0 || (intro && !intro.done);
    if (now - last < (busy ? FRAME_FAST : FRAME_SLOW)) return;
    const dt = Math.min(0.1, (now - last) / 1000) * SPEED;
    last = now;
    step(dt);
    for (const cat of all) syncBubble(cat);
    // 자는 고양이 근처를 확대해 보면 그르렁
    if (OfficeSound.isOn()) {
      let near = 0;
      if (camera.radius < 16) {
        for (const c of cats) {
          if (c.act !== 'sleep' && c.act !== 'doze') continue;
          const d = BABYLON.Vector3.Distance(c.root.position, camera.target);
          near = Math.max(near, (1 - d / 5) * (1 - (camera.radius - 6) / 10));
        }
      }
      OfficeSound.setPurr(near);
      // 실내·실외: 보는 곳(카메라 중심)이 건물 안이면 1, 건물 밖 2m 넘게 벗어나면 0 (사이는 부드럽게)
      const t = camera.target, zoom = Math.max(0, Math.min(1, (60 - camera.radius) / 45));
      let out = Infinity;
      for (const b of [{ x0: 0, x1: 10, z0: 0, z1: 18 }, { x0: 22, x1: 32, z0: 0, z1: 18 }, { x0: 0, x1: 32, z0: 18, z1: 28 }]) {
        out = Math.min(out, Math.max(b.x0 - t.x, t.x - b.x1, b.z0 - t.z, t.z - b.z1));
      }
      const inside = Math.max(0, Math.min(1, 1 - out / 2));
      // 자판 소리: 타자 치는 고양이마다 소리 하나. 치기 시작하면 재생, 멈추면 끈다.
      // 크기는 그 고양이와 보는 곳(화면 가운데) 사이 거리·확대 정도로, 좌우는 화면 위치로.
      if (typeof CatModel !== 'undefined') {
        const vw = engine.getRenderWidth(), vh = engine.getRenderHeight();
        const close = Math.max(0, Math.min(1, (40 - camera.radius) / 34)); // 반경 40 → 6
        const srcs = {};
        for (const c of cats) {
          if (!c.model) continue;
          const hit = CatModel.keyStrikes(c);
          if (c.act !== 'type' || c.pose !== 'sit') continue;
          const near = Math.max(0, 1 - BABYLON.Vector3.Distance(c.root.position, t) / 12);
          const vol = near * near * (0.15 + 0.85 * close);
          const sp = BABYLON.Vector3.Project(c.root.position, BABYLON.Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(vw, vh));
          const pan = Math.max(-1, Math.min(1, (sp.x / vw) * 2 - 1));
          srcs[c.id] = { vol, pan };
          if (hit && vol > 0.05) OfficeSound.key(vol, pan); // 앞발이 닿을 때마다 한 타
        }
        OfficeSound.typing(srcs);
      }
      // 환경음: 밖이면 새소리·물소리 (타자 소리는 위에서 고양이마다)
      const pondNear = Math.max(0, 1 - Math.min(Math.hypot(t.x - 16, t.z - 9.55), Math.hypot(t.x + 7.2, t.z + 7.5)) / 9);
      OfficeSound.ambient({
        birds: (1 - inside) * (0.4 + 0.6 * zoom) + inside * 0.05, // 안에서는 창 너머로 아주 작게
        river: wxFx.frozen() ? 0 : (1 - inside) * pondNear * (0.4 + 0.6 * zoom), // 얼면 물소리 없음
      });
    }
    scene.render();
    placeBubbles();
    roomSigns.update();
    placeBossTag();
  });
  window.addEventListener('resize', () => engine.resize());

  // 전체 화면: F11 또는 오른쪽 위 버튼. Esc 로 나감. 앱 창(Tauri)이면 창 자체를, 브라우저면 페이지를 전체 화면으로.
  const tauriWin = window.__TAURI__ && window.__TAURI__.window ? window.__TAURI__.window.getCurrentWindow() : null;
  /**
   * 지금 전체 화면인지.
   * 앱 창이면 창 상태, 브라우저면 fullscreenElement 로 본다.
   * @returns {Promise<boolean>}
   */
  const isFull = async () => (tauriWin ? tauriWin.isFullscreen() : !!document.fullscreenElement);
  /**
   * 전체 화면 켜고 끄기.
   * 앱 창이면 창을, 브라우저면 페이지를 전환한다. 실패하면 경고만 하고, 단추 아이콘·툴팁을 현재 상태에 맞춘다.
   * @param {boolean} on 켜기 여부
   * @returns {Promise<void>}
   * @see isFull
   */
  const setFull = async (on) => {
    try {
      if (tauriWin) await tauriWin.setFullscreen(on);
      else if (on) await document.documentElement.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch (e) { console.warn('전체 화면 전환 실패', e); }
    fsBtn.innerHTML = svg((await isFull()) ? 'min' : 'max');
    fsBtn.title = (await isFull()) ? '창 모드로 (Esc)' : '전체 화면 (F11)';
  };
  const fsBtn = document.createElement('button');
  fsBtn.id = 'fsBtn';
  fsBtn.type = 'button';
  fsBtn.title = '전체 화면 (F11)';
  fsBtn.className = 'ib';
  fsBtn.innerHTML = svg('max');
  fsBtn.onclick = async () => setFull(!(await isFull()));
  (document.querySelector('.topbar') || document.getElementById('stage')).appendChild(fsBtn); // 위쪽 막대 안으로
  window.addEventListener('keydown', async (e) => {
    if (e.key === 'F11') { e.preventDefault(); setFull(!(await isFull())); }
    else if (e.key === 'Escape' && tauriWin && (await isFull())) setFull(false);
  });

  // ── 설정: settings.js 화면을 그림자 DOM 안에 (설정 스타일이 오피스와 섞이지 않게) ──
  let settings = null;
  try {
    const host = document.createElement('div');
    host.id = 'settingsHost';
    document.getElementById('stage').appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    let css = await fetch('../styles.css').then((r) => r.text());
    css = css.replace(/:root/g, ':host')
      .replace(/html,\s*body\s*\{/g, ':host(.never) {').replace(/(^|\n)body\s*\{/g, '$1:host(.never) {')
      .replace(/url\("(?!data:|https?:|\/)([^"]+)"\)/g, 'url("../$1")'); // 상대 경로는 ui/ 기준
    shadow.innerHTML = `<style>${css}
      :host { position: fixed; inset: 0; z-index: 50; pointer-events: none; font-family: "Pretendard", system-ui, sans-serif; color: var(--text); }
      #settings:not([hidden]) { pointer-events: auto; }</style><div id="wrap"></div>`;
    const inv = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core.invoke : null;
    settings = MeowSettings.mount(shadow, shadow.getElementById('wrap'), {
      invoke: inv,
      toast: (m) => ui.toast(m),
      getPlan: () => (lastPlanSnap ? { plan: live.plan, error: lastPlanSnap.error, state: lastPlanSnap.state } : live.plan ? { plan: live.plan } : null),
    });
    const gear = document.createElement('button');
    gear.className = 'ib';
    gear.title = '설정';
    gear.innerHTML = svg('settings');
    gear.onclick = () => settings.toggle();
    const help = document.createElement('button');
    help.className = 'ib';
    help.title = '조작 안내 (마우스)';
    help.innerHTML = svg('help');
    // [?] 메뉴: 처음 안내 다시 보기 · 마우스 조작 안내
    const helpMenu = document.createElement('div');
    helpMenu.className = 'help-menu';
    helpMenu.hidden = true;
    helpMenu.innerHTML = '<button data-h="tour">처음 안내 다시 보기</button><button data-h="mouse">마우스 조작 안내</button><button data-h="layout">패널 위치 초기화</button>';
    help.onclick = (e) => { e.stopPropagation(); helpMenu.hidden = !helpMenu.hidden; };
    helpMenu.onclick = (e) => {
      const b = e.target.closest('[data-h]');
      if (!b) return;
      helpMenu.hidden = true;
      if (b.dataset.h === 'tour') OfficeTour.start();
      else if (b.dataset.h === 'layout') OfficePanel.resetLayout();
      else if (window.__officeHint) window.__officeHint();
    };
    document.addEventListener('click', (e) => { if (!helpMenu.hidden && !helpMenu.contains(e.target)) helpMenu.hidden = true; });
    const bar = document.querySelector('.topbar');
    if (bar) {
      if (LIVE) { // 위쪽 막대 '＋ 새 대화' (실시간 모드만)
        // 화면 왼쪽 위의 색 있는 단추: 고양이 발바닥에 ＋ 를 얹은 그림 + '새 대화' (패널은 위쪽 툴바 띠를 침범하지 않으므로 가려지지 않는다 — panel.js TOP)
        const nb = document.createElement('button');
        nb.className = 'chat-new-btn';
        const PAW_PLUS = '<svg viewBox="0 0 28 24" width="26" height="22" aria-hidden="true"><g fill="currentColor"><ellipse cx="4.6" cy="11.2" rx="2.3" ry="3"/><ellipse cx="9.4" cy="6.4" rx="2.4" ry="3.2"/><ellipse cx="15.2" cy="6.4" rx="2.4" ry="3.2"/><ellipse cx="20" cy="11.2" rx="2.3" ry="3"/><path d="M12.3 11.6c-3.4 0-6.3 3.3-6.3 6.3 0 2.2 1.7 3.5 3.7 3.5 1 0 1.7-.5 2.6-.5s1.6.5 2.6.5c2 0 3.7-1.3 3.7-3.5 0-3-2.9-6.3-6.3-6.3z"/></g><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M23.6 1.6v6.4M20.4 4.8h6.4"/></g></svg>';
        const paintNb = () => { nb.innerHTML = PAW_PLUS + '<span></span>'; nb.lastChild.textContent = t('chat.new'); nb.title = t('chat.new'); };
        paintNb();
        nb.onclick = () => OfficeChat.openNew();
        window.addEventListener('meow-lang', paintNb);
        document.getElementById('widgets').appendChild(nb);
      }
      bar.insertBefore(help, bar.querySelector('#fsBtn')); bar.insertBefore(gear, bar.querySelector('#fsBtn')); bar.appendChild(helpMenu);
    }
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settings.isOpen()) settings.close(); });
  } catch (e) { console.warn('설정 화면 준비 실패', e); }
  // 업데이트 단추·업데이트 완료 안내·로그인 안내·알림 읽음 (예전 관리 창 기능)
  appBits = OfficeApp.start({
    invoke: LIVE ? window.__TAURI__.core.invoke : null,
    listen: LIVE && window.__TAURI__.event ? window.__TAURI__.event.listen : null,
    toast: (t) => ui.toast(t),
    bar: document.querySelector('.topbar'),
    stage: document.getElementById('stage'),
    alertsVisible: () => OfficePanel.alertsVisible(),
    lastAlerts: () => live.alerts,
    onPlanRefreshed: (snap) => applyPlan(snap),
  });
  if (lastPlanSnap) appBits.onPlan(lastPlanSnap);
  appBits.onAlerts(live.alerts);

  // 사용량 상세 (현황 카드 아래 '사용량 상세' · 한도 고리)
  const usage = OfficeUsage.init ? (OfficeUsage.init(document.getElementById('stage'), {
    invoke: window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__.core.invoke : null,
    openSettings: (pane) => settings && settings.open(pane),
    getPlan: () => live.plan,
    getProvider: (n) => live.providers[n] || null,
    providerOn,
  }), OfficeUsage) : null;
  OfficePanel.onUsage((t) => usage && usage.open({ svc: !t || t === 'all' ? 'claude' : t })); // 현황 카드에서 고른 서비스를 따라

  // 개발용 핸들
  window.__office = { engine, scene, camera, office, cats, boss, demo, demoTick: demo.tick, step, tourFocus };
})().catch((e) => {
  // 초기화 실패(WebGL 생성 불가 등): 빈 창 대신 안내 문구, 앱 로그에도 남김
  console.error('오피스 초기화 실패', e);
  try { window.__TAURI__ && window.__TAURI__.core.invoke('log_ui', { level: 'error', message: `office: 초기화 실패 ${(e && e.stack) || e}` }); } catch (_) { /* 무시 */ }
  const m = document.createElement('div');
  m.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:24px;text-align:center;font:600 14px/1.6 Pretendard,system-ui,sans-serif;color:#4a5162;background:#f5f3ff;z-index:99';
  m.innerHTML = '<div><b style="font-size:16px;color:#1f2430">사무실 화면을 열지 못했습니다</b><br>그래픽(WebGL)을 쓸 수 없는 환경일 수 있습니다. 앱을 다시 실행해 보고, 계속되면 설정 › 정보 › 로그 [보내기]로 알려 주세요.</div>';
  document.body.appendChild(m);
});
