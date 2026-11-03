# rin 레포 작업 규칙

Rin이 자기 자신을 고칠 때, 그리고 팀원이 이 레포를 고칠 때 읽는 규칙이다. 배포 방식은 `DEPLOY.md`에, Rin이 쓰는 계정과 비밀값은 `ACCOUNTS.md`에 있다. 계정이나 토큰을 붙이거나 바꾸면 `ACCOUNTS.md`도 같이 고친다.

## 구조

- `src/gateway/main.ts`: 채널 멘션과 DM 수신, 호출 게이트, 취소 버튼, `@Rin 모델` 명령
- `src/worker/main.ts`: 큐 소비, 동시 실행 제한, 취소 감지, 예약 디스패치, 레포 동기화, 종료 시 작업 마무리
- `src/worker/run.ts`: 작업 하나의 실행. Slack 요청은 상태 메시지와 스레드 답, 예약 작업은 채널 본문 글
- `src/worker/thread.ts`: 스레드 글을 프롬프트로 바꾼다. 팀원 글은 지시, 그 밖은 자료로 감싼다
- `src/worker/coord.ts`: worker 사이의 약속(하트비트, 리더, 전체 동시 실행 상한, 끊긴 작업 재개)
- `src/worker/repos.ts`: `repos/` clone 동기화, worktree 생성과 정리
- `src/worker/attachments.ts`: Slack 첨부 파일 내려받기, 올릴 파일 검사, 7일 지난 파일 폴더 정리
- `src/worker/cron.ts`, `src/worker/scheduler.ts`: 예약 시각 계산과 디스패치
- `src/github/app.ts`: GitHub App 설치 토큰과 봇 커밋 신원
- `src/agent/tools.ts`: Claude에게 주는 Rin 도구(`mcp__rin__*`)
- `src/agent/guards.ts`: Bash와 파일 쓰기 정책. `src/agent/options.ts`가 PreToolUse 훅으로 건다
- `src/cloudflare/api.ts`: Cloudflare 읽기 전용 API 호출. 토큰은 Claude에게 넘기지 않는다
- `src/slack/`: 메시지 나누기, 상태 메시지 블록
- `bin/mmd2png.mjs`: Mermaid 파일을 이미지의 Chromium과 `mermaid.min.js`로 PNG로 바꾼다. 이미지 안에서는 `mmd2png` 명령이다
- `src/db/`: Postgres 접근과 마이그레이션
- `prompts/`: 시스템 프롬프트에 붙는 글. 붙는 순서는 `src/agent/options.ts`의 `PROMPT_FILES`다. `rin.md`는 팀 규칙, `hackathon.md`는 해커톤 문맥, `korean.md`는 한국어 글쓰기와 문자 규칙, `karpathy.md`는 코드 작업 지침이다
- `workspace-template/`: 작업 공간을 처음 만들 때 복사하는 파일. `skills/` 아래 스킬은 worker가 시작할 때마다 작업 공간의 `.claude/skills/`에 덮어쓴다

## 고칠 때 지킬 것

- 고친 뒤 `npm run typecheck`와 `npm test`를 통과시킨다. DB 쿼리를 고쳤으면 `test/db.smoke.ts`도 돌린다.
- `src/agent/guards.ts`의 정책은 요청 없이 느슨하게 만들지 않는다. 정책을 바꾸면 `test/guards.test.ts`도 같이 고친다.
- 마이그레이션은 `src/db/migrations.ts`에 새 id로 추가한다. 이미 적용된 항목은 고치지 않는다.
- 커밋은 `rin/`으로 시작하는 브랜치에 하고 PR로 올린다. 레포는 squash 머지만 쓴다.
