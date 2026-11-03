# Rin AWS 배포

Rin을 EC2 한 대에서 Docker Compose(`deploy/compose.db.yaml`, `deploy/compose.app.yaml`)로 띄운다. main에 머지하면 `.github/workflows/deploy.yml`이 이미지를 ECR `hopcharlie/rin:<sha>`에 올리고, SSM Run Command로 호스트에서 `deploy/ec2/deploy.sh`를 실행한다.

## 만드는 것

| 리소스 | 내용 |
| --- | --- |
| EC2 | t3.large 1대, Amazon Linux 2023, 기본 VPC 공인 서브넷, gp3 40GiB. 들어오는 포트는 없고 SSM으로만 접속한다 |
| ECR | `hopcharlie/rin`. 최근 이미지 20개만 남긴다 |
| IAM 역할 `rin-host` | 호스트용. SSM 접속, `/rin/*` 파라미터 읽기, ECR 읽기. IMDS 홉 제한이 1이라 컨테이너는 이 역할을 쓰지 못한다 |
| IAM 역할 `rin-deploy` | GitHub Actions용. 이 레포 main 브랜치만 쓸 수 있다. ECR 푸시와 호스트에 대한 Run Command |
| IAM 사용자 `rin-ai` | Rin이 쓰는 AWS 계정. `ViewOnlyAccess`만 있고 파라미터, 비밀값, S3 객체 읽기와 KMS 복호화는 막혀 있다 |
| SSM 파라미터 | `/rin/POSTGRES_PASSWORD`, `/rin/RIN_AI_AWS_ACCESS_KEY_ID`, `/rin/RIN_AI_AWS_SECRET_ACCESS_KEY`는 Terraform이 만든다. 나머지는 `put-secrets.sh`로 넣는다 |

비용은 서울 리전 온디맨드 기준으로 하루 약 2.7달러다.

## 처음 한 번 하는 일

필요한 것은 Docker, AWS CLI v2.9 이상, `gh`, 해커톤 계정(525091405886)용 AWS CLI 프로필이다. 프로필 이름이 `hopcharlie`가 아니면 `AWS_PROFILE`로 지정한다. Terraform은 `tf.sh`가 Docker 이미지로 실행하고, 다른 계정의 프로필이면 실행 전에 멈춘다.

1. 인프라를 만든다.

   ```bash
   cd deploy/aws
   ./tf.sh init
   ./tf.sh plan
   ./tf.sh apply
   ```

2. 비밀값을 넣는다. 레포 밖에 파일을 만들고 `KEY=VALUE`를 한 줄에 하나씩, 따옴표 없이 적는다. 스크립트는 키 이름만 출력한다.

   ```bash
   # ~/rin-secrets.env
   # ANTHROPIC_API_KEY=...
   # SLACK_BOT_TOKEN=xoxb-...
   # SLACK_APP_TOKEN=xapp-...
   # GITHUB_APP_ID=...
   # GITHUB_APP_INSTALLATION_ID=...
   # GITHUB_APP_PRIVATE_KEY_B64=...   (base64 -w0 github-app.pem 의 결과)
   ./put-secrets.sh ~/rin-secrets.env
   ```

   `RIN_MODEL` 같은 설정값도 같은 파일에 넣으면 컨테이너 환경 변수가 된다. Terraform이 만드는 세 파라미터는 이 파일에 넣지 않는다.

3. 레포 변수를 설정한다.

   ```bash
   gh variable set RIN_DEPLOY_ROLE_ARN --repo 2026-Softbank-Hackathon-Charlie/rin --body "$(./tf.sh output -raw deploy_role_arn)"
   gh variable set RIN_INSTANCE_ID --repo 2026-Softbank-Hackathon-Charlie/rin --body "$(./tf.sh output -raw instance_id)"
   ```

4. 첫 배포를 수동으로 돌린다. 호스트가 처음 부팅하며 Docker를 설치하는 데 몇 분 걸리므로 apply 후 5분쯤 기다린다.

   ```bash
   gh workflow run deploy.yml --repo 2026-Softbank-Hackathon-Charlie/rin --ref main
   gh run watch --repo 2026-Softbank-Hackathon-Charlie/rin
   ```

   성공하면 `#final_team_charlie`에 "Rin 배포 완료"가 올라온다.

## 배포가 하는 일

`deploy.sh`는 다음 순서로 돈다.

1. `/rin/*` 파라미터를 모두 읽어 `/run/rin.env`(root만 읽기)에 쓴다.
2. 새 이미지로 `docker compose up -d`를 실행하고, gateway와 worker가 180초 안에 healthy가 되기를 기다린다. 기존 worker는 진행 중인 작업을 끝내느라 멈추는 데 최대 5분이 걸릴 수 있고, 180초는 그 뒤부터 센다.
3. 성공하면 `/srv/rin/current-image`에 이미지를 기록하고 Slack에 알린 뒤 7일 지난 이미지를 지운다.
4. 실패하면 직전 이미지로 같은 방법으로 되돌리고 Slack에 알린다. 워크플로도 실패로 끝난다.

비밀값을 바꾼 뒤에는 `put-secrets.sh`를 다시 실행하고 워크플로를 수동으로 돌려야 컨테이너에 반영된다.

## 호스트에 들어가기

Session Manager 플러그인이 필요하다.

```bash
aws ssm start-session --profile hopcharlie --region ap-northeast-2 --target "$(./tf.sh output -raw instance_id)"
sudo docker compose -p rin ps
sudo docker logs --tail 100 rin-worker-1
```
