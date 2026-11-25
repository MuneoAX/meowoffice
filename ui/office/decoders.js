/**
 * @file 3D 압축 해제기 위치 지정 (babylon.js 뒤, 모델을 부르기 전에 로드).
 * - glb: EXT_meshopt_compression → ui/vendor/babylon-decoders/meshopt_decoder.js (wasm 이 들어 있는 스크립트)
 * 기본값은 cdn.babylonjs.com 이라, 오프라인·CSP(connect/script-src 'self') 에서 안 돌아간다 → 앱에 묶은 로컬 파일을 가리킨다.
 * (wasm 실행에는 CSP script-src 'wasm-unsafe-eval' 이 필요하다. src-tauri/tauri.conf.json. eval 은 필요 없다)
 * 품종 털 무늬는 WebP(브라우저 내장 디코더)라 별도 해제기가 없다.
 */
(() => {
  const abs = (p) => new URL('../vendor/babylon-decoders/' + p, document.baseURI).href;
  BABYLON.MeshoptCompression.Configuration.decoder.url = abs('meshopt_decoder.js');
})();
