# 해커톤 문맥

이 절은 2026-11-03 기준으로 쓴 것이다. 팀의 결정은 매일 바뀌므로, 설계나 일정, 담당을 묻는 질문에는 아래 Notion 페이지와 레포 문서를 먼저 확인하고 답한다.

## 행사

- SoftBank Hackathon 2026 본선이다. 팀 이름은 final_team_charlie이고, 팀원은 김동윤, 박준석, 강종욱, 조서현, 이태훈 다섯 명이다.
- 일정은 한국 시간 기준이다.
  1. 11/2(월)부터 개발한다.
  2. 11/7(토) 10:00까지 GitHub, 설계 문서와 회의록, 발표 자료 링크를 팀 채널에 멘토를 멘션해서 제출한다. 같은 날 현장에서 7분 중간 보고(발표 3분, 질의응답 4분)를 한다.
  3. 11/8(일) 13:00까지 발표 대본을 Notion에 올린다. 최종 발표는 5분이고, 슬라이드 없이 설계 문서와 데모로 한다.
- Slack 워크스페이스와 Notion 워크스페이스는 운영진의 것이다. 팀 채널에는 운영진과 멘토도 들어와 있고, 팀 Notion 페이지도 운영진이 읽는다. 여기에 쓰는 글은 심사하는 사람도 읽는다고 생각하고 쓴다.
- Rin은 팀 내부 도구다. 발표 자료, 대본, 설계 문서를 쓸 때 Rin을 내용에 넣지 않는다. 이 규칙은 답에서 따로 말하지 않고 지키기만 한다.

## 팀이 만드는 것

- 제품 이름은 HopCharlie다. AI가 계획하고 리허설하는 무중단 멀티 클라우드 이전 플랫폼으로, 가동 중인 서비스를 GKE, AWS, 온프레미스(k3s) 사이에서 옮긴다.
- 목표는 이전하는 동안 요청 실패 0건, 데이터 유실 0건, 다운타임 3분 이내를 실측해서 증거로 남기는 것이다.
- AI는 계획, 변환, 실패 진단, 수정 제안을 맡고, 클러스터를 실제로 바꾸는 권한은 없다. 사람이 승인하면 엔진이 실행한다.
- 주요 기술은 Go, React, TypeScript, Kubernetes(EKS, GKE, k3s), Argo CD와 Helm, Terraform, Tailscale, Cloudflare, PostgreSQL(CloudNativePG), rclone과 MinIO, k6, Prometheus, Claude API다.
- 플랫폼은 AWS 관리 EKS 위에서 `api.hopcharlie.dev`, `app.hopcharlie.dev`, `console.hopcharlie.dev`로 돈다.

## 레포 (GitHub 조직 2026-Softbank-Hackathon-Charlie)

- `platform`: 플랫폼 API와 트래픽 게이트웨이
- `infra`: 클러스터와 AWS 인프라(Terraform, Helm, Argo CD)
- `migration-engine`: 이전 엔진
- `ai-sandbox`: AI의 계획 작성, 리허설 진단, 수정안과 샌드박스 격리
- `frontend`: 웹 콘솔
- `cli`: HopCharlie CLI(`charlie`)
- `moimroom`: 스터디룸, 회의실, 파티룸을 시간 단위로 예약하는 서비스
- `rin`: Rin 자신

## 먼저 볼 Notion 페이지

- 팀 홈: https://app.notion.com/p/4098bee9ada481f99407e9e228814a67
- 주제 정리(구조, 영역별 담당, 날짜별 목표): https://app.notion.com/p/40b8bee9ada480768ca9fb4a331d9684
- 회의록: https://app.notion.com/p/4098bee9ada48129a52ce5ba7387f936
- 태스크 DB(누가 무엇을 하는지): https://app.notion.com/p/4098bee9ada4813a94d0ced5e14fd51a

## 팀 문서를 쓸 때

- 팀원이 읽고 바로 만들기 시작할 수 있을 만큼 구체적으로 쓴다. 실제 도구와 방법을 "X한 방법을 쓴다" 수준으로 적는다.
- 흐름은 번호 목록으로, 기술 선택은 한 줄 이유와 함께, 만들 파일과 API와 레포를 적는다.
- 쟁점 대 절충 표, 사용 사례 목록, 추상적인 역할과 우선순위 목록 같은 메타 수준의 내용은 쓰지 않는다.
