# GCP 전용 호스트 배포와 전환

2026-11-06에 GCP VM `hopcharlie-rin`으로 운영을 이전했고 기존 EC2는 종료했다. main 배포는 GCP 경로만 사용한다. 이전 검증은 [infra #86](https://github.com/2026-Softbank-Hackathon-Charlie/infra/issues/86), 잔여 AWS 호스트 정리는 [infra #93](https://github.com/2026-Softbank-Hackathon-Charlie/infra/issues/93)에서 추적한다. runner/GKE/router/DNS는 이 배포 경로의 변경 대상이 아니다.

## 공개 설정 계약

| Repository variable | 값 |
| --- | --- |
| `RIN_GCP_PROJECT_ID` | `project-b47cdba3-db5b-42a2-9a6` |
| `RIN_GCP_ZONE` | `asia-northeast3-a` |
| `RIN_GCP_INSTANCE` | `hopcharlie-rin` |
| `RIN_GCP_WORKLOAD_IDENTITY_PROVIDER` | infra의 `workload_identity_provider` 출력 |
| `RIN_GCP_DEPLOY_SERVICE_ACCOUNT` | infra의 `deploy_service_account` 출력 |

`RIN_DEPLOY_TARGET`과 `RIN_INSTANCE_ID`는 사용하지 않는다. `RIN_DEPLOY_ROLE_ARN`, ECR `hopcharlie/rin`, SSM 서울 `/rin/*`는 유지한다. 위 변수는 모두 공개 식별자이며 secret 값을 넣지 않는다. host는 e2-standard-2(2 vCPU/8GiB), 40GiB pd-balanced, runtime service account 없음이 전제다. GitHub WIF 신원에 IAP tunnel, OS Login admin과 VM 조회 권한이 필요하며 일반 SSH 공개 포트는 열지 않는다.

## 인증과 한 번 쓰는 secret

1. 기존 AWS OIDC 역할로 build/push를 마친다. 이후 같은 역할을 `inline-session-policy`로 다시 받아 ECR pull, SSM GetParametersByPath, SSM 경유 KMS decrypt만 허용한다. 원래 push 세션의 registry token과 AWS session credentials는 host로 전송하지 않는다.
2. CI의 private 임시 디렉터리에서 SSM 응답을 env로 만들고 pull-only ECR token을 파일로 받는다. env key와 줄바꿈을 검사하며 값을 로그나 명령 인자에 넣지 않는다.
3. `send.sh`는 고정 이름의 tar 파일을 IAP SSH의 암호화된 stdin으로 보낸다. `--command`에는 공개 receiver 코드만 들어간다. TTY를 만들지 않으며 원격 종료 코드가 CI에 전달된다.
4. root receiver는 복원 marker를 확인한 뒤 `/run/rin-deploy.*`(0700)에 파일을 추출한다. secret은 0600이며 symlink/hardlink를 거부한다. ECR login은 이 디렉터리 안의 Docker config만 쓰며 pull 직후 지운다. deploy script는 root 소유 regular 0600 env와 root 소유 0700 parent만 받는다.
5. `/run/rin.env`는 Compose 생성 중에만 존재한다. 성공과 실패, INT/HUP/TERM에서 CI와 host의 임시 파일을 정리한다. 전원 손실 시 `/run` tmpfs는 사라진다. Docker가 보관하는 실행 중 컨테이너의 env는 기존 동작 그대로다.

SSM의 `POSTGRES_PASSWORD`를 포함한 기존 값은 복원 DB와 일치해야 한다. 기존 `rin-ai` 앱용 자격 증명은 별도이며, 이 전환이 해당 외부 서비스 권한을 바꾸지는 않는다.

## 이미지와 공간

새 이미지 pull 전에 `disk-preflight.sh`를 실행한다. 모든 실행/정지 컨테이너(기존 worker와 sandbox 포함)의 image ID, `current-image`, `previous-image`, 이미 로컬에 있는 목표 이미지를 보존한다. 그 외 `*/hopcharlie/rin`의 참조 없는 이미지만 force 없이 지운다. Postgres 이미지, 컨테이너, volume, `/srv/rin/pg`, `/srv/rin/data`는 지우지 않는다.

정리 후 Docker data filesystem의 가용 공간이 8GiB 미만이면 pull/Compose 이전에 실패한다. 이는 40GiB host에서 이미지 압축 해제와 DB/workspace 증가를 위한 최소 여유이며 모든 이미지 크기의 성공을 보장하지 않는다. 가용 공간이 부족하면 실행 중 서비스를 그대로 두고 운영자가 원인을 확인한다. `docker system prune --volumes`로 우회하지 않는다. 배포 성공 시 직전 `current-image`를 `previous-image`로 남긴다.

## 최초 전환 절차 — 완료된 이전의 기준

1. 원본/대상의 CPU·RAM·disk, PostgreSQL 버전과 앱 image digest, SSM 동일성, 백업/복원 경로와 공간을 확인한다. 대상의 `/srv/rin/.migration-ready`는 만들지 않는다. 대상에서 bot/worker를 실행하지 않는다.
2. 원본 gateway의 신규 수신을 멈추고 worker의 기존 작업 종료를 기다린다(현재 기본 drain 최대 2시간). DB의 running/queued, sandbox, 세션/작업 수를 확인한 뒤 PostgreSQL을 정상 종료한다. `/srv/rin/pg`와 `/srv/rin/data` 전체를 numeric owner/mode를 보존해 복사하고 원본·복구 snapshot은 남긴다. 로그에 토큰/세션 본문/DB 내용을 출력하지 않는다.
3. 대상의 같은 PostgreSQL 버전/digest, 파일 hash/소유권, DB 카운트와 필요한 로그인 상태를 검증한다. 원본 bot이 정지한 것을 확인하고 운영자가 root로 `install -m 600 /dev/null /srv/rin/.migration-ready`를 실행한다. 이 marker는 데이터가 복원·검증되었다는 사람의 확인이며 자동 DB 검증을 대신하지 않는다.
4. 공개 GCP 변수를 확인하고 승인된 main 배포를 실행한다. DB/gateway/worker healthy, 실제 bot 요청, sandbox metadata HTTP 차단, 후속 GCP 배포 및 일반 reboot 복구를 확인한다. 실행 중 worker의 SIGTERM drain은 기존처럼 비동기로 이어지며 SSH는 drain 완료까지 2시간 붙들고 있지 않는다.
5. 결과를 확인한 뒤 별도 승인된 원본 EC2 중지로 compute 중복 과금을 끝낸다. EBS/snapshot/IP 보존 비용을 기록한다. 원본 데이터의 영구 삭제는 이 절차에 포함하지 않는다.

대상이 쓰기를 받기 전에는 원본의 보존 사본으로 되돌릴 수 있다. 대상이 새 작업·세션·첨부를 쓴 뒤에는 대상 정지와 최신 상태의 역이전/검증이 먼저다. EC2 배포 경로는 제거했다. AWS 복귀가 필요하면 새 호스트·배포 권한을 준비하고 GCP의 최신 데이터를 역이전·검증해야 한다. 보관된 이전 직전 스냅샷을 현재 데이터로 취급하면 안 된다.

## 재부팅과 재생성

일반 reboot는 Docker와 기존 `restart: unless-stopped` 컨테이너를 시작한다. Docker에 이미 컨테이너 env가 있어 `/run/rin.env` 없이 복구한다. boot마다 Compose를 새로 실행하거나 SSM을 읽지 않는다. drain 때문에 `restart=no`가 된 옛 worker는 재기동하지 않는다.

컨테이너 삭제 후 재생성, image 변경 또는 secret 변경은 일반 reboot와 다르다. 승인된 CI 배포가 env와 pull token을 다시 전달해야 한다. host에 AWS deploy credentials를 저장하거나 기존 env를 영구 파일로 복사해 복구하지 않는다.

## 로컬 검증

`node --test deploy/gcp/deploy.test.mjs`는 실제 AWS/Docker/gcloud 대신 격리된 mock으로 env 입력/거부, cleanup, 기존 서비스 보존, rollback 이미지 보존, 공간 부족과 marker 차단을 검증한다. Linux에서 실행하면 실제 symlink 거부도 검사한다. Windows의 mode/owner는 mock 검증이며 Linux host 실검증이 따로 필요하다.

`bash -n deploy/ec2/deploy.sh deploy/gcp/{send,receive,disk-preflight}.sh` 및 workflow YAML/run block 검사를 함께 수행한다. AWS/GCP 인증·IAP·ECR session 권한·Compose/DB 복원·reboot·실제 bot 요청은 승인된 live 단계에서 확인한다.
