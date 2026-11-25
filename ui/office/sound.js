/**
 * @file 고양이 사무실 소리 (OfficeSound): 울음·효과음·환경음·타자 소리.
 * 고양이 소리 (CC0 녹음, assets/licenses/opengameart-sounds 참고).
 * 기본은 꺼짐. 켜면 요청 이벤트마다 짧게 울고, 자는 고양이 가까이 확대하면 그르렁 소리가 난다.
 * 환경음: 정원 새소리, 연못 물소리를 보는 곳에 따라 섞는다. 타자 소리는 타자 치는 고양이마다 따로 난다. 효과음: 도장, 커피, 잔.
 * 같은 소리가 겹쳐 시끄럽지 않게 전체 간격을 둔다.
 * 공개 API: setEnabled, savedOn, play, fx, key, typing, ambient, setPurr, isOn.
 * 모든 소리는 Web Audio 의 master 게인(0.5) 을 거쳐 나가며, 꺼져 있거나 ctx 가 없으면 아무것도 하지 않는다.
 *
 * @typedef {Object} TyperSrc 타자 소리 한 마리 분량
 * @property {number} vol 음량 0~1 (거리 감쇠 반영)
 * @property {number} pan 좌우 -1(왼쪽) ~ 1(오른쪽)
 *
 * @typedef {Object<string, TyperSrc>} TyperSrcs typing() 입력: 고양이 id → TyperSrc
 *
 * @typedef {Object} AmbientLevels ambient() 입력: 환경음 이름 → 음량 0~1
 * @property {number} [birds] 정원 새소리
 * @property {number} [river] 연못 물소리
 *
 * @typedef {Object} LoopVoice 반복 재생 중인 소리 하나
 * @property {AudioBufferSourceNode} src 재생 노드
 * @property {GainNode} gain 음량 노드
 * @property {StereoPannerNode|null} [p] 좌우 패너 (typing 만 씀)
 */
'use strict';

