# 지금의 배포 방식

이 파일은 Rin이 어디에서 어떻게 돌고 있는지 적는다. 배포 방식이 바뀌면 이 파일도 같이 고친다.

## 현재 상태 (11/3)

- 아직 서버에 배포하지 않았다. 로컬에서 `README.md`의 방법으로 실행한다.

## 예정 (1단계)

- main에 머지하면 GitHub Actions가 이미지를 빌드해 ECR `hopcharlie/rin:<sha>`에 올리고, SSM Run Command로 EC2에서 `deploy/ec2/deploy.sh`를 실행한다.
- EC2에서는 `deploy/compose.yaml`로 postgres, gateway, worker를 띄운다. 비밀값은 SSM `/rin/*`에서 읽어 `/run/rin.env`에 둔다.
- 새 버전이 2분 안에 `/healthz`를 통과하지 못하면 직전 이미지로 되돌린다.
