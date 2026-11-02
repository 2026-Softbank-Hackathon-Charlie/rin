# rin

팀 채널 `#final_team_charlie`에서 `@Rin`으로 부르는 Claude Code 에이전트다. 계획 문서는 Notion의 "Rin: 팀 슬랙 에이전트 봇 계획"에 있다.

## 구성

| 프로세스 | 하는 일 |
| --- | --- |
| gateway (`src/gateway`) | Slack Socket Mode로 멘션과 버튼 클릭을 받고, 호출 게이트를 거친 요청을 작업 큐에 넣는다. `@Rin 모델` 명령을 처리한다. |
| worker (`src/worker`) | 큐에서 작업을 꺼내 Claude Agent SDK로 실행한다. 동시 실행은 최대 4개다. 상태 메시지에 로그 꼬리와 취소 버튼을 보여 주고, 결과를 스레드에 올린다. |

두 프로세스는 Postgres(`jobs`, `threads`, `settings`)로만 이어진다. 모든 실행은 같은 작업 공간(`RIN_WORKSPACE`)을 cwd로 써서 CLAUDE.md, 스킬, 메모리를 공유한다.

## 로컬 실행

```sh
npm ci
cp .env.example .env            # 토큰을 채운다
docker compose -f compose.dev.yaml up -d
npm run dev:gateway             # 터미널 1
npm run dev:worker              # 터미널 2
```

## 검사

```sh
npm run typecheck
npm test
DATABASE_URL=postgres://rin:rin@localhost:5433/rin node --import tsx test/db.smoke.ts
```
