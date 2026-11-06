# Rin이 계속 쓰는 AWS 리소스

Rin은 GCP VM `hopcharlie-rin`에서 운영한다. 이 Terraform root는 GCP 배포와 앱이 계속 쓰는 AWS 리소스를 관리한다. EC2와 `rin-host` 역할·인스턴스 프로파일·보안 그룹은 만들지 않는다. 배포 흐름과 GCP 접속은 [DEPLOY.md](../../DEPLOY.md)와 [GCP runbook](../gcp/README.md)을 따른다.

## 소유권과 유지하는 리소스

기존 state `s3://hopcharlie-tfstate-525091405886-apne2/rin/terraform.tfstate`는 계속 **rin 레포의 `deploy/aws/`**가 관리한다. backend를 바꾸거나 state를 다른 root로 옮기지 않는다.

| 리소스 | 내용 |
| --- | --- |
| ECR | `hopcharlie/rin`. 최근 이미지 20개를 남긴다 |
| IAM 역할 `rin-deploy`와 `push-image-and-deploy` 정책 | 이 레포 main의 GitHub OIDC 신원만 허용한다. ECR push/pull과 로그인 권한을 유지하며 EC2 Run Command 권한은 없다 |
| IAM 사용자 `rin-ai`와 키 | 기존 앱용 신원과 키를 유지한다. `ViewOnlyAccess`와 비밀값·객체 읽기 거부 정책도 유지한다 |
| SSM 파라미터 | Terraform은 `/rin/POSTGRES_PASSWORD`, `/rin/RIN_AI_AWS_ACCESS_KEY_ID`, `/rin/RIN_AI_AWS_SECRET_ACCESS_KEY`를 관리한다. 나머지 `/rin/*`는 `put-secrets.sh`로 넣는다 |
| GitHub OIDC provider | 다른 레포와 공유하는 기존 provider를 data source로 참조한다 |

GCP VM·WIF·배포 서비스 계정과 `rin-deploy`의 별도 inline policy **`rin-gcp-deploy-read`는 infra 레포의 `terraform/environments/gcp/dev/rin`이 관리한다.** 이 root에서는 해당 정책을 정의하거나 제거하지 않는다. CI는 이 정책으로 `/rin/*`와 SSM 경유 KMS 복호화 권한을 얻고, session policy로 ECR pull·SSM 읽기만 허용한 세션을 GCP 배포에 사용한다.

기존 EC2의 백업 스냅샷 `snap-020c500e21c7a614d`는 Terraform 밖에서 만들었으므로 이 root가 삭제하지 않는다. 보관·삭제는 별도 결정이다.

## 기존 호스트 정의 정리

Docker, AWS CLI, 해커톤 계정 `525091405886`의 AWS 프로필이 필요하다. `tf.sh`는 공식 Terraform 1.17.1 이미지로 실행하고 다른 계정이면 시작 전에 멈춘다. 프로필 이름이 `hopcharlie`가 아니면 `AWS_PROFILE`을 지정한다.

```bash
cd deploy/aws
export AWS_PROFILE=softbank-charlie  # 사용하는 해커톤 계정 프로필
./tf.sh init
./tf.sh plan -out=tfplan
```

검토할 계획의 범위는 다음과 같다.

1. create와 replacement가 0개여야 한다. 이미 종료한 EC2는 refresh로 state에서 빠지며 새로 만들지 않는다.
2. 남아 있는 `rin-host` 역할·역할 정책·SSM 정책 연결·인스턴스 프로파일·보안 그룹만 제거한다.
3. `push-image-and-deploy`만 in-place update하여 EC2 Run Command 문을 제거한다. `instance_id` output도 사라진다.
4. ECR, SSM 파라미터, `rin-ai`와 키, `rin-deploy` 역할과 trust에는 변경이 없어야 한다. 다른 변경이 있으면 적용하지 않는다.

검토·승인한 저장 계획만 적용한다.

```bash
./tf.sh apply tfplan
rm -f tfplan
```

계획 파일에는 비밀값이 포함될 수 있으므로 공유하거나 커밋하지 않는다(`tfplan`은 `.gitignore`에 있다). 이 root의 전체 `destroy`는 운영 중인 ECR·SSM·신원을 삭제하므로 호스트 정리에 사용하지 않는다. 관련 이슈는 [infra#93](https://github.com/2026-Softbank-Hackathon-Charlie/infra/issues/93)이다.

## 비밀값과 배포 설정

비밀값은 레포 밖의 `KEY=VALUE` 파일로 준비한다. 키는 대문자·숫자·밑줄만 사용하고 값을 따옴표로 감싸지 않는다. `put-secrets.sh`는 값 대신 키 이름만 출력한다.

```bash
./put-secrets.sh ~/rin-secrets.env
```

Terraform이 관리하는 세 파라미터는 위 파일에 넣지 않는다. `RIN_MODEL` 같은 설정은 같은 파일로 넣을 수 있다. 비밀값 변경 후 승인된 GCP 배포를 실행해야 컨테이너에 반영된다.

GitHub Actions에는 기존 배포 역할과 [GCP runbook의 공개 변수](../gcp/README.md#공개-설정-계약)를 사용한다. `RIN_INSTANCE_ID`는 사용하지 않는다.

```bash
gh variable set RIN_DEPLOY_ROLE_ARN --repo 2026-Softbank-Hackathon-Charlie/rin --body "$(./tf.sh output -raw deploy_role_arn)"
```

main 병합 후 deploy workflow가 ECR에 이미지를 올리고, read-only AWS 세션으로 env와 ECR pull token을 받아 IAP로 GCP에 전달한다. 배포 성공 여부는 GitHub Actions에서 확인한다.

## 로컬 검증

```bash
./tf.sh fmt -check -recursive
./tf.sh validate
./tf.sh test
```

`tests/retirement.tftest.hcl`은 AWS와 random provider를 모두 mock한다. 실제 AWS API를 호출하지 않고 ECR 권한의 정확한 범위와 기존 OIDC 신뢰·신원·SSM 이름을 검사한다. 실제 삭제 대상과 유지 리소스의 무변경 여부는 위의 실제 state 기준 plan으로 확인한다.
