# 지금의 배포 방식

이 파일은 Rin이 어디에서 어떻게 돌고 있는지 적는다. 배포 방식이 바뀌면 이 파일도 같이 고친다.

## 현재 상태

- 1단계 배포 구성은 레포에 있다. EC2와 IAM 역할을 처음 만드는 순서는 `deploy/aws/README.md`에 있다.
- EC2를 띄우기 전까지는 로컬 Docker(`compose.dev.yaml`의 app 프로필)에서 돈다.
- 같은 Slack 앱으로 두 곳에서 동시에 띄우면 이벤트가 나뉘어 들어간다. EC2에 배포하기 전에 로컬 gateway와 worker를 멈춘다.

## 1단계: EC2와 GitHub Actions

- main에 머지하면 `.github/workflows/deploy.yml`이 동작한다.
  1. GitHub OIDC로 AWS 역할 `rin-deploy`를 받는다.
  2. 이미지를 빌드해 ECR `hopcharlie/rin:<커밋 sha>`에 올린다.
  3. SSM Run Command로 EC2에서 새 이미지의 `deploy/ec2/deploy.sh`와 `deploy/compose.yaml`을 꺼내 `/srv/rin`에 두고 `deploy.sh`를 실행한다.
- `deploy.sh`는 SSM `/rin/*`의 비밀값을 `/run/rin.env`에 쓰고, `docker compose`로 gateway와 worker를 새 이미지로 바꾼다. postgres는 그대로 둔다.
- 두 컨테이너가 180초 안에 healthy가 되지 않으면 직전 이미지로 되돌리고 Actions 실행을 실패로 끝낸다. 결과는 팀 채널에 한 줄로 알린다.
- worker는 종료 신호를 받으면 실행 중인 작업을 최대 4분 동안 마무리한다.
- 인프라(EC2, ECR, IAM 역할, `rin-ai` 사용자)는 `deploy/aws/`의 Terraform으로 관리한다. state는 `hopcharlie-tfstate-525091405886-apne2` 버킷의 `rin/terraform.tfstate`에 있다.

## Rin이 자기 레포를 고칠 때

- 코드 변경은 `rin/` 브랜치와 PR로 올린다. 머지되면 위 워크플로가 몇 분 안에 배포한다.
- `deploy/ec2/deploy.sh`나 `deploy/compose.yaml`이 깨지면 되돌리기도 동작하지 않을 수 있다. 이 두 파일을 고칠 때는 PR 본문에 그 사실을 밝힌다.
