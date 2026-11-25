/**
 * @file 다국어(i18n) — 화면 문구를 키로 관리한다. 사전: ui/i18n/<언어>.js 가 I18N.add("<언어>", { 키: 문구 }) 로 등록.
 * 쓰는 법
 *   - 스크립트: I18N.t("weather.rain") · 자리표시: I18N.t("loc.changed", { name: "서울" }) → "{name}" 자리에 넣음
 *   - HTML: <b data-i18n="loc.title"></b> · 속성은 data-i18n-title / data-i18n-placeholder / data-i18n-aria-label. I18N.apply(root) 로 채움
 * 언어: localStorage meow.lang ("auto" | "ko" | "en" …). auto = 브라우저(OS) 언어, 사전에 없으면 en.
 * 문구가 없으면: 현재 언어 → ko → 키 그대로. 새 문구는 반드시 ko.js 에 먼저 넣고, 다른 언어는 비어도 된다.
 * 규칙·키 이름: docs/I18N.md
 * 공개 API: I18N.{ add, t, lang, setLang, apply, apiLang, languages } 와 전역 단축 t(key, params).
 */
/**
 * @typedef {Object<string,string>} I18nDict
 * @property 키(예: "loc.title") → 문구. 자리표시는 {이름} 형태
 */
'use strict';

const I18N = (() => {
  const dicts = {};
  const FALLBACK = 'ko';
  let cur = null;

  /**
   * 언어 사전 등록(같은 언어는 병합).
   * dicts[lang] 에 dict 를 덮어쓰며 합친다.
   * @param {string} lang 언어 코드("ko"·"en"…)
   * @param {I18nDict} dict 키 → 문구
   * @returns {void}
   */
  function add(lang, dict) { dicts[lang] = Object.assign(dicts[lang] || {}, dict); }
  /**
   * 쓸 언어 고르기.
   * localStorage meow.lang 이 사전에 있는 값이면 그것, "auto"면 브라우저 언어(전체 → 앞부분) → 없으면 en(영어 사전이 없으면 ko).
   * @returns {string} 언어 코드
   */
  function pick() {
    let want = 'auto';
    try { want = localStorage.getItem('meow.lang') || 'auto'; } catch (_) { /* 저장소 없음 */ }
    if (want !== 'auto' && dicts[want]) return want;
    const nav = (navigator.language || FALLBACK).toLowerCase();
    const base = nav.split('-')[0];
    return dicts[nav] ? nav : dicts[base] ? base : dicts.en ? 'en' : FALLBACK; // 사전에 없는 언어(일본어 등)는 영어로
  }
  /**
   * 현재 언어 코드(처음 부르면 pick 으로 정해 캐시).
   * @returns {string} 언어 코드
   * @see pick
   */
  function lang() { return cur || (cur = pick()); }
  /**
   * 언어 바꾸기.
   * meow.lang 에 저장하고 캐시를 비운 뒤 document 를 다시 채우고 "meow-lang" 이벤트(detail=새 언어)를 보낸다.
   * @param {string} l "auto" | 언어 코드
   * @returns {void}
   * @see apply, lang
   */
  function setLang(l) {
    try { localStorage.setItem('meow.lang', l); } catch (_) { /* 이번만 */ }
    changed();
    syncNative();
  }
  /**
   * 언어가 바뀐 뒤 이 창을 다시 채운다(캐시 비움 → html lang → data-i18n → "meow-lang" 이벤트).
   * setLang(이 창에서 바꿈)과 storage 이벤트(다른 창에서 바꿈 — 오피스 창 설정 → 알림 창)가 부른다.
   * @returns {void}
   */
  function changed() {
    cur = null;
    document.documentElement.lang = lang();
    preloadFont();
    apply(document);
    window.dispatchEvent(new CustomEvent('meow-lang', { detail: lang() }));
  }
  /**
   * 일본어 화면이면 Noto Sans JP 중 사전 문구에 쓰인 글자 조각을 미리 불러온다.
   * 글꼴은 글자 범위별 조각(ui/vendor/noto-sans-jp)이라 DOM 에 처음 나올 때 받는데, 캔버스(3D 라벨)는 그 전에 그리면 대체 글꼴로 굳는다.
   * @returns {void}
   */
  function preloadFont() {
    if (lang() !== 'ja' || !document.fonts || !dicts.ja) return;
    document.fonts.load('400 16px "Noto Sans JP"', Object.values(dicts.ja).join('')).catch(() => { /* 글꼴 없음 — 대체 글꼴 */ });
  }
  /**
   * 앱 본체(Rust)에 언어를 알린다 — 트레이 메뉴·알림 카드·오류 문구가 화면과 같은 언어를 쓰도록.
   * Tauri 밖(브라우저 미리보기)이면 아무것도 하지 않는다.
   * @returns {void}
   * @see Tauri 명령 set_lang(choice: "auto"|코드, lang: 실제로 쓰는 코드)
   */
  function syncNative() {
    const tauri = window.__TAURI__;
    if (!tauri || !tauri.core) return;
    let choice = 'auto';
    try { choice = localStorage.getItem('meow.lang') || 'auto'; } catch (_) { /* 저장소 없음 */ }
    tauri.core.invoke('set_lang', { choice, lang: lang() }).catch(() => { /* 옛 본체 — 무시 */ });
  }
  /**
   * 키 → 문구 번역.
   * 현재 언어 → ko → 키 그대로 순으로 찾고, params 가 있으면 "{이름}" 자리를 값으로 바꾼다(값이 null/undefined 면 자리표시 유지).
   * @param {string} key 문구 키
   * @param {Object<string,*>} [params] 자리표시 값
   * @returns {string} 번역 문구
   * @see lang
   */
  function t(key, params) {
    const l = lang();
    let s = (dicts[l] && dicts[l][key]) ?? (dicts[FALLBACK] && dicts[FALLBACK][key]) ?? key;
    if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
    return s;
  }
  /**
   * root 안의 data-i18n* 요소를 현재 언어로 채운다.
   * data-i18n 은 textContent, data-i18n-title/placeholder/aria-label 은 같은 이름 속성에 넣는다.
   * @param {ParentNode} [root=document] 채울 범위
   * @returns {void}
   * @see t
   */
  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      root.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`))));
    }
  }
  /**
   * 날씨·지명 API 등에 넘길 언어 코드.
   * 현재 언어의 "-" 앞부분(예: "en-US" → "en").
   * @returns {string} 언어 코드
   * @see MeowWeather.searchPlace
   */
  function apiLang() { return lang().split('-')[0]; }
  /**
   * 등록된 언어 코드 목록.
   * @returns {string[]} 언어 코드들
   */
  function languages() { return Object.keys(dicts); }

  // 다른 창에서 언어를 바꾸면(같은 저장소 공유) 이 창도 따라간다. storage 이벤트는 바꾼 창 자신에게는 오지 않는다.
  window.addEventListener('storage', (e) => { if (e.key === 'meow.lang') changed(); });
  // 사전·화면 스크립트가 모두 실린 뒤: html lang, 정적 data-i18n 채우기, 본체에 언어 알림.
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.lang = lang();
    preloadFont();
    apply(document);
    syncNative();
  });

  return { add, t, lang, setLang, apply, apiLang, languages };
})();
/**
 * I18N.t 의 전역 단축.
 * @param {string} key 문구 키
 * @param {Object<string,*>} [params] 자리표시 값
 * @returns {string} 번역 문구
 * @see I18N.t
 */
const t = (key, params) => I18N.t(key, params);
