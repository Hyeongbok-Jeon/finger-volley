# 손가락 배구

말랑과 몽글이 모래사장에서 겨루는 비치발리볼 웹게임. 캐릭터와 그래픽은 모두 코드로 직접 그렸어요.

- 혼자 하기(컴퓨터), 둘이 하기(키보드 하나), 온라인 대결(랜덤 매칭)
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
배포 후 나온 주소(`wss://finger-volley.<계정>.workers.dev`)를 `index.html`의 `SERVER`에 넣어요.
