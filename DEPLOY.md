# 지금의 배포 방식

이 파일은 Rin이 어디에서 어떻게 돌고 있는지 적는다. 배포 방식이 바뀌면 이 파일도 같이 고친다.

## 현재 상태

- EC2 `i-05d4ba044ec963ed0`(서울)에서 돈다. 인프라는 `deploy/aws/`의 Terraform으로 관리하고, 처음 만드는 순서는 `deploy/aws/README.md`에 있다.
- 같은 Slack 앱으로 로컬과 EC2를 동시에 띄우지 않는다. 로컬 시험이 필요하면 EC2 쪽을 먼저 멈춘다.

## 배포 흐름 (교대 배포)

main에 머지하면 `.github/workflows/deploy.yml`이 동작한다.

1. GitHub OIDC로 AWS 역할 `rin-deploy`를 받는다.
2. 이미지를 빌드해 ECR `hopcharlie/rin:<커밋 sha>`에 올린다.
3. SSM Run Command로 EC2에서 새 이미지의 `deploy/ec2/deploy.sh`, `deploy/compose.db.yaml`, `deploy/compose.app.yaml`을 꺼내 `/srv/rin`에 두고 `deploy.sh`를 실행한다.

`deploy.sh`는 돌고 있는 Rin을 끊지 않고 새 버전으로 넘긴다.

1. postgres는 compose 프로젝트 `rin`(`compose.db.yaml`)으로 배포와 상관없이 계속 돈다.
2. 새 gateway와 worker를 프로젝트 `rin-<sha 7자리>`로 옛 버전 옆에 띄운다.
3. 180초 안에 healthy가 되지 않으면 새 컨테이너만 지우고 실패로 끝낸다. 옛 버전은 그대로 일하므로 이것이 롤백이다.
4. healthy가 되면 옛 gateway를 지운다. Socket Mode는 연결 여러 개를 허용하고 이벤트 하나를 그중 한 곳에만 보내므로, 겹치는 동안 멘션이 유실되지 않는다.
5. 옛 worker에는 SIGTERM을 보내고 재시작하지 않게 한다. 옛 worker는 새 작업을 받지 않고, 하던 작업을 최대 2시간까지 마친 뒤 스스로 종료한다.

## 샌드박스

- worker는 Claude Code를 직접 띄우지 않고, 실행마다 같은 이미지로 샌드박스 컨테이너 `rin-sbx-<작업 id>-<임의 값>`을 띄운다. 샌드박스는 `rin_default` 네트워크에 붙고, `/srv/rin/data`를 `/data`로 마운트한다. 모든 샌드박스가 같은 `/data`(작업 공간의 `repos/`, `worktrees/` 포함)를 읽고 쓴다. 메모리는 3GB까지다.
- worker는 이를 위해 `/var/run/docker.sock`을 마운트하고, 소켓을 가진 그룹에 들어간다. 그룹 id는 `deploy.sh`가 `DOCKER_GID`로 넘긴다. worker가 시작할 때 Docker나 이미지를 쓸 수 없으면 healthy가 되지 않으므로, 배포는 옛 버전을 남긴 채 실패한다.
- 샌드박스는 Claude가 끝나면 `--rm`으로 지워진다. 남은 샌드박스는 리더가 10분마다 찾아서, 작업이 더 이상 실행 중이 아니면 지운다.
- 로컬 개발(`compose.dev.yaml`)에는 샌드박스가 없다. `RIN_SANDBOX_IMAGE`가 없으면 Claude는 worker 컨테이너 안에서 돈다.

## worker 사이의 약속

- 동시 실행 상한(4개)은 프로세스가 아니라 DB에서 실행 중인 작업 전체를 센다. 옛 worker와 새 worker가 겹쳐도 Claude 실행은 4개를 넘지 않는다.
- 예약 디스패치, 첨부 파일과 샌드박스 정리, 죽은 worker 작업 회수는 리더만 한다. 레포 동기화와 worktree 관리는 worker가 하지 않고 Claude가 샌드박스에서 한다. 리더는 drain 중이 아니고 하트비트가 살아 있는 worker 중 가장 늦게 시작한 것이다(`workers` 테이블).
- 같은 clone에 대한 git 작업은 Postgres advisory lock으로 worker 사이에서도 한 번에 하나만 돈다.
- 2시간 안에 끝나지 않은 작업은 큐에 다시 넣고, 새 worker가 같은 Claude 세션을 이어서 마무리한다. 하트비트가 90초 넘게 끊긴 worker(크래시, 재부팅)의 작업도 같은 방법으로 이어 간다. 자동 재개는 작업마다 한 번만 하고, 그다음에는 "중단"으로 끝낸다.
- 배포 결과는 Slack에 알리지 않는다. GitHub Actions의 deploy 실행 결과와 로그로 확인한다.

## Rin이 자기 레포를 고칠 때

- 코드 변경은 `rin/` 브랜치와 PR로 올린다. 머지되면 위 흐름으로 몇 분 안에 배포된다. 이번 실행은 옛 worker에서 끝까지 마무리된다.
- `deploy/ec2/deploy.sh`나 compose 파일이 깨지면 새 버전이 뜨지 않을 뿐 옛 버전은 계속 돈다. 그래도 이 파일들을 고칠 때는 PR 본문에 그 사실을 밝힌다.
- `compose.db.yaml`의 postgres 정의를 바꾸면 DB 컨테이너가 다시 만들어진다. 꼭 필요할 때만 바꾼다.
