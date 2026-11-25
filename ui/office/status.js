/**
 * @file 고양이 상태 문구 표 (OfficeStatus).
 * 패널의 고양이 목록과 머리 위 상태 알약(intro.js coin)이 같은 문구·같은 분류를 쓰도록 표와 판정을 한 곳에 둔다.
 * 공개 API: OfficeStatus.of(c) → [문구, 분류] · OfficeStatus.DOING · OfficeStatus.ALERT
 * @see OfficePanel, OfficeIntro.coin
 *
 * @typedef {Object} StatusCat 상태를 읽을 고양이 정보 (office.js refreshPanel 이 만드는 항목의 일부)
 * @property {string} [alert] 처리할 요청 종류 (permission | question | deliver | report | error)
 * @property {boolean} [leaving] 퇴근 중
 * @property {boolean} [landing] 출근(착지) 중
 * @property {string} [doing] 하는 일 (work | fish | read | board | meeting | coffee | rest | walk | skate)
 * @property {boolean} [atDesk] 책상에 앉았는지 (false 면 자리로 가는 중)
 */
'use strict';

const OfficeStatus = (() => {
  /**
   * 하는 일 → [문구 키, 분류]. 분류는 패널 CSS 클래스이자 알약 색 구분이다 (busy | idle | wait | perm | done | err | off).
   * @type {Object<string, [string, string]>}
   */
  const DOING = {
    work: ['status.doing.work', 'busy'], fish: ['status.doing.fish', 'idle'], read: ['status.doing.read', 'idle'], board: ['status.doing.board', 'idle'], meeting: ['status.doing.meeting', 'busy'],
    coffee: ['status.doing.coffee', 'idle'], rest: ['status.doing.rest', 'idle'], walk: ['status.doing.walk', 'idle'], skate: ['status.doing.skate', 'idle'],
  };
  /**
   * 요청 종류 → [문구 키, 분류].
   * @type {Object<string, [string, string]>}
   */
  const ALERT = { permission: ['status.alert.permission', 'perm'], question: ['status.alert.question', 'wait'], deliver: ['status.alert.deliver', 'done'], report: ['status.alert.report', 'done'], error: ['status.alert.error', 'err'] };

  /**
   * 고양이의 현재 상태 문구와 분류.
   * 요청 → 퇴근 중 → 출근 중 → 자리로 가는 중 → 하는 일(DOING) → 대기 순.
   * @param {StatusCat} c 고양이 정보
   * @returns {[string, string]} [문구, 분류]
   * @see ALERT, DOING
   */
  function of(c) {
    const [key, cls] = pick(c);
    return [t(key), cls];
  }
  /**
   * 상태 문구 키와 분류 (번역 전).
   * @param {StatusCat} c 고양이 정보
   * @returns {[string, string]} [사전 키, 분류]
   */
  function pick(c) {
    if (c.alert) return ALERT[c.alert] || ['status.alert.other', 'wait'];
    if (c.leaving) return ['status.leaving', 'off'];
    if (c.landing) return ['status.landing', 'idle'];
    if (c.doing === 'work' && c.atDesk === false) return ['status.toDesk', 'busy'];
    return DOING[c.doing] || ['status.idle', 'idle'];
  }

  return { DOING, ALERT, of };
})();
