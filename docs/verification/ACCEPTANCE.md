# Thor acceptance and evidence

이 문서는 공개 환경에서 수행 가능한 검증의 체크리스트다. **체크리스트 작성, 소스 존재, 테스트 작성은 합격 증거가 아니다.** 아래 항목은 모두 `NOT_RUN`으로 시작한다. 실제 실행 후 증거와 함께 상태를 바꾼다. 독립 기획·패치 검토는 사용자의 최종 제품 검수를 대신하지 않는다.

상태: `NOT_RUN` / `PASS` / `FAIL` / `BLOCKED_EXTERNAL` / `NOT_APPLICABLE`.

- `PASS`: 지정한 관찰 결과와 해당 빌드의 증거가 모두 있음.
- `BLOCKED_EXTERNAL`: 필요한 사내 접근·계정·인증서 등 외부 조건과 미검증 범위를 명시함. 합격으로 집계하지 않음.
- `NOT_APPLICABLE`: 해당 버전이 기능을 지원하지 않는 이유와 사용자에게 표시되는 제한을 명시함. 핵심 요구를 임의로 제외하는 용도로 사용하지 않음.
- 제품·계약·모의 서버·실제 서비스 검증을 서로 구분한다. 예를 들어 mock agent 통과는 실제 Claude wrapper의 사내 호환성을 증명하지 않는다.

## 먼저 차단할 release/security 실패

다음 중 하나라도 확인되면 해당 변경의 공개 배포를 보류하고 수정 후 재검증한다.

- 실제 토큰·쿠키·사내 주소·문서·개인 경로·원문 로그가 Git, Actions 로그, release asset, 앱 피드백에 포함됨.
- 실패·취소·검증하지 않은 작업을 완료로 표시하거나, 원격 쓰기 결과가 불명인데 무조건 재실행함.
- 업데이트가 프로젝트·설정·기억·사용자 확장을 유실시키거나 설치 폴더에 사용자 상태를 보관함.
- 변조·허용되지 않은 출처의 업데이트가 검증 없이 설치됨. updater용 비밀키·배포 토큰이 앱에 포함됨.
- 미리보기 또는 비신뢰 웹 입력이 host의 파일·인증·실행 권한에 접근함. 원시 쿠키가 모델 입력으로 전달됨.
- 실제 설치·앱 실행·앱 피드백 대신 개발 서버·CLI 직접 호출·별도 API 요청만 실행하고 제품 검증 완료로 보고함.

Microsoft가 신뢰하는 Authenticode 인증서가 없으면 서명 검증을 `PASS`로 표시하지 않는다. **명시적으로 표시한 미서명 preview**의 설치·기능 검증과, 신뢰된 게시자의 배포 검증은 별도 결과다. 미서명이라는 제한이 해시 검증·업데이트 출처 제한·데이터 보존 검사를 면제하지 않는다.

## 실행별 증거 양식

공개 가능한 증거는 합성 데이터와 정제한 내용만 저장한다. 실제 내부 자료·인증값·원문 네트워크 기록은 저장소 밖의 승인된 장소에 보관한다. 사용자 경로는 `%APPDATA%`, `<workspace>` 등으로 치환한다. 정제한 증거에도 기능 시험의 판단 근거는 남겨야 한다.

```yaml
run_id: <unique-id>
date_utc: <timestamp>
reviewer: <role-or-handle>
product_version: <version>
source_commit: <full-sha>
build:
  actions_run_url: <url-or-local-build-reason>
  release_url: <url-or-not-yet-released>
  installer_name: <filename>
  installer_sha256: <sha256>
  authenticode_status: <observed-status>
  publisher: <observed-publisher-or-unsigned>
components:
  aionui_commit: <sha>
  aioncore_tag: <tag-required-by-ui>
  aioncore_commit: <sha>
  officecli_version_hash: <version-and-hash>
  adapter_runtime_versions: <versions>
  contract_state_schema: <versions>
environment:
  windows_version_arch: <version-and-arch>
  install_kind: <clean-vm-or-existing-user-profile>
  permissions: <standard-user-or-admin>
  agent_mode: <mock-or-real-runtime-name>
  service_mode: <synthetic-mcp-or-actual-service>
case:
  id: <Pxx-or-Xxx>
  status: <NOT_RUN|PASS|FAIL|BLOCKED_EXTERNAL|NOT_APPLICABLE>
  preconditions: <required-data-and-state>
  actions: <reproducible-actions>
  expected: <observable-result>
  observed: <actual-result>
  evidence: <sanitized-report-screenshot-log-or-issue-url>
  limitations: <what-this-run-does-not-prove>
  defect_issue: <url-or-none>
  retest_run: <id-or-none>
```

