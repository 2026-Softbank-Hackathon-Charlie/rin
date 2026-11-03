# Rin이 쓰는 계정과 비밀값

Rin이 외부 서비스에 접근할 때 쓰는 신원을 모두 여기에 적는다. 새 계정이나 토큰을 붙이면 이 파일에 한 줄을 더하는 것이 절차다.

## 규칙

- 비밀값은 SSM Parameter Store `/rin/<KEY>`(서울, SecureString)에 둔다. 배포할 때 `deploy/ec2/deploy.sh`가 `/rin/*`를 모두 컨테이너 환경 변수로 옮기므로, 키를 넣고 재배포하면 바로 쓰인다. 넣을 때는 `deploy/aws/put-secrets.sh`를 쓴다.
- 작업 공간, 메모리, `CLAUDE.md`, Slack, Notion에는 비밀값을 두지 않는다.
- Rin 전용 신원을 따로 만들고 권한은 읽기 전용부터 준다. 쓰기 권한은 필요할 때 따로 만들고, 요청자가 명시했을 때만 쓰도록 guard를 건다.
- 가능하면 만료일을 둔다. 해커톤이 끝나면 아래 표의 폐기 방법대로 모두 정리한다.

## 외부 서비스

| 서비스 | 신원 | 권한 | SSM 키 | Claude에게 | 만료 | 폐기 방법 |
| --- | --- | --- | --- | --- | --- | --- |
| Anthropic | API 키 | Claude 호출, 월 한도 200달러 | `ANTHROPIC_API_KEY` | 환경 변수로 준다 | 없음 | Anthropic Console에서 키 삭제 |
| Slack | 앱 Rin(봇 토큰, Socket Mode 앱 토큰) | app_mentions:read, chat:write, reactions:write, groups:history, im:history, im:write, files:read, files:write | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | 주지 않는다. Rin 도구로만 쓴다 | 없음 | api.slack.com/apps에서 앱 삭제 |
| GitHub | App charlie-rin(App ID 5581776), 조직의 모든 레포에 설치 | contents, pull_requests, actions, checks, statuses, workflows, issues, secrets, actions variables, organization projects 쓰기, metadata, members 읽기 | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_B64` | 1시간짜리 설치 토큰만 `GH_TOKEN`으로 준다 | 없음(설치 토큰은 1시간) | 조직 설정에서 설치 해제, 앱 삭제 |
| AWS | IAM 사용자 `rin-ai` | ViewOnlyAccess, 비밀값 읽기는 명시적으로 거부 | `RIN_AI_AWS_ACCESS_KEY_ID`, `RIN_AI_AWS_SECRET_ACCESS_KEY` | 환경 변수로 준다 | 없음 | `deploy/aws` Terraform에서 사용자와 키 제거 |
| Notion | 조서현 계정의 OAuth(hosted Notion MCP) | 조서현이 볼 수 있는 페이지 전부. 삭제와 이동 도구는 막았다 | 없음. EC2 `/srv/rin/data/claude`에 있다 | Claude Code가 직접 쓴다. 샌드박스에 마운트되는 폴더라 Claude가 읽을 수 있다 | 갱신이 실패하면 다시 로그인 | Notion 설정의 연결된 앱에서 해제 |
| Cloudflare | 팀 Cloudflare 계정에서 만든 user token | `hopcharlie.dev` zone의 Zone, DNS, SSL and Certificates, Analytics 읽기, 계정의 Account Settings, Cloudflare Tunnel 읽기 | `CLOUDFLARE_API_TOKEN` | 주지 않는다. Rin 도구로만 쓴다 | 2026-11-09 23:59 KST | Cloudflare My Profile > API Tokens에서 삭제 |

## 내부 비밀값

- `POSTGRES_PASSWORD`: Rin이 쓰는 Postgres의 비밀번호다. Terraform이 만든다.
- `rin_reader` 비밀번호: 따로 저장하지 않는다. worker가 시작할 때 `POSTGRES_PASSWORD`에서 HMAC으로 만들어 역할에 설정하고, Claude에게는 `PGUSER`, `PGPASSWORD` 등 libpq 환경 변수로 준다(`src/db/reader.ts`). 역할은 `public` 스키마 테이블의 SELECT만 가진다.

## 실행 격리

Claude Code는 실행마다 worker가 띄우는 샌드박스 컨테이너에서 돈다(`src/worker/sandbox.ts`). 샌드박스가 받는 것은 위 표에서 "환경 변수로 준다"로 적은 값(Anthropic API 키, GitHub 설치 토큰, `rin-ai` 키, `rin_reader` 로그인)과 `/data`(작업 공간, Claude Code 설정과 Notion 로그인, `/data/tools`)뿐이다. "주지 않는다"로 적은 Slack 토큰, GitHub App 개인 키, Cloudflare 토큰과 `POSTGRES_PASSWORD`는 worker 컨테이너에만 있다.

- 샌드박스 안에서 Claude는 sudo를 쓸 수 있다. 샌드박스에는 Docker 소켓이 없고, EC2 메타데이터 응답의 hop 제한이 1이라서 인스턴스 역할도 쓸 수 없다.
- worker는 샌드박스를 띄우기 위해 호스트의 Docker 소켓을 가진다. 그래서 worker 안에서 코드가 실행되면 호스트 root를 얻은 것과 같다. worker는 Claude가 쓴 파일을 실행하지 않는다. worker가 git을 실행하는 `repos/`는 샌드박스에 읽기 전용으로 마운트하고, worktree는 독립 clone으로 만든 뒤 그 안에서는 git을 실행하지 않는다.
- 남은 한계: Anthropic API 키와 `/data/claude`의 Notion OAuth 토큰은 Claude가 읽을 수 있다. 로컬 개발(`compose.dev.yaml`)에는 샌드박스가 없어서 Claude가 worker 컨테이너 안에서 돈다.