const OfficeSound = (() => {
  /**
   * 소리 파일 폴더 (ui 기준 상대 경로).
   * @type {string}
   */
  const BASE = 'sounds/';
  /**
   * 소리 이름 → 파일 이름 표 (BASE 아래). 울음 6종, 환경음 4종(새·물·타자 A/B), 효과음 4종.
   * @type {Object<string, string>}
   */
  const FILES = {
    soft: 'mew-soft.wav', food: 'mew-food.wav', purr: 'mew-purr.wav', purr2: 'mew-purr2.wav',
    kitten: 'kitten-mew.wav', purrLoop: 'purr-sleepy.wav',
    // 환경음 (반복)
    birds: 'amb-birds.wav', river: 'amb-river.wav', typeA: 'typing-a.wav', typeB: 'typing-b.wav',
    // 효과음
    stamp: 'stamp.wav', grounds: 'coffee-grounds.wav', boil: 'coffee-boil.wav', clink: 'cup-clink.wav',
  };
  /**
   * 효과음 이름 → 기본 음량(0~1) 표. 없는 이름은 fx() 가 0.6 을 쓴다.
   * @type {Object<string, number>}
   */
  const FX_VOL = { stamp: 0.9, grounds: 0.5, boil: 0.35, clink: 0.55 };
  /**
   * 환경음 이름 → 최대 음량(0~1). ambient(levels) 의 0~1 값에 곱해진다. 없는 이름은 0.3.
   * @type {Object<string, number>}
   */
  const AMB_MAX = { birds: 0.35, river: 0.4 };
  /**
   * 고양이 한 마리 타자 소리 최대 크기 (게인 0~1).
   * @type {number}
   */
  const TYPE_MAX = 0.2; // 고양이 한 마리 타자 소리 최대 크기
  /**
   * 이벤트 → [소리 이름(FILES 키), 기본 재생 속도(음높이 배율, 1=원음), 음량(0~1)] 표.
   * play(event, breed) 가 여기서 소리를 고르고 품종 PITCH 와 무작위 ±4% 를 곱해 재생 속도를 정한다.
   * @type {Object<string, [string, number, number]>}
   */
  const EVENTS = {
    attention: ['soft', 1.0, 0.7], // 결재 줄 맨 앞에 섬
    happy: ['purr', 1.08, 0.8], // 승인
    sad: ['kitten', 0.78, 0.5], // 반려
    question: ['kitten', 1.0, 0.6], // 질문 팻말
    deliver: ['food', 1.0, 0.7], // 완료 배달 도착
    five: ['purr2', 1.1, 0.8], // 하이파이브
    error: ['soft', 0.82, 0.6], // 오류
    eat: ['purr2', 0.95, 0.85], // 간식을 받아 먹으며 그르렁
    roll: ['purr', 1.15, 0.85], // 간식을 받고 발라당
  };
  /**
   * 품종 → 목소리 높이 배율 표 (재생 속도에 곱함, 1=원음). 없는 품종은 1. 품종별 목소리 높이.
   * @type {Object<string, number>}
   */
  const PITCH = { korean_cheese: 1.04, korean_tuxedo: 0.94, siamese: 1.14, boss: 0.86, munchkin: 1.12, scottish_fold: 1.08, maine_coon: 0.88, norwegian_forest: 0.9, persian: 0.96, bengal: 1.0, sphynx: 1.1 }; // 품종별 목소리 높이
  /**
   * 초: 이 간격 안의 다음 울음(play)은 건너뜀. 같은 소리가 겹치지 않게 하는 전체 간격.
   * @type {number}
   */
  const GAP = 1.1; // 초: 이 간격 안의 다음 소리는 건너뜀

  /**
   * 모듈 상태: ctx = AudioContext(켤 때 load 가 만듦), master = 전체 음량 GainNode, enabled = 켜짐 여부, last = 마지막 울음 재생 시각(ctx.currentTime 초).
   */
  let ctx = null, master = null, enabled = false, last = -10;
  /**
   * 소리 이름 → 디코딩된 AudioBuffer. 불러오기에 실패한 소리는 없다.
   * @type {Object<string, AudioBuffer>}
   */
  const buffers = {};
  /**
   * 그르렁 반복 재생 중인 소리 (없으면 null).
   * @type {LoopVoice|null}
   */
  let purr = null; // { src, gain }

  /**
   * AudioContext 와 master 게인(0.5)을 만들고 FILES 의 소리를 모두 불러 디코딩한다.
   * 파일마다 실패해도 경고만 남기고 계속한다. setEnabled(true) 가 처음 켤 때 한 번 부른다.
   * @returns {Promise<void[]>} 모든 소리 불러오기가 끝나면 풀리는 Promise
   * @see setEnabled
   */
  function load() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    return Promise.all(Object.entries(FILES).map(async ([k, f]) => {
      try {
        const r = await fetch(BASE + f);
        buffers[k] = await ctx.decodeAudioData(await r.arrayBuffer());
      } catch (e) { console.warn('소리 불러오기 실패', f, e && e.message); }
    }));
  }

  /**
   * 켜기·끄기. 켤 때는 사용자 클릭 안에서 불러야 한다 (브라우저 자동 재생 제한)
   * 상태를 localStorage('office.sound')에 저장하고, 끄면 그르렁·반복음·타자 소리를 멈춘 뒤 ctx 를 중지한다.
   * 켜면 처음 한 번 load() 로 소리를 불러오고 ctx 를 재개한다.
   * @param {boolean} on true 면 켜기, false 면 끄기
   * @returns {Promise<void>}
   * @see load
   * @see stopPurr
   * @see stopLoops
   * @see stopTypers
   */
  async function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem('office.sound', enabled ? '1' : '0'); } catch (e) { /* 저장 못 해도 동작 */ }
    if (!enabled) { stopPurr(); stopLoops(); stopTypers(); if (ctx) ctx.suspend(); return; }
    if (!ctx) await load();
    await ctx.resume();
  }
  /**
   * 저장된 켜짐 설정을 읽는다 (localStorage 접근이 막히면 false).
   * @returns {boolean} 지난번에 소리를 켜 두었으면 true
   */
  function savedOn() { try { return localStorage.getItem('office.sound') === '1'; } catch (e) { return false; } }

  /**
   * pan: -1(왼쪽) ~ 1(오른쪽)
   * 이벤트에 맞는 울음을 한 번 재생한다. 꺼져 있거나 소리가 없거나 마지막 울음 뒤 GAP 초가 안 지났으면 건너뛴다.
   * 재생 속도 = 이벤트 기본 속도 × 품종 PITCH × (0.96~1.04 무작위), 음량은 이벤트 값, 좌우는 pan 으로 둔다.
   * @param {string} event EVENTS 의 키 (attention, happy, sad, question, deliver, five, error)
   * @param {string} breed 품종 키 (PITCH 로 음높이 보정, 모르면 1배)
   * @param {number} [pan=0] 좌우 -1(왼쪽) ~ 1(오른쪽)
   * @returns {void}
   */
  function play(event, breed, pan = 0) {
    if (!enabled || !ctx) return;
    const ev = EVENTS[event];
    if (!ev || !buffers[ev[0]]) return;
    if (ctx.currentTime - last < GAP) return;
    last = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffers[ev[0]];
    src.playbackRate.value = ev[1] * (PITCH[breed] || 1) * (0.96 + Math.random() * 0.08);
    const g = ctx.createGain();
    g.gain.value = ev[2];
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); src.connect(g).connect(p).connect(master); } else src.connect(g).connect(master);
    src.start();
  }

  /**
   * 마지막 효과음 재생 시각(ctx.currentTime 초). 0.12초 안의 연속 효과음은 건너뛴다.
   * @type {number}
   */
  let lastFx = -10;
  /**
   * 효과음 한 번 (vol 0~1 은 거리 감쇠, pan -1~1)
   * 꺼져 있거나 소리가 없거나 vol 이 0.02 이하이거나 직전 효과음 뒤 0.12초가 안 지났으면 건너뛴다.
   * 음량 = FX_VOL[name](기본 0.6) × min(1, vol), 재생 속도는 0.97~1.03 무작위.
   * @param {string} name 효과음 이름 (stamp, grounds, boil, clink)
   * @param {number} [vol=1] 거리 감쇠 음량 0~1
   * @param {number} [pan=0] 좌우 -1(왼쪽) ~ 1(오른쪽)
   * @returns {void}
   */
  function fx(name, vol = 1, pan = 0) {
    if (!enabled || !ctx || !buffers[name] || vol <= 0.02) return;
    if (ctx.currentTime - lastFx < 0.12) return;
    lastFx = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    const g = ctx.createGain();
    g.gain.value = (FX_VOL[name] || 0.6) * Math.min(1, vol);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); src.connect(g).connect(p).connect(master); } else src.connect(g).connect(master);
    src.start();
  }

  /**
   * 자판 소리용 상태: noise = 0.05초 백색잡음 버퍼(처음 쓸 때 만듦), keyWin = 현재 집계 구간 시작 시각, keyCount = 그 구간의 소리 수.
   * 자판 한 번 두들기는 소리 (합성: 짧은 딸깍 + 낮은 톡). vol 0~1, pan -1~1
   */
  let noise = null, keyCount = 0, keyWin = 0;
  /**
   * 자판 한 번 두들기는 소리 (합성: 짧은 딸깍 + 낮은 톡). vol 0~1, pan -1~1
   * 0.1초 구간에 6번까지만 소리 낸다 (여러 마리가 겹쳐도 시끄럽지 않게).
   * 딸깍은 백색잡음을 2.6~4.4kHz 대역통과로 걸러 0.035초 안에 줄이고, 톡은 220~280Hz 사인파가 110Hz 로 0.03초 만에 떨어지게 합성한다.
   * @param {number} [vol=1] 거리 감쇠 음량 0~1 (0.03 이하면 무시)
   * @param {number} [pan=0] 좌우 -1(왼쪽) ~ 1(오른쪽)
   * @returns {void}
   */
  function key(vol = 1, pan = 0) {
    if (!enabled || !ctx || vol <= 0.03) return;
    const now = ctx.currentTime;
    if (now - keyWin > 0.1) { keyWin = now; keyCount = 0; }
    if (++keyCount > 6) return; // 0.1초에 6번까지 (여러 마리가 겹쳐도 시끄럽지 않게)
    if (!noise) {
      noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const out = ctx.createGain();
    out.gain.value = 0.32 * Math.min(1, vol); // 바로 앞(vol 1)에서 또렷하게
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = Math.max(-1, Math.min(1, pan)); out.connect(p).connect(master); } else out.connect(master);
    // 딸깍: 잡음을 높은 대역으로 걸러 아주 짧게
    const n = ctx.createBufferSource(); n.buffer = noise;
    n.playbackRate.value = 0.8 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600 + Math.random() * 1800; bp.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.9, now); ng.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    n.connect(bp).connect(ng).connect(out);
    n.start(now); n.stop(now + 0.05);
    // 톡: 낮은 사인파가 빠르게 떨어짐 (키가 바닥에 닿는 소리)
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(220 + Math.random() * 60, now); o.frequency.exponentialRampToValueAtTime(110, now + 0.03);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, now); og.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    o.connect(og).connect(out);
    o.start(now); o.stop(now + 0.05);
  }

  /**
   * 타자 소리 중인 고양이 → { src, gain, p }. 새로 들어온 고양이는 재생 시작, 빠진 고양이는 줄이며 끈다.
   * @type {Object<string, LoopVoice>}
   */
  const typers = {};
  /**
   * 타자 녹음 A/B 를 번갈아 고르기 위한 순번.
   * @type {number}
   */
  let typerN = 0;
  /**
   * 고양이마다 타자 소리 (녹음 반복). srcs: { 고양이id: { vol 0~1, pan -1~1 } }
   * 목록에 새로 들어온 고양이는 재생 시작, 빠진 고양이는 줄이며 끈다.
   * 새 고양이는 녹음 A/B 를 번갈아 반복 재생(속도 0.92~1.08, 시작 위치 무작위)하고, 이미 있는 고양이는 음량(vol × TYPE_MAX)과 좌우를 0.15초에 걸쳐 따라가게 한다.
   * @param {TyperSrcs} srcs 지금 타자 치는 고양이들 (고양이 id → { vol, pan })
   * @returns {void}
   * @see stopTypers
   */
  function typing(srcs) {
    if (!enabled || !ctx) return;
    const now = ctx.currentTime;
    for (const [id, { vol, pan }] of Object.entries(srcs)) {
      let T = typers[id];
      if (!T) {
        const buf = buffers[(typerN++ % 2) ? 'typeB' : 'typeA'];
        if (!buf) continue;
        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        src.playbackRate.value = 0.92 + Math.random() * 0.16; // 고양이마다 빠르기 조금씩 다르게
        const gain = ctx.createGain(); gain.gain.value = 0;
        const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (p) src.connect(gain).connect(p).connect(master); else src.connect(gain).connect(master);
        src.start(0, Math.random() * buf.duration);
        T = typers[id] = { src, gain, p };
      }
      T.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, vol)) * TYPE_MAX, now, 0.15);
      if (T.p) T.p.pan.setTargetAtTime(pan, now, 0.15);
    }
    for (const id of Object.keys(typers)) {
      if (srcs[id]) continue;
      const T = typers[id];
      T.gain.gain.setTargetAtTime(0, now, 0.12);
      try { T.src.stop(now + 0.6); } catch (e) { /* 이미 멈춤 */ }
      delete typers[id];
    }
  }
  /**
   * 타자 소리를 모두 즉시 멈추고 목록을 비운다 (setEnabled(false) 가 부름).
   * @returns {void}
   */
  function stopTypers() { for (const id of Object.keys(typers)) { try { typers[id].src.stop(); } catch (e) { /* 이미 멈춤 */ } delete typers[id]; } }

  /**
   * 반복 재생 중인 환경음: 이름 → { src, gain }.
   * @type {Object<string, LoopVoice>}
   */
  const loops = {};
  /**
   * 환경음 크기 (0~1). levels: { birds, river }
   * 이름마다 반복 재생을 처음 필요할 때(음량 0.01 초과) 시작하고, 이후 목표 음량(v × AMB_MAX)을 0.6초에 걸쳐 따라가게 한다.
   * @param {AmbientLevels} levels 환경음 이름 → 0~1 음량
   * @returns {void}
   */
  function ambient(levels) {
    if (!enabled || !ctx) return;
    for (const [k, v] of Object.entries(levels)) {
      if (!buffers[k]) continue;
      let L = loops[k];
      if (!L) {
        if (v <= 0.01) continue;
        const src = ctx.createBufferSource();
        src.buffer = buffers[k];
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain).connect(master);
        src.start(0, Math.random() * buffers[k].duration);
        L = loops[k] = { src, gain };
      }
      L.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)) * (AMB_MAX[k] || 0.3), ctx.currentTime, 0.6);
    }
  }
  /**
   * 환경음을 모두 즉시 멈추고 목록을 비운다.
   * @returns {void}
   */
  function stopLoops() { for (const k of Object.keys(loops)) { try { loops[k].src.stop(); } catch (e) { /* 이미 멈춤 */ } delete loops[k]; } }

  /**
   * 자는 고양이 근처를 확대해 보면 그르렁 (near: 0~1)
   * near 가 0.01 이하면 음량을 0 으로 줄이고(재생은 유지), 그보다 크면 반복 재생을 시작해 음량(near × 0.45)을 0.3초에 걸쳐 따라가게 한다.
   * @param {number} near 자는 고양이에 가까운 정도 0~1
   * @returns {void}
   * @see stopPurr
   */
  function setPurr(near) {
    if (!enabled || !ctx || !buffers.purrLoop) return;
    if (near <= 0.01) { if (purr) purr.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3); return; }
    if (!purr) {
      const src = ctx.createBufferSource();
      src.buffer = buffers.purrLoop;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(master);
      src.start();
      purr = { src, gain };
    }
    purr.gain.gain.setTargetAtTime(Math.min(1, near) * 0.45, ctx.currentTime, 0.3);
  }
  /**
   * 그르렁 소리를 멈추고 상태를 비운다.
   * @returns {void}
   */
  function stopPurr() { if (purr) { try { purr.src.stop(); } catch (e) { /* 이미 멈춤 */ } purr = null; } }

  /**
   * 공개 API. isOn 은 소리가 지금 켜져 있는지 돌려주는 함수 () => boolean 이다.
   * @see setEnabled
   * @see savedOn
   * @see play
   * @see fx
   * @see key
   * @see typing
   * @see ambient
   * @see setPurr
   */
  return { setEnabled, savedOn, play, fx, key, typing, ambient, setPurr, isOn: () => enabled };
})();
