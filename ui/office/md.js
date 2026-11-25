/**
 * @file 채팅 답변용 최소 마크다운 렌더러 (MeowMd). 모델 출력은 신뢰할 수 없는 입력이므로 innerHTML 을 쓰지 않고
 * createElement/textContent 로만 조립한다. 원시 HTML 은 글자로 보이고, 링크는 http/https 만 <a> 가 되며 클릭은 open_url 로 연다.
 * 지원: 코드 펜스(닫히지 않은 펜스도 코드로), # ~ ### 제목, 목록(-, *, +, 1.), 인용(>), 구분선, 문단, 인라인(`코드`, **굵게**, *기울임*, [글](주소)).
 * 그림 문법(![..](..))은 "그림: 주소" 글자로만. 표·구문 강조는 2단계.
 * 공개 API: MeowMd.render(text, opts) → DocumentFragment.
 */
'use strict';

const MeowMd = (() => {
  /**
   * 번역 문구 (없으면 기본값).
   * @param {string} key 문구 키
   * @param {string} dflt 기본 문구
   * @returns {string}
   */
  const tr = (key, dflt) => { try { return typeof t === 'function' ? t(key) : dflt; } catch (e) { return dflt; } };

  /**
   * 링크 주소가 열어도 되는 http/https 인지.
   * @param {string} url 주소
   * @returns {boolean}
   */
  function safeUrl(url) {
    try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; }
  }

  /**
   * 링크 열기: 앱이면 open_url (웹뷰 이동 금지), 아니면 새 창.
   * @param {string} url http/https 주소
   * @returns {void}
   */
  function openUrl(url) {
    const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (inv) inv('open_url', { url }).catch(() => {});
    else window.open(url, '_blank', 'noopener');
  }

  const INLINE = /!\[([^\]]*)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/;

  /**
   * 인라인 마크다운을 부모에 붙인다.
   * @param {Node} parent 붙일 부모
   * @param {string} text 한 줄(또는 여러 줄) 글
   * @returns {void}
   */
  function inline(parent, text) {
    let rest = text;
    while (rest) {
      const m = INLINE.exec(rest);
      if (!m) { parent.appendChild(document.createTextNode(rest)); return; }
      if (m.index > 0) parent.appendChild(document.createTextNode(rest.slice(0, m.index)));
      if (m[2] !== undefined) {
        parent.appendChild(document.createTextNode(`그림: ${m[2]}`));
      } else if (m[3] !== undefined) {
        const c = document.createElement('code'); c.textContent = m[3]; parent.appendChild(c);
      } else if (m[4] !== undefined) {
        const b = document.createElement('strong'); inline(b, m[4]); parent.appendChild(b);
      } else if (m[5] !== undefined) {
        const i = document.createElement('em'); inline(i, m[5]); parent.appendChild(i);
      } else if (safeUrl(m[7])) {
        const a = document.createElement('a');
        // href 를 달지 않는다: 가운데 클릭·끌기로 웹뷰가 직접 이동하는 길을 막고, 열기는 open_url 로만 (설계서 7.4)
        a.dataset.url = m[7]; a.title = m[7]; a.setAttribute('role', 'link'); a.tabIndex = 0; a.style.cursor = 'pointer';
        a.addEventListener('click', (e) => { e.preventDefault(); openUrl(m[7]); });
        a.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openUrl(m[7]); } });
        inline(a, m[6]);
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m[0])); // 그 외 스킴은 글자
      }
      rest = rest.slice(m.index + m[0].length);
    }
  }

  /**
   * 여러 줄 글을 줄바꿈(<br>)과 함께 붙인다.
   * @param {Node} parent 부모
   * @param {string[]} lines 줄들
   * @returns {void}
   */
  function lines(parent, arr) {
    arr.forEach((ln, i) => { if (i) parent.appendChild(document.createElement('br')); inline(parent, ln); });
  }

  /**
   * 코드 블록(복사 단추 포함) 만들기.
   * @param {string} code 코드 본문
   * @returns {HTMLElement}
   */
  function codeBlock(code) {
    const wrap = document.createElement('div');
    wrap.className = 'md-code';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'md-copy'; btn.textContent = tr('chat.copy', '복사');
    btn.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(code).then(() => { btn.textContent = tr('chat.copied', '복사됨'); setTimeout(() => { btn.textContent = tr('chat.copy', '복사'); }, 1200); }, () => {});
      } catch (e) { /* 클립보드 불가 */ }
    });
    const pre = document.createElement('pre');
    const c = document.createElement('code'); c.textContent = code; pre.appendChild(c);
    wrap.append(btn, pre);
    return wrap;
  }

  /**
   * 마크다운 글을 DocumentFragment 로 그린다.
   * 코드 펜스를 먼저 떼어 낸 뒤 줄 단위로 블록(제목·목록·인용·구분선·문단)을 만들고 각 글에 인라인 규칙을 적용한다.
   * 스트리밍 중 닫히지 않은 펜스는 끝까지를 코드 블록으로 본다.
   * @param {string} text 마크다운 글
   * @returns {DocumentFragment}
   * @see inline, codeBlock
   */
  function render(text) {
    const frag = document.createDocumentFragment();
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = document.createElement('p'); lines(p, para); frag.appendChild(p); para = [];
    };
    while (i < src.length) {
      const ln = src[i];
      const fence = /^\s*```/.exec(ln);
      if (fence) {
        flush();
        const buf = []; i++;
        while (i < src.length && !/^\s*```\s*$/.test(src[i])) { buf.push(src[i]); i++; }
        i++; // 닫는 펜스 (없으면 끝)
        frag.appendChild(codeBlock(buf.join('\n')));
        continue;
      }
      if (!ln.trim()) { flush(); i++; continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(ln);
      if (h) { flush(); const e = document.createElement('h' + (h[1].length + 2)); inline(e, h[2]); frag.appendChild(e); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { flush(); frag.appendChild(document.createElement('hr')); i++; continue; }
      if (/^\s*>/.test(ln)) {
        flush();
        const buf = [];
        while (i < src.length && /^\s*>/.test(src[i])) { buf.push(src[i].replace(/^\s*>\s?/, '')); i++; }
        const q = document.createElement('blockquote'); lines(q, buf); frag.appendChild(q);
        continue;
      }
      const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(ln);
      if (li) {
        flush();
        const ordered = /\d/.test(li[1]);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < src.length) {
          const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(src[i]);
          if (!m || /\d/.test(m[1]) !== ordered) break;
          const item = document.createElement('li'); inline(item, m[2]); list.appendChild(item); i++;
        }
        frag.appendChild(list);
        continue;
      }
      para.push(ln); i++;
    }
    flush();
    return frag;
  }

  return { render };
})();
