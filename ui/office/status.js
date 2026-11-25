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
   * 하는 일 → [문구, 분류]. 분류는 패널 CSS 클래스이자 알약 색 구분이다 (busy | idle | wait | perm | done | err | off).
   * @type {Object<string, [string, string]>}
   */
  const DOING = {
    work: ['일하는 중', 'busy'], fish: ['낚시', 'idle'], read: ['책 읽기', 'idle'], board: ['화이트보드', 'idle'], meeting: ['회의', 'busy'],
    coffee: ['커피 타임', 'idle'], rest: ['휴식', 'idle'], walk: ['산책', 'idle'], skate: ['스케이트', 'idle'],
  };
  /**
   * 요청 종류 → [문구, 분류].
   * @type {Object<string, [string, string]>}
   */
  const ALERT = { permission: ['결재 대기', 'perm'], question: ['입력 대기', 'wait'], deliver: ['완료', 'done'], report: ['완료 보고', 'done'], error: ['오류', 'err'] };

  /**
   * 고양이의 현재 상태 문구와 분류.
   * 요청 → 퇴근 중 → 출근 중 → 자리로 가는 중 → 하는 일(DOING) → 대기 순.
   * @param {StatusCat} c 고양이 정보
   * @returns {[string, string]} [문구, 분류]
   * @see ALERT, DOING
   */
  function of(c) {
    if (c.alert) return ALERT[c.alert] || ['요청', 'wait'];
    if (c.leaving) return ['퇴근 중', 'off'];
    if (c.landing) return ['출근 중', 'idle'];
    if (c.doing === 'work' && c.atDesk === false) return ['자리로 가는 중', 'busy'];
    return DOING[c.doing] || ['대기', 'idle'];
  }

  return { DOING, ALERT, of };
})();