아래 표의 상태와 실행 기록을 연결한다. 다른 commit에서의 증거를 현재 빌드의 증거로 합치지 않는다. 필요한 회귀 검사는 변경 범위에 맞춰 다시 실행한다.

0.1.0의 최신 설치·공개 릴리즈·앱 피드백 관찰은 [implementation-status.md](implementation-status.md)와 [public-windows-0.1.0.json](public-windows-0.1.0.json)에 기록했다. 일반 사용자 설치, 설치 파일 비교, 준비된 Thor 창, Codex 연결 버튼, 앱에서 연 브라우저의 실제 이슈 생성과 앱 URL 재확인은 통과했다. P02의 프로젝트 재시작 보존, P15의 오류·응답 유실 경로는 아직 실행하지 않아 해당 항목 전체를 PASS로 바꾸지 않는다. P13의 0.1.0 source→CI→공개 자산 검증은 통과했다. 설치된 앱의 메일 샘플 등록은 [이슈 #7](https://github.com/bitboom/thor/issues/7)로 실패를 기록했으며, 0.1.1 수정·릴리즈·앱 업데이트 검증 전까지 P16은 완료되지 않았다. 아래 표의 미실행 상태는 이러한 부분 통과를 해당 항목 전체의 통과로 확대하지 않는다는 뜻이다.

## 공개 환경에서 완료할 항목

| ID / 현재 상태 | 실행과 관찰 가능한 합격 기준 | 필요한 증거 |
|---|---|---|
| P01 `NOT_RUN` 독립 제품·버전 | `desktop`/`host`/`agent` 경계와 upstream 출처·라이선스·수정 기록이 존재한다. UI가 요구하는 AionCore tag/commit으로 실제 빌드한다. main SHA 두 개만 고정한 것을 호환 조합 증명으로 취급하지 않는다. | source/component manifest, build 결과, CI URL |
| P02 `NOT_RUN` 실제 Windows 설치 | Actions가 만든 installer를 일반 사용자로 설치하고 Thor 창을 실제로 연다. 설치된 exe 경로·버전이 release와 일치한다. 새 프로젝트 생성→종료→재실행으로 보존 확인. 깨끗한 Windows·한글/공백 경로 시험은 기존 개발 PC 성공과 별도로 기록한다. | installer SHA, 설치/실행 화면, OS·권한, 상태 전후 |
| P03 `NOT_RUN` 실제 agent | 사용자가 허용한 기존 로컬 로그인 runtime으로 설치된 Thor에서 합성 작업을 실행해 도구 사용과 파일 결과를 확인한다. stream·취소·재시작 후 resume를 각각 시험한다. mock만 연결된 경우 실제 agent 합격으로 표시하지 않는다. 인증 파일·토큰을 prompt나 로그로 옮기지 않는다. | runtime/version, task/run ID, 실제 결과, 취소·재개 기록 |
| P04 `NOT_RUN` BYO agent 계약 | 같은 desktop·업무층을 수정하지 않고 실제 adapter와 두 번째 mock adapter를 교체한다. 시작·이벤트·승인 응답·취소·결과 표시와 지원 capability를 확인한다. 기존 실행은 원래 adapter로 재개하고 미지원 기능은 명시한다. | 계약 시험, UI 실행 증거, 변경 없는 계층 확인 |
| P05 `NOT_RUN` desktop 교체 경계 | UI 없는 별도 client가 동일 host에서 작업 생성·시작·이벤트 수신·승인 응답·취소·재연결·결과와 기억 조회를 수행한다. host/agent 구현 수정 없이 작동한다. 조회만 되는 client로 전체 교체를 증명하지 않는다. | client 시험과 이벤트 기록, 동일 프로젝트 ID |
| P06 `NOT_RUN` 실제 MCP 프로토콜 | 선언한 transport로 합성 MCP server를 띄우고 initialize, tools/list, tools/call, pagination, timeout, 재연결, 잘못된 인증을 시험한다. JSON fixture를 함수에 직접 넣는 시험과 실제 transport 시험을 구분한다. 합성 메일 조회→첨부 읽기→결과 파일이 연결된다. | server/client 계약 시험, 정제 trace, fixture 해시 |
| P07 `NOT_RUN` Office preview | 고정한 OfficeCLI를 설치본에서 실행해 DOCX/XLSX/PPTX를 연다. 한글·표·차트·병합 셀·이미지·슬라이드 사례를 확인한다. 파일 변경 뒤 active/pinned 화면이 갱신된다. read-only의 UI와 서버는 쓰기를 막고, 편집 모드는 충돌·저장·복사본·원본 보존을 검증한다. 실패 진단·포트 충돌·탭 종료/업데이트 시 watch 정리를 확인한다. | fixture·전후 해시, 화면, 프로세스 정리·외부 요청 기록 |
| P08 `NOT_RUN` Office 결과 | 합성 DOCX/XLSX/PPTX 각각 3종의 지정 부분을 복사본에 수정한다. 원본 보존, 수식·표·차트 등 사례별 미변경 요소를 검사한다. 실제 Microsoft Office가 있으면 복구 경고·값·렌더링을 확인한다. 없으면 구조/preview 검증만 기록하고 native Office 검수는 별도 미검증으로 남긴다. | expected/actual, 파일 해시·구조 비교, Office 버전 또는 제한 |
| P09 `NOT_RUN` HTML·로컬 권한 | 설치본에서 HTML 결과를 생성해 브라우저에서 표·필터·재열기를 확인한다. preview의 Node/host secret/파일 접근과 미승인 외부 요청을 차단한다. 비신뢰 origin의 local host/Office endpoint 접근도 검사한다. 임의 shell/file 도구가 승인·경로 경계를 우회하는지 부정 시험한다. | 합성 정상/악성 fixture, 차단 결과·정제 네트워크 증거 |
| P10 `NOT_RUN` 지속 실행·복구 | 50단계 이상 합성 작업과 일시 오류를 시험한다. 실행 전·중·결과 저장 경계 3곳에서 프로세스를 강제 종료하고 재개한다. 완료 조건을 실제 검증한다. 실패·취소·예산·인증 대기를 완료로 표시하지 않고 무진전 반복의 사유·checkpoint를 남긴다. 50은 제품 제한이 아니다. | fault 위치, 원장, 재개와 결과 비교 |
| P11 `NOT_RUN` 외부 부작용 | 합성 원격 쓰기에서 실행 전 원장 기록, 원격 반영 후 응답 유실, 응답 후 로컬 기록 전 단절을 시험한다. idempotency 지원은 실제 원격 반영 1건, 미지원은 조회 또는 `unknown` 보류. 취소가 진행 중인 원격 쓰기를 취소했다고 간주하지 않는다. | 원격 건수·operation ID·fault trace·재개 판정 |
| P12 `NOT_RUN` 메모리·상태 | 합성 사실/선호 20개 저장→5회 재시작→10개 회상 질문→5개 수정/삭제→재색인. 최신값·프로젝트 격리·삭제 유지·출처를 확인한다. 소스/설치 폴더 밖에 상태를 보관하고 UI·agent 교체로 상태가 사라지지 않는다. | 기대값/실제값, redacted state location, 재색인 결과 |
| P13 `NOT_RUN` GitHub CI·release | `bitboom/thor`의 정확한 commit에서 Actions가 빌드·시험한 asset을 release한다. manifest·hash·버전·필수 asset이 맞는다. 라이선스/NOTICE를 유지하고 repo/Actions/assets에 secret·개인 자료가 없다. 공개 PR에 사내 secret/runner를 연결하지 않는다. | commit, Actions URL, release URL, asset SHA·검사 결과 |
| P14 `NOT_RUN` 앱 업데이트·복구 | 실제 설치본 n→n+1→n+2를 앱 버튼으로 업데이트한다. 프로젝트 파일 해시·설정·기억·확장을 보존한다. 다운로드 단절·잘못된 hash/서명·허용되지 않은 feed/채널·disk 부족·migration 도중 종료를 시험한다. 활성 작업을 checkpoint하고 호환 조합을 유지한다. 구 binary가 새 DB를 조용히 열지 않는다. | 각 installer와 버전, 버튼/재실행 화면, 상태 비교, 실패 복구 |
| P15 `NOT_RUN` 앱 피드백→Issue | 설치된 앱의 피드백 화면에서 합성 문제와 정제 로그를 검토해 실제 GitHub Issue를 생성한다. preview=payload, Issue URL/report ID 저장, 원격 이슈 본문 일치를 확인한다. 토큰·쿠키·메일·내부 URL·개인 경로 canary 0건. 응답 유실·403·rate limit에서는 초안 보존·중복 방지를 확인한다. gh/API 직접 등록만으로 앱 흐름을 대체하지 않는다. | 앱 화면, 정제 payload, 실제 Issue URL·본문 확인, canary 검사 |
| P16 `NOT_RUN` 실제 피드백 수정 루프 | P15의 실제 이슈를 직접 읽고 재현한다. 제품 결함이면 수정 commit과 적절한 회귀시험을 이슈에 연결하고 다음 Actions→release→앱 업데이트로 수정 확인한다. 실제 결함이 없으면 합성 개선 요청임을 표시하며 실제 장애를 발견했다고 꾸미지 않는다. | Issue, 수정 commit/PR, 다음 Actions·release, 설치본 재검증 |
| P17 `NOT_RUN` 공개 종단 작업 | 설치된 Thor에서 합성 메일 MCP 첨부→Office/HTML 결과→종료·재개→기억 질의→피드백 흐름을 수행한다. 개별 도구 결과가 아닌 실제 설치 앱 전체 흐름의 기대값을 확인한다. public workflow와 사내 workflow 판정은 분리한다. | 재현 절차, task ID, 산출물·출처, 화면·회상 결과 |

P02/P03/P07/P14/P15/P17의 UI 관찰은 소스 unit test만으로 대체할 수 없다. P13/P15/P16은 실제 GitHub 결과가 있어야 한다. P06은 실제 MCP transport를 거쳐야 한다. 성공 경로와 오류·재개 경로를 같은 의미로 묶지 않는다.

## 외부 조건이 있어야 검증 가능한 항목

| ID / 초기 상태 | 필요한 조건 | 공개 검증과의 차이 |
|---|---|---|
| X01 `BLOCKED_EXTERNAL` 사내 Claude wrapper | 기존 실행 명령/설정과 실제 사내 model deployment 접근 | 공개 runtime이나 mock 성공은 기존 wrapper의 사내 stream·MCP·cancel·resume·업데이트 회귀를 증명하지 않음 |
| X02 `BLOCKED_EXTERNAL` 메일·DRM | 실제 사내 MCP·정상/거부/만료 첨부·감사/평문 정책 | 합성 MCP/DRM 응답은 실제 권한·복호화·임시 평문 처리를 증명하지 않음 |
| X03 `BLOCKED_EXTERNAL` 사이트 skill | 기존 Confluence/Jira cookie skill과 승인된 테스트 구역 | 합성 cookie/401 시험은 실제 로그인·세션 만료·권한·쓰기 경로를 증명하지 않음 |
| X04 `BLOCKED_EXTERNAL` 사내 네트워크 | 회사 CA/proxy/EDR와 실제 승인 PC | 일반 Windows 성공은 회사 배포·네트워크 정책 적용을 증명하지 않음 |
| X05 `BLOCKED_EXTERNAL` 신뢰된 Windows 서명 | 유효한 Authenticode 서명 수단·게시자 확인 | 해시 검증 또는 미서명 preview 설치를 신뢰된 게시자 서명 검증으로 표현하지 않음 |
| X06 `NOT_RUN` Microsoft Office 검수 | 실제 Office 설치·지원 버전·합성 대표 문서 | 로컬 Office 사용 가능 여부를 먼저 확인. 없으면 외부 조건으로 기록; XML/preview만으로 편집 충실도 완료를 선언하지 않음 |
| X07 `BLOCKED_EXTERNAL` 내부 대표 업무 | 내부 담당자의 기대값·허용된 실제 데이터·최종 사용자 검수 | P17은 공개 종단 흐름이며 실제 업무 3건의 정확성과 누락 여부를 증명하지 않음 |

차단 조건이 해결되면 같은 ID로 실제 실행 증거를 추가한다. 공개 릴리즈 설명에는 `PASS`의 범위와 미검증 항목을 함께 적는다. 일부 외부 항목이 막혔다고 공개 환경에서 가능한 나머지 검증을 중단하지 않는다.

## 독립 패치 검토 기록

검토자는 구현 코드를 직접 바꾸지 않고 아래 형식으로 finding을 전달한다. 코드 결함과 아직 시험하지 않은 사실을 구분한다.

```text
Finding ID / severity:
File and line:
Trigger / precondition:
Observed code or runtime evidence:
User-visible impact:
Required change or verification:
Relevant acceptance IDs:
Resolution commit and retest evidence:
```

발견 사항이 없으면 검토 범위와 실행하지 않은 검증을 짧게 남긴다. 테스트가 통과해도 실제 실행하지 않은 설치·업데이트·사내 경로까지 합격으로 확대하지 않는다.
