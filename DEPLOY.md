# 지금의 배포 방식

이 파일은 Rin이 어디에서 어떻게 돌고 있는지 적는다. 배포 방식이 바뀌면 이 파일도 같이 고친다.

## 현재 상태

- GCP Compute Engine VM `hopcharlie-rin`에서 돈다. 프로젝트는 `project-b47cdba3-db5b-42a2-9a6`, 존은 `asia-northeast3-a`(서울)이고, e2-standard-2(2 vCPU, 8GiB)에 40GiB pd-balanced 디스크를 쓴다. VM에는 runtime service account를 붙이지 않았고, 접속은 IAP로만 한다.
- 2026-11-06에 AWS EC2 `i-05d4ba044ec963ed0`에서 옮겨 왔다. 이전 절차와 검증 결과는 [infra#86](https://github.com/2026-Softbank-Hackathon-Charlie/infra/issues/86)에 있다. 옛 EC2는 종료했고, 이전 직후에 만든 원본 디스크 스냅샷 `snap-020c500e21c7a614d`만 남아 있다.
- 레포 변수 `RIN_DEPLOY_TARGET`이 `gcp`라서 main 배포는 GCP VM으로 간다. GCP 쪽 레포 변수와 전환 절차는 [deploy/gcp/README.md](deploy/gcp/README.md)에 있다.
- 이미지, 비밀값, CI 역할은 AWS에 그대로 둔다. ECR `hopcharlie/rin`, SSM 서울 `/rin/*`, IAM 역할 `rin-deploy`, IAM 사용자 `rin-ai`는 GCP 배포와 Rin이 계속 쓰므로 지우지 않는다. 이 리소스는 `deploy/aws/`의 Terraform이 관리한다.
- `deploy/aws/main.tf`에는 종료한 EC2(`aws_instance.rin`)와 `rin-host` 역할, 인스턴스 프로파일, 보안 그룹 정의가 아직 남아 있다. 이 정의를 지우기 전에 `./tf.sh apply`를 실행하면 EC2를 다시 만든다.
- 같은 Slack 앱으로 로컬과 GCP VM을 동시에 띄우지 않는다. 로컬 시험이 필요하면 GCP VM 쪽을 먼저 멈춘다.

## 배포 흐름 (교대 배포)

main에 머지하면 `.github/workflows/deploy.yml`이 조직 self-hosted runner(`[self-hosted, hopcharlie]`)에서 동작한다.

1. GitHub OIDC로 AWS 역할 `rin-deploy`를 받고, 이미지를 빌드해 ECR `hopcharlie/rin:<커밋 sha>`에 올린다.
2. 같은 역할을 session policy로 다시 받는다. 이 세션은 ECR pull, SSM `/rin` 읽기, SSM을 거친 KMS 복호화만 할 수 있다. push할 때 쓴 세션과 토큰은 VM에 보내지 않는다.
3. GitHub OIDC로 GCP Workload Identity Federation을 거쳐 서비스 계정 `RIN_GCP_DEPLOY_SERVICE_ACCOUNT`로 인증한다.
4. `deploy/gcp/send.sh`가 2의 세션으로 `/rin/*`를 읽어 env 파일을 만들고, pull 전용 ECR 토큰을 받는다. env 파일, ECR 토큰, 이미지 이름, `disk-preflight.sh`를 tar로 묶어 IAP SSH(`gcloud compute ssh --tunnel-through-iap`)의 stdin으로 보낸다. 비밀값은 명령 인자나 로그에 들어가지 않는다.
5. VM에서 root로 도는 `deploy/gcp/receive.sh`가 `/srv/rin/.migration-ready`를 확인하고 tar를 `/run/rin-deploy.*`에 푼다. `disk-preflight.sh`로 공간을 확인하고, 이미지를 pull한 뒤 ECR 토큰을 지운다.
6. 새 이미지에서 `deploy/ec2/deploy.sh`, `deploy/compose.db.yaml`, `deploy/compose.app.yaml`을 꺼내 `/srv/rin`에 두고, env 파일을 `RIN_ENV_FILE`로 넘겨 `deploy.sh`를 실행한다. `deploy.sh`는 경로 이름과 달리 GCP VM에서도 그대로 쓴다.

`disk-preflight.sh`는 pull 전에 쓰지 않는 Rin 이미지만 지운다. 사용 중인 이미지와 직전에 성공한 이미지는 남기고, 정리한 뒤에도 8GiB 여유가 없으면 기존 서비스를 그대로 둔 채 실패한다.

워크플로에는 EC2로 배포하는 단계(`RIN_DEPLOY_TARGET`이 없거나 `aws`일 때 SSM Run Command로 배포)가 아직 남아 있다. EC2를 종료했으므로 이 변수를 지우거나 `aws`로 바꾸면 배포가 실패한다.

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
- `deploy/ec2/deploy.sh`, `deploy/gcp/*.sh`나 compose 파일이 깨지면 새 버전이 뜨지 않을 뿐 옛 버전은 계속 돈다. 그래도 이 파일들을 고칠 때는 PR 본문에 그 사실을 밝힌다.
- `compose.db.yaml`의 postgres 정의를 바꾸면 DB 컨테이너가 다시 만들어진다. 꼭 필요할 때만 바꾼다.

## 한 번 쓰는 env와 재부팅

GCP VM에는 SSM에서 읽은 env를 파일로 남겨 두지 않는다. `deploy.sh`는 `RIN_ENV_FILE`로 받은 root 소유 0600 파일(소유 디렉터리 0700)로 Compose를 만들고, 그때 쓴 `/run/rin.env`는 성공하든 실패하든 지운다.

일반 재부팅은 Docker가 `unless-stopped` 컨테이너를 저장된 env로 다시 띄워서 복구한다. 부팅할 때 Compose를 다시 만들거나 SSM을 읽지 않는다. 그래서 컨테이너를 지웠거나 비밀값을 바꿨으면 deploy 워크플로를 다시 돌려 env를 다시 전달해야 한다. 비밀값은 `deploy/aws/put-secrets.sh`로 SSM에 넣은 뒤 워크플로를 수동으로 돌린다.

## 호스트에 들어가기

IAP 터널과 OS Login 권한이 있는 GCP 계정이 필요하다.

```bash
gcloud compute ssh hopcharlie-rin --project project-b47cdba3-db5b-42a2-9a6 --zone asia-northeast3-a --tunnel-through-iap
sudo docker compose -p rin ps                                       # postgres
sudo docker ps --filter label=com.docker.compose.service=worker     # worker(drain 중인 옛 버전 포함)
```

## AWS로 되돌리기

EC2를 종료했으므로 `RIN_DEPLOY_TARGET`만 `aws`로 바꿔서는 돌아갈 수 없다. 돌아가려면 Terraform으로 EC2를 새로 만들고, GCP VM의 Rin을 멈춘 뒤 `/srv/rin/pg`와 `/srv/rin/data`를 옮기고 검증해야 한다. 스냅샷 `snap-020c500e21c7a614d`는 이전 시점의 데이터라서, 그 뒤에 쌓인 작업, 세션, 첨부 파일은 들어 있지 않다.
