# rin

팀 채널 `#final_team_charlie`와 DM에서 부르는 Claude Code 에이전트다. 계획 문서는 Notion의 "Rin: 팀 슬랙 에이전트 봇 계획"에 있다.

## 부르는 방법

- 팀 채널: `@Rin 할 일`. 스레드 안에서도 멘션이 있어야 한다.
- DM: Rin에게 바로 메시지를 보낸다. Rin은 그 메시지의 스레드에 답하고, 그 스레드에서는 멘션 없이 대화를 이어 간다.
- `@Rin 모델`, `@Rin 모델 claude-opus-5-5`: 지금 모델을 보거나 바꾼다. DM에서는 `모델`만 쓴다.
- 실행 중인 작업은 상태 메시지의 취소 버튼으로 멈춘다.

## 구성

| 프로세스 | 하는 일 |
| --- | --- |
| gateway (`src/gateway`) | Slack Socket Mode로 채널 멘션, DM, 버튼 클릭을 받는다. 팀원 5명만 받고, 요청을 작업 큐에 넣는다. |
| worker (`src/worker`) | 큐에서 작업을 꺼내 Claude Agent SDK로 실행한다. 동시 실행은 최대 4개다. 상태 메시지에 로그 꼬리와 취소 버튼을 보여 주고, 결과를 스레드에 올린다. 예약 작업을 30초마다 큐에 넣고, 조직 레포를 `repos/`에 최신으로 맞춘다. |

두 프로세스는 Postgres(`jobs`, `threads`, `worktrees`, `schedules`, `settings`)로만 이어진다. 모든 실행은 같은 작업 공간(`RIN_WORKSPACE`)을 cwd로 써서 CLAUDE.md, 스킬, 메모리를 공유한다.

Claude가 쓰는 Rin 도구(`mcp__rin__*`)는 `src/agent/tools.ts`에 있다.

| 도구 | 하는 일 |
| --- | --- |
| `slack_read_thread`, `slack_list_messages`, `slack_search_messages` | 팀 채널의 이전 대화를 읽고 찾는다. 결과는 자료로 감싼다. |
| `slack_send_dm` | 팀원에게 DM을 보낸다. 팀원 밖에는 보내지 않는다. |
| `worktree_create` | 코드 수정용 worktree를 `rin/<id>` 브랜치로 만든다. 스레드마다 같은 worktree를 이어 쓴다. |
| `schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete` | 예약 작업을 관리한다. cron(KST) 또는 한 번만 실행할 ISO 시각을 쓴다. |

## Slack 앱 설정

앱 manifest에 아래가 있어야 한다. DM을 받으려면 `message.im` 이벤트와 App Home의 Messages 탭이 필요하다.

```yaml
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Rin
    always_online: true
oauth_config:
  scopes:
    bot: [app_mentions:read, chat:write, reactions:write, groups:history, im:history, im:write, files:read, files:write]
settings:
  event_subscriptions:
    bot_events: [app_mention, message.im]
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
```

## 로컬 실행

```sh
npm ci
cp .env.example .env                                   # 토큰을 채운다
docker build -t rin:local .
docker compose -f compose.dev.yaml --profile app up -d  # postgres, gateway, worker를 컨테이너로 띄운다
```

Notion MCP 로그인(한 번):

```sh
docker compose -f compose.dev.yaml exec -it worker claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
docker compose -f compose.dev.yaml exec -it worker claude      # /mcp 에서 notion 을 골라 로그인한다
# 브라우저가 localhost 주소로 돌아가며 실패하면 그 주소를 복사해서:
docker compose -f compose.dev.yaml exec worker curl -s "<복사한 주소>"
```

## 검사

```sh
npm run typecheck
npm test
docker compose -f compose.dev.yaml up -d postgres
docker compose -f compose.dev.yaml exec postgres createdb -U rin rin_test   # 처음 한 번
# 테이블을 비우는 검사라서 이름이 _test로 끝나는 DB에서만 돈다
DATABASE_URL=postgres://rin:rin@localhost:5433/rin_test node --import tsx test/db.smoke.ts
```
