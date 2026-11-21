/* U-Tapao PMIS Mobile — 앱 화면(웹 번들) 버전 정보
 * - build: 화면 묶음 일련번호(정수). 서버의 최신 build 보다 작으면 자동 업데이트 대상
 * - label: 표시용 버전
 * - minNative: 이 화면이 동작하는 최소 설치형 앱 빌드 번호(versionCode). 새 휴대폰 기능(플러그인·권한)이
 *              들어간 화면을 배포할 때만 올린다. 설치 앱이 이보다 낮으면 "새 앱 설치" 안내만 표시
 * ⚠️ 직접 고치지 말고 mobile_app/tools/publish_web_update.js 로 올린다 (zip·Drive 업로드와 함께 갱신)
 */
window.PMIS_WEB_BUNDLE = { build: 3, label: '0.9.3-w3', minNative: 0 };
