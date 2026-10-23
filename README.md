# 손가락 배구

말랑과 몽글이 모래사장에서 겨루는 비치발리볼 웹게임. 캐릭터와 그래픽은 모두 코드로 직접 그렸어요.

- 혼자 하기(컴퓨터), 온라인 대결(랜덤 매칭), 친구와 하기(방 코드·초대 링크)
- 휴대폰: 캐릭터를 손가락으로 잡고 끌기, 빠르게 휘두르면 스매시

## 구성
- `index.html` — 게임 전체 (GitHub Pages로 배포)
- `server/` — 온라인 매칭·중계 서버 (Cloudflare Workers + Durable Objects)
  - 먼저 들어온 사람의 브라우저가 물리를 계산하고, 서버는 메시지만 전달해요.

## 서버 배포
```bash
cd server
npx wrangler deploy
```
현재 서버: `wss://finger-volley.shekel-vrooms-7p.workers.dev` (`index.html`의 `SERVER`)

## 랭킹

- 온라인 대결(랜덤 매칭)만 레이팅(Elo, 시작 1000, K=32)에 반영돼요. 친구 방과 혼자 하기는 기록되지 않아요.
- 계정 없이 닉네임만 정하면 돼요. 브라우저가 만든 랜덤 id와 비밀 값이 `localStorage`에 저장되고, 서버에는 비밀 값의 해시만 남아요.
- 결과는 두 사람이 각자 보고해요. 서로 일치하면 반영, 서로 우기면 무효, 한쪽만 보고하면(상대가 나감) 90초 뒤 반영돼요. 20초 안에 끝난 판은 반영하지 않아요.
- 서버: `server/src/index.js`의 `Board` Durable Object (`/rank/top`, `/rank/me`, `/rank/register`, `/rank/report`).
- 로컬에서 시험할 때는 `wrangler dev --var MIN_GAME_MS:0 --var SOLO_REPORT_MS:3000`로 대기 시간을 줄일 수 있어요.
