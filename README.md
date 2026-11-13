# 🏭 GH 산업단지 개발사업 업무편람 도우미

새로 배정된 직원이 **업무편람을 검색하고, 질문하고, 다음에 할 일을 확인**할 수 있는 웹사이트입니다.
서버나 AI 사용료 없이 GitHub Pages(무료)에서 돌아갑니다.

## 무엇을 할 수 있나

| 메뉴 | 기능 |
|---|---|
| 💬 **질문하기** | "보상계획 공고는 어떻게 해?", "타당성검토 끝나면 다음엔?"처럼 물어보면 편람에서 맞는 절을 찾아 핵심 문단을 강조해 보여 주고, **같은 업무의 다음 절차**와 **다음 업무 단계**, 업무흐름도, 체크리스트, 관련 법령, 원문 쪽수를 함께 안내합니다. |
| 🧭 **업무 흐름** | 기획 → 계획 → 설계·보상 → 조성 → 공급 → 유지·관리 → 재생 단계와 각 단계의 업무를 한 화면에서 보여 줍니다. |
| 📖 **편람 보기** | 목차에서 절 단위로 읽고, 📄 버튼으로 원문 PDF 페이지 이미지를 볼 수 있습니다. |

- 질문 링크 공유: `https://<주소>/#/q/준공인가` 처럼 주소에 질문을 넣으면 바로 답이 열립니다.
- 줄임말도 알아듣습니다. 예: 환평 → 환경영향평가, 교평 → 교통영향평가, 투심 → 내부투자심의회 (`site/app.js`의 `SYN`에서 추가).

## 폴더 구성

```
base/                 ← 업무편람 원본 (HWP + PDF)  ★ 여기만 바꾸면 됩니다
scripts/build.py      ← HWP/PDF → 사이트 데이터 변환
site/                 ← 웹사이트 (index.html, app.js, style.css)
  data/manual.json    ← (자동 생성) 편람 본문·구조
  pages/p001.webp …   ← (자동 생성) 원문 페이지 이미지
.github/workflows/    ← 올리면 자동으로 변환·배포
```

## 처음 한 번: GitHub에 올리기

1. GitHub에서 새 저장소(Public)를 만듭니다. 예: `gh-industrial-manual`
2. 이 폴더에서:
   ```bash
   git remote add origin https://github.com/<계정>/gh-industrial-manual.git
   git push -u origin main
   ```
3. 저장소의 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 바꿉니다.
4. **Actions** 탭에서 "업무편람 사이트 빌드·배포"가 끝나면(약 5~15분) `https://<계정>.github.io/gh-industrial-manual/` 로 접속합니다.

## 편람이 개정되면 (v42 등)

1. `base/` 폴더의 HWP·PDF를 새 파일로 바꿉니다. 파일명에 `v42` 처럼 **버전 번호를 넣어 두면** 가장 높은 버전을 자동으로 고릅니다. 예전 파일은 지우는 것을 권장합니다.
2. GitHub에 올립니다(웹에서 **Add file → Upload files** 로 올려도 됩니다).
3. 자동으로 다시 변환·배포됩니다.

> HWP 문서의 **스타일 이름**(Part 제목 / 1. / 1.1. / 1.1.1. / ■ / - / •)을 기준으로 목차를 나눕니다.
> 새 판에서도 같은 스타일을 쓰면 그대로 동작합니다.

## 내 PC에서 미리 보기

```bash
pip install pyhwp pymupdf pillow
python scripts/build.py            # base/의 최신 편람 변환 (HWP 변환에 수 분 걸림)
cd site && python -m http.server 8000
# 브라우저에서 http://localhost:8000
```

## 참고

- 공개 저장소이므로 **편람 내용이 인터넷에 공개**됩니다. 대외비 내용이 들어가지 않도록 확인 후 올리세요.
- HWP 안의 메모(검토 의견)는 사이트에 나오지 않습니다.
- 검색은 브라우저 안에서 2글자 단위 BM25로 동작합니다. 나중에 AI 답변(Claude API 등)을 붙이려면 서버리스 함수(Cloudflare Workers 등)를 하나 더하면 됩니다.
