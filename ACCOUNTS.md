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
| GitHub | App charlie-rin(App ID 5581776), 조직의 모든 레포에 설치 | contents, pull_requests, actions, checks, statuses, workflows 쓰기, metadata 읽기 | `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_B64` | 1시간짜리 설치 토큰만 `GH_TOKEN`으로 준다 | 없음(설치 토큰은 1시간) | 조직 설정에서 설치 해제, 앱 삭제 |
| AWS | IAM 사용자 `rin-ai` | ViewOnlyAccess, 비밀값 읽기는 명시적으로 거부 | `RIN_AI_AWS_ACCESS_KEY_ID`, `RIN_AI_AWS_SECRET_ACCESS_KEY` | 환경 변수로 준다 | 없음 | `deploy/aws` Terraform에서 사용자와 키 제거 |
| Notion | 조서현 계정의 OAuth(hosted Notion MCP) | 조서현이 볼 수 있는 페이지 전부. 삭제와 이동 도구는 막았다 | 없음. EC2 `/srv/rin/data/claude`에 있다 | Claude Code가 직접 쓴다 | 갱신이 실패하면 다시 로그인 | Notion 설정의 연결된 앱에서 해제 |
| Cloudflare | 팀 Cloudflare 계정에서 만든 user token | `hopcharlie.dev` zone의 Zone, DNS, SSL and Certificates, Analytics 읽기, 계정의 Account Settings, Cloudflare Tunnel 읽기 | `CLOUDFLARE_API_TOKEN` | 주지 않는다. Rin 도구로만 쓴다 | 2026-11-09 23:59 KST | Cloudflare My Profile > API Tokens에서 삭제 |

## 내부 비밀값

- `POSTGRES_PASSWORD`: Rin이 쓰는 Postgres의 비밀번호다. Terraform이 만든다.

## 알려진 한계

Claude는 worker와 같은 컨테이너에서 같은 사용자(node)로 돈다. 그래서 Claude가 Bash로 `/proc/1/environ`을 읽으면, 위 표에서 "주지 않는다"로 적은 값도 볼 수 있다(2026-11-03에 EC2에서 확인했다). "주지 않는다"는 평소 실행에서 쓰이거나 출력되지 않는다는 뜻일 뿐, 공격을 막는 경계가 아니다. 지금 실제로 막아 주는 것은 토큰마다 좁힌 권한과 만료일이다.
