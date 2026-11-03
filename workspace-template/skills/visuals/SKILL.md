---
name: visuals
description: 다이어그램, 차트, 표, 한 장짜리 요약 같은 이미지를 PNG로 만들어 Slack에 올릴 때 쓴다. 아키텍처 그림, 흐름도, 시퀀스 다이어그램, 일정표, 측정 결과 그래프를 그려 달라는 요청이면 이 스킬을 따른다.
---

# 시각화 이미지 만들기

이 컨테이너에는 Chromium(`chromium`), Mermaid를 PNG로 바꾸는 `mmd2png`, 한글 글꼴(Noto Sans CJK KR)이 있다. 원본 파일과 PNG는 이 대화의 파일 폴더에 만든다. 이 폴더의 경로는 프롬프트의 상황 줄에 적혀 있다. 확인을 마친 PNG만 `mcp__rin__slack_upload_file`로 올린다.

## 도구 고르기

- 상자와 선으로 된 그림은 Mermaid로 그린다. 아키텍처, 흐름도, 시퀀스, 상태도, 간트 차트, 파이 차트, 간단한 막대와 선 그래프가 여기에 든다.
- 그 밖의 그림은 HTML과 인라인 SVG로 직접 그리고 Chromium으로 찍는다. 수치가 많은 차트, 비교표, 한 장짜리 요약, 배치를 세밀하게 정해야 하는 그림이 여기에 든다.

## Mermaid

```sh
mmd2png diagram.mmd diagram.png
```

- 2배 해상도의 흰 배경 PNG가 나온다. 배율은 `--scale 3`처럼 바꾼다.
- 한글이나 공백이 든 라벨은 큰따옴표로 감싼다. 예를 들어 `A["결제 서비스"]`처럼 쓴다.
- 테마는 다이어그램 첫 줄에 `%%{init: {"theme": "neutral"}}%%`처럼 적는다.
- 문법 오류가 나면 Mermaid의 오류 메시지가 출력되고 종료 코드 1로 끝난다. 메시지의 줄 번호를 보고 고친다.
- 같은 그림을 Notion에 넣을 때는 PNG 대신 Mermaid 코드를 언어가 mermaid인 코드 블록으로 넣는다. Notion이 직접 그린다.

## HTML

- 캔버스 크기를 먼저 정하고 `body`의 너비와 높이를 그 크기로 고정한다. 기본은 1200x800이고, 발표 화면용은 1600x900이다.
- 글꼴은 `font-family: "Noto Sans CJK KR", sans-serif;`로 둔다.
- 차트는 되도록 인라인 SVG로 직접 그린다. 외부 차트 라이브러리를 불러오면 `--virtual-time-budget`으로 그리기가 끝날 때까지 기다린다.

```sh
chromium --headless --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1200,800 --virtual-time-budget=5000 \
  --screenshot=/절대/경로/chart.png file:///절대/경로/chart.html
```

- `--window-size`는 캔버스 크기와 같게 준다. 결과 PNG는 2배 크기(2400x1600)로 나온다.
- 실행하면 dbus나 GPU 관련 경고가 나온다. `bytes written to file`이 보이면 성공이다.

## 올리기 전 확인

1. Read 도구로 PNG를 직접 연다.
2. 한글이 네모로 깨졌는지, 글자가 겹치거나 잘렸는지, 수치와 라벨이 원자료와 맞는지 본다.
3. 문제가 있으면 고쳐서 다시 만든다. 이 확인을 마친 뒤에만 올린다.

## 지킬 것

- 그림에 넣는 수치는 도구 결과나 파일에서 확인한 값만 쓴다. 예시 데이터로 그려야 하면 그림 안에 "예시 데이터"라고 적는다.
- 그림 안의 글자에도 이모지를 쓰지 않는다.
- 팀 채널에 올린 그림은 운영진과 멘토도 본다.
