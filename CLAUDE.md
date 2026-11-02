# rin 레포 작업 규칙

Rin이 자기 자신을 고칠 때, 그리고 팀원이 이 레포를 고칠 때 읽는 규칙이다. 배포 방식은 `DEPLOY.md`에 있다.

## 구조

- `src/gateway/main.ts`: 채널 멘션과 DM 수신, 호출 게이트, 취소 버튼, `@Rin 모델` 명령
- `src/worker/main.ts`: 큐 소비, 동시 실행 제한, 취소 감지, 예약 디스패치, 레포 동기화, 종료 시 작업 마무리
- `src/worker/run.ts`: 작업 하나의 실행. Slack 요청은 상태 메시지와 스레드 답, 예약 작업은 채널 본문 글
- `src/worker/thread.ts`: 스레드 글을 프롬프트로 바꾼다. 팀원 글은 지시, 그 밖은 자료로 감싼다
- `src/worker/repos.ts`: `repos/` clone 동기화, worktree 생성과 정리
- `src/worker/cron.ts`, `src/worker/scheduler.ts`: 예약 시각 계산과 디스패치
- `src/github/app.ts`: GitHub App 설치 토큰과 봇 커밋 신원
- `src/agent/tools.ts`: Claude에게 주는 Rin 도구(`mcp__rin__*`)
- `src/agent/guards.ts`: Bash와 파일 쓰기 정책. `src/agent/options.ts`가 PreToolUse 훅으로 건다
- `src/slack/`: 메시지 나누기, 상태 메시지 블록
- `src/db/`: Postgres 접근과 마이그레이션
- `prompts/rin.md`: 시스템 프롬프트에 붙는 팀 규칙
- `workspace-template/`: 작업 공간을 처음 만들 때 복사하는 파일

## 고칠 때 지킬 것

- 고친 뒤 `npm run typecheck`와 `npm test`를 통과시킨다. DB 쿼리를 고쳤으면 `test/db.smoke.ts`도 돌린다.
- `src/agent/guards.ts`의 정책은 요청 없이 느슨하게 만들지 않는다. 정책을 바꾸면 `test/guards.test.ts`도 같이 고친다.
- 마이그레이션은 `src/db/migrations.ts`에 새 id로 추가한다. 이미 적용된 항목은 고치지 않는다.
- 커밋은 `rin/`으로 시작하는 브랜치에 하고 PR로 올린다. 레포는 squash 머지만 쓴다.
